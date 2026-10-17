-- A restart is deferred until this date is actually frozen at its normal send time.
alter table daily_cs_private.schedule_state add column pending_restart_date date
  check (pending_restart_date is null or
    (isfinite(pending_restart_date) and pending_restart_date > last_frozen_date));

do $migration$
declare patch record; definition text; occurrences integer;
begin
  for patch in select * from (values
    ('daily_cs_private.plan_schedule(date,boolean)',
      $anchor$  while d <= through_date loop$anchor$,
      $replacement$  while d <= through_date loop
    if d=s.pending_restart_date then
      if persist_days then
        delete from daily_cs_private.schedule_queue where cycle=s.cycle and consumed_date is null;
      end if;
      s.cycle := s.cycle+1;
      pending := active_ids;
      if persist_days then
        insert into daily_cs_private.schedule_queue(cycle,lesson_id,position)
        select s.cycle,x.id,x.ordinality from unnest(active_ids) with ordinality x(id,ordinality);
        update daily_cs_private.schedule_state set pending_restart_date=null where singleton;
      end if;
    end if;$replacement$,1),
    ('daily_cs_private.restore_schedule_state(jsonb)',
      $anchor$  select * into restored_state from jsonb_populate_record(null::daily_cs_private.schedule_state,schedule_export->'state');$anchor$,
      $replacement$  select * into restored_state from jsonb_populate_record(null::daily_cs_private.schedule_state,schedule_export->'state');
  if restored_state.pending_restart_date is not null and
    (not isfinite(restored_state.pending_restart_date)
      or restored_state.pending_restart_date<=restored_state.last_frozen_date
      or to_char(restored_state.pending_restart_date,'YYYY-MM-DD') is distinct from
        schedule_export#>>'{state,pending_restart_date}') then
    raise exception using errcode='22023',message='validation_failed: restart must use a future YYYY-MM-DD date';
  end if;$replacement$,1),
    ('daily_cs_private.restore_schedule_state(jsonb)',
      $anchor$update daily_cs_private.schedule_state set cycle=restored_state.cycle,last_frozen_date=restored_state.last_frozen_date where singleton;$anchor$,
      $replacement$update daily_cs_private.schedule_state set cycle=restored_state.cycle,last_frozen_date=restored_state.last_frozen_date,
    pending_restart_date=restored_state.pending_restart_date where singleton;$replacement$,1)
  ) as patches(signature,anchor,replacement,expected)
  loop
    definition := pg_catalog.pg_get_functiondef(patch.signature::regprocedure);
    occurrences := (length(definition)-length(replace(definition,patch.anchor,'')))/length(patch.anchor);
    if occurrences is distinct from patch.expected then
      raise exception 'Deferred restart migration expected % matching guard(s) in %, found %',
        patch.expected,patch.signature,occurrences;
    end if;
    execute replace(definition,patch.anchor,patch.replacement);
  end loop;
end $migration$;
