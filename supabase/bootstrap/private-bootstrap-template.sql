-- Private operator template. Replace placeholders in Supabase SQL Editor.
-- Do not commit a filled copy. This file intentionally contains no owner email,
-- UID, endpoint key, or lesson content.

begin;

-- Phase 1, before Google sign-in: admit only the verified owner email.
insert into daily_cs_private.owner_allowlist (email_hash, provider)
values (daily_cs_private.normalize_email_hash('<OWNER_EMAIL>'), 'google')
on conflict (email_hash) do update
set provider = excluded.provider;

-- Phase 2, after the owner has signed in and root has verified auth.users.id.
insert into daily_cs_private.owner_profile (singleton, owner_uid, owner_email_hash)
values (true, '<OWNER_AUTH_UID>'::uuid, daily_cs_private.normalize_email_hash('<OWNER_EMAIL>'))
on conflict (singleton) do update
set owner_uid = excluded.owner_uid,
    owner_email_hash = excluded.owner_email_hash,
    revision = daily_cs_private.owner_profile.revision + 1;

-- Machine endpoint credentials. Generate long random values outside SQL and keep
-- only hashes in the database.
insert into daily_cs_private.api_credentials (scope, token_hash, label)
values
  ('mail', daily_cs_private.sha256_text('<MAIL_ENDPOINT_KEY>'), 'gas-mail'),
  ('backup_export', daily_cs_private.sha256_text('<BACKUP_EXPORT_KEY>'), 'github-nightly-backup')
on conflict (token_hash) do nothing;

commit;
