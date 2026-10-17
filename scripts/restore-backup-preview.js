'use strict';

const { createOwnerApiClient, readJsonFile, writeJsonAtomic } = require('./lib/owner-api-client');

function readBackupEnvelope(inputPath) {
  const backup = readJsonFile(inputPath);
  if (!backup || backup.schemaVersion !== 1 || !backup.hash || !backup.export) {
    throw new Error('Backup file must be a Daily_CS v2 backup envelope');
  }
  if (backup.export.hash && backup.export.hash !== backup.hash) {
    throw new Error('Backup envelope hash does not match export hash');
  }
  return backup;
}

async function restoreBackup(inputPath, options = {}) {
  const backup = readBackupEnvelope(inputPath);
  const preview = {
    status: options.commit ? 'commit-ready' : 'preview-only',
    expectedExportHash: backup.hash,
    schemaVersion: backup.schemaVersion,
    lessonCount: Array.isArray(backup.export.lessons) ? backup.export.lessons.length : 0,
    revisionCount: Array.isArray(backup.export.revisions) ? backup.export.revisions.length : 0,
  };
  if (options.output) {
    writeJsonAtomic(options.output, preview);
  }
  if (!options.commit) {
    return preview;
  }
  const client = options.client || createOwnerApiClient({ maxBodyBytes: options.maxBodyBytes });
  return client.request('backup.restore', {
    expectedExportHash: backup.hash,
    export: backup.export,
  });
}

if (require.main === module) {
  const inputFlag = process.argv.indexOf('--input');
  const outputFlag = process.argv.indexOf('--output');
  const input = inputFlag === -1 ? null : process.argv[inputFlag + 1];
  const output = outputFlag === -1 ? null : process.argv[outputFlag + 1];
  const commit = process.argv.includes('--commit');
  if (!input) {
    console.error('Usage: node scripts/restore-backup-preview.js --input <backup.json> [--output preview.json] [--commit]');
    process.exit(2);
  }
  restoreBackup(input, { output, commit })
    .then((result) => {
      const status = result && result.status ? result.status : commit ? 'restore-committed' : 'preview-only';
      console.log(`Backup restore ${status}`);
    })
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}

module.exports = { readBackupEnvelope, restoreBackup };
