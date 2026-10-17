const assert = require('node:assert/strict');
const { execFileSync, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { renderMailFromSnapshot } = require('../lib/render');

const root = path.resolve(__dirname, '..');
const migrations = path.join(root, 'supabase', 'migrations');
const container = `daily-cs-schedule-${process.pid}-${Date.now()}`;

function docker(args, input) {
  return execFileSync('docker', args, { encoding: 'utf8', input, stdio:['pipe','pipe','pipe'], maxBuffer: 8 * 1024 * 1024 });
}

function sql(statement) {
  return docker(['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'], statement).trim();
}

const authHarness = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create schema auth;
create table auth.sessions(id uuid primary key, user_id uuid not null, not_after timestamptz);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true),''),'{}')::jsonb $$;
`;

const ownerSession = `
select set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111',false);
select set_config('request.jwt.claims','{"session_id":"22222222-2222-2222-2222-222222222222"}',false);
`;

test('backup reporting keeps success terminal and rejects unscoped or content-bearing reports', () => {
  sql(fs.readFileSync(path.join(__dirname, 'operations-health.sql'), 'utf8'));
});

test('weekday mail gates preserve daily web history, manual weekend jobs and ACK recovery', () => {
  sql(fs.readFileSync(path.join(__dirname, 'weekday-mail.sql'), 'utf8'));
});

test('deferred course restart preserves the prior Sunday until Monday09KST and survives backup restore', () => {
  sql(fs.readFileSync(path.join(__dirname, 'deferred-course-restart.sql'), 'utf8'));
});

function owner(action, payload = {}) {
  const escaped = JSON.stringify(payload).replace(/'/g, "''");
  const output = sql(`${ownerSession} set role authenticated;
    select public.daily_cs_owner_api('${action}', '${escaped}'::jsonb);`);
  return JSON.parse(output.split('\n').at(-1));
}

function jsonSql(statement) {
  return JSON.parse(sql(statement).split('\n').at(-1));
}

function clock(instant) {
  sql(`create or replace function daily_cs_private.schedule_now() returns timestamptz
    language sql stable set search_path='' as $$ select '${instant}'::timestamptz $$;`);
}

function published(title, legacyId) {
  const id = randomUUID();
  const document = JSON.stringify({ markdown: `## ${title}\nSynthetic complete body with a question and a substantial answer.` }).replace(/'/g, "''");
  sql(`insert into daily_cs_private.lessons(id,owner_uid,legacy_id,title,category,state,document_kind,draft_document,published_revision)
    values('${id}','11111111-1111-1111-1111-111111111111',${legacyId},'${title}','synthetic','published','markdown','${document}',1);
    insert into daily_cs_private.lesson_revisions(lesson_id,revision_number,title,category,document_kind,document,content_hash,created_by)
    values('${id}',1,'${title}','synthetic','markdown','${document}',daily_cs_private.document_hash('${document}'::jsonb),
      '11111111-1111-1111-1111-111111111111');
    ${ownerSession} select daily_cs_private.on_catalog_change('${id}');`);
  return id;
}

function schedule(from, days) {
  const response = owner('schedule.get', { from, days });
  assert.equal(response.error, undefined, JSON.stringify(response));
  return response.data.days;
}

function override(date, lessonId, mode = 'lesson') {
  const expectedScheduleRevision = Number(sql('select schedule_revision from daily_cs_private.settings'));
  return owner('schedule.setOverride', { date, lessonId, mode, expectedScheduleRevision });
}

function mail(action, payload = {}, token = 'synthetic-mail-key') {
  return jsonSql(`select public.daily_cs_mail_api('${action}','${JSON.stringify(payload).replace(/'/g, "''")}'::jsonb,'${token}');`);
}

test.before(() => {
  docker(['run', '-d', '--name', container, '-e', 'POSTGRES_PASSWORD=postgres', 'postgres:17-alpine']);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']);
      docker(['exec', container, 'psql', '-X', '-qAt', '-U', 'postgres', '-c', 'select 1']);
      break;
    } catch (error) {
      if (attempt === 59) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
  sql(authHarness);
  for (const migration of fs.readdirSync(migrations).filter(name=>name.endsWith('.sql')).sort()) {
    sql(fs.readFileSync(path.join(migrations,migration),'utf8'));
  }
  sql(`insert into daily_cs_private.owner_profile(owner_uid,owner_email_hash)
    values ('11111111-1111-1111-1111-111111111111','synthetic-owner-hash');
    insert into auth.sessions values ('22222222-2222-2222-2222-222222222222',
      '11111111-1111-1111-1111-111111111111',null);`);
});

test.after(() => docker(['rm', '-f', container]));

test.beforeEach(() => {
  sql(`truncate daily_cs_private.mail_render_requests,daily_cs_private.mail_outbox,
    daily_cs_private.manual_snapshots,daily_cs_private.day_snapshots,daily_cs_private.schedule_queue,
    daily_cs_private.schedule_catalog_order,daily_cs_private.schedule_overrides,
    daily_cs_private.lesson_revisions,daily_cs_private.lessons,daily_cs_private.settings_time_events cascade;
    update daily_cs_private.settings set start_date='2026-09-15',send_time='09:00',mail_paused=false,revision=1,schedule_revision=1;
    update daily_cs_private.schedule_state set last_frozen_date='2026-09-14',cycle=1;
    insert into daily_cs_private.settings_time_events values('2026-09-15','09:00',now());
    insert into daily_cs_private.api_credentials(scope,token_hash,label) values
      ('mail',daily_cs_private.sha256_text('synthetic-mail-key'),'synthetic mail'),
      ('backup_export',daily_cs_private.sha256_text('synthetic-backup-key'),'synthetic backup')
    on conflict(token_hash) do nothing;`);
  clock('2026-09-14T03:00:00Z');
});

test('reader returns an explicit prelaunch day before the configured start', () => {
  const response = owner('reader.today', { date: '2026-09-14' });
  assert.equal(response.data?.day?.status, 'not_started');
  assert.equal(response.data.day.date, '2026-09-14');
  assert.equal(response.data.day.snapshotId, null);
});

test('queue follows original published order, appends a new lesson to the current remainder, and repeats', () => {
  const a = published('Alpha', 1);
  const b = published('Beta', 2);
  const c = published('Gamma', 3);
  assert.deepEqual(schedule('2026-09-15', 4).map(day => day.lessonId), [a,b,c,a]);
  assert.equal(sql('select count(*) from daily_cs_private.day_snapshots'), '0');
  clock('2026-09-15T00:00:00Z');
  assert.equal(owner('reader.today').data.day.lessonId, a);
  const d = published('Delta', 4);
  assert.deepEqual(schedule('2026-09-16', 4).map(day => day.lessonId), [b,c,d,a]);
  assert.equal(schedule('2026-09-19', 1)[0].cycle, 2);
});

test('the KST rollover freezes the published version, and draft edits never change its body', () => {
  const a = published('Alpha', 1);
  clock('2026-09-14T23:59:59Z');
  assert.equal(owner('reader.today').data.day.status, 'not_started');
  clock('2026-09-15T00:00:00Z');
  const original = owner('reader.today').data.day;
  assert.equal(original.status, 'frozen');
  const updated = owner('lesson.saveDraft', { id:a,expectedRevision:1,title:'Changed draft',category:'synthetic',documentKind:'markdown',
    document:{markdown:'## Changed draft\nThis is an edited draft which is not yet published.'} });
  assert.equal(updated.error, undefined, JSON.stringify(updated));
  assert.deepEqual(owner('reader.today').data.day, original);
  assert.equal(owner('reader.today', {lessonId:a}).data.day.title, 'Alpha');
  assert.equal(owner('lesson.publish', {id:a,expectedRevision:2}).error, undefined);
  assert.deepEqual(owner('reader.today').data.day, original);
  assert.equal(schedule('2026-09-16',1)[0].title, 'Changed draft');
});

test('tomorrow override moves the queued occurrence; an already read override is labelled review', () => {
  const a=published('Alpha',1), b=published('Beta',2), c=published('Gamma',3);
  clock('2026-09-15T00:01:00Z');
  owner('reader.today');
  assert.equal(override('2026-09-16',c).error, undefined);
  assert.deepEqual(schedule('2026-09-16',3).map(day=>day.lessonId),[c,b,a]);
  assert.equal(override('2026-09-16',a).error, undefined);
  const days=schedule('2026-09-16',3);
  assert.deepEqual(days.map(day=>day.lessonId),[a,b,c]);
  assert.equal(days[0].isReview,true);
  assert.equal(override('2026-09-15',b).error.code,'validation_failed');
});

test('unpublish removes future occurrences and its override without mutating history', () => {
  const a=published('Alpha',1), b=published('Beta',2), c=published('Gamma',3);
  clock('2026-09-15T00:01:00Z');
  const before=owner('reader.today').data.day;
  override('2026-09-16',b);
  assert.equal(owner('lesson.unpublish',{id:b,expectedRevision:1}).error,undefined);
  assert.deepEqual(schedule('2026-09-16',2).map(day=>day.lessonId),[c,a]);
  assert.deepEqual(owner('reader.today').data.day,before);
});

test('empty elapsed days stay empty after new publication', () => {
  clock('2026-09-15T00:00:00Z');
  const empty=owner('reader.today').data.day;
  assert.equal(empty.status,'empty');
  const a=published('Alpha',1);
  assert.deepEqual(owner('reader.today').data.day,empty);
  assert.equal(schedule('2026-09-16',1)[0].lessonId,a);
});

test('mail pause leaves the calendar running, with no daily backlog generated on resume', () => {
  published('Alpha',1); published('Beta',2);
  sql('update daily_cs_private.settings set mail_paused=true');
  clock('2026-09-17T00:30:00Z');
  assert.equal(mail('mail.prepareDue').data.candidate,null);
  assert.equal(sql('select count(*) from daily_cs_private.day_snapshots'),'3');
  sql('update daily_cs_private.settings set mail_paused=false');
  assert.equal(mail('mail.prepareDue').data.candidate.date,'2026-09-17');
  assert.equal(sql("select string_agg(scheduled_date::text,',') from daily_cs_private.mail_render_requests where kind='daily'"),'2026-09-17');
  clock('2026-09-18T01:00:01Z');
  assert.equal(mail('mail.prepareDue').data.candidate,null);
  assert.equal(sql('select count(*) from daily_cs_private.day_snapshots'),'4');
});

test('send time edits apply tomorrow without rewriting today and are revision guarded', () => {
  published('Alpha',1);
  clock('2026-09-15T00:30:00Z');
  const day=owner('reader.today').data.day;
  const changed=owner('settings.update',{expectedRevision:1,sendTime:'11:30',mailPaused:false});
  assert.equal(changed.error,undefined,JSON.stringify(changed));
  assert.equal(owner('reader.today').data.day.sendEligibleAt,day.sendEligibleAt);
  assert.equal(new Date(schedule('2026-09-16',1)[0].sendEligibleAt).toISOString(),'2026-09-16T02:30:00.000Z');
  assert.equal(owner('settings.update',{expectedRevision:1,sendTime:'12:00'}).error.code,'conflict');
  clock('2026-09-16T02:29:59Z');
  assert.equal(owner('reader.today').data.day.date,'2026-09-15');
  clock('2026-09-16T02:30:00Z');
  assert.equal(owner('reader.today').data.day.date,'2026-09-16');
});

test('before-start manual tests snapshot the chosen body without freezing the future date and command IDs are idempotent', () => {
  const a=published('Alpha',1), b=published('Beta',2);
  const commandId=randomUUID();
  const request={lessonId:b,commandId,date:'2026-09-15'};
  const first=owner('mail.enqueueTest',request);
  assert.equal(first.error,undefined,JSON.stringify(first));
  assert.equal(owner('mail.enqueueTest',request).data.messageId,first.data.messageId);
  assert.equal(owner('mail.enqueueTest',{...request,lessonId:a}).error.code,'conflict');
  assert.equal(sql('select count(*) from daily_cs_private.day_snapshots'),'0');
  assert.equal(sql('select count(*) from daily_cs_private.manual_snapshots'),'1');
  assert.equal(sql('select count(*) from daily_cs_private.mail_outbox'),'0');
  const prepared=mail('mail.prepareDue').data.candidate;
  assert.equal(prepared.lesson.lessonId,b);
  assert.match(prepared.lesson.document.markdown,/Beta/);
  assert.equal(prepared.id,first.data.messageId);
});

test('owner authentication and mail credentials guard internal materialization before any freezing', () => {
  published('Alpha',1);
  clock('2026-09-15T00:30:00Z');
  assert.equal(mail('mail.prepareDue',{},'synthetic-backup-key').error.code,'forbidden');
  assert.equal(sql('select count(*) from daily_cs_private.day_snapshots'),'0');
  const denied=jsonSql(`set role authenticated; select daily_cs_private.owner_schedule_api('reader.today','{}');`);
  assert.equal(denied.error.code,'forbidden');
  assert.equal(sql("select has_function_privilege('authenticated','daily_cs_private.ensure_mail_due()','EXECUTE')"),'f');
  assert.equal(sql("select has_function_privilege('service_role','daily_cs_private.mail_schedule_api(text,jsonb)','EXECUTE')"),'f');
});

test('private search returns published bodies and excludes drafts and trash', () => {
  const a=published('Alpha',1), b=published('Beta',2);
  owner('lesson.unpublish',{id:b,expectedRevision:1});
  const found=owner('reader.search',{query:'complete body',limit:1});
  assert.equal(found.data.items.length,1);
  assert.equal(found.data.items[0].lessonId,a);
  assert.match(found.data.items[0].document.markdown,/Alpha/);
  assert.equal(owner('reader.today',{lessonId:b}).error.code,'not_found');
});

test('day materialization includes leap day and an explicit empty override consumes no lesson', () => {
  const a=published('Alpha',1), b=published('Beta',2);
  sql(`update daily_cs_private.settings set start_date='2028-02-28';
    update daily_cs_private.schedule_state set last_frozen_date='2028-02-27';
    truncate daily_cs_private.settings_time_events;
    insert into daily_cs_private.settings_time_events values('2028-02-28','09:00',now());`);
  clock('2028-02-27T03:00:00Z');
  assert.equal(override('2028-02-29',null,'empty').error,undefined);
  clock('2028-03-01T00:00:00Z');
  const history=owner('reader.history',{from:'2028-02-28',to:'2028-03-01'}).data.days;
  assert.deepEqual(history.map(day=>day.date),['2028-02-28','2028-02-29','2028-03-01']);
  assert.deepEqual(history.map(day=>day.lessonId),[a,null,b]);
});

test('full shared-renderer mail is materialized before claim and matches its immutable manual body', () => {
  const a=published('Alpha',1);
  const first=owner('mail.enqueueTest',{lessonId:a,commandId:randomUUID()});
  const pending=mail('mail.prepareDue').data.candidate;
  assert.equal(mail('mail.claimDue',{workerId:'synthetic-worker'}).data.message,null);
  const wrong=mail('mail.materialize',{candidateId:pending.id,contentHash:'incorrect',text:'not valid',html:'<p>not valid</p>'});
  assert.equal(wrong.error.code,'validation_failed');
  const rendered=renderMailFromSnapshot(pending.lesson);
  assert.match(rendered.text,/Synthetic complete body/);
  assert.match(rendered.html,/Synthetic complete body/);
  assert.equal(mail('mail.materialize',{candidateId:pending.id,contentHash:pending.contentHash,...rendered}).data.state,'queued');
  const claimed=mail('mail.claimDue',{workerId:'synthetic-worker'}).data.message;
  assert.equal(claimed.id,first.data.messageId);
  assert.equal(claimed.snapshotId,pending.snapshotId);
  assert.equal(claimed.text,rendered.text);
  assert.equal(claimed.html,rendered.html);
  assert.match(claimed.subject,/^\[TEST\]/);
  assert.equal(sql('select count(*) from daily_cs_private.day_snapshots'),'0');
});

test('daily candidate and outbox use the same date snapshot once and reject overdue materialization', () => {
  published('Alpha',1);
  clock('2026-09-15T00:30:00Z');
  const day=owner('reader.today').data.day;
  const pending=mail('mail.prepareDue').data.candidate;
  assert.equal(pending.snapshotId,day.snapshotId);
  assert.equal(pending.contentHash,day.contentHash);
  assert.deepEqual(pending.lesson.document,day.document);
  assert.equal(mail('mail.prepareDue').data.candidate.id,pending.id);
  const rendered=renderMailFromSnapshot(pending.lesson);
  const payload={candidateId:pending.id,contentHash:pending.contentHash,...rendered};
  assert.equal(mail('mail.materialize',payload).data.state,'queued');
  assert.equal(mail('mail.materialize',payload).data.messageId,pending.id);
  assert.equal(sql("select count(*) from daily_cs_private.mail_outbox where kind='daily'"),'1');
  assert.equal(sql(`select command_id from daily_cs_private.mail_outbox where id='${pending.id}'`),pending.id);
  assert.equal(mail('mail.prepareDue').data.candidate,null);
  clock('2026-09-16T00:59:59Z');
  const late=mail('mail.prepareDue').data.candidate;
  clock('2026-09-16T01:00:01Z');
  assert.equal(mail('mail.materialize',{candidateId:late.id,contentHash:late.contentHash,...renderMailFromSnapshot(late.lesson)}).error.code,'conflict');
});

test('manual and date snapshots reject mutation, while render materialization cannot be called by authenticated directly', () => {
  const a=published('Alpha',1);
  owner('mail.enqueueTest',{lessonId:a,commandId:randomUUID()});
  clock('2026-09-15T00:00:00Z');
  owner('reader.today');
  assert.throws(()=>sql("update daily_cs_private.day_snapshots set title='Changed'"),/immutable snapshot/);
  assert.throws(()=>sql("update daily_cs_private.manual_snapshots set title='Changed'"),/immutable snapshot/);
  assert.equal(sql("select has_table_privilege('authenticated','daily_cs_private.day_snapshots','UPDATE')"),'f');
  assert.throws(()=>sql(`${ownerSession} set role authenticated;
    select daily_cs_private.mail_schedule_api('mail.prepareDue','{}');`),/permission denied/);
});

test('resend requires explicit confirmation and preserves the uncertain original with idempotent command identity', () => {
  const a=published('Alpha',1);
  owner('mail.enqueueTest',{lessonId:a,commandId:randomUUID()});
  const pending=mail('mail.prepareDue').data.candidate;
  mail('mail.materialize',{candidateId:pending.id,contentHash:pending.contentHash,...renderMailFromSnapshot(pending.lesson)});
  sql(`update daily_cs_private.mail_outbox set state='uncertain' where id='${pending.id}'`);
  const commandId=randomUUID();
  const request={messageId:pending.id,expectedState:'uncertain',mailboxChecked:true,commandId};
  assert.equal(owner('mail.retryUncertain',{...request,mailboxChecked:false}).error.code,'validation_failed');
  const retried=owner('mail.retryUncertain',request);
  assert.equal(retried.error,undefined,JSON.stringify(retried));
  assert.equal(retried.data.kind,'resend');
  assert.equal(owner('mail.retryUncertain',request).data.messageId,retried.data.messageId);
  assert.equal(owner('mail.retryUncertain',{...request,messageId:randomUUID()}).error.code,'conflict');
  assert.equal(sql(`select state from daily_cs_private.mail_outbox where id='${pending.id}'`),'uncertain');
  assert.equal(sql("select count(*) from daily_cs_private.mail_render_requests where kind='resend'"),'1');
});

test('reorder validates the complete active set and changes only the unconsumed queue', () => {
  const a=published('Alpha',1),b=published('Beta',2),c=published('Gamma',3);
  clock('2026-09-15T00:00:00Z');
  const original=owner('reader.today').data.day;
  let expectedScheduleRevision=Number(sql('select schedule_revision from daily_cs_private.settings'));
  const invalid=owner('schedule.rebuildFuture',{from:'2026-09-16',expectedScheduleRevision,orderedLessonIds:[c,b]});
  assert.equal(invalid.error.code,'validation_failed');
  const changed=owner('schedule.rebuildFuture',{from:'2026-09-16',expectedScheduleRevision,orderedLessonIds:[c,b,a]});
  assert.equal(changed.error,undefined,JSON.stringify(changed));
  assert.deepEqual(schedule('2026-09-16',4).map(day=>day.lessonId),[c,b,c,b]);
  assert.deepEqual(owner('reader.today').data.day,original);
});

test('legacy reader aliases select only the published revision and snapshot links survive later publication', () => {
  const a=published('Alpha',1);
  assert.equal(owner('reader.lesson',{id:'001'}).data.day.lessonId,a);
  assert.equal(owner('reader.lesson',{id:a}).data.day.title,'Alpha');
  owner('mail.enqueueTest',{lessonId:a,commandId:randomUUID()});
  const manual=mail('mail.prepareDue').data.candidate;
  const old=owner('reader.snapshot',{snapshotId:manual.snapshotId}).data.day;
  assert.equal(old.kind,'manual');
  assert.equal(sql('select count(*) from daily_cs_private.day_snapshots'),'0');
  owner('lesson.saveDraft',{id:a,expectedRevision:1,title:'New Alpha',category:'synthetic',documentKind:'markdown',
    document:{markdown:'## New Alpha\nUpdated complete synthetic content for a newer published version.'}});
  owner('lesson.publish',{id:a,expectedRevision:2});
  assert.equal(owner('reader.lesson',{id:'1'}).data.day.title,'New Alpha');
  assert.deepEqual(owner('reader.snapshot',{snapshotId:manual.snapshotId}).data.day,old);
  assert.equal(owner('reader.snapshot',{snapshotId:randomUUID()}).error.code,'not_found');
});

test('structured mail includes every original lesson section through the shared renderer', () => {
  const a=published('Structured Alpha',1);
  const body={id:'001',order:1,week:1,track:'common',category:'synthetic',level:'foundation',
    title:'Structured Alpha',summary:'SUMMARY_MARKER',keywords:['KEYWORD_MARKER'],question:'QUESTION_MARKER',
    explanation:['EXPLANATION_MARKER'],answer:'ANSWER_MARKER',pitfalls:['PITFALL_MARKER'],
    example:{language:'text',description:'EXAMPLE_DESCRIPTION_MARKER',code:'EXAMPLE_CODE_MARKER'},
    followUps:[{question:'FOLLOWUP_QUESTION_MARKER',answer:'FOLLOWUP_ANSWER_MARKER'}],
    quiz:{question:'QUIZ_QUESTION_MARKER',choices:['CHOICE_A','CHOICE_B','CHOICE_C','CHOICE_D'],answerIndex:2,explanation:'QUIZ_EXPLANATION_MARKER'},
    sources:[{title:'SOURCE_TITLE_MARKER',url:'https://example.invalid/source',note:'SOURCE_NOTE_MARKER'}],
    versionNote:'VERSION_MARKER'};
  sql(`update daily_cs_private.lessons set document_kind='structured',draft_document='${JSON.stringify(body)}'::jsonb,published_revision=2 where id='${a}';
    insert into daily_cs_private.lesson_revisions(lesson_id,revision_number,title,category,document_kind,document,content_hash,created_by)
    values('${a}',2,'Structured Alpha','synthetic','structured','${JSON.stringify(body)}',
      daily_cs_private.document_hash('${JSON.stringify(body)}'::jsonb),'11111111-1111-1111-1111-111111111111');`);
  owner('mail.enqueueTest',{lessonId:a,commandId:randomUUID()});
  const candidate=mail('mail.prepareDue').data.candidate;
  const rendered=renderMailFromSnapshot(candidate.lesson);
  for(const marker of ['SUMMARY_MARKER','QUESTION_MARKER','EXPLANATION_MARKER','ANSWER_MARKER','PITFALL_MARKER',
    'EXAMPLE_DESCRIPTION_MARKER','EXAMPLE_CODE_MARKER','FOLLOWUP_QUESTION_MARKER','FOLLOWUP_ANSWER_MARKER',
    'QUIZ_QUESTION_MARKER','CHOICE_C','QUIZ_EXPLANATION_MARKER','SOURCE_TITLE_MARKER','SOURCE_NOTE_MARKER','VERSION_MARKER']) {
    assert.ok(rendered.text.includes(marker),`plain text missing ${marker}`);
    assert.ok(rendered.html.includes(marker),`HTML missing ${marker}`);
  }
  assert.equal(mail('mail.materialize',{candidateId:candidate.id,contentHash:candidate.contentHash,...rendered}).data.state,'queued');
});

test('schedule exports restore an identical future queue and never reactivate uncertain mail', () => {
  const a=published('Alpha',1); published('Beta',2);
  clock('2026-09-15T00:30:00Z');
  owner('reader.today');
  owner('mail.enqueueTest',{lessonId:a,commandId:randomUUID()});
  const pending=mail('mail.prepareDue').data.candidate;
  const originalQueue=schedule('2026-09-16',4);
  const exported=jsonSql('select daily_cs_private.export_schedule_state()');
  assert.equal(JSON.stringify(exported).includes('synthetic-mail-key'),false);
  assert.equal(JSON.stringify(exported).includes('claim_token_hash'),false);
  sql(`truncate daily_cs_private.mail_render_requests,daily_cs_private.mail_outbox,daily_cs_private.manual_snapshots cascade;
    ${ownerSession} select daily_cs_private.restore_schedule_state('${JSON.stringify(exported).replace(/'/g,"''")}'::jsonb);`);
  assert.deepEqual(schedule('2026-09-16',4),originalQueue);
  assert.equal(mail('mail.prepareDue').data.candidate,null);
  assert.equal(mail('mail.materialize',{candidateId:pending.id,contentHash:pending.contentHash,
    ...renderMailFromSnapshot(pending.lesson)}).error.code,'conflict');
  const oldStatus=owner('mail.status',{from:'2026-09-15',days:1}).data.items;
  assert.ok(oldStatus.every(item=>item.state==='uncertain'));
  const retried=owner('mail.retryUncertain',{messageId:pending.id,expectedState:'uncertain',mailboxChecked:true,commandId:randomUUID()});
  assert.equal(retried.error,undefined,JSON.stringify(retried));
  assert.equal(mail('mail.prepareDue').data.candidate.kind,'resend');
});

test('daily claim and begin reject pause or an elapsed window, including a repeated begin ACK', () => {
  published('Alpha',1);
  clock('2026-09-15T00:59:59Z');
  const pending=mail('mail.prepareDue').data.candidate;
  mail('mail.materialize',{candidateId:pending.id,contentHash:pending.contentHash,...renderMailFromSnapshot(pending.lesson)});
  sql('update daily_cs_private.settings set mail_paused=true');
  assert.equal(mail('mail.claimDue',{workerId:'synthetic-worker'}).data.message,null);
  sql('update daily_cs_private.settings set mail_paused=false');
  clock('2026-09-15T01:00:00Z');
  const claimed=mail('mail.claimDue',{workerId:'synthetic-worker'}).data.message;
  assert.equal(claimed.id,pending.id);
  assert.equal(claimed.commandId,pending.id);
  const request={messageId:claimed.id,claimToken:claimed.claimToken,commandId:randomUUID()};
  assert.equal(mail('mail.beginSending',request).data.state,'sending');
  clock('2026-09-15T01:00:01Z');
  assert.equal(mail('mail.beginSending',request).error.code,'conflict');
  assert.equal(mail('mail.ackSent',request).data.state,'sent');
});

test('expired claims are recoverable at the exact lease boundary but sending is never reclaimed', () => {
  published('Alpha',1);
  clock('2026-09-15T00:00:00Z');
  const pending=mail('mail.prepareDue').data.candidate;
  mail('mail.materialize',{candidateId:pending.id,contentHash:pending.contentHash,...renderMailFromSnapshot(pending.lesson)});
  const first=mail('mail.claimDue',{workerId:'first'}).data.message;
  clock('2026-09-15T00:10:00Z');
  const second=mail('mail.claimDue',{workerId:'second'}).data.message;
  assert.ok(second,'claim must be recoverable at the exact ten-minute expiry');
  assert.equal(second.id,first.id);
  assert.notEqual(second.claimToken,first.claimToken);
  assert.equal(mail('mail.beginSending',{messageId:first.id,claimToken:first.claimToken,commandId:randomUUID()}).error.code,'forbidden');
  assert.equal(mail('mail.beginSending',{messageId:second.id,claimToken:second.claimToken,commandId:randomUUID()}).data.state,'sending');
  clock('2026-09-15T00:30:00Z');
  assert.equal(mail('mail.claimDue',{workerId:'third'}).data.message,null);
});

test('a tampered restore cannot rewind the cursor or overwrite an immutable manual snapshot', () => {
  const a=published('Alpha',1);
  clock('2026-09-15T00:30:00Z');
  owner('reader.today');
  owner('mail.enqueueTest',{lessonId:a,commandId:randomUUID()});
  const original=jsonSql('select daily_cs_private.export_schedule_state()');
  const rewound=structuredClone(original);
  rewound.state.last_frozen_date='2026-09-14';
  assert.throws(()=>sql(`${ownerSession} select daily_cs_private.restore_schedule_state('${JSON.stringify(rewound).replace(/'/g,"''")}'::jsonb);`),/cursor must match/);
  const changed=structuredClone(original);
  changed.manualSnapshots[0].title='Tampered title';
  assert.throws(()=>sql(`${ownerSession} select daily_cs_private.restore_schedule_state('${JSON.stringify(changed).replace(/'/g,"''")}'::jsonb);`),/immutable manual snapshot differs/);
  assert.deepEqual(jsonSql('select daily_cs_private.export_schedule_state()'),original);
});

test('concurrent mail preparation and materialization produce one daily request and one outbox row', async () => {
  published('Alpha',1);
  clock('2026-09-15T00:30:00Z');
  function parallelSql(statement) {
    return new Promise((resolve,reject)=>{
      const child=execFile('docker',['exec','-i',container,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres'],
        {encoding:'utf8',maxBuffer:8*1024*1024},(error,stdout)=>error?reject(error):resolve(JSON.parse(stdout.trim().split('\n').at(-1))));
      child.stdin.end(statement);
    });
  }
  const requests=await Promise.all(Array.from({length:4},()=>parallelSql(
    "select public.daily_cs_mail_api('mail.prepareDue','{}','synthetic-mail-key');")));
  const ids=new Set(requests.map(value=>value.data.candidate.id));
  assert.equal(ids.size,1);
  const pending=requests[0].data.candidate;
  const body=JSON.stringify({candidateId:pending.id,contentHash:pending.contentHash,...renderMailFromSnapshot(pending.lesson)}).replace(/'/g,"''");
  const materialized=await Promise.all(Array.from({length:4},()=>parallelSql(
    `select public.daily_cs_mail_api('mail.materialize','${body}'::jsonb,'synthetic-mail-key');`)));
  assert.ok(materialized.every(value=>value.data.messageId===pending.id));
  assert.equal(sql("select count(*) from daily_cs_private.mail_render_requests where kind='daily'"),'1');
  assert.equal(sql("select count(*) from daily_cs_private.mail_outbox where kind='daily'"),'1');
});

test('date input requires explicit ISO dates and schedule tables have no public or owner DML grants', () => {
  for(const date of ['tomorrow','09/15/2026','2026-9-15','2026-02-30']) {
    assert.equal(owner('reader.today',{date}).error.code,'validation_failed');
  }
  for(const table of ['schedule_state','schedule_catalog_order','schedule_queue','settings_time_events',
    'manual_snapshots','mail_render_requests']) {
    assert.equal(sql(`select relrowsecurity from pg_class where oid='daily_cs_private.${table}'::regclass`),'t');
    for(const role of ['anon','authenticated','service_role']) {
      assert.equal(sql(`select has_table_privilege('${role}','daily_cs_private.${table}','INSERT,UPDATE,DELETE')`),'f');
    }
  }
});

test('the complete owner export restores into an empty catalog with schedule metadata and the next cycle intact', () => {
  published('Alpha',1); published('Beta',2);
  clock('2026-09-17T00:30:00Z');
  const current=owner('reader.today').data.day;
  assert.equal(current.cycle,2);
  const upcoming=schedule('2026-09-18',4);
  const exported=owner('export.create',{includeTrash:true});
  assert.equal(exported.error,undefined,JSON.stringify(exported));
  const envelope=exported.data.export;
  assert.equal(envelope.scheduleState.state.cycle,2);
  sql(`truncate daily_cs_private.mail_render_requests,daily_cs_private.mail_outbox,
    daily_cs_private.manual_snapshots,daily_cs_private.day_snapshots,daily_cs_private.schedule_queue,
    daily_cs_private.schedule_catalog_order,daily_cs_private.schedule_overrides,
    daily_cs_private.lesson_revisions,daily_cs_private.lessons cascade;
    update daily_cs_private.schedule_state set last_frozen_date='2026-09-14',cycle=1;`);
  const restored=owner('backup.restore',{expectedExportHash:envelope.hash,export:envelope});
  assert.equal(restored.error,undefined,JSON.stringify(restored));
  assert.deepEqual(owner('reader.today').data.day,current);
  assert.deepEqual(schedule('2026-09-18',4),upcoming);
});
