'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { exportBackup } = require('./export-backup');
const { readJsonFile } = require('./lib/owner-api-client');

async function main() {
  const backupDir = process.env.DAILY_CS_BACKUP_DIR || 'private-backups';
  const latestPath = path.join(backupDir, 'latest.json');
  const datedPath = path.join(backupDir, `${new Date().toISOString().slice(0, 10)}.json`);
  const result = await exportBackup({ output: latestPath });
  let changed = true;
  if (fs.existsSync(datedPath)) {
    const existing = readJsonFile(datedPath);
    changed = existing.hash !== result.hash;
  }
  if (changed) {
    fs.copyFileSync(latestPath, datedPath);
    console.log(`Backup changed hash=${result.hash}`);
  } else {
    console.log(`Backup unchanged hash=${result.hash}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
