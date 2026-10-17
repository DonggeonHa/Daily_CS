begin;
do $test$
declare
  run_id text := floor(extract(epoch from clock_timestamp()) * 1000000)::bigint::text;
  token text := 'synthetic-report-key-' || gen_random_uuid()::text;
  report jsonb;
  response jsonb;
begin
  insert into daily_cs_private.api_credentials(scope,token_hash,label)
  values('backup_export',daily_cs_private.sha256_text(token),'synthetic report test');
  report := jsonb_build_object('runId',run_id,'status','success','contentHash',repeat('a',64),'commitSha',repeat('b',40));
  response := public.daily_cs_backup_api('backup.report',report,token);
  if response #>> '{data,recorded}' is distinct from 'true' then raise exception 'success report failed'; end if;
  response := public.daily_cs_backup_api('backup.report',jsonb_build_object('runId',run_id,'status','failure','errorCode','workflow_failed'),token);
  if response #>> '{data,recorded}' is distinct from 'true' then raise exception 'failure retry failed'; end if;
  response := public.daily_cs_backup_api('backup.report',report,token);
  if response #>> '{data,recorded}' is distinct from 'true' then raise exception 'same success retry failed'; end if;
  if not exists(select 1 from daily_cs_private.backup_runs b where b.run_id=report->>'runId'
    and b.status='success' and b.content_hash=repeat('a',64) and b.commit_sha=repeat('b',40) and b.error_code is null) then
    raise exception 'success must remain terminal with its original hash and commit';
  end if;
  response := public.daily_cs_backup_api('backup.report',jsonb_set(report,'{contentHash}',to_jsonb(repeat('c',64))),token);
  if response #>> '{error,code}' is distinct from 'conflict' then raise exception 'conflicting success must be rejected'; end if;
  response := public.daily_cs_backup_api('backup.report',report || '{"document":"must not persist"}'::jsonb,token);
  if response #>> '{error,code}' is distinct from 'validation_failed' then raise exception 'report must reject arbitrary content'; end if;
  response := public.daily_cs_backup_api('backup.report','[]'::jsonb,token);
  if response #>> '{error,code}' is distinct from 'validation_failed' then raise exception 'report must reject non-object input'; end if;
  response := public.daily_cs_backup_api('backup.report',report,'invalid-credential');
  if response #>> '{error,code}' is distinct from 'forbidden' then raise exception 'report must require scoped credentials'; end if;
  if has_table_privilege('anon','daily_cs_private.backup_runs','SELECT')
    or has_table_privilege('authenticated','daily_cs_private.backup_runs','SELECT') then
    raise exception 'backup reports must not be directly readable';
  end if;
end $test$;
rollback;
