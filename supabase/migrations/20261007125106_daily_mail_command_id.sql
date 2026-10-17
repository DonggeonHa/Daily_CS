update daily_cs_private.mail_outbox
set command_id = id
where command_id is null;

create or replace function daily_cs_private.ensure_mail_outbox_command_id()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.command_id is null then
    new.command_id := new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists ensure_mail_outbox_command_id on daily_cs_private.mail_outbox;
create trigger ensure_mail_outbox_command_id
before insert or update of command_id on daily_cs_private.mail_outbox
for each row execute function daily_cs_private.ensure_mail_outbox_command_id();

alter table daily_cs_private.mail_outbox
  alter column command_id set not null;

revoke all on function daily_cs_private.ensure_mail_outbox_command_id()
from public, anon, authenticated, service_role;
