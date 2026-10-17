const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { exportBackup, hashJson } = require('../scripts/export-backup');
const {
  buildImportPayload,
  importLessons,
  readLessonSummaries,
  summarizePayload,
  writeImportEvidence,
} = require('../scripts/import-lessons-preview');
const { restoreBackup } = require('../scripts/restore-backup-preview');
const { createOwnerApiClient, writeJsonAtomic, readJsonFile } = require('../scripts/lib/owner-api-client');

test('backup hash is stable for identical JSON payloads', () => {
  const payload = { lessons: [{ id: '001', title: 'Synthetic' }], settings: { startDate: '2026-09-15' } };

  assert.equal(hashJson(payload), hashJson(payload));
  assert.notEqual(hashJson(payload), hashJson({ ...payload, settings: { startDate: '2026-09-16' } }));
});

test('writeJsonAtomic writes a parseable private backup envelope', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-cs-backup-'));
  const filePath = path.join(dir, 'backup.json');
  const envelope = { schemaVersion: 1, hash: 'abc', data: { synthetic: true } };

  writeJsonAtomic(filePath, envelope);

  assert.deepEqual(readJsonFile(filePath), envelope);
});

test('backup export uses backup API key header and stores server export hash', async () => {
  const originalFetch = global.fetch;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-cs-export-'));
  const output = path.join(dir, 'backup.json');
  process.env.DAILY_CS_BACKUP_API_URL = 'https://project.supabase.co/functions/v1/backup-api';
  process.env.DAILY_CS_BACKUP_API_KEY = 'fake-backup-key';
  global.fetch = async (url, request) => {
    assert.equal(url, process.env.DAILY_CS_BACKUP_API_URL);
    assert.equal(request.headers['X-Daily-CS-Backup-Key'], 'fake-backup-key');
    assert.equal(request.headers.authorization, undefined);
    assert.deepEqual(JSON.parse(request.body), { action: 'backup.export', payload: {} });
    return {
      status: 200,
      text: async () => JSON.stringify({ data: { export: { hash: 'server-hash', lessons: [] } } }),
    };
  };
  try {
    const result = await exportBackup({ output });
    assert.equal(result.hash, 'server-hash');
    assert.deepEqual(readJsonFile(output), {
      schemaVersion: 1,
      hash: 'server-hash',
      export: { hash: 'server-hash', lessons: [] },
    });
  } finally {
    global.fetch = originalFetch;
    delete process.env.DAILY_CS_BACKUP_API_URL;
    delete process.env.DAILY_CS_BACKUP_API_KEY;
  }
});

test('import preview reads only lesson summaries from private archive source', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-cs-import-'));
  fs.writeFileSync(
    path.join(dir, '001.json'),
    JSON.stringify({
      id: '001',
      order: 1,
      title: 'Synthetic title',
      category: 'database',
      answer: 'Sensitive full answer should not be returned',
    }),
  );
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');

  const summaries = readLessonSummaries(dir);

  assert.deepEqual(summaries, [
    {
      id: '001',
      legacyId: 1,
      order: 1,
      title: 'Synthetic title',
      category: 'database',
      hasAnswer: true,
      hasSources: false,
    },
  ]);
});

function writeSyntheticLessons(dir, count = 365) {
  const lessons = Array.from({ length: count }, (_, index) => ({
    id: String(index + 1).padStart(3, '0'),
    order: index + 1,
    track: 'common',
    category: 'database',
    level: 'foundation',
    week: Math.floor(index / 7) + 1,
    title: `Synthetic ${index + 1}`,
    summary: 'Synthetic summary',
    keywords: ['synthetic'],
    question: 'Synthetic question?',
    answer: 'Synthetic answer',
    explanation: ['Synthetic explanation'],
    example: { language: 'sql', code: 'select 1;', description: 'Synthetic example' },
    pitfalls: ['Synthetic pitfall'],
    followUps: [{ question: 'Follow?', answer: 'Answer.' }],
    quiz: { question: 'Quiz?', choices: ['A', 'B'], answerIndex: 0, explanation: 'Because.' },
    sources: [{ title: 'Synthetic source', url: 'https://example.invalid', note: 'Synthetic note' }],
    versionNote: 'Synthetic version note',
  }));
  for (const lesson of lessons) {
    fs.writeFileSync(path.join(dir, `${lesson.id}.json`), JSON.stringify(lesson));
  }
  return lessons;
}

test('import payload preserves structured lessons with derived legacy ids', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-cs-import-commit-'));
  writeSyntheticLessons(dir);

  const payload = buildImportPayload(dir);
  const summary = summarizePayload(payload);

  assert.equal(payload.schemaVersion, 2);
  assert.equal(payload.lessons.length, 365);
  assert.equal(payload.lessons[0].legacyId, 1);
  assert.equal(payload.lessons[364].legacyId, 365);
  assert.equal(summary.fieldCounts.sources, 365);
  assert.equal(summary.sourceCounts['1'], 365);
  assert.ok(summary.previewBodyBytes > 0);
});

test('import evidence writes hash and field summary without lesson bodies', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-cs-import-evidence-'));
  const output = path.join(dir, 'evidence.json');
  writeSyntheticLessons(dir);

  const evidence = writeImportEvidence(dir, output);
  const written = readJsonFile(output);

  assert.equal(written.summary.lessonCount, 365);
  assert.equal(written.summary.payloadHash, evidence.summary.payloadHash);
  assert.equal(JSON.stringify(written).includes('Synthetic answer'), false);
});

test('import commit previews first and reuses server hash for the exact payload', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-cs-import-commit-'));
  writeSyntheticLessons(dir);
  const calls = [];
  const client = {
    request: async (action, payload) => {
      calls.push({ action, payload });
      if (action === 'import.preview') {
        return { hash: 'server-preview-hash', lessons: payload.lessons.length, mode: 'simpleLessons' };
      }
      assert.equal(action, 'import.commit');
      return { status: 'import-committed' };
    },
  };

  const result = await importLessons(dir, { commit: true, client });

  assert.equal(result.status, 'import-committed');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].action, 'import.preview');
  assert.equal(calls[1].payload.expectedExportHash, 'server-preview-hash');
  assert.deepEqual(calls[1].payload.lessons, calls[0].payload.lessons);
});

test('import commit does not mutate when preview reports validation failure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-cs-import-preview-fail-'));
  writeSyntheticLessons(dir);
  const calls = [];
  const client = {
    request: async (action) => {
      calls.push(action);
      throw new Error('import.preview failed: validation_failed');
    },
  };

  await assert.rejects(() => importLessons(dir, { commit: true, client }), /validation_failed/);

  assert.deepEqual(calls, ['import.preview']);
});

test('import commit surfaces hash mismatch and conflict responses from owner API', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-cs-import-errors-'));
  writeSyntheticLessons(dir);
  const mismatchClient = {
    request: async (action) => {
      if (action === 'import.preview') return { hash: 'server-preview-hash' };
      throw new Error('import.commit failed: lesson import hash mismatch');
    },
  };
  await assert.rejects(() => importLessons(dir, { commit: true, client: mismatchClient }), /hash mismatch/);

  const conflictClient = {
    request: async (action) => {
      if (action === 'import.preview') return { hash: 'server-preview-hash' };
      throw new Error('import.commit failed: restore conflicts with existing immutable day snapshots');
    },
  };
  await assert.rejects(() => importLessons(dir, { commit: true, client: conflictClient }), /conflicts/);
});

test('owner API client rejects bodies over the configured size before fetch', async () => {
  const originalFetch = global.fetch;
  process.env.DAILY_CS_OWNER_API_URL = 'https://project.supabase.co/functions/v1/owner-api';
  process.env.DAILY_CS_OWNER_ACCESS_TOKEN = 'owner-access-token';
  let fetched = false;
  global.fetch = async () => {
    fetched = true;
    return { status: 200, text: async () => JSON.stringify({ data: {} }) };
  };
  try {
    const client = createOwnerApiClient({ maxBodyBytes: 20 });
    await assert.rejects(() => client.request('import.preview', { lessons: [{ id: '001' }] }), /request body is/);
    assert.equal(fetched, false);
  } finally {
    global.fetch = originalFetch;
    delete process.env.DAILY_CS_OWNER_API_URL;
    delete process.env.DAILY_CS_OWNER_ACCESS_TOKEN;
  }
});

test('owner API client default accepts a compact 365 lesson restore body over 4 MiB', async () => {
  const originalFetch = global.fetch;
  process.env.DAILY_CS_OWNER_API_URL = 'https://project.supabase.co/functions/v1/owner-api';
  process.env.DAILY_CS_OWNER_ACCESS_TOKEN = 'owner-access-token';
  let bodyBytes = 0;
  global.fetch = async (url, request) => {
    assert.equal(url, process.env.DAILY_CS_OWNER_API_URL);
    bodyBytes = Buffer.byteLength(request.body, 'utf8');
    return {
      status: 200,
      text: async () => JSON.stringify({ data: { status: 'restore-committed' } }),
    };
  };
  try {
    const client = createOwnerApiClient();
    const result = await client.request('backup.restore', {
      expectedExportHash: 'restore-hash',
      export: { lessons: [{ id: '001', answer: 'x'.repeat(4_840_000) }], revisions: [] },
    });
    assert.equal(result.status, 'restore-committed');
    assert.ok(bodyBytes > 4 * 1024 * 1024);
  } finally {
    global.fetch = originalFetch;
    delete process.env.DAILY_CS_OWNER_API_URL;
    delete process.env.DAILY_CS_OWNER_ACCESS_TOKEN;
  }
});

test('backup restore defaults to local preview and commits through owner API only with commit flag', async () => {
  const originalFetch = global.fetch;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-cs-restore-'));
  const input = path.join(dir, 'backup.json');
  const backup = {
    schemaVersion: 1,
    hash: 'restore-hash',
    export: { lessons: [{ id: '001' }], revisions: [] },
  };
  writeJsonAtomic(input, backup);

  const preview = await restoreBackup(input);
  assert.equal(preview.status, 'preview-only');
  assert.equal(preview.lessonCount, 1);

  process.env.DAILY_CS_OWNER_API_URL = 'https://project.supabase.co/functions/v1/owner-api';
  process.env.DAILY_CS_OWNER_ACCESS_TOKEN = 'owner-access-token';
  global.fetch = async (url, request) => {
    assert.equal(url, process.env.DAILY_CS_OWNER_API_URL);
    assert.equal(request.headers.authorization, 'Bearer owner-access-token');
    const body = JSON.parse(request.body);
    assert.equal(body.action, 'backup.restore');
    assert.equal(body.payload.expectedExportHash, 'restore-hash');
    assert.deepEqual(body.payload.export, backup.export);
    return {
      status: 200,
      text: async () => JSON.stringify({ data: { status: 'restore-committed' } }),
    };
  };
  try {
    const result = await restoreBackup(input, { commit: true });
    assert.equal(result.status, 'restore-committed');
  } finally {
    global.fetch = originalFetch;
    delete process.env.DAILY_CS_OWNER_API_URL;
    delete process.env.DAILY_CS_OWNER_ACCESS_TOKEN;
  }
});

test('backup restore rejects a mismatched local envelope before owner API commit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-cs-restore-mismatch-'));
  const input = path.join(dir, 'backup.json');
  writeJsonAtomic(input, {
    schemaVersion: 1,
    hash: 'restore-hash',
    export: { hash: 'different-hash', lessons: [] },
  });

  await assert.rejects(() => restoreBackup(input, { commit: true, client: { request: async () => ({}) } }), /hash does not match/);
});

test('backup export accepts injected fake client for no-live API verification', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-cs-export-client-'));
  const output = path.join(dir, 'backup.json');
  const calls = [];
  const client = {
    request: async (action, payload) => {
      calls.push({ action, payload });
      return { export: { hash: 'server-hash', lessons: [] } };
    },
  };

  const result = await exportBackup({ output, client });

  assert.equal(result.hash, 'server-hash');
  assert.deepEqual(calls, [{ action: 'backup.export', payload: {} }]);
});
