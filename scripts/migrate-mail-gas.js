'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildMailAppsScript } = require('./build-mail-apps-script');

function migrationChecklist() {
  const builtPath = buildMailAppsScript();
  return {
    codeGs: path.relative(process.cwd(), builtPath),
    dryRunFunction: 'dryRunDailyCsV2Migration',
    preflightFunction: 'preflightDailyCsV2Mail',
    apiTestFunction: 'testDailyCsV2Api',
    installFunction: 'installDailyCsV2Poller',
    pollerFunction: 'dailyCsV2Poller',
    requiredProperties: [
      'DAILY_CS_MAIL_API_URL',
      'DAILY_CS_MAIL_API_KEY',
      'RECIPIENT_EMAIL',
    ],
  };
}

if (require.main === module) {
  const checklist = migrationChecklist();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(checklist, null, 2)}\n`);
  } else {
    console.log(`Built ${checklist.codeGs}`);
    console.log(`Run ${checklist.dryRunFunction} in Apps Script before ${checklist.installFunction}.`);
    console.log(`Required script properties: ${checklist.requiredProperties.join(', ')}`);
  }
  if (!fs.existsSync(path.resolve(checklist.codeGs))) {
    process.exit(1);
  }
}

module.exports = { migrationChecklist };
