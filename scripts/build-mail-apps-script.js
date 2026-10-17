'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const sourcePath = path.join(root, 'apps-script', 'src', 'mail-sender.gs');
const distDir = path.join(root, 'apps-script', 'dist');
const outputPath = path.join(distDir, 'Code.gs');

function buildMailAppsScript() {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Missing Apps Script source: ${sourcePath}`);
  }
  fs.mkdirSync(distDir, { recursive: true });
  const source = fs.readFileSync(sourcePath, 'utf8');
  fs.writeFileSync(
    outputPath,
    [
      '// Daily_CS v2 managed Apps Script build.',
      '// Source: apps-script/src/mail-sender.gs',
      '// Do not paste secrets into this file.',
      source,
      '',
    ].join('\n'),
  );
  return outputPath;
}

if (require.main === module) {
  const built = buildMailAppsScript();
  console.log(`Built ${path.relative(root, built)}`);
}

module.exports = { buildMailAppsScript };
