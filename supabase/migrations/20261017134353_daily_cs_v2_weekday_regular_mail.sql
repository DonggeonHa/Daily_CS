-- Scheduled dates already use Asia/Seoul. Keep daily web snapshots unchanged.
create function daily_cs_private.is_mail_weekday(scheduled_day date)
returns boolean language sql immutable strict parallel safe set search_path = '' as $$
  select extract(isodow from scheduled_day) between 1 and 5
$$;
revoke all on function daily_cs_private.is_mail_weekday(date)
from public, anon, authenticated, service_role;

-- Patch only the existing daily-mail predicates. All other state transitions,
-- manual test/resend paths, ACK recovery, privileges and function attributes stay intact.
do $migration$
declare
  patch record;
  definition text;
  occurrences integer;
begin
  for patch in select * from (values
    ('daily_cs_private.ensure_mail_due()',
      $anchor$where s.singleton and not s.mail_paused and d.snapshot_date=today and d.document is not null$anchor$,
      $replacement$where s.singleton and not s.mail_paused and d.snapshot_date=today and d.document is not null
    and daily_cs_private.is_mail_weekday(d.snapshot_date)$replacement$, 1),
    ('daily_cs_private.mail_schedule_api(text,jsonb)',
      $anchor$and (req.kind<>'daily' or (req.scheduled_date=(daily_cs_private.schedule_now() at time zone 'Asia/Seoul')::date$anchor$,
      $replacement$and (req.kind<>'daily' or (daily_cs_private.is_mail_weekday(req.scheduled_date)
        and req.scheduled_date=(daily_cs_private.schedule_now() at time zone 'Asia/Seoul')::date$replacement$, 1),
    ('daily_cs_private.mail_schedule_api(text,jsonb)',
      $anchor$  if c.snapshot_id is not null then$anchor$,
      $replacement$  if c.kind='daily' and not daily_cs_private.is_mail_weekday(c.scheduled_date) then
    return daily_cs_private.api_error('conflict','daily mail is limited to Monday through Friday');
  end if;
  if c.snapshot_id is not null then$replacement$, 1),
    ('public.daily_cs_mail_api(text,jsonb,text)',
      $anchor$          scheduled_date = (daily_cs_private.mail_now() at time zone 'Asia/Seoul')::date$anchor$,
      $replacement$          daily_cs_private.is_mail_weekday(scheduled_date)
          and scheduled_date = (daily_cs_private.mail_now() at time zone 'Asia/Seoul')::date$replacement$, 1),
    ('public.daily_cs_mail_api(text,jsonb,text)',
      $anchor$        message_row.scheduled_date <> (daily_cs_private.mail_now() at time zone 'Asia/Seoul')::date$anchor$,
      $replacement$        not daily_cs_private.is_mail_weekday(message_row.scheduled_date)
        or message_row.scheduled_date <> (daily_cs_private.mail_now() at time zone 'Asia/Seoul')::date$replacement$, 2)
  ) as patches(signature, anchor, replacement, expected)
  loop
    definition := pg_catalog.pg_get_functiondef(patch.signature::regprocedure);
    occurrences := (length(definition)-length(replace(definition,patch.anchor,'')))/length(patch.anchor);
    if occurrences is distinct from patch.expected then
      raise exception 'Weekday mail migration expected % matching guard(s) in %, found %',
        patch.expected,patch.signature,occurrences;
    end if;
    execute replace(definition,patch.anchor,patch.replacement);
  end loop;
end $migration$;
