create or replace function public.daily_cs_before_user_created(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  user_email text := event #>> '{user,email}';
  oauth_provider text := coalesce(
    event #>> '{user,app_metadata,provider}',
    event #>> '{user,raw_app_meta_data,provider}'
  );
  hashed_user_email text;
begin
  if user_email is null or oauth_provider is null or lower(oauth_provider) <> 'google' then
    raise exception using errcode = '42501', message = 'forbidden: google owner allowlist required';
  end if;

  hashed_user_email := daily_cs_private.normalize_email_hash(user_email);

  if not exists (
    select 1
    from daily_cs_private.owner_allowlist as allowlist
    where allowlist.email_hash = hashed_user_email
      and allowlist.provider = 'google'
  ) then
    raise exception using errcode = '42501', message = 'forbidden: google owner allowlist required';
  end if;

  update daily_cs_private.owner_allowlist as allowlist
  set consumed_at = coalesce(allowlist.consumed_at, now())
  where allowlist.email_hash = hashed_user_email
    and allowlist.provider = 'google';

  return event;
end;
$$;

revoke all on function public.daily_cs_before_user_created(jsonb) from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'supabase_auth_admin') then
    grant execute on function public.daily_cs_before_user_created(jsonb) to supabase_auth_admin;
  end if;
end $$;

do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end $$;
