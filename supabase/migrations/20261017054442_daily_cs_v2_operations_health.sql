create table daily_cs_private.backup_runs (
  run_id text primary key check (run_id ~ '^[0-9]{1,30}$'),
  status text not null check (status in ('success', 'failure')),
  content_hash text check (content_hash ~ '^[0-9a-f]{64}$'),
  commit_sha text check (commit_sha ~ '^[0-9a-f]{40}$'),
  error_code text check (error_code = 'workflow_failed'),
  reported_at timestamptz not null default now(),
  check ((status = 'success' and content_hash is not null and commit_sha is not null and error_code is null)
    or (status = 'failure' and content_hash is null and commit_sha is null and error_code is not null))
);
alter table daily_cs_private.backup_runs enable row level security;
revoke all on daily_cs_private.backup_runs from public, anon, authenticated, service_role;

create function daily_cs_private.operations_health()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform daily_cs_private.require_active_owner();
  return jsonb_build_object(
    'mailLastSeenAt', (select max(last_used_at) from daily_cs_private.api_credentials where scope = 'mail' and enabled),
    'backupLatest', (select jsonb_build_object('runId',run_id,'status',status,'reportedAt',reported_at,
      'contentHash',content_hash,'commitSha',commit_sha,'errorCode',error_code)
      from daily_cs_private.backup_runs order by reported_at desc, run_id desc limit 1),
    'backupLastSuccessAt', (select max(reported_at) from daily_cs_private.backup_runs where status = 'success'),
    'backupLastFailureAt', (select max(reported_at) from daily_cs_private.backup_runs where status = 'failure')
  );
end $$;
revoke all on function daily_cs_private.operations_health() from public, anon, authenticated;
grant execute on function daily_cs_private.operations_health() to authenticated;

create or replace function public.daily_cs_backup_api(action text, payload jsonb, token text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare credential_id uuid; envelope jsonb;
begin
  select id into credential_id from daily_cs_private.api_credentials
  where scope = 'backup_export' and enabled and token_hash = daily_cs_private.sha256_text(token);
  if credential_id is null then
    return daily_cs_private.api_error('forbidden', 'valid backup credential required');
  end if;
  if action = 'backup.report' then
    if jsonb_typeof(payload) is distinct from 'object' then
      return daily_cs_private.api_error('validation_failed', 'invalid backup report');
    end if;
    if coalesce(payload->>'runId','') !~ '^[0-9]{1,30}$'
      or coalesce(payload->>'status','') not in ('success','failure')
      or exists(select 1 from jsonb_object_keys(payload) as fields(key) where key not in ('runId','status','contentHash','commitSha','errorCode')) then
      return daily_cs_private.api_error('validation_failed', 'invalid backup report');
    end if;
    if (payload->>'status' = 'success' and (
        coalesce(payload->>'contentHash','') !~ '^[0-9a-f]{64}$'
        or coalesce(payload->>'commitSha','') !~ '^[0-9a-f]{40}$' or payload ? 'errorCode'))
      or (payload->>'status' = 'failure' and (
        payload->>'errorCode' is distinct from 'workflow_failed' or payload ? 'contentHash' or payload ? 'commitSha')) then
      return daily_cs_private.api_error('validation_failed', 'invalid backup report');
    end if;
    insert into daily_cs_private.backup_runs(run_id,status,content_hash,commit_sha,error_code)
    values(payload->>'runId',payload->>'status',payload->>'contentHash',payload->>'commitSha',payload->>'errorCode')
    on conflict(run_id) do update set status=excluded.status,content_hash=excluded.content_hash,
      commit_sha=excluded.commit_sha,error_code=excluded.error_code,reported_at=now()
    where backup_runs.status <> 'success';
    if payload->>'status' = 'success' and exists(select 1 from daily_cs_private.backup_runs
      where run_id=payload->>'runId' and (content_hash is distinct from payload->>'contentHash'
        or commit_sha is distinct from payload->>'commitSha')) then
      return daily_cs_private.api_error('conflict', 'backup success is already recorded with different metadata');
    end if;
    update daily_cs_private.api_credentials set last_used_at=now() where id=credential_id;
    return daily_cs_private.api_ok(jsonb_build_object('recorded',true));
  end if;
  if action is distinct from 'backup.export' then
    return daily_cs_private.api_error('bad_request', 'unknown backup action');
  end if;
  update daily_cs_private.api_credentials set last_used_at=now() where id=credential_id;
  envelope := daily_cs_private.export_with_hash(true);
  return daily_cs_private.api_ok(jsonb_build_object('export',envelope));
end $$;
revoke all on function public.daily_cs_backup_api(text,jsonb,text) from public, anon, authenticated;
grant execute on function public.daily_cs_backup_api(text,jsonb,text) to service_role;

do $migration$
declare
  definition text := pg_catalog.pg_get_functiondef('daily_cs_private.owner_schedule_api(text,jsonb)'::regprocedure);
  anchor text := $anchor$'settings',daily_cs_private.schedule_settings(),'counts'$anchor$;
  replacement text := $replacement$'operations',daily_cs_private.operations_health(),
      'settings',daily_cs_private.schedule_settings(),'counts'$replacement$;
begin
  if (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> 1 then
    raise exception 'Expected unique dashboard metadata anchor was not found';
  end if;
  execute replace(definition,anchor,replacement);
end $migration$;
