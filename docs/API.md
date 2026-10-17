# Daily_CS v2 API

All private operations are Edge Function `POST` requests with JSON request and response bodies. Successful responses use `{ "data": ... }`. Failed responses use `{ "error": { "code": "stable_code", "message": "safe human message" } }`. The server never returns tokens, raw credentials, owner email, or private lesson content to unauthorized callers.

## Owner Auth

Owner UI calls `/functions/v1/owner-api` with `Authorization: Bearer <Supabase access token>` and a body:

```json
{ "action": "lesson.saveDraft", "payload": {} }
```

The Edge Function verifies the JWT with Supabase Auth and the database RPC verifies all of the following again inside the transaction:

- `auth.uid()` equals the explicitly bootstrapped owner UID.
- The JWT contains a `session_id` claim.
- That session belongs to the same user in `auth.sessions` and is not expired.
- The account was admitted by the Google-only before-user-created allowlist hook. There is no first-user-wins path.

Common error codes are `bad_request`, `unauthorized`, `forbidden`, `not_found`, `conflict`, `validation_failed`, `import_failed`, and `internal_error`. Optimistic lock failures return HTTP `409` with code `conflict`.

## Owner API Actions

### `settings.get`

Payload: `{}`.

Data:

```json
{
  "ownerUid": "uuid",
  "timezone": "Asia/Seoul",
  "startDate": "2026-09-15",
  "sendTime": "09:00",
  "mailPaused": false,
  "revision": 1
}
```

### `dashboard.get`

Payload: `{}`.

Data:

```json
{
  "today": ReaderDay,
  "tomorrow": ScheduleDay,
  "counts": { "draft": 1, "published": 365, "trash": 0, "queuedMail": 1, "uncertainMail": 0 },
  "settings": {
    "timezone": "Asia/Seoul",
    "startDate": "2026-09-15",
    "sendTime": "09:00",
    "mailPaused": false,
    "revision": 1
  }
}
```

### `settings.update`

Payload:

```json
{
  "expectedRevision": 1,
  "sendTime": "09:00",
  "mailPaused": false
}
```

Changing `sendTime` affects tomorrow and later. It does not rewrite past snapshots and does not pause web availability.

### `lesson.list`

Payload: `{ "state": "draft|published|trash|all", "query": "optional", "limit": 100, "cursor": "optional" }`.

Data: `{ "items": [LessonSummary], "nextCursor": "optional" }`.

`LessonSummary` contains `id`, `legacyId`, `state`, `title`, `category`, `publishedRevision`, `draftRevision`, `updatedAt`, and `scheduledCount`.

### `lesson.get`

Payload: `{ "id": "uuid-or-legacy-id" }`.

Data: `{ "lesson": LessonDetail, "revisions": [RevisionSummary] }`.

`LessonDetail.document` is either structured lesson JSON or Markdown. Raw HTML in Markdown is rejected at write time.
Structured documents preserve the original 365 lesson shape: `id` as a three-digit string, numeric `order`, `track`, `category`, `level`, `week`, `title`, `summary`, `keywords`, `question`, `answer`, `explanation`, `example`, `pitfalls`, `followUps`, `quiz`, `sources`, and `versionNote`. Draft autosave may store incomplete content. Completeness is enforced only by publish/import/restore validation.

### `revision.list`

Payload: `{ "lessonId": "uuid" }`.

Data: `{ "items": [RevisionSummary] }`.

`RevisionSummary` contains `id`, `lessonId`, `revisionNumber`, `title`, `category`, `documentKind`, `contentHash`, `createdAt`, and `createdBy`.

### `revision.get`

Payload: `{ "revisionId": "uuid" }`.

Data: `{ "revision": RevisionDetail }`, including immutable `document`.

### `lesson.create`

Payload:

```json
{
  "legacyId": 366,
  "title": "Synthetic title",
  "category": "Synthetic category",
  "documentKind": "structured",
  "document": {},
  "state": "draft"
}
```

Data: `{ "lesson": LessonDetail }`.

### `lesson.saveDraft`

Payload:

```json
{
  "id": "uuid",
  "expectedRevision": 3,
  "title": "Updated title",
  "category": "Updated category",
  "documentKind": "markdown",
  "document": { "markdown": "No raw HTML" }
}
```

Drafts are independent from the published revision and may be incomplete. The server freezes elapsed day snapshots before mutating published content. Markdown raw HTML is rejected outside fenced code blocks; code examples such as Java generics or SQL comparisons inside fences are allowed because renderers escape executable HTML.

### `lesson.publish`

Payload: `{ "id": "uuid", "expectedRevision": 4 }`.

Publishes the current draft as a new immutable revision. The lesson joins the active published cycle after existing queued content unless schedule overrides place it elsewhere.

### `lesson.unpublish`

Payload: `{ "id": "uuid", "expectedRevision": 5 }`.

Moves a lesson from `published` to `draft` for future scheduling only. Historical snapshots remain immutable.

### `lesson.restoreRevision`

Payload: `{ "id": "uuid", "revisionId": "uuid", "expectedRevision": 5 }`.

Creates a new draft from an immutable revision. It does not rewrite historical snapshots.

### `lesson.moveToTrash`

Payload: `{ "id": "uuid", "expectedRevision": 6 }`.

Moves the lesson to trash and removes future generated queue rows. Historical snapshots keep their embedded immutable content.

### `lesson.restoreTrash`

Payload: `{ "id": "uuid", "expectedRevision": 7 }`.

Moves a trashed lesson back to `draft`.

### `lesson.duplicate`

Payload: `{ "id": "uuid", "title": "Copy title" }`.

Creates a draft copy with a new UUID and no legacy ID unless explicitly supplied later by import.

### `lesson.bulkUpdateState`

Payload:

```json
{
  "items": [
    { "id": "uuid", "expectedRevision": 3 }
  ],
  "state": "draft|trash"
}
```

Data: `{ "updated": [{ "id": "uuid", "revision": 4 }] }`.

### `lesson.purge`

Payload: `{ "id": "uuid", "expectedRevision": 7 }`.

Hard-deletes the lesson row when no historical snapshot references it. If historical snapshots reference it, the server tombstones the editable catalog row: owner list/get/edit no longer expose it, future scheduling ignores it, unreferenced draft/revision data is cleared, and snapshot-referenced immutable revisions remain only for historical integrity. Data includes `retainedHistory` to tell the UI whether a tombstone was retained.

### `schedule.get`

Payload: `{ "from": "2026-09-15", "days": 31 }`.

Data: `{ "days": [ScheduleDay] }`, where each day contains `date`, `status`, `lessonId`, `legacyId`, `snapshotId`, `title`, `category`, `sendEligibleAt`, and optional `overrideReason`.

### `reader.today`

Payload: `{ "date": "optional YYYY-MM-DD", "lessonId": "optional uuid" }`.

Data: `{ "day": ReaderDay }`. With `lessonId`, it returns the private published library copy for that lesson without freezing a date snapshot.

### `reader.lesson`

Payload: `{ "id": "uuid or legacy id" }`.

Data: `{ "lesson": ReaderLesson }`, resolved from the published immutable revision only. Draft fields are not exposed through reader actions.

### `reader.snapshot`

Payload: `{ "snapshotId": "uuid" }`.

Data: `{ "day": ReaderDay }`, resolved from an immutable normal or manual snapshot including `date`, `kind`, `documentKind`, `document`, `contentHash`, and lesson metadata.

### `reader.history`

Payload: `{ "from": "2026-09-15", "to": "2026-10-15", "category": "optional" }`.

Data: `{ "days": [ReaderDay] }`.

### `reader.search`

Payload: `{ "query": "string", "limit": 50, "cursor": "optional" }`.

Data: `{ "items": [ReaderSearchResult], "nextCursor": "optional" }`.

Reader actions are private owner-auth actions. There is no public content endpoint, public content table, or published snapshot view.

### `schedule.setOverride`

Payload:

```json
{
  "date": "2026-09-16",
  "lessonId": "uuid",
  "mode": "lesson|empty|auto",
  "expectedScheduleRevision": 10
}
```

Overrides only tomorrow or later. Past days are frozen before the change. `empty` intentionally leaves the web day and mail queue empty.

### `schedule.rebuildFuture`

Payload: `{ "from": "2026-09-15", "expectedScheduleRevision": 10 }`.

Recomputes future queue rows from active published lessons, preserving frozen snapshots and explicit overrides.

### `import.preview`

Payload: `{ "lessons": [SyntheticImportLesson] }`.

Validates a full import in a transaction and returns counts, conflicts, and hashes without writing.

### `import.commit`

Payload: `{ "expectedExportHash": "sha256", "lessons": [SyntheticImportLesson] }`.

All validation happens before the transaction mutates data. On any error, nothing is written.

### `export.create`

Payload: `{ "includeTrash": false }`.

Data contains a JSON export envelope with schema version, settings, lessons, revisions, schedule overrides, and SHA-256 hash. Export-only machine credentials can call only the backup endpoint, not this owner action.

### `backup.restore`

Payload: `{ "expectedExportHash": "sha256", "export": ExportEnvelope }`.

Restores from a validated export in one transaction. On any error, nothing is written.

### `mail.status`

Payload: `{ "from": "2026-09-15", "days": 14 }`.

Data: `{ "items": [MailStatus] }`, including `id`, `date`, `state`, `snapshotId`, `scheduledFor`, `claimedUntil`, `sentAt`, and safe `lastError`.

### `mail.enqueueTest`

Payload: `{ "date": "2026-09-15", "commandId": "uuid" }`.

Creates a manual test message from the immutable snapshot for that day. `commandId` is unique so retries are idempotent.

### `mail.retryUncertain`

Payload:

```json
{
  "messageId": "uuid",
  "expectedState": "uncertain",
  "commandId": "uuid",
  "mailboxChecked": true
}
```

Creates a new `resend` mail job linked to the uncertain original after explicit owner mailbox confirmation. The original row remains `uncertain` for audit. The new `commandId` is unique and is not blocked by the ordinary daily date guard; the daily date guard applies only to `daily` jobs, not `test` or `resend`.

## Reader Data Is Private

All content, including published/today/history/category/search, is owner-auth private. The reader UI calls `owner-api` actions after login. The frontend must not expose lesson metadata, content, categories, search indexes, schedule snapshots, drafts, trash, or owner data to anonymous users.

## Mail Machine API

Apps Script calls `/functions/v1/mail-api` with headers:

- `X-Daily-CS-Mail-Key: <mail endpoint key>`
- `Content-Type: application/json`

Body shape is the same action envelope:

```json
{ "action": "mail.claimDue", "payload": { "workerId": "gas-project-id", "commandId": "uuid" } }
```

Mail keys are hashed in the database and scoped to `mail`. They cannot call owner CRUD, import/export, or backup operations.

### `mail.claimDue`

Claims at most one due row whose state is `queued` or whose `claimed` lease expired before `sending`. Eligibility is scheduled date/time plus one hour, Asia/Seoul. There is no backlog catch-up.

Data:

```json
{
  "message": {
    "id": "uuid",
    "kind": "daily",
    "commandId": "uuid",
    "date": "2026-09-15",
    "subject": "Daily CS",
    "text": "plain text",
    "html": "<p>sanitized</p>",
    "snapshotId": "uuid",
    "claimToken": "opaque"
  }
}
```

If nothing is due, data is `{ "message": null }`.

Regular `daily` mail runs Monday through Friday by `scheduled_date` in Asia/Seoul. Weekend regular mail is excluded at preparation and claim, and rejected with `conflict` at materialization, claim recovery, and send start. Existing same-date and one-hour send windows still apply, so Monday does not send weekend backlog. Web snapshots remain daily; explicit `test` and `resend` jobs, sent ACKs, and uncertainty reconciliation retain their existing behavior.

Recipient address remains a private Apps Script property. The mail endpoint does not return it.

State transition: `queued -> claimed`, with a ten-minute lease. Expired claims can return to `queued`. `sending` is never automatically retried.

### `mail.preflight`

Payload: `{ "workerId": "gas-project-id" }`.

Data: `{ "status": "mail-preflight-ok" }`. This validates the scoped mail credential without claiming or sending mail.

### `mail.resumeClaim`

Payload: `{ "messageId": "uuid", "claimToken": "opaque", "commandId": "optional uuid" }`.

Returns the currently claimed or sending message body for a known current claim without claiming a new row. Apps Script stores only metadata locally and calls this after a restart to recover the immutable body. Expired claimed rows are released back to `queued` and return `{ "message": null, "status": "expired" }`; `sent` returns `{ "state": "sent" }`; `uncertain` returns `conflict` for owner reconciliation.

### `mail.reconcileLegacyGuard`

Payload:

```json
{
  "legacyStatus": "sent|sending|uncertain",
  "messageId": "optional uuid",
  "commandId": "optional uuid",
  "kind": "daily",
  "date": "optional YYYY-MM-DD",
  "providerMessageId": "optional",
  "reason": "optional safe short text"
}
```

Reconciles durable Apps Script legacy state without claiming or generating mail. Lookup uses `messageId`, then `commandId`, then daily `date`. `sent` marks the matched row sent; `sending` and `uncertain` mark a non-sent row uncertain for owner confirmation; an already sent row stays sent; no match returns `{ "state": "missing" }`.

### `mail.beginSending`

Payload: `{ "messageId": "uuid", "claimToken": "opaque", "commandId": "optional uuid" }`.

The server validates the current lease and transitions `claimed -> sending`. Repeating the call with the same command ID is idempotent. Apps Script must call this and receive ACK before `MailApp.sendEmail`.

### `mail.ackSent`

Payload: `{ "messageId": "uuid", "claimToken": "opaque", "providerMessageId": "optional" }`.

State transition: `sending -> sent`. It also reconciles `uncertain -> sent` when Apps Script already sent the email and still has the same original claim token. This is idempotent for the same message and claim token.

### `mail.markUncertain`

Payload: `{ "messageId": "uuid", "claimToken": "opaque", "reason": "safe short text" }`.

State transition: `sending -> uncertain`. `uncertain` rows never auto-resend; the only automatic reconciliation is `mail.ackSent` with the same original claim token after Apps Script confirms the email was already sent.

## Backup Machine API

Backup jobs call `/functions/v1/backup-api` with `X-Daily-CS-Backup-Key`. Backup keys are scoped to `backup_export` and can only request immutable export envelopes. They cannot mail or mutate owner data.

Action: `backup.export`, payload `{}`. Data is `{ "export": ExportEnvelope }`.
