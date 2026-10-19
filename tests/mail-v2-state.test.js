const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const crypto = require('node:crypto');

const SOURCE_PATH = path.join(__dirname, '..', 'apps-script', 'src', 'mail-sender.gs');
const SOURCE_TEXT = fs.readFileSync(SOURCE_PATH, 'utf8');
const STATE_INDEX_KEY = 'MAIL_V2_STATE_INDEX';

function makeMessage(overrides = {}) {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    commandId: '11111111-1111-4111-8111-111111111111',
    kind: 'daily',
    date: '2026-09-15',
    subject: '[매일매일 CS] 2026-09-15',
    text: 'plain body',
    html: '<p>html body</p>',
    claimToken: 'claim-token',
    ...overrides,
  };
}

function stateKey(key) {
  return `MAIL_V2_STATE_${key.replace(/[^A-Za-z0-9_]/g, '_')}`;
}

function createHarness(overrides = {}) {
  const stores = {
    DAILY_CS_MAIL_API_URL: 'https://project.supabase.co/functions/v1/mail-api',
    DAILY_CS_MAIL_API_KEY: 'fake-mail-only-key',
    RECIPIENT_EMAIL: 'owner@example.com',
    ...(overrides.properties || {}),
  };
  const calls = {
    api: [],
    sends: [],
    logs: [],
    deletedTriggers: [],
    createdTriggers: [],
    propertyReads: 0,
    propertyWrites: 0,
    propertyDeletes: 0,
  };
  const responses = overrides.responses || {};
  const triggers = overrides.triggers || [];
  const context = {
    console: {
      log(value) {
        calls.logs.push(String(value));
      },
    },
    Date,
    Error,
    JSON,
    String,
    PropertiesService: {
      getScriptProperties() {
        return {
          getProperty(key) {
            calls.propertyReads += 1;
            return Object.prototype.hasOwnProperty.call(stores, key) ? String(stores[key]) : null;
          },
          setProperty(key, value) {
            const stored = String(value);
            if (overrides.propertyValueLimit && Buffer.byteLength(stored, 'utf8') > overrides.propertyValueLimit) {
              throw new Error(`property value too large: ${key}`);
            }
            calls.propertyWrites += 1;
            stores[key] = stored;
          },
          deleteProperty(key) {
            calls.propertyDeletes += 1;
            delete stores[key];
          },
        };
      },
    },
    LockService: {
      getScriptLock() {
        return {
          tryLock() {
            return overrides.lockAvailable !== false;
          },
          releaseLock() {
            calls.lockReleased = true;
          },
        };
      },
    },
    MailApp: {
      getRemainingDailyQuota() {
        return overrides.remainingQuota ?? 10;
      },
      sendEmail(message) {
        calls.sends.push(message);
        if (overrides.sendError) {
          throw new Error(overrides.sendError);
        }
      },
    },
    UrlFetchApp: {
      fetch(url, request) {
        const body = JSON.parse(request.payload);
        calls.api.push({ url, request, body });
        const data = typeof responses === 'function'
          ? responses(body, { calls, stores })
          : responses[body.action];
        if (data instanceof Error) {
          return {
            getResponseCode: () => 409,
            getContentText: () => JSON.stringify({ error: { code: 'conflict', message: data.message } }),
          };
        }
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({ data }),
        };
      },
    },
    ScriptApp: {
      getProjectTriggers() {
        return triggers;
      },
      deleteTrigger(trigger) {
        calls.deletedTriggers.push(trigger);
      },
      newTrigger(handler) {
        const trigger = { handler };
        calls.createdTriggers.push(trigger);
        return {
          timeBased() {
            trigger.timeBased = true;
            return this;
          },
          everyMinutes(minutes) {
            trigger.minutes = minutes;
            return this;
          },
          create() {
            trigger.created = true;
            return trigger;
          },
        };
      },
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      formatDate(date, timeZone, pattern) {
        assert.equal(timeZone, 'Asia/Seoul');
        if (pattern === "yyyy-MM-dd'T'HH:mm:ss") return '2026-09-15T09:00:00';
        throw new Error(`Unexpected pattern ${pattern}`);
      },
      newBlob(value, contentType, name) {
        const bytes = Array.isArray(value) ? Buffer.from(value) : Buffer.from(String(value ?? ''), 'utf8');
        return { getBytes: () => Array.from(bytes), getContentType: () => contentType, getName: () => name };
      },
      computeDigest(algorithm, value) {
        assert.equal(algorithm, 'sha256');
        return Array.from(crypto.createHash('sha256').update(Array.isArray(value) ? Buffer.from(value) : String(value), 'utf8').digest());
      },
      base64Decode(value) { return Array.from(Buffer.from(value, 'base64')); },
      base64Encode(bytes) { return Buffer.from(bytes).toString('base64'); },
      base64EncodeWebSafe(bytes) {
        return Buffer.from(bytes).toString('base64url');
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(SOURCE_TEXT, context, { filename: SOURCE_PATH });
  return { context, stores, calls };
}

function createStatefulMailBackend(initialMessage, options = {}) {
  const message = { ...initialMessage };
  const row = {
    state: options.initialState || 'queued',
    message,
    claimToken: message.claimToken,
    commandId: message.commandId,
    sendingCommandId: null,
    legacy: null,
    expiredOnce: Boolean(options.expireFirstResume),
  };

  return (body) => {
    const { action, payload } = body;
    if (action === 'mail.claimDue') {
      if (row.state !== 'queued') return { message: null };
      row.state = 'claimed';
      row.claimToken = message.claimToken;
      return { message: { ...message, state: 'claimed' } };
    }
    if (action === 'mail.resumeClaim') {
      assert.equal(payload.messageId, message.id);
      assert.equal(payload.claimToken, row.claimToken);
      if (row.expiredOnce) {
        row.expiredOnce = false;
        row.state = 'queued';
        return { message: null, status: 'expired' };
      }
      if (row.state === 'sent') return { state: 'sent' };
      if (row.state !== 'claimed' && row.state !== 'sending') {
        throw new Error(`message is not resumable: ${row.state}`);
      }
      return { message: { ...message, state: row.state } };
    }
    if (action === 'mail.reconcileLegacyGuard') {
      assert.equal(payload.messageId, message.id);
      assert.equal(payload.claimToken, row.claimToken);
      row.legacy = payload.legacyStatus;
      row.state = payload.legacyStatus === 'sent' ? 'sent' : 'uncertain';
      return { state: row.state, messageId: message.id };
    }
    if (action === 'mail.beginSending') {
      assert.equal(payload.messageId, message.id);
      assert.equal(payload.claimToken, row.claimToken);
      assert.equal(payload.commandId, row.commandId);
      if (row.state === 'sending' && row.sendingCommandId === message.commandId) {
        return { state: 'sending' };
      }
      assert.equal(row.state, 'claimed');
      row.state = 'sending';
      row.sendingCommandId = payload.commandId;
      return { state: 'sending' };
    }
    if (action === 'mail.ackSent') {
      assert.equal(payload.messageId, message.id);
      assert.equal(payload.claimToken, row.claimToken);
      if (row.state !== 'sending' && row.state !== 'uncertain' && row.state !== 'sent') {
        throw new Error(`message is not sending: ${row.state}`);
      }
      row.state = 'sent';
      return { state: 'sent' };
    }
    if (action === 'mail.markUncertain') {
      assert.equal(payload.messageId, message.id);
      assert.equal(payload.claimToken, row.claimToken);
      assert.equal(row.state, 'sending');
      row.state = 'uncertain';
      return { state: 'uncertain' };
    }
    throw new Error(`unexpected action ${action}`);
  };
}

test('daily poll begins remotely, records local sending before MailApp, then ACKs sent', () => {
  const message = makeMessage();
  const harness = createHarness({
    responses: {
      'mail.claimDue': { message },
      'mail.beginSending': { status: 'begun' },
      'mail.ackSent': { status: 'acked' },
    },
  });

  const result = harness.context.dailyCsV2Poller();

  assert.equal(result.status, 'sent');
  assert.deepEqual(harness.calls.api.map((entry) => entry.body.action), [
    'mail.claimDue',
    'mail.beginSending',
    'mail.ackSent',
  ]);
  assert.equal(harness.calls.api[0].url, 'https://project.supabase.co/functions/v1/mail-api');
  assert.equal(harness.calls.api[0].request.headers['X-Daily-CS-Mail-Key'], 'fake-mail-only-key');
  assert.equal(harness.calls.api[0].request.headers.Authorization, undefined);
  assert.equal(harness.calls.api[0].request.headers.apikey, undefined);
  assert.equal(harness.calls.api[1].request.headers['Idempotency-Key'], `${message.commandId}:begin-sending`);
  assert.equal(harness.calls.api[1].body.payload.idempotencyKey, `${message.commandId}:begin-sending`);
  assert.equal(harness.calls.api[1].body.payload.messageId, message.id);
  assert.equal(harness.calls.api[1].body.payload.claimToken, message.claimToken);
  assert.equal(harness.calls.api[1].body.payload.commandId, message.commandId);
  assert.equal(harness.calls.api[2].request.headers['Idempotency-Key'], `${message.commandId}:ack-sent`);
  assert.equal(harness.calls.api[2].body.payload.idempotencyKey, `${message.commandId}:ack-sent`);
  assert.equal(harness.calls.api[2].body.payload.messageId, message.id);
  assert.equal(harness.calls.api[2].body.payload.claimToken, message.claimToken);
  assert.equal(harness.calls.sends.length, 1);
  assert.equal(harness.calls.sends[0].to, 'owner@example.com');
  const state = JSON.parse(harness.stores[stateKey('daily_2026-09-15')]);
  assert.equal(state.status, 'sent');
  assert.equal(state.remoteAckAt, '2026-09-15T09:00:00');
  assert.equal(state.subject, undefined);
  assert.equal(state.text, undefined);
  assert.equal(state.html, undefined);
  assert.match(state.bodyHash, /^\d+:\d+:\d+:/);
});

const IMAGE_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64');
test('Given an old lesson discussing CID text When sent Then prose is not mistaken for a missing image', () => {
  // Given
  const message = makeMessage({ html: '<p>Use <code>cid:diagram</code> for inline mail.</p>' });
  const harness = createHarness({ responses: createStatefulMailBackend(message) });
  // When
  const result = harness.context.dailyCsV2Poller();
  // Then
  assert.equal(result.status, 'sent');
  assert.equal(harness.calls.sends[0].inlineImages, undefined);
});
function makeImageMessage(overrides = {}) {
  const assetId = crypto.createHash('sha256').update(IMAGE_BYTES).digest('hex');
  const ref = { cid: `visual-${assetId}`, assetId, mimeType: 'image/png' };
  return makeMessage({
    snapshotId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    contentHash: 'c'.repeat(64),
    html: `<p>Visual explanation</p><img src="cid:${ref.cid}" alt="Synthetic diagram">`,
    inlineImageRefs: [ref],
    inlineImages: [{ ...ref, base64: IMAGE_BYTES.toString('base64') }],
    ...overrides,
  });
}

test('Given a snapshot PNG When the poll sends Then CID bytes reach MailApp without binary Properties storage', () => {
  // Given
  const message = makeImageMessage();
  const harness = createHarness({ propertyValueLimit: 9000, responses: createStatefulMailBackend(message) });
  // When
  const result = harness.context.dailyCsV2Poller();
  // Then
  assert.equal(result.status, 'sent');
  const blob = harness.calls.sends[0].inlineImages[message.inlineImages[0].cid];
  assert.deepEqual(Buffer.from(blob.getBytes()), IMAGE_BYTES);
  assert.equal(blob.getContentType(), 'image/png');
  assert.equal(blob.getName(), `${message.inlineImages[0].assetId}.png`);
  assert.doesNotMatch(JSON.stringify(harness.stores), /iVBOR|base64|inlineImages/);
});

test('Given a 256KiB snapshot PNG When sent Then its bytes remain out of compact Properties', () => {
  // Given
  const bytes = Buffer.alloc(262144);
  IMAGE_BYTES.copy(bytes);
  const assetId = crypto.createHash('sha256').update(bytes).digest('hex');
  const ref = { cid: `visual-${assetId}`, assetId, mimeType: 'image/png' };
  const message = makeImageMessage({ html: `<img src="cid:${ref.cid}">`, inlineImageRefs: [ref], inlineImages: [{ ...ref, base64: bytes.toString('base64') }] });
  const harness = createHarness({ propertyValueLimit: 9000, responses: createStatefulMailBackend(message) });
  // When
  const result = harness.context.dailyCsV2Poller();
  // Then
  assert.equal(result.status, 'sent');
  assert.deepEqual(Buffer.from(harness.calls.sends[0].inlineImages[ref.cid].getBytes()), bytes);
  assert.ok(Object.values(harness.stores).every((value) => Buffer.byteLength(String(value)) < 9000));
});

const invalidImageCases = [
  ['missing bytes', (m) => { m.inlineImages = []; }],
  ['missing manifest', (m) => { delete m.inlineImageRefs; }],
  ['duplicate CID', (m) => { m.inlineImages.push({ ...m.inlineImages[0] }); }],
  ['duplicate manifest CID', (m) => { m.inlineImageRefs.push({ ...m.inlineImageRefs[0] }); }],
  ['wrong MIME', (m) => { m.inlineImages[0].mimeType = 'image/svg+xml'; }],
  ['invalid base64', (m) => { m.inlineImages[0].base64 = '!!!!'; }],
  ['noncanonical base64', (m) => { m.inlineImages[0].base64 = m.inlineImages[0].base64.replace(/==$/, 'AB=='); }],
  ['PNG signature', (m) => { const bytes = Buffer.from(IMAGE_BYTES); bytes[0] = 0; m.inlineImages[0].base64 = bytes.toString('base64'); }],
  ['SHA mismatch', (m) => { const bytes = Buffer.from(IMAGE_BYTES); bytes[40] ^= 1; m.inlineImages[0].base64 = bytes.toString('base64'); }],
  ['oversized PNG', (m) => { m.inlineImages[0].base64 = Buffer.alloc(262145).toString('base64'); }],
  ['oversized dimensions', (m) => { const bytes = Buffer.from(IMAGE_BYTES); bytes.writeUInt32BE(2049, 16); m.inlineImages[0].base64 = bytes.toString('base64'); }],
  ['missing snapshot identity', (m) => { delete m.contentHash; }],
  ['unreferenced image', (m) => { m.html = '<p>No CID</p>'; }],
];
for (const [label, mutate] of invalidImageCases) {
  test(`Given ${label} When a visual mail is claimed Then it fails before beginSending`, () => {
    // Given
    const message = makeImageMessage();
    mutate(message);
    const harness = createHarness({ responses: createStatefulMailBackend(message) });
    // When / Then
    assert.throws(() => harness.context.dailyCsV2Poller(), /inline|image|PNG|snapshot/i);
    assert.deepEqual(harness.calls.api.map((entry) => entry.body.action), ['mail.claimDue']);
    assert.equal(harness.calls.sends.length, 0);
  });
}

test('Given a visual claim interrupted before begin When resumed Then PNG is fetched again and sent once', () => {
  // Given
  const message = makeImageMessage();
  let failBegin = true;
  const backend = createStatefulMailBackend(message);
  const harness = createHarness({ responses(body) {
    if (body.action === 'mail.beginSending' && failBegin) { failBegin = false; return new Error('temporary begin failure'); }
    return backend(body);
  } });
  assert.throws(() => harness.context.dailyCsV2Poller(), /temporary begin/);
  // When
  const result = harness.context.dailyCsV2Poller();
  // Then
  assert.equal(result.status, 'sent');
  assert.equal(harness.calls.sends.length, 1);
  assert.equal(harness.calls.api.filter((entry) => entry.body.action === 'mail.resumeClaim').length, 1);
});

test('Given a compact visual claim When resumed bytes are incomplete Then it remains unsent and claimed', () => {
  // Given
  const message = makeImageMessage();
  let resumed = false;
  const backend = createStatefulMailBackend(message);
  const harness = createHarness({ responses(body) {
    if (body.action === 'mail.beginSending') return new Error('temporary begin failure');
    if (body.action === 'mail.resumeClaim') { resumed = true; return { message: { ...message, inlineImages: [] } }; }
    return backend(body);
  } });
  assert.throws(() => harness.context.dailyCsV2Poller(), /temporary begin/);
  // When / Then
  assert.throws(() => harness.context.dailyCsV2Poller(), /inline|image/i);
  assert.equal(resumed, true);
  assert.equal(harness.calls.sends.length, 0);
  assert.equal(JSON.parse(harness.stores[stateKey('daily_2026-09-15')]).status, 'claimed');
});

test('Given a compact visual claim When snapshot hash changes on resume Then it fails before begin', () => {
  // Given
  const message = makeImageMessage();
  const harness = createHarness({ responses: {
    'mail.claimDue': { message },
    'mail.beginSending': new Error('temporary begin failure'),
    'mail.resumeClaim': { message: { ...message, contentHash: 'd'.repeat(64) } },
  } });
  assert.throws(() => harness.context.dailyCsV2Poller(), /temporary begin/);
  // When / Then
  assert.throws(() => harness.context.dailyCsV2Poller(), /immutable|snapshot|manifest/i);
  assert.equal(harness.calls.api.filter((entry) => entry.body.action === 'mail.beginSending').length, 1);
  assert.equal(harness.calls.sends.length, 0);
});

test('Given a visual send with failed ACK When polled again Then it ACKs without image fetch or resend', () => {
  // Given
  const message = makeImageMessage();
  let failAck = true;
  const backend = createStatefulMailBackend(message);
  const harness = createHarness({ responses(body) {
    if (body.action === 'mail.ackSent' && failAck) { failAck = false; return new Error('ACK offline'); }
    return backend(body);
  } });
  assert.throws(() => harness.context.dailyCsV2Poller(), /ACK offline/);
  const before = harness.calls.api.length;
  // When
  const result = harness.context.dailyCsV2Poller();
  // Then
  assert.equal(result.status, 'ack-only');
  assert.equal(harness.calls.sends.length, 1);
  assert.deepEqual(harness.calls.api.slice(before).map((entry) => entry.body.action), ['mail.ackSent']);
});

for (const legacyStatus of ['sent', 'sending']) {
  test(`Given legacy ${legacyStatus} and missing image bytes When polled Then the prior send guard reconciles without begin`, () => {
    // Given
    const message = makeImageMessage({ inlineImages: [] });
    const harness = createHarness({
      properties: { MAIL_STATE_2026_09_15: JSON.stringify({ status: legacyStatus }) },
      responses: createStatefulMailBackend(message),
    });
    // When / Then
    if (legacyStatus === 'sent') assert.equal(harness.context.dailyCsV2Poller().status, 'skipped-legacy-sent');
    else assert.throws(() => harness.context.dailyCsV2Poller(), /legacy uncertain/i);
    assert.deepEqual(harness.calls.api.map((entry) => entry.body.action), ['mail.claimDue', 'mail.reconcileLegacyGuard']);
    assert.equal(harness.calls.sends.length, 0);
  });
}

test('Given a visual provider failure When polled again Then unresolved sending becomes uncertain without a second send', () => {
  // Given
  const harness = createHarness({ sendError: 'provider ambiguous', responses: createStatefulMailBackend(makeImageMessage()) });
  assert.throws(() => harness.context.dailyCsV2Poller(), /provider ambiguous/);
  const before = harness.calls.api.length;
  // When / Then
  assert.throws(() => harness.context.dailyCsV2Poller(), /uncertain local sending/i);
  assert.equal(harness.calls.sends.length, 1);
  assert.deepEqual(harness.calls.api.slice(before).map((entry) => entry.body.action), ['mail.markUncertain']);
});

test('uncertain daily local state reconciles and refuses to resend', () => {
  const message = makeMessage();
  const harness = createHarness({
    properties: {
      [STATE_INDEX_KEY]: JSON.stringify(['daily_2026-09-15']),
      [stateKey('daily_2026-09-15')]: JSON.stringify({
        status: 'sending',
        messageId: message.id,
        commandId: message.commandId,
        kind: message.kind,
        claimToken: message.claimToken,
        commandKey: 'daily_2026-09-15',
        dateKey: message.date,
      }),
    },
    responses: {
      'mail.claimDue': { message },
      'mail.markUncertain': { status: 'uncertain-recorded' },
    },
  });

  assert.throws(() => harness.context.dailyCsV2Poller(), /uncertain local sending/i);
  assert.deepEqual(harness.calls.api.map((entry) => entry.body.action), ['mail.markUncertain']);
  assert.equal(harness.calls.api[0].request.headers['Idempotency-Key'], `${message.commandId}:mark-uncertain`);
  assert.equal(harness.calls.api[0].body.payload.idempotencyKey, `${message.commandId}:mark-uncertain`);
  assert.equal(harness.calls.api[0].body.payload.messageId, message.id);
  assert.equal(harness.calls.api[0].body.payload.claimToken, message.claimToken);
  assert.equal(harness.calls.sends.length, 0);
});

test('explicit resend command uses UUID ledger and does not reset old daily uncertainty', () => {
  const message = makeMessage({
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    commandId: '22222222-2222-4222-8222-222222222222',
    kind: 'resend',
  });
  const oldUncertain = {
    status: 'sending',
    messageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    commandId: '11111111-1111-4111-8111-111111111111',
    claimToken: 'old-claim-token',
    commandKey: 'daily_2026-09-15',
    dateKey: '2026-09-15',
  };
  const harness = createHarness({
    properties: {
      [stateKey('daily_2026-09-15')]: JSON.stringify(oldUncertain),
    },
    responses: {
      'mail.claimDue': { message },
      'mail.beginSending': { status: 'begun' },
      'mail.ackSent': { status: 'acked' },
    },
  });

  const result = harness.context.dailyCsV2Poller();

  assert.equal(result.status, 'sent');
  assert.equal(harness.calls.sends.length, 1);
  assert.deepEqual(JSON.parse(harness.stores[stateKey('daily_2026-09-15')]), oldUncertain);
  const resendState = JSON.parse(harness.stores[stateKey('resend_22222222-2222-4222-8222-222222222222')]);
  assert.equal(resendState.status, 'sent');
});

test('begin failure happens before local sending state and before MailApp', () => {
  const message = makeMessage();
  const harness = createHarness({
    responses: {
      'mail.claimDue': { message },
      'mail.beginSending': new Error('lease mismatch'),
    },
  });

  assert.throws(() => harness.context.dailyCsV2Poller(), /lease mismatch/);
  assert.equal(JSON.parse(harness.stores[stateKey('daily_2026-09-15')]).status, 'claimed');
  assert.equal(harness.calls.sends.length, 0);
});

test('send failure preserves local sending state for manual confirmation', () => {
  const message = makeMessage();
  const harness = createHarness({
    sendError: 'smtp timeout',
    responses: {
      'mail.claimDue': { message },
      'mail.beginSending': { status: 'begun' },
    },
  });

  assert.throws(() => harness.context.dailyCsV2Poller(), /smtp timeout/);

  const state = JSON.parse(harness.stores[stateKey('daily_2026-09-15')]);
  assert.equal(state.status, 'sending');
  assert.equal(state.messageId, message.id);
  assert.equal(state.claimToken, message.claimToken);
  assert.equal(harness.calls.sends.length, 1);
});

test('ack failure leaves local sent state for ACK-only retry', () => {
  const message = makeMessage();
  const harness = createHarness({
    responses: {
      'mail.claimDue': { message },
      'mail.beginSending': { status: 'begun' },
      'mail.ackSent': new Error('ack network failed'),
    },
  });

  assert.throws(() => harness.context.dailyCsV2Poller(), /ack network failed/);

  const state = JSON.parse(harness.stores[stateKey('daily_2026-09-15')]);
  assert.equal(state.status, 'sent');
  assert.equal(state.remoteAckAt, undefined);
  assert.equal(harness.calls.sends.length, 1);
});

test('local sent state performs ACK-only retry without another MailApp send', () => {
  const message = makeMessage();
  const harness = createHarness({
    properties: {
      [STATE_INDEX_KEY]: JSON.stringify(['daily_2026-09-15']),
      [stateKey('daily_2026-09-15')]: JSON.stringify({
        status: 'sent',
        messageId: message.id,
        commandId: message.commandId,
        claimToken: message.claimToken,
        commandKey: 'daily_2026-09-15',
        dateKey: message.date,
        localSentAt: '2026-09-15T09:00:00',
      }),
    },
    responses: {
      'mail.ackSent': { status: 'sent' },
    },
  });

  const result = harness.context.dailyCsV2Poller();

  assert.equal(result.status, 'ack-only');
  assert.deepEqual(harness.calls.api.map((entry) => entry.body.action), ['mail.ackSent']);
  assert.equal(harness.calls.sends.length, 0);
});

test('failed ACK is retried from local ledger even when claimDue would be idle', () => {
  const message = makeMessage();
  const harness = createHarness({
    properties: {
      [STATE_INDEX_KEY]: JSON.stringify(['daily_2026-09-15']),
      [stateKey('daily_2026-09-15')]: JSON.stringify({
        status: 'sent',
        messageId: message.id,
        commandId: message.commandId,
        claimToken: message.claimToken,
        commandKey: 'daily_2026-09-15',
        dateKey: message.date,
        localSentAt: '2026-09-15T09:00:00',
      }),
    },
    responses: {
      'mail.ackSent': { status: 'sent' },
      'mail.claimDue': { message: null },
    },
  });

  const result = harness.context.dailyCsV2Poller();

  assert.equal(result.status, 'ack-only');
  assert.deepEqual(harness.calls.api.map((entry) => entry.body.action), ['mail.ackSent']);
  assert.equal(harness.calls.sends.length, 0);
});


test('terminal ACK conflict is recorded once without resending or looping forever', () => {
  const message = makeMessage();
  const harness = createHarness({
    properties: {
      [STATE_INDEX_KEY]: JSON.stringify(['daily_2026-09-15']),
      [stateKey('daily_2026-09-15')]: JSON.stringify({
        status: 'sent',
        messageId: message.id,
        commandId: message.commandId,
        kind: message.kind,
        claimToken: message.claimToken,
        commandKey: 'daily_2026-09-15',
        dateKey: message.date,
        localSentAt: '2026-09-15T09:00:00',
      }),
    },
    responses: {
      'mail.ackSent': new Error('remote terminal conflict'),
    },
  });

  const first = harness.context.dailyCsV2Poller();
  const second = harness.context.dailyCsV2Poller();

  assert.equal(first.status, 'ack-conflict');
  assert.equal(second.status, 'skipped-acked');
  assert.deepEqual(harness.calls.api.map((entry) => entry.body.action), ['mail.ackSent']);
  assert.equal(harness.calls.sends.length, 0);
  const state = JSON.parse(harness.stores[stateKey('daily_2026-09-15')]);
  assert.equal(state.status, 'sent');
  assert.equal(state.remoteAckConflictAt, '2026-09-15T09:00:00');
  assert.equal(state.claimToken, message.claimToken);
});

test('local sending state is marked uncertain even when claimDue would be idle', () => {
  const message = makeMessage();
  const harness = createHarness({
    properties: {
      [STATE_INDEX_KEY]: JSON.stringify(['daily_2026-09-15']),
      [stateKey('daily_2026-09-15')]: JSON.stringify({
        status: 'sending',
        messageId: message.id,
        commandId: message.commandId,
        claimToken: message.claimToken,
        commandKey: 'daily_2026-09-15',
        dateKey: message.date,
      }),
    },
    responses: {
      'mail.markUncertain': { status: 'uncertain' },
      'mail.claimDue': { message: null },
    },
  });

  assert.throws(() => harness.context.dailyCsV2Poller(), /uncertain local sending/i);

  assert.deepEqual(harness.calls.api.map((entry) => entry.body.action), ['mail.markUncertain']);
  assert.equal(JSON.parse(harness.stores[stateKey('daily_2026-09-15')]).status, 'uncertain');
  assert.equal(harness.calls.sends.length, 0);
});

test('test commands with different UUIDs do not collide with daily date guard', () => {
  const message = makeMessage({
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    commandId: '33333333-3333-4333-8333-333333333333',
    kind: 'test',
  });
  const harness = createHarness({
    properties: {
      [stateKey('daily_2026-09-15')]: JSON.stringify({
        status: 'sending',
        messageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        commandId: '11111111-1111-4111-8111-111111111111',
        claimToken: 'old-token',
        commandKey: 'daily_2026-09-15',
        dateKey: '2026-09-15',
      }),
    },
    responses: {
      'mail.claimDue': { message },
      'mail.beginSending': { status: 'begun' },
      'mail.ackSent': { status: 'acked' },
    },
  });

  const result = harness.context.dailyCsV2Poller();

  assert.equal(result.status, 'sent');
  assert.ok(harness.stores[stateKey('test_33333333-3333-4333-8333-333333333333')]);
  assert.equal(harness.calls.sends.length, 1);
});


test('real sized 60KB html is sent without persisting full body in 9KB Properties values', () => {
  const html = `<article>${'x'.repeat(60000)}</article>`;
  const text = 'plain summary';
  const message = makeMessage({ html, text });
  const harness = createHarness({
    propertyValueLimit: 9000,
    responses: {
      'mail.claimDue': { message },
      'mail.beginSending': { status: 'begun' },
      'mail.ackSent': { status: 'acked' },
    },
  });

  const result = harness.context.dailyCsV2Poller();

  assert.equal(result.status, 'sent');
  assert.equal(harness.calls.sends[0].htmlBody.length > 60000, true);
  const storedState = harness.stores[stateKey('daily_2026-09-15')];
  assert.equal(Buffer.byteLength(storedState, 'utf8') < 9000, true);
  assert.doesNotMatch(storedState, /<article>/);
  assert.doesNotMatch(storedState, /plain summary/);
});

test('legacy MAIL_STATE sent prevents duplicate daily send and requests backend reconciliation', () => {
  const message = makeMessage();
  const harness = createHarness({
    properties: {
      MAIL_STATE_2026_09_15: JSON.stringify({ status: 'sent', lessonId: '001' }),
    },
    responses: {
      'mail.claimDue': { message },
      'mail.reconcileLegacyGuard': { status: 'legacy-sent-recorded' },
    },
  });

  const result = harness.context.dailyCsV2Poller();

  assert.equal(result.status, 'skipped-legacy-sent');
  assert.deepEqual(harness.calls.api.map((entry) => entry.body.action), [
    'mail.claimDue',
    'mail.reconcileLegacyGuard',
  ]);
  assert.equal(harness.calls.sends.length, 0);
});

test('legacy MAIL_STATE sent reconciles even when MailApp quota is zero', () => {
  const message = makeMessage();
  const harness = createHarness({
    remainingQuota: 0,
    properties: {
      MAIL_STATE_2026_09_15: JSON.stringify({ status: 'sent', lessonId: '001' }),
    },
    responses: createStatefulMailBackend(message),
  });

  const result = harness.context.dailyCsV2Poller();

  assert.equal(result.status, 'skipped-legacy-sent');
  assert.deepEqual(harness.calls.api.map((entry) => entry.body.action), [
    'mail.claimDue',
    'mail.reconcileLegacyGuard',
  ]);
  assert.equal(harness.calls.api[1].body.payload.legacyStatus, 'sent');
  assert.equal(harness.calls.sends.length, 0);
});

test('legacy MAIL_STATE sending fails closed before MailApp and before beginSending', () => {
  const message = makeMessage();
  const harness = createHarness({
    properties: {
      MAIL_STATE_2026_09_15: JSON.stringify({ status: 'sending', lessonId: '001' }),
    },
    responses: {
      'mail.claimDue': { message },
      'mail.reconcileLegacyGuard': { status: 'legacy-sending-recorded' },
    },
  });

  assert.throws(() => harness.context.dailyCsV2Poller(), /Legacy uncertain send state/);
  assert.deepEqual(harness.calls.api.map((entry) => entry.body.action), [
    'mail.claimDue',
    'mail.reconcileLegacyGuard',
  ]);
  assert.equal(harness.calls.sends.length, 0);
});

test('ACK-only recovery runs with zero MailApp quota', () => {
  const message = makeMessage();
  const harness = createHarness({
    remainingQuota: 0,
    properties: {
      [STATE_INDEX_KEY]: JSON.stringify(['daily_2026-09-15']),
      [stateKey('daily_2026-09-15')]: JSON.stringify({
        status: 'sent',
        messageId: message.id,
        commandId: message.commandId,
        kind: message.kind,
        claimToken: message.claimToken,
        commandKey: 'daily_2026-09-15',
        dateKey: message.date,
        localSentAt: '2026-09-15T09:00:00',
      }),
    },
    responses: {
      'mail.ackSent': { status: 'sent' },
    },
  });

  const result = harness.context.dailyCsV2Poller();

  assert.equal(result.status, 'ack-only');
  assert.deepEqual(harness.calls.api.map((entry) => entry.body.action), ['mail.ackSent']);
  assert.equal(harness.calls.sends.length, 0);
});

test('claimed recovery reloads immutable payload through resumeClaim and does not store body', () => {
  const message = makeMessage({ html: `<p>${'x'.repeat(30000)}</p>` });
  const harness = createHarness({
    propertyValueLimit: 9000,
    properties: {
      [STATE_INDEX_KEY]: JSON.stringify(['daily_2026-09-15']),
      [stateKey('daily_2026-09-15')]: JSON.stringify({
        status: 'claimed',
        messageId: message.id,
        commandId: message.commandId,
        kind: message.kind,
        claimToken: message.claimToken,
        commandKey: 'daily_2026-09-15',
        dateKey: message.date,
        bodyHash: 'prior-hash',
      }),
    },
    responses: {
      'mail.resumeClaim': { message },
      'mail.beginSending': { status: 'begun' },
      'mail.ackSent': { status: 'acked' },
    },
  });

  const result = harness.context.dailyCsV2Poller();

  assert.equal(result.status, 'sent');
  assert.deepEqual(harness.calls.api.map((entry) => entry.body.action), [
    'mail.resumeClaim',
    'mail.beginSending',
    'mail.ackSent',
  ]);
  assert.doesNotMatch(harness.stores[stateKey('daily_2026-09-15')], /xxxxxxxxxx/);
});

test('expired claimed recovery is removed and future claim can proceed', () => {
  const message = makeMessage({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' });
  const harness = createHarness({
    properties: {
      [STATE_INDEX_KEY]: JSON.stringify(['daily_2026-09-14']),
      [stateKey('daily_2026-09-14')]: JSON.stringify({
        status: 'claimed',
        messageId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        commandId: '44444444-4444-4444-8444-444444444444',
        kind: 'daily',
        claimToken: 'expired-token',
        commandKey: 'daily_2026-09-14',
        dateKey: '2026-09-14',
        bodyHash: 'expired-hash',
      }),
    },
    responses: {
      'mail.resumeClaim': { message: null, status: 'expired' },
      'mail.claimDue': { message },
      'mail.beginSending': { status: 'begun' },
      'mail.ackSent': { status: 'acked' },
    },
  });

  const result = harness.context.dailyCsV2Poller();

  assert.equal(result.status, 'sent');
  assert.equal(harness.stores[stateKey('daily_2026-09-14')], undefined);
  assert.deepEqual(harness.calls.api.map((entry) => entry.body.action), [
    'mail.resumeClaim',
    'mail.claimDue',
    'mail.beginSending',
    'mail.ackSent',
  ]);
});

test('stateful fake backend exercises queued to claimed to sending to sent', () => {
  const message = makeMessage({
    id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    commandId: '55555555-5555-4555-8555-555555555555',
  });
  const harness = createHarness({
    responses: createStatefulMailBackend(message),
  });

  const result = harness.context.dailyCsV2Poller();

  assert.equal(result.status, 'sent');
  assert.deepEqual(harness.calls.api.map((entry) => entry.body.action), [
    'mail.claimDue',
    'mail.beginSending',
    'mail.ackSent',
  ]);
  assert.equal(harness.calls.sends.length, 1);
  assert.equal(JSON.parse(harness.stores[stateKey('daily_2026-09-15')]).remoteAckAt, '2026-09-15T09:00:00');
});

test('stateful fake backend expires one compact claim then sends the next due message', () => {
  const message = makeMessage({
    id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    commandId: '66666666-6666-4666-8666-666666666666',
  });
  const harness = createHarness({
    properties: {
      [STATE_INDEX_KEY]: JSON.stringify(['daily_2026-09-15']),
      [stateKey('daily_2026-09-15')]: JSON.stringify({
        status: 'claimed',
        messageId: message.id,
        commandId: message.commandId,
        kind: message.kind,
        claimToken: message.claimToken,
        commandKey: 'daily_2026-09-15',
        dateKey: message.date,
        bodyHash: 'expired-hash',
      }),
    },
    responses: createStatefulMailBackend(message, { initialState: 'claimed', expireFirstResume: true }),
  });

  const result = harness.context.dailyCsV2Poller();

  assert.equal(result.status, 'sent');
  assert.deepEqual(harness.calls.api.map((entry) => entry.body.action), [
    'mail.resumeClaim',
    'mail.claimDue',
    'mail.beginSending',
    'mail.ackSent',
  ]);
  assert.equal(harness.calls.sends.length, 1);
});

test('UTF-8 body byte limit is enforced before beginSending', () => {
  const message = makeMessage({ html: '가'.repeat(70000) });
  const harness = createHarness({
    responses: {
      'mail.claimDue': { message },
      'mail.beginSending': { status: 'begun' },
    },
  });

  assert.throws(() => harness.context.dailyCsV2Poller(), /200KB UTF-8/);
  assert.deepEqual(harness.calls.api.map((entry) => entry.body.action), ['mail.claimDue']);
  assert.equal(harness.calls.sends.length, 0);
});

test('acked history for at least 400 days stays below 9KB and trims to 90 records', () => {
  const responses = { 'mail.beginSending': { status: 'begun' }, 'mail.ackSent': { status: 'acked' } };
  const harness = createHarness({ propertyValueLimit: 9000, responses });

  for (let day = 1; day <= 400; day += 1) {
    const date = `2026-10-${String((day % 28) + 1).padStart(2, '0')}`;
    const command = `${String(day).padStart(8, '0')}-1111-4111-8111-111111111111`;
    responses['mail.claimDue'] = { message: makeMessage({
      id: `${String(day).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
      commandId: command,
      kind: 'test',
      date,
    }) };
    harness.context.dailyCsV2Poller();
  }

  const acked = JSON.parse(harness.stores.MAIL_V2_ACKED_INDEX);
  assert.equal(acked.length, 90);
  assert.equal(Buffer.byteLength(harness.stores.MAIL_V2_ACKED_INDEX, 'utf8') < 9000, true);
  assert.equal(JSON.parse(harness.stores[STATE_INDEX_KEY]).length, 0);
});

test('288 idle polls stay within a small Properties read budget', () => {
  const harness = createHarness({ responses: { 'mail.claimDue': { message: null } } });

  for (let poll = 0; poll < 288; poll += 1) {
    const result = harness.context.dailyCsV2Poller();
    assert.equal(result.status, 'idle');
  }

  assert.equal(harness.calls.sends.length, 0);
  assert.equal(harness.calls.propertyReads < 2500, true);
});

test('install poller deletes only known Daily CS handlers and leaves unrelated triggers', () => {
  const legacy = { getHandlerFunction: () => 'sendDailyEmail', getTriggerSource: () => 'CLOCK', getEventType: () => 'CLOCK' };
  const oldV2 = { getHandlerFunction: () => 'dailyCsV2Poller', getTriggerSource: () => 'CLOCK', getEventType: () => 'CLOCK' };
  const unrelated = { getHandlerFunction: () => 'otherHandler', getTriggerSource: () => 'CLOCK', getEventType: () => 'CLOCK' };
  const harness = createHarness({ triggers: [legacy, oldV2, unrelated] });

  const result = harness.context.installDailyCsV2Poller();

  assert.equal(result.status, 'poller-installed');
  assert.deepEqual(harness.calls.deletedTriggers, [legacy, oldV2]);
  assert.equal(harness.calls.createdTriggers[0].handler, 'dailyCsV2Poller');
  assert.equal(harness.calls.createdTriggers[0].minutes, 5);
});

test('dry-run migration reports known triggers without deleting or creating', () => {
  const legacy = { getHandlerFunction: () => 'verificationTriggerHandler', getTriggerSource: () => 'CLOCK', getEventType: () => 'CLOCK' };
  const harness = createHarness({ triggers: [legacy] });

  const result = harness.context.dryRunDailyCsV2Migration();

  assert.equal(result.status, 'dry-run');
  assert.equal(result.wouldRemove.length, 1);
  assert.deepEqual(harness.calls.deletedTriggers, []);
  assert.deepEqual(harness.calls.createdTriggers, []);
});
