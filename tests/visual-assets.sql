-- Synthetic fixtures only. Run after all migrations; all changes roll back.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '45s';
select daily_cs_private.take_owner_lock();

create function pg_temp.visual_assert(condition boolean, message text)
returns void language plpgsql as $$ begin
  if condition is distinct from true then raise exception '%',message; end if;
end $$;
create function pg_temp.visual_rejects(statement text)
returns boolean language plpgsql as $$ begin
  execute statement;
  return false;
exception when invalid_parameter_value or invalid_text_representation or check_violation
  or insufficient_privilege or numeric_value_out_of_range then return true;
end $$;

-- These identities have no email or credentials and exist only inside this transaction.
insert into auth.users(id) values('f1111111-1111-4111-8111-111111111111');
insert into auth.sessions(id,user_id,not_after)
values('f2222222-2222-4222-8222-222222222222','f1111111-1111-4111-8111-111111111111',now()+interval '1 hour');
insert into daily_cs_private.owner_profile(singleton,owner_uid,owner_email_hash)
values(true,'f1111111-1111-4111-8111-111111111111','synthetic-no-email')
on conflict(singleton) do update set owner_uid=excluded.owner_uid;
select set_config('request.jwt.claim.sub','f1111111-1111-4111-8111-111111111111',true);
select set_config('request.jwt.claims','{"sub":"f1111111-1111-4111-8111-111111111111","session_id":"f2222222-2222-4222-8222-222222222222"}',true);

create function pg_temp.visual_fixture(hash text)
returns jsonb language sql as $$ select jsonb_build_array(jsonb_build_object(
  'version',1,'id','synthetic','title','Synthetic diagram','description','Synthetic description',
  'alt','One synthetic box','emailAssetId',hash,'emailScenarioId','normal','emailStep',0,
  'scenarios',jsonb_build_array(jsonb_build_object('id','normal','label','Normal',
    'steps',jsonb_build_array(jsonb_build_object('title','Initial','description','Initial description',
      'nodes',jsonb_build_array(jsonb_build_object('id','box','label','Box','tone','neutral')))))))) $$;

do $test$
declare
  png text:='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=';
  asset jsonb; hash text; visuals jsonb; changed jsonb; result jsonb; envelope jsonb;
  old_assets bigint; old_lessons bigint; old_overrides text; refs jsonb;
  lesson_id uuid:='f3333333-3333-4333-8333-333333333333';
begin
  hash:=encode(extensions.digest(decode(png,'base64'),'sha256'),'hex');
  asset:=jsonb_build_object('assetId',hash,'mimeType','image/png','width',1,'height',1,'base64',png);
  visuals:=pg_temp.visual_fixture(hash);
  perform daily_cs_private.validate_visuals(visuals);
  perform daily_cs_private.validate_document('markdown',jsonb_build_object('markdown','Synthetic content for publication.','visuals',visuals));
  perform daily_cs_private.validate_visuals('[]');
  perform daily_cs_private.validate_document('markdown','{"markdown":"Old complete body without visuals."}');
  foreach changed in array array[
    'null'::jsonb,'{}'::jsonb,
    jsonb_set(visuals,'{0,version}','2'),jsonb_set(visuals,'{0,emailStep}','-1'),
    jsonb_set(visuals,'{0,emailStep}','1'),jsonb_set(visuals,'{0,emailScenarioId}','"missing"'),
    jsonb_set(visuals,'{0,title}','"<script>x</script>"'),jsonb_set(visuals,'{0,title}','"https://example.invalid"'),
    jsonb_set(visuals,'{0,extra}','true'),visuals||visuals,
    jsonb_set(visuals,'{0,scenarios,0,steps,0,nodes,0,tone}','"unknown"'),
    jsonb_set(visuals,'{0,scenarios,0,steps,0,nodes}',(visuals#>'{0,scenarios,0,steps,0,nodes}')||(visuals#>'{0,scenarios,0,steps,0,nodes}')),
    jsonb_set(visuals,'{0,scenarios,0,steps,0,edges}','[{"from":"box","to":"missing","label":""}]')
  ] loop
    perform pg_temp.visual_assert(pg_temp.visual_rejects(format('select daily_cs_private.validate_visuals(%L::jsonb)',changed)),
      'malformed visual accepted');
  end loop;
  foreach changed in array array[
    asset||'{"mimeType":"image/svg+xml"}',asset||'{"width":2049}',asset||'{"width":2}',
    asset||jsonb_build_object('assetId',repeat('0',64)),asset||'{"base64":"AAAA"}',asset||'{"extra":true}'
  ] loop
    perform pg_temp.visual_assert(pg_temp.visual_rejects(format('select daily_cs_private.validate_visual_asset(%L::jsonb)',changed)),
      'malformed PNG accepted');
  end loop;
  select count(*) into old_assets from daily_cs_private.visual_assets;
  result:=public.daily_cs_owner_api('visual.put',asset);
  perform pg_temp.visual_assert(result#>>'{data,asset,assetId}'=hash,'owner upload failed');
  result:=public.daily_cs_owner_api('visual.put',asset);
  perform pg_temp.visual_assert((select count(*) from daily_cs_private.visual_assets)=old_assets+1,'upload must dedupe');
  result:=public.daily_cs_owner_api('visual.get',jsonb_build_object('assetId',hash));
  perform pg_temp.visual_assert(result#>>'{data,asset,base64}'=png,'asset bytes changed');
  perform pg_temp.visual_assert(pg_temp.visual_rejects(format('update daily_cs_private.visual_assets set width=2 where asset_id=%L',hash)),'asset update accepted');
  perform pg_temp.visual_assert(pg_temp.visual_rejects(format('delete from daily_cs_private.visual_assets where asset_id=%L',hash)),'asset delete accepted');
  refs:=daily_cs_private.visual_refs(jsonb_build_object('visuals',visuals));
  perform pg_temp.visual_assert(refs=jsonb_build_array(jsonb_build_object('assetId',hash,'cid','visual-'||hash,'mimeType','image/png')),'manifest mismatch');
  perform pg_temp.visual_assert(jsonb_array_length(daily_cs_private.visual_refs(jsonb_build_object('visuals',visuals||visuals)))=1,'manifest did not dedupe');
  perform pg_temp.visual_assert(jsonb_array_length(daily_cs_private.export_envelope(true)->'assets')=old_assets+1,'asset export must contain bytes once');
  envelope:=jsonb_build_object('schemaVersion',2,'lessons','[]'::jsonb,'revisions','[]'::jsonb,'scheduleOverrides','[]'::jsonb,'daySnapshots','[]'::jsonb);
  perform daily_cs_private.validate_export_envelope(envelope);
  envelope:=envelope||jsonb_build_object('assets',jsonb_build_array(asset),'lessons',jsonb_build_array(jsonb_build_object(
    'id',lesson_id,'title','Synthetic visual lesson','category','synthetic','state','draft','documentKind','markdown',
    'draftDocument',jsonb_build_object('markdown','Complete synthetic body.','visuals',visuals),'draftRevision',1,'rowRevision',1)));
  perform daily_cs_private.validate_export_envelope(envelope);
  perform daily_cs_private.validate_export_envelope(envelope-'assets');
  changed:=envelope-'assets'||jsonb_build_object('revisions',jsonb_build_array(jsonb_build_object(
    'documentKind','markdown','document',envelope#>'{lessons,0,draftDocument}',
    'contentHash',daily_cs_private.document_hash(envelope#>'{lessons,0,draftDocument}'))));
  perform pg_temp.visual_assert(pg_temp.visual_rejects(format('select daily_cs_private.validate_export_envelope(%L::jsonb)',changed)),
    'published revision backup accepted missing assets');
  select count(*) into old_lessons from daily_cs_private.lessons;
  select md5(coalesce(string_agg(to_jsonb(o)::text,'' order by schedule_date),'')) into old_overrides from daily_cs_private.schedule_overrides o;
  changed:=jsonb_set(envelope,'{assets,0,base64}','"AAAA"');
  perform pg_temp.visual_assert(pg_temp.visual_rejects(format('select daily_cs_private.restore_export_envelope(%L::jsonb,%L::uuid)',changed,'f1111111-1111-4111-8111-111111111111')),'invalid restore accepted');
  perform pg_temp.visual_assert((select count(*) from daily_cs_private.lessons)=old_lessons,'failed restore changed lessons');
  perform pg_temp.visual_assert((select md5(coalesce(string_agg(to_jsonb(o)::text,'' order by schedule_date),'')) from daily_cs_private.schedule_overrides o)=old_overrides,'failed restore changed schedule');
  result:=daily_cs_private.restore_export_envelope(envelope,'f1111111-1111-4111-8111-111111111111');
  perform pg_temp.visual_assert(result->>'assets'='1' and exists(select 1 from daily_cs_private.lessons where id=lesson_id),'valid restore failed');
  perform pg_temp.visual_assert((select count(*) from daily_cs_private.visual_assets)=old_assets+1,'restore duplicated asset');
  changed:=jsonb_set(visuals,'{0,emailAssetId}',to_jsonb(repeat('0',64)));
  update daily_cs_private.lessons set draft_document=jsonb_build_object('markdown','Complete synthetic body.','visuals',changed)
    where id=lesson_id;
  perform pg_temp.visual_assert(pg_temp.visual_rejects(format('select public.daily_cs_owner_api(''lesson.publish'',%L::jsonb)',
    jsonb_build_object('id',lesson_id,'expectedRevision',1))),'publish accepted missing PNG');
  perform pg_temp.visual_assert(not exists(select 1 from daily_cs_private.lesson_revisions r
    where r.lesson_id='f3333333-3333-4333-8333-333333333333'),
    'failed publication retained a revision');
  update daily_cs_private.lessons set draft_document=jsonb_build_object('markdown','Complete synthetic body.','visuals',visuals)
    where id=lesson_id;
end $test$;

do $draft$
declare
  synthetic_id uuid:='f3333333-3333-4333-8333-333333333333';
  response jsonb; document jsonb; revision integer; published jsonb; envelope jsonb;
begin
  -- Given a published lesson, its independent draft may reference an asset not uploaded yet.
  response:=public.daily_cs_owner_api('lesson.publish',jsonb_build_object('id',synthetic_id,'expectedRevision',1));
  perform pg_temp.visual_assert(not(response ? 'error'),'synthetic publication failed');
  revision:=(response#>>'{data,lesson,row_revision}')::integer;
  select r.document into published from daily_cs_private.lesson_revisions r where r.lesson_id=synthetic_id and r.revision_number=1;
  document:=jsonb_build_object('markdown','Independent synthetic draft.',
    'visuals',pg_temp.visual_fixture(repeat('0',64)));
  -- When autosaving, Then retain publication and allow the incomplete asset reference in the draft.
  response:=public.daily_cs_owner_api('lesson.saveDraft',jsonb_build_object('id',synthetic_id,'expectedRevision',revision,
    'title','Synthetic visual lesson','category','synthetic','documentKind','markdown','document',document));
  perform pg_temp.visual_assert(not(response ? 'error'),'published lesson draft autosave rejected missing asset');
  perform pg_temp.visual_assert(response#>>'{data,lesson,state}'='published','draft save changed publication state');
  perform pg_temp.visual_assert((select r.document=published from daily_cs_private.lesson_revisions r
    where r.lesson_id=synthetic_id and r.revision_number=1),'draft save changed published revision');
  -- Export only this synthetic lesson/revision from the actual exporter; restore must retain its incomplete draft.
  envelope:=daily_cs_private.export_envelope(true);
  envelope:=envelope-'scheduleState'||jsonb_build_object(
    'lessons',(select jsonb_agg(l) from jsonb_array_elements(envelope->'lessons') l where l->>'id'=synthetic_id::text),
    'revisions',(select jsonb_agg(r) from jsonb_array_elements(envelope->'revisions') r where r->>'lessonId'=synthetic_id::text),
    'scheduleOverrides','[]'::jsonb,'daySnapshots','[]'::jsonb);
  perform daily_cs_private.validate_export_envelope(envelope);
  update daily_cs_private.lessons set state='draft',published_revision=null,draft_document=published where id=synthetic_id;
  perform daily_cs_private.restore_export_envelope(envelope,'f1111111-1111-4111-8111-111111111111');
  perform pg_temp.visual_assert((select l.state='published' and l.draft_document=document and l.published_revision=1
    from daily_cs_private.lessons l where l.id=synthetic_id),'restore lost incomplete draft or publication');
  perform pg_temp.visual_assert((select r.document=published from daily_cs_private.lesson_revisions r
    where r.lesson_id=synthetic_id and r.revision_number=1),'restore changed published visual revision');
  -- A subsequent publish still requires every referenced PNG.
  select row_revision into revision from daily_cs_private.lessons where id=synthetic_id;
  perform pg_temp.visual_assert(pg_temp.visual_rejects(format('select public.daily_cs_owner_api(''lesson.publish'',%L::jsonb)',
    jsonb_build_object('id',synthetic_id,'expectedRevision',revision))),'publication accepted missing draft asset');
end $draft$;

do $mail$
declare png text:='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=';
  hash text; document jsonb; refs jsonb; snapshot uuid:=gen_random_uuid(); request uuid:=gen_random_uuid();
  command uuid:=gen_random_uuid(); token text:='synthetic-visual-'||gen_random_uuid();
  response jsonb; manifest jsonb; message jsonb; claim text; old_count bigint;
begin
  perform pg_temp.visual_assert(not exists(select 1 from daily_cs_private.mail_outbox where kind<>'daily' and state in ('queued','claimed')),
    'mail visual test requires no pending manual messages');
  hash:=encode(extensions.digest(decode(png,'base64'),'sha256'),'hex');
  document:=jsonb_build_object('markdown','Synthetic complete visual body.','visuals',pg_temp.visual_fixture(hash));
  refs:=daily_cs_private.visual_refs(document);
  insert into daily_cs_private.api_credentials(scope,token_hash,label) values('mail',daily_cs_private.sha256_text(token),'synthetic visual regression');
  insert into daily_cs_private.manual_snapshots(id,preview_date,title,category,document_kind,document,content_hash)
    values(snapshot,current_date,'Synthetic visual snapshot','synthetic','markdown',document,daily_cs_private.document_hash(document));
  insert into daily_cs_private.mail_render_requests(id,kind,manual_snapshot_id,scheduled_date,send_after,command_id)
    values(request,'test',snapshot,current_date,now()-interval '1 minute',command);
  manifest:=jsonb_build_object('candidateId',request,'snapshotId',snapshot,'contentHash',daily_cs_private.document_hash(document),
    'text','Synthetic mail','html','<p>Synthetic mail</p>','inlineImageRefs',refs);
  response:=public.daily_cs_mail_api('mail.materialize',manifest,'wrong-synthetic-token');
  perform pg_temp.visual_assert(response#>>'{error,code}'='forbidden','invalid machine credential accepted');
  select count(*) into old_count from daily_cs_private.mail_outbox;
  response:=public.daily_cs_mail_api('mail.materialize',manifest-'inlineImageRefs',token);
  perform pg_temp.visual_assert(response#>>'{error,code}'='validation_failed','missing visual manifest accepted');
  response:=public.daily_cs_mail_api('mail.materialize',manifest||jsonb_build_object('snapshotId',gen_random_uuid()),token);
  perform pg_temp.visual_assert(response#>>'{error,code}'='validation_failed','wrong snapshot accepted');
  perform pg_temp.visual_assert((select count(*) from daily_cs_private.mail_outbox)=old_count,'invalid materialize wrote outbox');
  response:=public.daily_cs_mail_api('mail.materialize',manifest,token);
  perform pg_temp.visual_assert(response#>>'{data,messageId}'=request::text,'visual materialize failed');
  perform pg_temp.visual_assert((select inline_image_refs=refs from daily_cs_private.mail_outbox where id=request),'outbox references differ');
  perform pg_temp.visual_assert((select not (to_jsonb(o)::text like '%base64%') from daily_cs_private.mail_outbox o where id=request),'binary persisted in outbox');
  response:=public.daily_cs_mail_api('mail.claimDue','{"workerId":"synthetic-visual"}',token);
  message:=response#>'{data,message}'; claim:=message->>'claimToken';
  perform pg_temp.visual_assert(message->>'id'=request::text,'visual claim selected wrong message');
  perform pg_temp.visual_assert(message->'inlineImageRefs'=refs and message#>>'{inlineImages,0,base64}'=png,'claim attachment bytes differ');
  perform pg_temp.visual_assert(message#>>'{lesson,contentHash}'=message->>'contentHash','claim hash differs');
  response:=public.daily_cs_mail_api('mail.resumeClaim',jsonb_build_object('messageId',request,'claimToken','bad'),token);
  perform pg_temp.visual_assert(response#>>'{error,code}'='forbidden' and not(response::text like '%base64%'),'bad claim exposed asset');
  response:=public.daily_cs_mail_api('mail.resumeClaim',jsonb_build_object('messageId',request,'claimToken',claim,'commandId',command),token);
  perform pg_temp.visual_assert(response#>>'{data,message,inlineImages,0,base64}'=png,'resume attachment differs');
  response:=public.daily_cs_mail_api('mail.beginSending',jsonb_build_object('messageId',request,'claimToken',claim,'commandId',command),token);
  perform pg_temp.visual_assert(response#>>'{data,state}'='sending','begin sending failed');
  response:=public.daily_cs_mail_api('mail.ackSent',jsonb_build_object('messageId',request,'claimToken',claim),token);
  perform pg_temp.visual_assert(response#>>'{data,state}'='sent','ACK failed');
  response:=public.daily_cs_mail_api('mail.resumeClaim',jsonb_build_object('messageId',request,'claimToken',claim,'commandId',command),token);
  perform pg_temp.visual_assert(response#>>'{data,state}'='sent' and not(response::text like '%base64%'),'ACK-only recovery exposed or resent images');
end $mail$;

-- Run the real invoker path under authenticated and verify session revocation immediately.
set local role authenticated;
do $test$
declare hash text:=encode(extensions.digest(decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=','base64'),'sha256'),'hex');
  response jsonb;
begin
  response:=public.daily_cs_owner_api('visual.get',jsonb_build_object('assetId',hash));
  perform pg_temp.visual_assert(response#>>'{data,asset,assetId}'=hash,'authenticated owner retrieval failed');
  perform pg_temp.visual_assert(pg_temp.visual_rejects('select * from daily_cs_private.visual_assets'),'owner direct PNG table access accepted');
end $test$;
reset role;
delete from auth.sessions where id='f2222222-2222-4222-8222-222222222222';
set local role authenticated;
do $test$ begin
  perform pg_temp.visual_assert(public.daily_cs_owner_api('visual.get','{"assetId":"0000000000000000000000000000000000000000000000000000000000000000"}')#>>'{error,code}'='forbidden','revoked owner session accepted');
end $test$;
reset role;

select pg_temp.visual_assert(not has_table_privilege('anon','daily_cs_private.visual_assets','SELECT,INSERT,UPDATE,DELETE'),'anonymous asset privileges');
select pg_temp.visual_assert(not has_function_privilege('authenticated','daily_cs_private.mail_visual_images(jsonb)','EXECUTE'),'asset helper callable by owner');
select pg_temp.visual_assert(not has_function_privilege('anon','public.daily_cs_owner_api(text,jsonb)','EXECUTE'),'anonymous owner API callable');
select 'visual asset regressions passed' as result;
rollback;
