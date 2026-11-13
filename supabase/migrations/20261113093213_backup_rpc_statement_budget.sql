-- Allow the measured full backup export to finish within its private client deadline.
alter function public.daily_cs_backup_api(text, jsonb, text)
  set statement_timeout = '60s';

notify pgrst, 'reload schema';
