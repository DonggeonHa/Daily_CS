-- Requires the synthetic helpers in visual-assets.sql. No persistent fixtures.
do $text$
declare
  visuals jsonb:=pg_temp.visual_fixture(repeat('a',64)); changed jsonb;
  value text; code integer; field text; maximum integer; failures text[]:='{}';
begin
  -- Given a valid self-edge, When its label is blank, Then reject it.
  foreach value in array array['','   ',U&'\00a0\2003\feff'] loop
    changed:=jsonb_set(visuals,'{0,scenarios,0,steps,0,edges}',
      jsonb_build_array(jsonb_build_object('from','box','to','box','label',value)));
    if not pg_temp.visual_rejects(format('select daily_cs_private.validate_visuals(%L::jsonb)',changed)) then
      failures:=array_append(failures,'blank edge label accepted: '||encode(convert_to(value,'UTF8'),'hex'));
    end if;
  end loop;
  -- PostgreSQL jsonb rejects U+0000 before visual validation; cover every other ASCII control and C1 bounds.
  foreach code in array array(select generate_series(1,31) union all select unnest(array[127,133,159])) loop
    foreach field in array array['title','description'] loop
      changed:=jsonb_set(visuals,array['0',field],to_jsonb('before'||chr(code)||'after'));
      if not pg_temp.visual_rejects(format('select daily_cs_private.validate_visuals(%L::jsonb)',changed)) then
        failures:=array_append(failures,'control accepted: '||code||' in '||field);
      end if;
    end loop;
  end loop;
  foreach field in array array['title','description'] loop
    maximum:=case field when 'title' then 120 else 1200 end;
    changed:=jsonb_set(visuals,array['0',field],to_jsonb(repeat('😀',maximum)));
    if pg_temp.visual_rejects(format('select daily_cs_private.validate_visuals(%L::jsonb)',changed)) then
      failures:=array_append(failures,'Unicode code-point boundary rejected in '||field);
    end if;
    changed:=jsonb_set(visuals,array['0',field],to_jsonb(repeat('😀',maximum+1)));
    if not pg_temp.visual_rejects(format('select daily_cs_private.validate_visuals(%L::jsonb)',changed)) then
      failures:=array_append(failures,'oversized Unicode accepted in '||field);
    end if;
    changed:=jsonb_set(visuals,array['0',field],to_jsonb(U&'\00a0\2003\feff'::text));
    if not pg_temp.visual_rejects(format('select daily_cs_private.validate_visuals(%L::jsonb)',changed)) then
      failures:=array_append(failures,'Unicode whitespace accepted in '||field);
    end if;
  end loop;
  foreach value in array array['javascript :alert(1)',U&'data\00a0:text/plain,example',U&'javascript\feff:alert(1)'] loop
    changed:=jsonb_set(visuals,'{0,description}',to_jsonb(value));
    if not pg_temp.visual_rejects(format('select daily_cs_private.validate_visuals(%L::jsonb)',changed)) then
      failures:=array_append(failures,'spaced scheme accepted: '||value);
    end if;
  end loop;
  perform pg_temp.visual_assert(cardinality(failures)=0,array_to_string(failures,'; '));
end $text$;

-- jsonb has no collation. Rebind only the helper's text predicate so the real validator
-- sees both database-default and C collation, then restore the exact function definition.
do $locale$
declare
  original text:=pg_get_functiondef('daily_cs_private.visual_text(jsonb,integer,boolean)'::regprocedure);
  predicate text:='(value #>> ''{}'') !~*';
  whitespace text:=U&'\0009\000a\000b\000c\000d \00a0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200a\2028\2029\202f\205f\3000\feff';
  visuals jsonb:=pg_temp.visual_fixture(repeat('a',64)); changed jsonb;
  locale_name text; scheme text; value text; code integer; failures text[]:='{}';
begin
  perform pg_temp.visual_assert(strpos(original,predicate)>0,'visual text collation test predicate missing');
  foreach locale_name in array array['default','C'] loop
    execute replace(original,predicate,format('(value #>> ''{}'') COLLATE %I !~*',locale_name));
    -- Given every ECMAScript whitespace code point, When placed before the colon, Then reject both schemes.
    foreach scheme in array array['javascript','data'] loop
      for code in 1..length(whitespace) loop
        value:=scheme||substr(whitespace,code,1)||':example';
        changed:=jsonb_set(visuals,'{0,description}',to_jsonb(value));
        if not pg_temp.visual_rejects(format('select daily_cs_private.validate_visuals(%L::jsonb)',changed)) then
          failures:=array_append(failures,locale_name||': scheme accepted U+'||to_hex(ascii(substr(whitespace,code,1)))||' '||scheme);
        end if;
      end loop;
    end loop;
    -- Controls remain invalid independently of the locale's POSIX character classes.
    foreach code in array array(select generate_series(1,31) union all select generate_series(127,159)) loop
      changed:=jsonb_set(visuals,'{0,description}',to_jsonb('before'||chr(code)||'after'));
      if not pg_temp.visual_rejects(format('select daily_cs_private.validate_visuals(%L::jsonb)',changed)) then
        failures:=array_append(failures,locale_name||': control accepted U+'||to_hex(code));
      end if;
    end loop;
    foreach value in array array['Plain explanatory text.','JavaScript examples and data values.',
      U&'data\200b:example',U&'javascript\180e:example',U&'one\00a0two'] loop
      changed:=jsonb_set(visuals,'{0,description}',to_jsonb(value));
      if pg_temp.visual_rejects(format('select daily_cs_private.validate_visuals(%L::jsonb)',changed)) then
        failures:=array_append(failures,locale_name||': safe text rejected '||value);
      end if;
    end loop;
  end loop;
  execute original;
  perform pg_temp.visual_assert(cardinality(failures)=0,array_to_string(failures,'; '));
exception when others then
  execute original;
  raise;
end $locale$;
