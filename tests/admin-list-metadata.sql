do $test$
declare
  owner_id uuid;
  session_id uuid;
  result jsonb;
  items jsonb;
begin
  select owner_uid into strict owner_id from daily_cs_private.owner_profile where singleton;
  select id into session_id from auth.sessions
  where user_id = owner_id and (not_after is null or not_after > now())
  order by created_at desc limit 1;
  if session_id is null then
    raise exception 'An active owner session is required for this transactional API test';
  end if;
  perform set_config('request.jwt.claim.sub', owner_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', owner_id, 'session_id', session_id, 'role', 'authenticated')::text, true);
  result := public.daily_cs_owner_api('lesson.list', '{"state":"all"}'::jsonb);
  if result ? 'error' then raise exception 'Owner list API rejected the active owner'; end if;
  items := result #> '{data,items}';
  if items is null or jsonb_array_length(items) <> (select count(*) from daily_cs_private.lessons where owner_uid = owner_id) then
    raise exception 'List summary must include the complete owner catalog';
  end if;
  if exists (
    select 1 from jsonb_array_elements(items) item
    join daily_cs_private.lessons l on l.id::text = item ->> 'id'
    where not (item ?& array['level', 'summary', 'keywords'])
      or (item ->> 'level') is distinct from (l.draft_document ->> 'level')
      or (item ->> 'summary') is distinct from (l.draft_document ->> 'summary')
      or (item -> 'keywords') is distinct from coalesce(l.draft_document -> 'keywords', 'null'::jsonb)
      or item ?| array['document', 'draftDocument', 'draft_document']
  ) then
    raise exception 'List metadata differs from the draft or exposes the full document';
  end if;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '{}', true);
  result := public.daily_cs_owner_api('lesson.list', '{"state":"all"}'::jsonb);
  if result #>> '{error,code}' is distinct from 'forbidden' then
    raise exception 'Anonymous list access must remain forbidden';
  end if;
end
$test$;
