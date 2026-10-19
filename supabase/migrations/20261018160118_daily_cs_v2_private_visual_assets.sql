-- Private immutable PNGs. Bytes occur once in exports; snapshots retain hash references.
create table daily_cs_private.visual_assets (
  asset_id text primary key check (asset_id ~ '^[0-9a-f]{64}$'),
  mime_type text not null check (mime_type = 'image/png'),
  width integer not null check (width between 1 and 2048),
  height integer not null check (height between 1 and 2048),
  bytes bytea not null check (octet_length(bytes) between 45 and 262144),
  created_at timestamptz not null default now()
);
alter table daily_cs_private.visual_assets enable row level security;
revoke all on daily_cs_private.visual_assets from public, anon, authenticated, service_role;

create function daily_cs_private.reject_visual_asset_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = '22023', message = 'validation_failed: visual assets are immutable';
end $$;
create trigger immutable_visual_asset before update or delete on daily_cs_private.visual_assets
for each row execute function daily_cs_private.reject_visual_asset_mutation();

create function daily_cs_private.validate_visual_asset(asset jsonb)
returns bytea language plpgsql immutable set search_path = '' as $$
declare decoded bytea; w bigint; h bigint;
begin
  if jsonb_typeof(asset) is distinct from 'object'
    or coalesce(asset->>'assetId','') !~ '^[0-9a-f]{64}$'
    or asset->>'mimeType' is distinct from 'image/png'
    or jsonb_typeof(asset->'width') is distinct from 'number'
    or jsonb_typeof(asset->'height') is distinct from 'number'
    or jsonb_typeof(asset->'base64') is distinct from 'string'
    or length(asset->>'base64') > 349528
    or (asset->>'base64') !~ '^[A-Za-z0-9+/]*={0,2}$'
    or exists(select 1 from jsonb_object_keys(asset) k where k not in ('assetId','mimeType','width','height','base64')) then
    raise exception using errcode = '22023', message = 'validation_failed: invalid visual asset';
  end if;
  decoded := decode(asset->>'base64','base64');
  if octet_length(decoded) not between 45 and 262144
    or replace(encode(decoded,'base64'), E'\n','') is distinct from asset->>'base64'
    or encode(substring(decoded from 1 for 16),'hex') <> '89504e470d0a1a0a0000000d49484452'
    or encode(substring(decoded from octet_length(decoded)-11 for 12),'hex') <> '0000000049454e44ae426082'
    or encode(extensions.digest(decoded,'sha256'),'hex') is distinct from asset->>'assetId' then
    raise exception using errcode = '22023', message = 'validation_failed: PNG bytes or hash are invalid';
  end if;
  w := get_byte(decoded,16)::bigint*16777216 + get_byte(decoded,17)*65536 + get_byte(decoded,18)*256 + get_byte(decoded,19);
  h := get_byte(decoded,20)::bigint*16777216 + get_byte(decoded,21)*65536 + get_byte(decoded,22)*256 + get_byte(decoded,23);
  if w not between 1 and 2048 or h not between 1 and 2048
    or (asset->>'width')::numeric is distinct from w::numeric
    or (asset->>'height')::numeric is distinct from h::numeric then
    raise exception using errcode = '22023', message = 'validation_failed: PNG dimensions are invalid';
  end if;
  return decoded;
end $$;

create function daily_cs_private.check_visual_asset_insert()
returns trigger language plpgsql set search_path = '' as $$
begin
  perform daily_cs_private.validate_visual_asset(jsonb_build_object('assetId',new.asset_id,
    'mimeType',new.mime_type,'width',new.width,'height',new.height,
    'base64',replace(encode(new.bytes,'base64'), E'\n','')));
  return new;
end $$;
create trigger validate_visual_asset before insert on daily_cs_private.visual_assets
for each row execute function daily_cs_private.check_visual_asset_insert();

-- Single-line plain text: Unicode code-point limits; no C0/C1 controls, including tabs/newlines/DEL.
-- Required text excludes ECMAScript whitespace, matching the shared renderer's trim().
create function daily_cs_private.visual_text(value jsonb, maximum integer, allow_empty boolean default false)
returns boolean language sql immutable set search_path = '' as $$
  select jsonb_typeof(value) = 'string' and length(value #>> '{}') <= maximum
    and (allow_empty or length(btrim(value #>> '{}',U&' \00a0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200a\2028\2029\202f\205f\3000\feff')) > 0)
    and (value #>> '{}') !~* U&'</?[a-z][^>]*>|https?://|javascript[[:space:]\feff]*:|data[[:space:]\feff]*:|www\\.|```|[[:cntrl:]]'
$$;
create function daily_cs_private.visual_object(value jsonb, allowed text[], required text[])
returns boolean language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(value) = 'object' then
    value ?& required and not exists(select 1 from jsonb_object_keys(value) k where not(k = any(allowed)))
    else false end
$$;
create function daily_cs_private.validate_visuals(visuals jsonb)
returns void language plpgsql immutable set search_path = '' as $$
declare v jsonb; s jsonb; step jsonb; n jsonb; e jsonb; m jsonb;
  visual_ids text[] := '{}'; scenario_ids text[]; node_ids text[]; selected_steps integer;
begin
  if visuals is null then return; end if;
  if jsonb_typeof(visuals) is distinct from 'array' or jsonb_array_length(visuals)>3 then
    raise exception using errcode='22023',message='validation_failed: visuals must be an array of at most 3';
  end if;
  for v in select value from jsonb_array_elements(visuals) loop
    if not daily_cs_private.visual_object(v,array['version','id','title','description','alt','emailAssetId','emailScenarioId','emailStep','scenarios'],
        array['version','id','title','description','alt','emailAssetId','emailScenarioId','emailStep','scenarios'])
      or v->'version' is distinct from '1'::jsonb or coalesce(v->>'id','') !~ '^[a-z][a-z0-9-]{0,47}$'
      or v->>'id'=any(visual_ids) or jsonb_typeof(v->'emailAssetId') is distinct from 'string'
      or coalesce(v->>'emailAssetId','') !~ '^[0-9a-f]{64}$'
      or not coalesce(daily_cs_private.visual_text(v->'title',120),false)
      or not coalesce(daily_cs_private.visual_text(v->'description',1200),false)
      or not coalesce(daily_cs_private.visual_text(v->'alt',1200),false)
      or jsonb_typeof(v->'emailStep') is distinct from 'number'
      or (v->>'emailStep') !~ '^[0-9]+$'
      or jsonb_typeof(v->'scenarios') is distinct from 'array' then
      raise exception using errcode='22023',message='validation_failed: invalid visual';
    end if;
    if jsonb_array_length(v->'scenarios') not between 1 and 8 then
      raise exception using errcode='22023',message='validation_failed: invalid scenario count';
    end if;
    visual_ids:=array_append(visual_ids,v->>'id'); scenario_ids:='{}'; selected_steps:=null;
    for s in select value from jsonb_array_elements(v->'scenarios') loop
      if not daily_cs_private.visual_object(s,array['id','label','steps'],array['id','label','steps'])
        or coalesce(s->>'id','') !~ '^[a-z][a-z0-9-]{0,47}$' or s->>'id'=any(scenario_ids)
        or not coalesce(daily_cs_private.visual_text(s->'label',120),false)
        or jsonb_typeof(s->'steps') is distinct from 'array' then
        raise exception using errcode='22023',message='validation_failed: invalid visual scenario';
      end if;
      if jsonb_array_length(s->'steps') not between 1 and 12 then
        raise exception using errcode='22023',message='validation_failed: invalid step count';
      end if;
      scenario_ids:=array_append(scenario_ids,s->>'id');
      if s->>'id'=v->>'emailScenarioId' then selected_steps:=jsonb_array_length(s->'steps'); end if;
      for step in select value from jsonb_array_elements(s->'steps') loop
        if not daily_cs_private.visual_object(step,array['title','description','nodes','edges','metrics'],array['title','description','nodes'])
          or not coalesce(daily_cs_private.visual_text(step->'title',120),false)
          or not coalesce(daily_cs_private.visual_text(step->'description',1200),false)
          or jsonb_typeof(step->'nodes') is distinct from 'array'
          or (step ? 'edges' and jsonb_typeof(step->'edges') is distinct from 'array')
          or (step ? 'metrics' and jsonb_typeof(step->'metrics') is distinct from 'array') then
          raise exception using errcode='22023',message='validation_failed: invalid visual step';
        end if;
        if jsonb_array_length(step->'nodes') not between 1 and 12
          or jsonb_array_length(coalesce(step->'edges','[]'))>24 or jsonb_array_length(coalesce(step->'metrics','[]'))>6 then
          raise exception using errcode='22023',message='validation_failed: invalid diagram size';
        end if;
        node_ids:='{}';
        for n in select value from jsonb_array_elements(step->'nodes') loop
          if not daily_cs_private.visual_object(n,array['id','label','detail','tone'],array['id','label','tone'])
            or coalesce(n->>'id','') !~ '^[a-z][a-z0-9-]{0,47}$' or n->>'id'=any(node_ids)
            or not coalesce(daily_cs_private.visual_text(n->'label',120),false)
            or (n ? 'detail' and not coalesce(daily_cs_private.visual_text(n->'detail',600,true),false))
            or coalesce(n->>'tone','') not in ('neutral','active','success','warning','error') then
            raise exception using errcode='22023',message='validation_failed: invalid diagram node';
          end if;
          node_ids:=array_append(node_ids,n->>'id');
        end loop;
        for e in select value from jsonb_array_elements(coalesce(step->'edges','[]')) loop
          if not daily_cs_private.visual_object(e,array['from','to','label'],array['from','to','label'])
            or not coalesce(e->>'from'=any(node_ids),false) or not coalesce(e->>'to'=any(node_ids),false)
            or not coalesce(daily_cs_private.visual_text(e->'label',160),false) then
            raise exception using errcode='22023',message='validation_failed: invalid diagram edge';
          end if;
        end loop;
        for m in select value from jsonb_array_elements(coalesce(step->'metrics','[]')) loop
          if not daily_cs_private.visual_object(m,array['label','value'],array['label','value'])
            or not coalesce(daily_cs_private.visual_text(m->'label',120),false)
            or not coalesce(daily_cs_private.visual_text(m->'value',120),false) then
            raise exception using errcode='22023',message='validation_failed: invalid diagram metric';
          end if;
        end loop;
      end loop;
    end loop;
    if selected_steps is null or (v->>'emailStep')::numeric >= selected_steps then
      raise exception using errcode='22023',message='validation_failed: email frame does not exist';
    end if;
  end loop;
end $$;

alter function daily_cs_private.validate_document(daily_cs_private.document_kind,jsonb) rename to validate_document_before_visuals;
create function daily_cs_private.validate_document(kind daily_cs_private.document_kind, document jsonb)
returns void language plpgsql stable set search_path = '' as $$
begin
  perform daily_cs_private.validate_document_before_visuals(kind,document);
  perform daily_cs_private.validate_visuals(document->'visuals');
end $$;

create function daily_cs_private.visual_refs(document jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('assetId',id,'cid','visual-'||id,'mimeType','image/png') order by id),'[]')
  from (select distinct v->>'emailAssetId' id from jsonb_array_elements(coalesce(document->'visuals','[]')) v) refs
$$;
create function daily_cs_private.require_visual_assets(document jsonb)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  perform daily_cs_private.validate_visuals(document->'visuals');
  if exists(select 1 from jsonb_array_elements(daily_cs_private.visual_refs(document)) r
      where not exists(select 1 from daily_cs_private.visual_assets a where a.asset_id=r->>'assetId')) then
    raise exception using errcode='22023',message='validation_failed: referenced visual asset is missing';
  end if;
end $$;
create function daily_cs_private.check_document_visual_assets()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name='lessons' then
    perform daily_cs_private.validate_visuals(new.draft_document->'visuals');
    -- Drafts remain independent while an earlier revision is published, including during restore.
    -- Revision inserts/updates below enforce asset existence for every actual publication.
  else
    perform daily_cs_private.require_visual_assets(new.document);
  end if;
  return new;
end $$;
create trigger lesson_visual_assets before insert or update on daily_cs_private.lessons
for each row execute function daily_cs_private.check_document_visual_assets();
create trigger revision_visual_assets before insert or update on daily_cs_private.lesson_revisions
for each row execute function daily_cs_private.check_document_visual_assets();
create trigger snapshot_visual_assets before insert on daily_cs_private.day_snapshots
for each row execute function daily_cs_private.check_document_visual_assets();
create trigger manual_snapshot_visual_assets before insert on daily_cs_private.manual_snapshots
for each row execute function daily_cs_private.check_document_visual_assets();

create function daily_cs_private.owner_visual_api(action text,payload jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare a daily_cs_private.visual_assets; decoded bytea;
begin
  perform daily_cs_private.require_active_owner();
  if action='visual.put' then
    decoded:=daily_cs_private.validate_visual_asset(payload);
    insert into daily_cs_private.visual_assets(asset_id,mime_type,width,height,bytes)
    values(payload->>'assetId','image/png',(payload->>'width')::integer,(payload->>'height')::integer,decoded)
    on conflict(asset_id) do nothing;
  elsif action is distinct from 'visual.get' then
    return daily_cs_private.api_error('bad_request','unknown visual action');
  end if;
  select * into a from daily_cs_private.visual_assets where asset_id=payload->>'assetId';
  if not found then return daily_cs_private.api_error('not_found','visual asset not found'); end if;
  return daily_cs_private.api_ok(jsonb_build_object('asset',jsonb_build_object('assetId',a.asset_id,
    'mimeType',a.mime_type,'width',a.width,'height',a.height,'base64',replace(encode(a.bytes,'base64'),E'\n',''))));
exception when invalid_parameter_value or invalid_text_representation or numeric_value_out_of_range then
  return daily_cs_private.api_error('validation_failed','visual asset failed validation');
when insufficient_privilege then
  return daily_cs_private.api_error('forbidden','active owner session required');
end $$;

-- Preserve the existing invoker API and every original owner/session/lock guard.
alter function public.daily_cs_owner_api(text,jsonb) set schema daily_cs_private;
alter function daily_cs_private.daily_cs_owner_api(text,jsonb) rename to owner_api_before_visuals;
create function public.daily_cs_owner_api(action text,payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql volatile security invoker set search_path = '' as $$
begin
  if action in ('visual.put','visual.get') then
    return daily_cs_private.owner_visual_api(action,payload);
  end if;
  return daily_cs_private.owner_api_before_visuals(action,payload);
end $$;
revoke all on function public.daily_cs_owner_api(text,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.daily_cs_owner_api(text,jsonb) to authenticated;

alter function daily_cs_private.export_envelope(boolean) rename to export_envelope_before_visuals;
create function daily_cs_private.export_envelope(include_trash boolean default false)
returns jsonb language sql stable security definer set search_path = '' as $$
  select daily_cs_private.export_envelope_before_visuals(include_trash) || jsonb_build_object('assets',
    coalesce((select jsonb_agg(jsonb_build_object('assetId',asset_id,'mimeType',mime_type,
      'width',width,'height',height,'base64',replace(encode(bytes,'base64'),E'\n','')) order by asset_id)
      from daily_cs_private.visual_assets),'[]'))
$$;

alter function daily_cs_private.validate_export_envelope(jsonb) rename to validate_export_envelope_before_visuals;
create function daily_cs_private.validate_export_envelope(envelope jsonb)
returns void language plpgsql stable set search_path = '' as $$
declare a jsonb; d jsonb; ids text[]:='{}';
begin
  perform daily_cs_private.validate_export_envelope_before_visuals(envelope);
  if envelope ? 'assets' and jsonb_typeof(envelope->'assets') is distinct from 'array' then
    raise exception using errcode='22023',message='validation_failed: assets must be an array';
  end if;
  for a in select value from jsonb_array_elements(coalesce(envelope->'assets','[]')) loop
    perform daily_cs_private.validate_visual_asset(a);
    if a->>'assetId'=any(ids) then
      raise exception using errcode='22023',message='validation_failed: duplicate exported asset';
    end if;
    ids:=array_append(ids,a->>'assetId');
  end loop;
  -- The existing validator checks draft visual structure; unresolved draft assets may be backed up.
  -- Published revisions and immutable snapshots must always include their referenced bytes.
  for d in
    select value->'document' from jsonb_array_elements(envelope->'revisions')
    union all select value->'document' from jsonb_array_elements(envelope->'daySnapshots')
    union all select value->'document' from jsonb_array_elements(coalesce(envelope#>'{scheduleState,manualSnapshots}','[]'))
  loop
    perform daily_cs_private.validate_visuals(d->'visuals');
    if exists(select 1 from jsonb_array_elements(daily_cs_private.visual_refs(d)) r
      where not (r->>'assetId'=any(ids))) then
      raise exception using errcode='22023',message='validation_failed: backup is missing a referenced visual asset';
    end if;
  end loop;
end $$;

alter function daily_cs_private.restore_export_envelope(jsonb,uuid) rename to restore_export_envelope_before_visuals;
create function daily_cs_private.restore_export_envelope(envelope jsonb,uid uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare a jsonb; counts jsonb;
begin
  perform daily_cs_private.validate_export_envelope(envelope);
  for a in select value from jsonb_array_elements(coalesce(envelope->'assets','[]')) loop
    insert into daily_cs_private.visual_assets(asset_id,mime_type,width,height,bytes)
    values(a->>'assetId','image/png',(a->>'width')::integer,(a->>'height')::integer,decode(a->>'base64','base64'))
    on conflict(asset_id) do nothing;
  end loop;
  counts:=daily_cs_private.restore_export_envelope_before_visuals(envelope,uid);
  return counts||jsonb_build_object('assets',jsonb_array_length(coalesce(envelope->'assets','[]')));
end $$;

-- Derive mail manifests only from the immutable snapshot used by the existing request.
alter table daily_cs_private.mail_outbox add column inline_image_refs jsonb not null default '[]'
  check (jsonb_typeof(inline_image_refs)='array' and jsonb_array_length(inline_image_refs)<=3);
create function daily_cs_private.visual_mail_source(day_id uuid,manual_id uuid)
returns jsonb language sql stable set search_path = '' as $$
  select body from (
    select daily_cs_private.snapshot_day(d) body from daily_cs_private.day_snapshots d where id=day_id
    union all select jsonb_build_object('snapshotId',m.id,'document',m.document,'contentHash',m.content_hash,
      'title',m.title,'documentKind',m.document_kind,'date',m.preview_date) from daily_cs_private.manual_snapshots m where id=manual_id
  ) sources limit 1
$$;
create function daily_cs_private.bind_mail_visual_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
declare source jsonb;
begin
  if tg_op='UPDATE' then
    if new.inline_image_refs is distinct from old.inline_image_refs then
      raise exception using errcode='22023',message='validation_failed: mail visual references are immutable';
    end if;
  else
    source:=daily_cs_private.visual_mail_source(new.snapshot_id,new.manual_snapshot_id);
    perform daily_cs_private.require_visual_assets(source->'document');
    new.inline_image_refs:=daily_cs_private.visual_refs(source->'document');
  end if;
  return new;
end $$;
create trigger mail_visual_refs before insert or update on daily_cs_private.mail_outbox
for each row execute function daily_cs_private.bind_mail_visual_refs();

create function daily_cs_private.mail_visual_images(refs jsonb)
returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(r||jsonb_build_object('base64',replace(encode(a.bytes,'base64'),E'\n','')) order by a.asset_id),'[]')
  from jsonb_array_elements(refs) r join daily_cs_private.visual_assets a on a.asset_id=r->>'assetId'
$$;

alter function public.daily_cs_mail_api(text,jsonb,text) set schema daily_cs_private;
alter function daily_cs_private.daily_cs_mail_api(text,jsonb,text) rename to mail_api_before_visuals;
create function public.daily_cs_mail_api(action text,payload jsonb,token text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare result jsonb; source jsonb; refs jsonb; candidate daily_cs_private.mail_render_requests;
  message daily_cs_private.mail_outbox; body jsonb;
begin
  -- Check the machine boundary before any snapshot or asset lookup, including failures.
  if not exists(select 1 from daily_cs_private.api_credentials where scope='mail' and enabled
      and token_hash=daily_cs_private.sha256_text(token)) then
    return daily_cs_private.api_error('forbidden','valid mail credential required');
  end if;
  perform daily_cs_private.take_owner_lock();
  if action='mail.materialize' then
    select * into candidate from daily_cs_private.mail_render_requests where id=(payload->>'candidateId')::uuid;
    if found then
      source:=daily_cs_private.visual_mail_source(candidate.snapshot_id,candidate.manual_snapshot_id);
      refs:=daily_cs_private.visual_refs(source->'document');
      if coalesce(payload->'inlineImageRefs','[]') is distinct from refs
        or (jsonb_array_length(refs)>0 and payload->>'snapshotId' is distinct from coalesce(candidate.snapshot_id,candidate.manual_snapshot_id)::text) then
        return daily_cs_private.api_error('validation_failed','snapshot visual manifest mismatch');
      end if;
      perform daily_cs_private.require_visual_assets(source->'document');
    end if;
  elsif action='mail.beginSending' then
    select * into message from daily_cs_private.mail_outbox where id=(payload->>'messageId')::uuid;
    if found and message.claim_token_hash is not distinct from daily_cs_private.sha256_text(payload->>'claimToken')
      and message.state in ('claimed','sending') then
      source:=daily_cs_private.visual_mail_source(message.snapshot_id,message.manual_snapshot_id);
      if message.inline_image_refs is distinct from daily_cs_private.visual_refs(source->'document') then
        return daily_cs_private.api_error('validation_failed','snapshot visual manifest mismatch');
      end if;
      perform daily_cs_private.require_visual_assets(source->'document');
    end if;
  end if;
  result:=daily_cs_private.mail_api_before_visuals(action,payload,token);
  if result ? 'error' then return result; end if;
  if action='mail.prepareDue' and jsonb_typeof(result#>'{data,candidate}')='object' then
    body:=result#>'{data,candidate}';
    perform daily_cs_private.require_visual_assets(body#>'{lesson,document}');
    return jsonb_set(result,'{data,candidate}',body||jsonb_build_object('inlineImageRefs',daily_cs_private.visual_refs(body#>'{lesson,document}')));
  elsif action='mail.materialize' and result#>>'{data,messageId}' is not null then
    return jsonb_set(result,'{data}',(result->'data')||jsonb_build_object('inlineImageRefs',coalesce(refs,'[]')));
  elsif action in ('mail.claimDue','mail.resumeClaim') and jsonb_typeof(result#>'{data,message}')='object' then
    body:=result#>'{data,message}';
    select * into message from daily_cs_private.mail_outbox where id=(body->>'id')::uuid;
    source:=daily_cs_private.visual_mail_source(message.snapshot_id,message.manual_snapshot_id);
    perform daily_cs_private.require_visual_assets(source->'document');
    refs:=daily_cs_private.visual_refs(source->'document');
    if message.inline_image_refs is distinct from refs then
      raise exception using errcode='22023',message='validation_failed: snapshot visual manifest mismatch';
    end if;
    return jsonb_set(result,'{data,message}',body||jsonb_build_object('lesson',source,
      'contentHash',source->>'contentHash','inlineImageRefs',refs,'inlineImages',daily_cs_private.mail_visual_images(refs)));
  end if;
  return result;
exception when invalid_parameter_value or invalid_text_representation or numeric_value_out_of_range then
  return daily_cs_private.api_error('validation_failed','visual mail payload failed validation');
end $$;
revoke all on function public.daily_cs_mail_api(text,jsonb,text) from public, anon, authenticated, service_role;
grant execute on function public.daily_cs_mail_api(text,jsonb,text) to service_role;

-- Keep helpers private. Only pure validators and the guarded invoker delegates are callable by the owner role.
revoke all on function daily_cs_private.reject_visual_asset_mutation(),daily_cs_private.check_visual_asset_insert(),
  daily_cs_private.validate_visual_asset(jsonb),daily_cs_private.visual_text(jsonb,integer,boolean),
  daily_cs_private.visual_object(jsonb,text[],text[]),daily_cs_private.validate_visuals(jsonb),
  daily_cs_private.validate_document(daily_cs_private.document_kind,jsonb),
  daily_cs_private.validate_document_before_visuals(daily_cs_private.document_kind,jsonb),
  daily_cs_private.visual_refs(jsonb),daily_cs_private.require_visual_assets(jsonb),daily_cs_private.check_document_visual_assets(),
  daily_cs_private.owner_visual_api(text,jsonb),daily_cs_private.owner_api_before_visuals(text,jsonb),
  daily_cs_private.export_envelope(boolean),daily_cs_private.export_envelope_before_visuals(boolean),
  daily_cs_private.validate_export_envelope(jsonb),daily_cs_private.validate_export_envelope_before_visuals(jsonb),
  daily_cs_private.restore_export_envelope(jsonb,uuid),daily_cs_private.restore_export_envelope_before_visuals(jsonb,uuid),
  daily_cs_private.visual_mail_source(uuid,uuid),daily_cs_private.bind_mail_visual_refs(),
  daily_cs_private.mail_visual_images(jsonb),daily_cs_private.mail_api_before_visuals(text,jsonb,text)
from public, anon, authenticated, service_role;
grant execute on function daily_cs_private.owner_visual_api(text,jsonb),daily_cs_private.owner_api_before_visuals(text,jsonb),
  daily_cs_private.validate_document(daily_cs_private.document_kind,jsonb),
  daily_cs_private.validate_document_before_visuals(daily_cs_private.document_kind,jsonb),
  daily_cs_private.validate_visuals(jsonb),daily_cs_private.visual_text(jsonb,integer,boolean),
  daily_cs_private.visual_object(jsonb,text[],text[])
to authenticated;
