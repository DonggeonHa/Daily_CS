'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { byteLength, createOwnerApiClient, writeJsonAtomic } = require('./lib/owner-api-client');

function hashJson(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function listJsonFiles(dir) {
  const root = path.resolve(dir);
  return fs.readdirSync(root)
    .filter((name) => /^\d{3}\.json$/.test(name))
    .sort()
    .map((name) => path.join(root, name));
}

function readLessons(dir) {
  return listJsonFiles(dir).map((filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

function legacyIdForLesson(lesson) {
  const numericId = Number.parseInt(lesson.id, 10);
  if (!Number.isInteger(numericId) || numericId !== lesson.order) {
    throw new Error(`Lesson ${lesson.id || '<missing>'} must have matching numeric id and order`);
  }
  return numericId;
}

function toImportLesson(lesson) {
  return {
    legacyId: legacyIdForLesson(lesson),
    ...lesson,
  };
}

function buildImportPayload(sourceDir) {
  const lessons = readLessons(sourceDir).map(toImportLesson);
  if (lessons.length !== 365) {
    throw new Error(`Expected 365 lessons, found ${lessons.length}`);
  }
  return {
    schemaVersion: 2,
    lessons,
  };
}

function readLessonSummaries(dir) {
  return readLessons(dir).map((lesson) => ({
    id: lesson.id,
    legacyId: legacyIdForLesson(lesson),
    order: lesson.order,
    title: lesson.title,
    category: lesson.category,
    hasAnswer: typeof lesson.answer === 'string' && lesson.answer.length > 0,
    hasSources: Array.isArray(lesson.sources) && lesson.sources.length > 0,
  }));
}

function summarizePayload(payload) {
  const fieldCounts = {};
  const sourceCounts = {};
  for (const lesson of payload.lessons) {
    for (const field of Object.keys(lesson)) {
      fieldCounts[field] = (fieldCounts[field] || 0) + 1;
    }
    const sourceLength = Array.isArray(lesson.sources) ? lesson.sources.length : 0;
    sourceCounts[sourceLength] = (sourceCounts[sourceLength] || 0) + 1;
  }
  const body = JSON.stringify({ action: 'import.preview', payload: { lessons: payload.lessons } });
  return {
    schemaVersion: payload.schemaVersion,
    lessonCount: payload.lessons.length,
    firstLegacyId: payload.lessons[0] ? payload.lessons[0].legacyId : null,
    lastLegacyId: payload.lessons[payload.lessons.length - 1] ? payload.lessons[payload.lessons.length - 1].legacyId : null,
    payloadHash: hashJson(payload),
    previewBodyBytes: byteLength(body),
    fieldCounts,
    sourceCounts,
  };
}

function writeImportEvidence(sourceDir, outputPath) {
  const payload = buildImportPayload(sourceDir);
  const evidence = {
    generatedAt: new Date().toISOString(),
    sourceDir: path.resolve(sourceDir),
    summary: summarizePayload(payload),
  };
  writeJsonAtomic(outputPath, evidence);
  return evidence;
}

async function importLessons(sourceDir, options = {}) {
  const payload = buildImportPayload(sourceDir);
  const client = options.client || createOwnerApiClient({ maxBodyBytes: options.maxBodyBytes });
  const preview = await client.request('import.preview', { lessons: payload.lessons });
  if (!options.commit) {
    return preview;
  }
  if (!preview || typeof preview.hash !== 'string' || preview.hash.length === 0) {
    throw new Error('import.preview did not return a commit hash');
  }
  return client.request('import.commit', {
    expectedExportHash: preview.hash,
    lessons: payload.lessons,
  });
}

if (require.main === module) {
  const sourceFlag = process.argv.indexOf('--source');
  const evidenceFlag = process.argv.indexOf('--evidence-output');
  const source = sourceFlag === -1 ? null : process.argv[sourceFlag + 1];
  const evidenceOutput = evidenceFlag === -1 ? null : process.argv[evidenceFlag + 1];
  const commit = process.argv.includes('--commit');
  const evidenceOnly = process.argv.includes('--evidence-only');
  if (!source) {
    console.error('Usage: node scripts/import-lessons-preview.js --source <private-archive/content/lessons> [--evidence-output <ignored-summary.json>] [--evidence-only] [--commit]');
    process.exit(2);
  }
  if (evidenceOutput) {
    const evidence = writeImportEvidence(source, evidenceOutput);
    console.log(`Import evidence lessons=${evidence.summary.lessonCount} hash=${evidence.summary.payloadHash} bytes=${evidence.summary.previewBodyBytes}`);
  }
  if (evidenceOnly) {
    process.exit(0);
  }
  importLessons(source, { commit })
    .then((result) => {
      const status = result && result.status ? result.status : commit ? 'import-committed' : 'preview-ok';
      console.log(`Import ${status}`);
    })
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}

module.exports = {
  buildImportPayload,
  hashJson,
  importLessons,
  readLessons,
  readLessonSummaries,
  summarizePayload,
  toImportLesson,
  writeImportEvidence,
};
