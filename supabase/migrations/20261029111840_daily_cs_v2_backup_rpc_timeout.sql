-- Full private exports exceed the inherited 8s timeout as visual assets grow.
alter function public.daily_cs_backup_api(text, jsonb, text)
  set statement_timeout = '30s';

notify pgrst, 'reload schema';
