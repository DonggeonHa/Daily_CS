# Daily_CS v2 Operations

This runbook covers local tooling that is safe to prepare before external activation. Do not paste Supabase, Google, owner email, or real lesson contents into source files or logs.

## Apps Script sender

Managed source lives at `apps-script/src/mail-sender.gs`. Build the pasteable Apps Script artifact from the clean project root with:

```bash
node scripts/build-mail-apps-script.js
```

The build output is `apps-script/dist/Code.gs`.

Required Apps Script properties:

- `DAILY_CS_MAIL_API_URL`: `https://<project-ref>.supabase.co/functions/v1/mail-api`
- `DAILY_CS_MAIL_API_KEY`: mail-only machine key for the mail API
- `RECIPIENT_EMAIL`: private single recipient address

Activation sequence:

1. Paste the generated `Code.gs` into the existing Google Apps Script project.
2. Set the required script properties in Apps Script UI.
3. Run `preflightDailyCsV2Mail`.
4. Run `testDailyCsV2Api`.
5. Run `dryRunDailyCsV2Migration` and confirm it lists only known Daily_CS handlers.
6. After root coordinates backend readiness, run `installDailyCsV2Poller`.

`installDailyCsV2Poller` deletes only known Daily_CS handlers: `sendDailyEmail`, `verificationTriggerHandler`, and `dailyCsV2Poller`. It does not touch unrelated project triggers. The new poller runs every five minutes.

The sender never auto-resends an uncertain local `sending` state. Regular `daily` commands are keyed by date (`daily_YYYY-MM-DD`) for one-send-per-day behavior. `test` and `resend` commands are keyed by UUID. If a daily command is uncertain, the old local state stays preserved; backend must create a new explicit `resend` command after owner mailbox confirmation.

Regular mail is eligible only Monday through Friday by its scheduled Asia/Seoul date. Saturday and Sunday requests, queued rows, and existing claims cannot reach sending; Monday processes only Monday's regular mail, without a weekend backlog. The daily web learning calendar and immutable snapshots continue every day. Explicit owner test/resend jobs and ACK or uncertainty recovery remain available on weekends. Keep the five-minute poller running for those operations.

The additive weekday migration changes no existing delivery rows or snapshots. Verify with `tests/weekday-mail.sql` against a fully migrated database; it uses synthetic 2038 dates, transaction-local clocks, and `ROLLBACK`. For a pre-deployment check, place the new migration inside the same outer transaction before that test and remove the test's nested `begin;`. Never apply the test fixture as a migration.

Compatibility guard: before sending a regular daily command, GAS checks the legacy `MAIL_STATE_YYYY_MM_DD` property used by `apps-script/mail-system.js`. Legacy `sent` fails closed with no MailApp call and asks backend to reconcile the claimed command as already handled. Legacy `sending` also fails closed with no `mail.beginSending` and no MailApp call so root can manually confirm the mailbox. This preserves old activation state during migration.

Apps Script Properties quotas are part of the design: Google's current Apps Script quotas list Properties value size as 9 KB per value and total Properties storage as 500 KB per property store. GAS therefore never stores email `subject`, `text`, or `html` in Script Properties. Local state stores only small metadata: message id, command id, kind, date, claim token, status/timestamps, and a compact body hash. ACKed history is capped at 90 records, while unresolved local records use a small pending index and are never silently dropped; if unresolved capacity is exceeded, GAS fails before `mail.beginSending` or `MailApp.sendEmail`.

## Mail API contract expected by GAS

All GAS mail calls are `POST /functions/v1/mail-api` with JSON:

```json
{ "action": "name", "payload": {} }
```

GAS sends the scoped mail key only in `X-Daily-CS-Mail-Key`. Begin, ACK, and uncertain-marker calls also send `Idempotency-Key` and the same value in `payload.idempotencyKey`.

Expected response shape:

```json
{ "data": {} }
```

or:

```json
{ "error": { "code": "conflict", "message": "human readable" } }
```

Mail actions used by GAS:

- `mail.preflight`
- `mail.claimDue`
- `mail.beginSending`
- `mail.ackSent`
- `mail.markUncertain`
- `mail.resumeClaim`
- `mail.reconcileLegacyGuard`

`mail.claimDue` returns `{ "message": null }` when idle, or:

```json
{
  "message": {
    "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "kind": "daily",
    "commandId": "11111111-1111-4111-8111-111111111111",
    "date": "2026-09-15",
    "subject": "[매일매일 CS] 2026-09-15 - title",
    "text": "plain text email",
    "html": "<p>email html</p>",
    "claimToken": "opaque",
    "senderName": "매일매일 CS"
  }
}
```

Valid message kinds are `daily`, `test`, and `resend`. Backend owns due-date rules, no-backlog behavior, render validation, and claim expiry. GAS validates UTF-8 byte size before `mail.beginSending` and enforces a 200 KB limit for both text and HTML bodies. GAS records a compact local `claimed` state before any irreversible transition, checks legacy daily state, checks quota, calls `mail.beginSending` with `messageId` and `claimToken`, records local `sending`, calls `MailApp.sendEmail`, records local `sent`, then calls `mail.ackSent`. ACK-only recovery runs before quota checks because it does not need MailApp quota.

Backend contract requested for activation:

- `mail.resumeClaim` accepts `{ messageId, claimToken, commandId, kind, date, bodyHash, checkedAt, idempotencyKey }`. It returns the immutable claimed `message` payload when the claim is still valid and no irreversible send has begun. If the pre-begin claim expired or is no longer recoverable, it returns `{ "message": null, "status": "expired" }` so GAS can remove the stale compact `claimed` state and continue polling without blocking forever. It must not create a resend.
- `mail.reconcileLegacyGuard` accepts `{ messageId, claimToken, commandId, date, legacyStatus, checkedAt, idempotencyKey }`. `legacyStatus: "sent"` means old GAS already marked the date sent, so backend should mark the claimed command as reconciled/skipped without sending. `legacyStatus: "sending"` means old GAS had an uncertain local send, so backend should move the command to owner/manual confirmation and must not ask GAS to send automatically.
- `mail.ackSent` should accept ACK-only recovery for a durable local `sent` state with the same valid `claimToken`, including when backend aged the remote row to an uncertain/manual state. If backend returns terminal `409 conflict`, GAS records `remoteAckConflictAt` with the claim metadata and stops retrying that ACK every poll; backend/root must reconcile manually.

## Backup and Owner API tooling

Backup export uses `POST /functions/v1/backup-api` with JSON:

```json
{ "action": "name", "payload": {} }
```

The backup script sends the scoped backup key only in `X-Daily-CS-Backup-Key`. It calls only `backup.export`.

Import and restore commit tooling uses `POST /functions/v1/owner-api` with owner auth:

```json
{ "action": "import.commit", "payload": {} }
```

Owner calls send `Authorization: Bearer <Supabase access token>`. They call:

- `import.preview`
- `import.commit`
- `backup.restore`

Import and restore do not mutate unless the CLI is called with `--commit`. Without `--commit`, restore performs a local envelope preview only; import preview sends the source lessons to the owner API for server validation. Import commit first runs `import.preview` and then sends `import.commit` with the server-returned hash for the exact same 365-lesson payload; the client does not try to reproduce the database `jsonb` hash locally.

The import payload contains 365 structured lesson documents derived from the private archive with a numeric `legacyId`, original `order`, all original structured lesson fields, and source citations preserved. Local import evidence must be written only under ignored `.omo/v2-evidence/import/` and must contain counts, hashes, byte sizes, and field/source summaries only, not lesson bodies.

Current Supabase Edge limits document 256 MB memory, 2 seconds CPU per request, and a 150 second Free-plan wall-clock limit. The 365-lesson import body must be measured before activation. If it grows beyond the client body guard or the function cannot validate and commit within one transaction, do not split the client into multiple mutating chunks; add a backend-owned staging/import-finalize contract that validates chunk hashes first and performs the final write transaction atomically.

## Private backup workflow

`.github/workflows/private-backup.yml` is intended for the private `Daily_CS-archive` repository. It needs:

- repository secret `DAILY_CS_BACKUP_API_URL`
- repository secret `DAILY_CS_BACKUP_API_KEY`
- default `GITHUB_TOKEN` with contents write permission

It runs nightly at 02:20 KST and on manual dispatch only when the repository is private. It writes `private-backups/latest.json` plus a date-stamped copy only when the exported hash changes.

The workflow logs only status lines and the export hash. It is guarded with `github.event.repository.private == true` and must run only in the private archive repository. The backup API key is scoped to `backup.export`; it cannot import, restore, mail, or edit owner content.

## Local commands

## Migration history

Hosted project `gdraufrjlmzhnegrrjhj` has these applied database migration versions:

- `20260914142658` -> `20260914142658_daily_cs_v2_owner_api.sql`
- `20260914144242` -> `20260914144242_daily_cs_v2_data_import_export_restore.sql`
- `20260914144315` -> `20260914144315_daily_cs_v2_schedule_snapshots.sql`
- `20260914145231` -> `20260914145231_daily_cs_v2_schedule_state_export_restore.sql`
- `20260914151041` -> `20260914151041_daily_cs_v2_tombstone_purge.sql`
- `20260921224340` -> `20260921224340_owner_hook_repair.sql`
- `20261005104134` -> `20261005104134_import_revision_guard.sql`
- `20261007125106` -> `20261007125106_daily_mail_command_id.sql`
- `20261017053118` -> `20261017053118_daily_cs_v2_admin_list_metadata.sql`

Migration history is applied through `20261017053118`, including tombstone purge, the import revision guard, daily mail command IDs, and admin list metadata. Applied migration files remain immutable; future database changes use new additive migrations.

Build GAS:

```bash
node scripts/build-mail-apps-script.js
```

Print migration checklist:

```bash
node scripts/migrate-mail-gas.js
```

Export backup:

```bash
node scripts/export-backup.js --output private-backups/latest.json
```

Preview backup restore:

```bash
node scripts/restore-backup-preview.js --input private-backups/latest.json --output restore-preview.json
```

Commit backup restore with owner auth:

```bash
node scripts/restore-backup-preview.js --input private-backups/latest.json --commit
```

Preview legacy lesson import without copying full private content into the clean tree:

```bash
node scripts/import-lessons-preview.js --source <private-archive>/content/lessons
```

Write ignored hash/count evidence for the legacy import:

```bash
node scripts/import-lessons-preview.js --source <private-archive>/content/lessons --evidence-output ../v2-evidence/import/initial-import-summary.json --evidence-only
```

Commit legacy lesson import with owner auth:

```bash
node scripts/import-lessons-preview.js --source <private-archive>/content/lessons --commit
```
