'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { createBackupApiClient, readJsonFile } = require('./lib/owner-api-client');

async function reportBackup(report, client) {
  if (!/^[0-9]{1,30}$/.test(report.runId) || !['success', 'failure'].includes(report.status)
    || (report.status === 'success' && (!/^[0-9a-f]{64}$/.test(report.contentHash) || !/^[0-9a-f]{40}$/.test(report.commitSha)))) {
    throw new Error('Invalid backup report');
  }
  const payload = report.status === 'success'
    ? { runId: report.runId, status: report.status, contentHash: report.contentHash, commitSha: report.commitSha }
    : { runId: report.runId, status: report.status, errorCode: 'workflow_failed' };
  return (client || createBackupApiClient()).request('backup.report', payload);
}

if (require.main === module) {
  Promise.resolve().then(() => {
    const status = process.argv[2];
    const report = { runId: process.env.GITHUB_RUN_ID, status };
    if (status === 'success') {
      report.contentHash = readJsonFile(path.join(process.env.DAILY_CS_BACKUP_DIR || 'private-backups', 'latest.json')).hash;
      report.commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    }
    return reportBackup(report);
  }).then(() => console.log('Backup result recorded.')).catch(() => {
    console.error('Backup result reporting failed.');
    process.exitCode = 1;
  });
}

module.exports = { reportBackup };
