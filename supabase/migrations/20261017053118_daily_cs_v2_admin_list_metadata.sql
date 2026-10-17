do $migration$
declare
  api_definition text := pg_catalog.pg_get_functiondef('public.daily_cs_owner_api(text,jsonb)'::regprocedure);
  list_start integer;
  list_end integer;
  list_block text;
  anchor text := $anchor$'category', category,$anchor$;
  metadata text := $metadata$'category', category,
          'level', draft_document ->> 'level',
          'summary', draft_document ->> 'summary',
          'keywords', draft_document -> 'keywords',$metadata$;
begin
  list_start := strpos(api_definition, $branch$  if action = 'lesson.list' then$branch$);
  if list_start = 0 then
    raise exception 'Expected lesson.list branch was not found';
  end if;
  list_end := strpos(substr(api_definition, list_start), E'\n  end if;');
  if list_end = 0 then
    raise exception 'Expected lesson.list branch terminator was not found';
  end if;
  list_block := substr(api_definition, list_start, list_end - 1);
  if (length(list_block) - length(replace(list_block, anchor, ''))) / length(anchor) <> 1
     or strpos(list_block, 'draft_document') > 0 then
    raise exception 'Expected unique lesson.list metadata anchor was not found';
  end if;
  execute overlay(api_definition placing replace(list_block, anchor, metadata)
    from list_start for length(list_block));
end
$migration$;
