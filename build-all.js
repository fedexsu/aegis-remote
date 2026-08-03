'use strict';

// One-command release build: agent -> (sign) -> installer -> (sign).
// Signing runs automatically WHEN configured (signing/metadata.json filled in
// and AZURE_* env vars set); otherwise it's skipped so builds still work.
//
//   node build-all.js   (or: npm run build:all)

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT });

function signingConfigured() {
  try {
    const m = fs.readFileSync(path.join(ROOT, 'signing', 'metadata.json'), 'utf8');
    if (m.includes('<REGION>') || m.includes('<YOUR')) return false;
    return !!(process.env.AZURE_TENANT_ID && process.env.AZURE_CLIENT_ID && process.env.AZURE_CLIENT_SECRET);
  } catch { return false; }
}
function sign(file) {
  if (!signingConfigured()) { console.log(`   (signing not configured — skipping ${file})`); return; }
  run('powershell', ['-ExecutionPolicy', 'Bypass', '-File', 'signing/sign.ps1', file]);
}

console.log('1/4  Building agent...');
run(process.execPath, ['build-agent.js']);

console.log('2/4  Signing agent...');
sign('release/Aegis/Aegis.exe');

console.log('3/4  Compiling installer...');
const iscc = [
  'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe',
  'C:\\Program Files\\Inno Setup 6\\ISCC.exe',
].find((p) => fs.existsSync(p));
if (!iscc) { console.error('ISCC.exe (Inno Setup 6) not found.'); process.exit(1); }
run(iscc, ['installer.iss']);

console.log('4/4  Signing installer...');
sign('release/AegisSetup.exe');

console.log('\nDone: release/AegisSetup.exe' + (signingConfigured() ? ' (signed)' : ' (UNSIGNED — configure signing to remove SmartScreen/SAC)'));
