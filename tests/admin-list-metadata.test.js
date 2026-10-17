const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const migration = fs.readFileSync(path.join(root, "supabase/migrations/20261017053118_daily_cs_v2_admin_list_metadata.sql"), "utf8");

test("list metadata migration adds only summary fields inside the guarded list branch", () => {
  // Given the immutable API migration already contains owner and session guards.
  const previous = fs.readFileSync(path.join(root, "supabase/migrations/20260914151041_daily_cs_v2_tombstone_purge.sql"), "utf8");
  // When the additive migration locates the current list branch.
  const listBranch = previous.split("if action = 'lesson.list' then")[1].split("end if;")[0];
  // Then its known anchor is unique, and only lightweight metadata is added.
  assert.equal(listBranch.split("'category', category,").length - 1, 1);
  for (const key of ["level", "summary", "keywords"]) assert.match(migration, new RegExp(`'${key}', draft_document`));
  assert.match(migration, /pg_get_functiondef/);
  assert.match(migration, /raise exception/);
  assert.match(migration, /overlay\(api_definition/);
  assert.doesNotMatch(migration, /security definer|grant |revoke |drop function|draftDocument.*draft_document/i);
});
