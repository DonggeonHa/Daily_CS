create or replace function daily_cs_private.commit_simple_lessons(lessons jsonb, uid uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  item jsonb;
  lesson_row daily_cs_private.lessons;
  lesson_uuid uuid;
  incoming_hash text;
  current_hash text;
  next_revision integer;
  imported_count integer := 0;
begin
  if jsonb_typeof(lessons) <> 'array' then
    raise exception using errcode = '22023', message = 'validation_failed: lessons array is required';
  end if;

  for item in select value from jsonb_array_elements(lessons) loop
    perform daily_cs_private.validate_publish_document('structured', item);
  end loop;

  for item in select value from jsonb_array_elements(lessons) loop
    incoming_hash := daily_cs_private.document_hash(item);

    select *
    into lesson_row
    from daily_cs_private.lessons
    where legacy_id = (item ->> 'order')::integer
    for update;

    if not found then
      lesson_uuid := extensions.gen_random_uuid();
      insert into daily_cs_private.lessons (
        id, owner_uid, legacy_id, title, category, state, document_kind,
        draft_document, published_revision, draft_revision, row_revision
      )
      values (
        lesson_uuid,
        uid,
        (item ->> 'order')::integer,
        item ->> 'title',
        item ->> 'category',
        'published',
        'structured',
        item,
        1,
        1,
        1
      );

      insert into daily_cs_private.lesson_revisions (
        lesson_id, revision_number, title, category, document_kind, document, content_hash, created_by
      )
      values (
        lesson_uuid,
        1,
        item ->> 'title',
        item ->> 'category',
        'structured',
        item,
        incoming_hash,
        uid
      );
    else
      select content_hash
      into current_hash
      from daily_cs_private.lesson_revisions
      where lesson_id = lesson_row.id
        and revision_number = lesson_row.published_revision;

      if current_hash is not null and current_hash = incoming_hash then
        next_revision := lesson_row.published_revision;
      else
        select coalesce(max(revision_number), 0) + 1
        into next_revision
        from daily_cs_private.lesson_revisions
        where lesson_id = lesson_row.id;

        insert into daily_cs_private.lesson_revisions (
          lesson_id, revision_number, title, category, document_kind, document, content_hash, created_by
        )
        values (
          lesson_row.id,
          next_revision,
          item ->> 'title',
          item ->> 'category',
          'structured',
          item,
          incoming_hash,
          uid
        );
      end if;

      update daily_cs_private.lessons
      set owner_uid = uid,
          title = item ->> 'title',
          category = item ->> 'category',
          state = 'published',
          document_kind = 'structured',
          draft_document = item,
          published_revision = next_revision,
          draft_revision = daily_cs_private.lessons.draft_revision + 1,
          row_revision = daily_cs_private.lessons.row_revision + 1,
          updated_at = now()
      where id = lesson_row.id
      returning id into lesson_uuid;
    end if;

    imported_count := imported_count + 1;
  end loop;

  return jsonb_build_object('lessons', imported_count);
end;
$$;

revoke all on function daily_cs_private.commit_simple_lessons(jsonb, uuid) from public, anon, authenticated;
