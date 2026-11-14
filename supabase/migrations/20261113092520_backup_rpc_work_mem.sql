-- Keep full private export intermediates in memory within the backup RPC only.
alter function public.daily_cs_backup_api(text, jsonb, text)
  set work_mem = '64MB';

notify pgrst, 'reload schema';
