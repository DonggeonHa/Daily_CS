// allow: SIZE_OK — Apps Script paste target is kept self-contained; build emits one auditable Code.gs.
var DailyCsV2Mail = (function () {
  var TIME_ZONE = 'Asia/Seoul';
  var POLLER_HANDLER = 'dailyCsV2Poller';
  var LEGACY_DAILY_HANDLER = 'sendDailyEmail';
  var LEGACY_VERIFICATION_HANDLER = 'verificationTriggerHandler';
  var STATE_INDEX_KEY = 'MAIL_V2_STATE_INDEX';
  var ACKED_INDEX_KEY = 'MAIL_V2_ACKED_INDEX';
  var LEGACY_STATE_PREFIX = 'MAIL_STATE_';
  var PENDING_LIMIT = 25;
  var ACKED_HISTORY_LIMIT = 90;
  var CLAIM_MINUTES = 10;
  var MAX_SUBJECT_LENGTH = 200;
  var MAX_TEXT_BYTES = 200000;
  var MAX_HTML_BYTES = 200000;
  var REQUIRED_PROPS = [
    'DAILY_CS_MAIL_API_URL',
    'DAILY_CS_MAIL_API_KEY',
    'RECIPIENT_EMAIL',
  ];

  function now() {
    return new Date();
  }

  function props() {
    return PropertiesService.getScriptProperties();
  }

  function timestamp(currentTime) {
    return Utilities.formatDate(currentTime, TIME_ZONE, "yyyy-MM-dd'T'HH:mm:ss");
  }

  function parseJson(text, label) {
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(label + ' returned invalid JSON: ' + error.message);
    }
  }

  function normalizeUrl(value) {
    var trimmed = String(value || '').trim();
    if (!/^https:\/\/[^?#\s]+\/functions\/v1\/mail-api\/?$/.test(trimmed) || trimmed.indexOf('@') !== -1) {
      throw new Error('DAILY_CS_MAIL_API_URL must be the https mail-api function URL');
    }
    return trimmed.replace(/\/$/, '');
  }

  function normalizeRecipient(value) {
    var trimmed = String(value || '').trim();
    if (/[,;\r\n]/.test(trimmed) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) {
      throw new Error('RECIPIENT_EMAIL must be one private recipient address');
    }
    return trimmed;
  }

  function readConfig() {
    var store = props();
    for (var index = 0; index < REQUIRED_PROPS.length; index += 1) {
      if (!store.getProperty(REQUIRED_PROPS[index])) {
        throw new Error('Missing script property: ' + REQUIRED_PROPS[index]);
      }
    }
    return {
      apiUrl: normalizeUrl(store.getProperty('DAILY_CS_MAIL_API_URL')),
      apiKey: String(store.getProperty('DAILY_CS_MAIL_API_KEY')).trim(),
      recipient: normalizeRecipient(store.getProperty('RECIPIENT_EMAIL')),
    };
  }

  function withIdempotency(payload, key) {
    var copy = payload || {};
    copy.idempotencyKey = key;
    return copy;
  }

  function postMailApi(config, action, payload, idempotencyKey) {
    var headers = {
      'X-Daily-CS-Mail-Key': config.apiKey,
    };
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }
    var response = UrlFetchApp.fetch(config.apiUrl, {
      method: 'post',
      contentType: 'application/json',
      muteHttpExceptions: true,
      headers: headers,
      payload: JSON.stringify({
        action: action,
        payload: payload || {},
      }),
    });
    var status = response.getResponseCode();
    var body = parseJson(response.getContentText(), action);
    if (status < 200 || status >= 300 || body.error) {
      var message = body && body.error && body.error.message ? body.error.message : 'HTTP ' + status;
      var error = new Error(action + ' failed: ' + message);
      error.code = body && body.error && body.error.code;
      throw error;
    }
    return body.data;
  }

  function validateQuota() {
    if (MailApp.getRemainingDailyQuota() < 1) {
      throw new Error('MailApp daily quota is exhausted');
    }
  }

  function utf8Bytes(value) {
    return Utilities.newBlob(String(value || '')).getBytes().length;
  }

  function validateMailMessage(message) {
    if (!message || typeof message !== 'object') {
      throw new Error('mail message is required');
    }
    if (!/^[0-9a-fA-F-]{36}$/.test(String(message.id || ''))) {
      throw new Error('mail message id must be a UUID');
    }
    if (!/^[0-9a-fA-F-]{36}$/.test(String(message.commandId || ''))) {
      throw new Error('mail commandId must be a UUID');
    }
    if (message.kind !== 'daily' && message.kind !== 'test' && message.kind !== 'resend') {
      throw new Error('mail message kind must be daily, test, or resend');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(message.date || ''))) {
      throw new Error('mail message date must be YYYY-MM-DD');
    }
    if (!message.claimToken || typeof message.claimToken !== 'string') {
      throw new Error('mail message claimToken is required');
    }
    if (!message.subject || String(message.subject).length > MAX_SUBJECT_LENGTH) {
      throw new Error('mail message subject is missing or too large');
    }
    if (!message.text || utf8Bytes(message.text) > MAX_TEXT_BYTES) {
      throw new Error('mail message text body is missing or exceeds 200KB UTF-8');
    }
    if (!message.html || utf8Bytes(message.html) > MAX_HTML_BYTES) {
      throw new Error('mail message html body is missing or exceeds 200KB UTF-8');
    }
  }

  function messageKey(message) {
    if (message.kind === 'daily') {
      return 'daily_' + message.date;
    }
    return message.kind + '_' + message.commandId;
  }

  function propertyKey(key) {
    return 'MAIL_V2_STATE_' + String(key).replace(/[^A-Za-z0-9_]/g, '_');
  }

  function legacyDailyStateKey(dateKey) {
    return LEGACY_STATE_PREFIX + String(dateKey).replace(/-/g, '_');
  }

  function readJsonArrayProperty(store, key, label) {
    var raw = store.getProperty(key);
    if (!raw) {
      return [];
    }
    var parsed = parseJson(raw, label);
    if (!Array.isArray(parsed)) {
      throw new Error(label + ' must be an array');
    }
    return parsed;
  }

  function readLegacyDailyState(store, dateKey) {
    var raw = store.getProperty(legacyDailyStateKey(dateKey));
    if (!raw) {
      return null;
    }
    var parsed = parseJson(raw, 'legacy mail state ' + dateKey);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('legacy mail state must be an object');
    }
    if (parsed.status !== 'sent' && parsed.status !== 'sending') {
      throw new Error('unknown legacy mail state for ' + dateKey);
    }
    return parsed;
  }

  function compactBodyHash(message) {
    var subject = String(message.subject || '');
    var text = String(message.text || '');
    var html = String(message.html || '');
    return [
      utf8Bytes(subject),
      utf8Bytes(text),
      utf8Bytes(html),
      Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, subject + '\n' + text + '\n' + html)),
    ].join(':');
  }

  function compactStateFromMessage(message, status, currentTime) {
    return {
      status: status,
      messageId: message.id,
      commandId: message.commandId,
      kind: message.kind,
      dateKey: message.date,
      claimToken: message.claimToken,
      commandKey: messageKey(message),
      bodyHash: compactBodyHash(message),
      updatedAt: timestamp(currentTime),
    };
  }

  function readStateIndex(store) {
    return readJsonArrayProperty(store, STATE_INDEX_KEY, 'mail pending state index');
  }

  function readAckedIndex(store) {
    return readJsonArrayProperty(store, ACKED_INDEX_KEY, 'mail acked state index');
  }

  function readState(store, key) {
    var raw = store.getProperty(propertyKey(key));
    if (!raw) {
      return null;
    }
    var parsed = parseJson(raw, 'mail state ' + key);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('mail state must be an object');
    }
    if (parsed.status !== 'claimed' && parsed.status !== 'sending' && parsed.status !== 'sent' && parsed.status !== 'uncertain') {
      parsed.rawStatus = parsed.status;
      parsed.status = 'unknown';
    }
    return parsed;
  }

  function removeFromIndex(store, indexKey, key) {
    var label = indexKey === ACKED_INDEX_KEY ? 'mail acked state index' : 'mail pending state index';
    var index = readJsonArrayProperty(store, indexKey, label).filter(function (value) {
      return value !== key;
    });
    store.setProperty(indexKey, JSON.stringify(index));
  }

  function removeState(store, key) {
    store.deleteProperty(propertyKey(key));
    removeFromIndex(store, STATE_INDEX_KEY, key);
    removeFromIndex(store, ACKED_INDEX_KEY, key);
  }

  function saveState(store, key, state) {
    store.setProperty(propertyKey(key), JSON.stringify(state));
    var pending = readStateIndex(store).filter(function (value) {
      return value !== key;
    });
    var acked = readAckedIndex(store).filter(function (value) {
      return value !== key;
    });
    if (state.status === 'sent' && state.remoteAckAt) {
      acked.push(key);
      while (acked.length > ACKED_HISTORY_LIMIT) {
        store.deleteProperty(propertyKey(acked.shift()));
      }
    } else if (state.status === 'claimed' || state.status === 'sending' || state.status === 'sent' || state.status === 'uncertain' || state.status === 'unknown') {
      pending.push(key);
      if (pending.length > PENDING_LIMIT) {
        throw new Error('Daily_CS local unresolved mail state capacity exceeded; refusing provider send');
      }
    }
    store.setProperty(STATE_INDEX_KEY, JSON.stringify(pending));
    store.setProperty(ACKED_INDEX_KEY, JSON.stringify(acked));
  }

  function ackSent(config, state, currentTime) {
    var idempotencyKey = state.commandId + ':ack-sent';
    postMailApi(config, 'mail.ackSent', withIdempotency({
      messageId: state.messageId,
      claimToken: state.claimToken,
      localSentAt: state.localSentAt,
      senderAckedAt: timestamp(currentTime),
    }, idempotencyKey), idempotencyKey);
  }

  function markUncertain(config, state, currentTime) {
    var idempotencyKey = state.commandId + ':mark-uncertain';
    postMailApi(config, 'mail.markUncertain', withIdempotency({
      messageId: state.messageId,
      claimToken: state.claimToken,
      reason: 'local sender observed uncertain state at ' + timestamp(currentTime),
    }, idempotencyKey), idempotencyKey);
  }

  function reconcileLegacyGuard(config, message, legacyState, currentTime) {
    var idempotencyKey = message.commandId + ':legacy-guard:' + legacyState.status;
    postMailApi(config, 'mail.reconcileLegacyGuard', withIdempotency({
      messageId: message.id,
      claimToken: message.claimToken,
      commandId: message.commandId,
      date: message.date,
      legacyStatus: legacyState.status,
      checkedAt: timestamp(currentTime),
    }, idempotencyKey), idempotencyKey);
  }

  function resumeClaim(config, state, currentTime) {
    var idempotencyKey = state.commandId + ':resume-claim';
    return postMailApi(config, 'mail.resumeClaim', withIdempotency({
      messageId: state.messageId,
      claimToken: state.claimToken,
      commandId: state.commandId,
      kind: state.kind,
      date: state.dateKey,
      bodyHash: state.bodyHash,
      checkedAt: timestamp(currentTime),
    }, idempotencyKey), idempotencyKey);
  }

  function handleExistingState(config, store, key, state, currentTime) {
    if (state.status === 'sent') {
      if (state.remoteAckAt || state.remoteAckConflictAt) {
        return { status: 'skipped-acked', commandKey: key };
      }
      try {
        ackSent(config, state, currentTime);
      } catch (error) {
        if (error.code === 'conflict') {
          saveState(store, key, {
            status: 'sent',
            messageId: state.messageId,
            commandId: state.commandId,
            kind: state.kind,
            claimToken: state.claimToken,
            commandKey: state.commandKey,
            dateKey: state.dateKey,
            bodyHash: state.bodyHash,
            localSentAt: state.localSentAt,
            remoteAckConflictAt: timestamp(currentTime),
            lastAckError: error.message,
          });
          return { status: 'ack-conflict', commandKey: key };
        }
        throw error;
      }
      saveState(store, key, {
        status: 'sent',
        messageId: state.messageId,
        commandId: state.commandId,
        kind: state.kind,
        claimToken: state.claimToken,
        commandKey: state.commandKey,
        dateKey: state.dateKey,
        bodyHash: state.bodyHash,
        localSentAt: state.localSentAt,
        remoteAckAt: timestamp(currentTime),
      });
      return { status: 'ack-only', commandKey: key };
    }
    if (state.status === 'claimed') {
      var resumed = resumeClaim(config, state, currentTime);
      if (!resumed || !resumed.message) {
        removeState(store, key);
        return { status: 'claim-expired', commandKey: key, continuePolling: true };
      }
      validateMailMessage(resumed.message);
      return sendLocalClaimedState(config, store, key, state, resumed.message, currentTime);
    }
    if (state.status === 'uncertain') {
      return { status: 'skipped-uncertain', commandKey: key };
    }
    if (state.status === 'unknown') {
      return { status: 'skipped-unknown-state', commandKey: key };
    }
    markUncertain(config, state, currentTime);
    saveState(store, key, {
      status: 'uncertain',
      messageId: state.messageId,
      commandId: state.commandId,
      kind: state.kind,
      claimToken: state.claimToken,
      commandKey: state.commandKey,
      dateKey: state.dateKey,
      bodyHash: state.bodyHash,
      remoteUncertainAt: timestamp(currentTime),
    });
    throw new Error('Uncertain local sending state exists for ' + key + '; refusing to resend');
  }

  function sendLocalClaimedState(config, store, key, state, message, currentTime) {
    validateMailMessage(message);
    var legacyState = message.kind === 'daily' ? readLegacyDailyState(store, message.date) : null;
    if (legacyState && legacyState.status === 'sent') {
      reconcileLegacyGuard(config, message, legacyState, currentTime);
      return { status: 'skipped-legacy-sent', commandKey: key, messageId: message.id };
    }
    if (legacyState && legacyState.status === 'sending') {
      reconcileLegacyGuard(config, message, legacyState, currentTime);
      throw new Error('Legacy uncertain send state exists for ' + message.date + '; refusing to resend');
    }
    validateQuota();
    var beginIdempotencyKey = state.commandId + ':begin-sending';
    postMailApi(config, 'mail.beginSending', withIdempotency({
      messageId: state.messageId,
      claimToken: state.claimToken,
      commandId: state.commandId,
      senderBeganAt: timestamp(currentTime),
    }, beginIdempotencyKey), beginIdempotencyKey);
    saveState(store, key, {
      status: 'sending',
      messageId: state.messageId,
      commandId: state.commandId,
      kind: state.kind,
      claimToken: state.claimToken,
      commandKey: key,
      dateKey: state.dateKey,
      bodyHash: state.bodyHash,
      updatedAt: timestamp(currentTime),
    });
    MailApp.sendEmail({
      to: config.recipient,
      subject: String(message.subject),
      body: String(message.text),
      htmlBody: String(message.html),
      name: message.senderName || '매일매일 CS',
    });
    var sentAt = timestamp(now());
    var sentState = {
      status: 'sent',
      messageId: state.messageId,
      commandId: state.commandId,
      kind: state.kind,
      claimToken: state.claimToken,
      commandKey: key,
      dateKey: state.dateKey,
      bodyHash: state.bodyHash,
      localSentAt: sentAt,
    };
    saveState(store, key, sentState);
    ackSent(config, sentState, now());
    sentState.remoteAckAt = timestamp(now());
    saveState(store, key, sentState);
    return { status: 'sent', commandKey: key, messageId: state.messageId };
  }

  function sendClaimedMessage(config, store, message, currentTime) {
    validateMailMessage(message);
    var key = messageKey(message);
    var existing = readState(store, key);
    if (existing) {
      return handleExistingState(config, store, key, existing, currentTime);
    }
    var state = compactStateFromMessage(message, 'claimed', currentTime);
    saveState(store, key, state);
    return sendLocalClaimedState(config, store, key, state, message, currentTime);
  }

  function recoverLocalState(config, store, currentTime) {
    var index = readStateIndex(store);
    for (var indexPosition = 0; indexPosition < index.length; indexPosition += 1) {
      var key = index[indexPosition];
      var state = readState(store, key);
      if (!state) {
        continue;
      }
      if (state.status === 'sent' && !state.remoteAckAt) {
        return handleExistingState(config, store, key, state, currentTime);
      }
      if (state.status === 'sending') {
        return handleExistingState(config, store, key, state, currentTime);
      }
      if (state.status === 'claimed') {
        var result = handleExistingState(config, store, key, state, currentTime);
        if (result && result.continuePolling) {
          continue;
        }
        return result;
      }
    }
    return null;
  }

  function pollImpl() {
    var currentTime = now();
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(30000)) {
      throw new Error('Could not acquire Daily_CS v2 mail lock');
    }
    try {
      var config = readConfig();
      var store = props();
      var recovered = recoverLocalState(config, store, currentTime);
      if (recovered) {
        return recovered;
      }
      var claim = postMailApi(config, 'mail.claimDue', {
        sender: 'apps-script-v2',
        now: timestamp(currentTime),
        leaseMinutes: CLAIM_MINUTES,
      });
      if (!claim || !claim.message) {
        console.log('mail idle');
        return { status: 'idle' };
      }
      return sendClaimedMessage(config, store, claim.message, currentTime);
    } finally {
      lock.releaseLock();
    }
  }

  function triggerSummary(trigger) {
    return {
      handler: trigger.getHandlerFunction(),
      source: String(trigger.getTriggerSource && trigger.getTriggerSource()),
      eventType: String(trigger.getEventType && trigger.getEventType()),
    };
  }

  function knownTriggerHandler(handler) {
    return handler === POLLER_HANDLER ||
      handler === LEGACY_DAILY_HANDLER ||
      handler === LEGACY_VERIFICATION_HANDLER;
  }

  function preflightImpl() {
    var config = readConfig();
    validateQuota();
    var triggers = ScriptApp.getProjectTriggers();
    var known = [];
    var other = [];
    for (var index = 0; index < triggers.length; index += 1) {
      var summary = triggerSummary(triggers[index]);
      if (knownTriggerHandler(summary.handler)) {
        known.push(summary);
      } else {
        other.push(summary);
      }
    }
    return {
      status: 'preflight-ok',
      endpoint: config.apiUrl,
      knownTriggers: known,
      otherTriggers: other,
    };
  }

  function removeKnownTriggers(dryRun) {
    var triggers = ScriptApp.getProjectTriggers();
    var removed = [];
    for (var index = 0; index < triggers.length; index += 1) {
      var trigger = triggers[index];
      var handler = trigger.getHandlerFunction();
      if (knownTriggerHandler(handler)) {
        removed.push(triggerSummary(trigger));
        if (!dryRun) {
          ScriptApp.deleteTrigger(trigger);
        }
      }
    }
    return removed;
  }

  function installPollerImpl() {
    removeKnownTriggers(false);
    ScriptApp.newTrigger(POLLER_HANDLER).timeBased().everyMinutes(5).create();
    return {
      status: 'poller-installed',
      intervalMinutes: 5,
    };
  }

  function migrationDryRunImpl() {
    return {
      status: 'dry-run',
      wouldRemove: removeKnownTriggers(true),
      wouldCreate: {
        handler: POLLER_HANDLER,
        intervalMinutes: 5,
      },
    };
  }

  function removeKnownTriggersImpl() {
    return {
      status: 'known-triggers-removed',
      removed: removeKnownTriggers(false),
    };
  }

  function testApiImpl() {
    var config = readConfig();
    return postMailApi(config, 'mail.preflight', {
      sender: 'apps-script-v2',
      checkedAt: timestamp(now()),
    });
  }

  return {
    poll: pollImpl,
    preflight: preflightImpl,
    installPoller: installPollerImpl,
    migrationDryRun: migrationDryRunImpl,
    removeKnownTriggers: removeKnownTriggersImpl,
    testApi: testApiImpl,
  };
})();

function dailyCsV2Poller() {
  return DailyCsV2Mail.poll();
}

function preflightDailyCsV2Mail() {
  return DailyCsV2Mail.preflight();
}

function installDailyCsV2Poller() {
  return DailyCsV2Mail.installPoller();
}

function dryRunDailyCsV2Migration() {
  return DailyCsV2Mail.migrationDryRun();
}

function removeKnownDailyCsTriggers() {
  return DailyCsV2Mail.removeKnownTriggers();
}

function testDailyCsV2Api() {
  return DailyCsV2Mail.testApi();
}
