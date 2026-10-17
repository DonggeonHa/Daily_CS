'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { createBackupApiClient, writeJsonAtomic } = require('./lib/owner-api-client');

function hashJson(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function exportBackup(options = {}) {
  const client = options.client || createBackupApiClient({ maxBodyBytes: options.maxBodyBytes });
  const data = await client.request('backup.export', {});
  const exported = data && data.export ? data.export : data;
  if (!exported || typeof exported !== 'object') {
    throw new Error('backup.export did not return an export envelope');
  }
  const envelope = {
    schemaVersion: 1,
    hash: exported.hash || hashJson(exported),
    export: exported,
  };
  if (options.output) {
    writeJsonAtomic(options.output, envelope);
    return { output: path.resolve(options.output), hash: envelope.hash };
  }
  return { hash: envelope.hash };
}

if (require.main === module) {
  const outputFlag = process.argv.indexOf('--output');
  const output = outputFlag === -1 ? null : process.argv[outputFlag + 1];
  if (!output) {
    console.error('Usage: node scripts/export-backup.js --output <private-backup.json>');
    process.exit(2);
  }
  exportBackup({ output })
    .then((result) => {
      console.log(`Backup exported hash=${result.hash}`);
    })
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}

module.exports = { exportBackup, hashJson };
