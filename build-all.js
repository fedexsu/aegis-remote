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

// Native helper binaries are compiled from C# with the in-box csc.exe. They MUST
// be signed too — the input INJECTOR especially: unsigned code that synthesizes
// mouse/keyboard is the #1 antivirus false positive and is exactly what causes
// the "Control blocked - antivirus removed the input helper" banner. We build
// (and sign) them here, BEFORE the bundle + agent are built, so the signed
// binaries are the ones that ship in the installer AND ride the self-update
// bundle (see scripts/build-agent-bundle.js).
const CSC = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
].find((p) => fs.existsSync(p));
const NATIVE = [
  { name: 'injector', script: 'agent/injector/build-injector.js', exe: 'agent/injector/injector.exe' },
  { name: 'blanker', script: 'agent/blanker/build-blanker.js', exe: 'agent/blanker/blanker.exe' },
  { name: 'sdcap', script: 'agent/sdcap/build-sdcap.js', exe: 'agent/sdcap/sdcap.exe' },
  { name: 'runas', src: 'agent/runas/RunAsUser.cs', exe: 'agent/runas/RunAsUser.exe' },
];
console.log('0/5  Building + signing native helpers...');
for (const n of NATIVE) {
  try {
    if (n.script) run(process.execPath, [n.script]);
    else if (CSC) run(CSC, ['/nologo', '/optimize+', '/target:exe', '/out:' + n.exe, n.src]);
  } catch (e) { console.warn(`   (could not build ${n.name}: ${e.message})`); }
  sign(n.exe); // no-op if signing not configured, or if the exe didn't build
}

console.log('1/5  Building agent self-update bundle...');
run(process.execPath, ['scripts/build-agent-bundle.js']);

console.log('2/5  Building agent...');
run(process.execPath, ['build-agent.js']);

console.log('3/5  Signing agent...');
sign('release/Aegis/Aegis.exe');

console.log('4/5  Compiling installer (NSIS per-user — truly silent on double-click)...');
// Use NSIS (installer.nsi) instead of Inno Setup (installer.iss). NSIS's
// `SilentInstall silent` directive makes a plain double-click of the raw .exe
// install with NO window at all, which Inno 6.7+ cannot do (its RedirectionGuard
// blocks the self-relaunch /VERYSILENT trick that used to make Inno silent).
// Same output filename (release/support.exe), same per-user install location,
// no admin — the switch is invisible to downstream deploy / Backblaze flows.
const makensis = [
  'C:\\Program Files (x86)\\NSIS\\makensis.exe',
  'C:\\Program Files\\NSIS\\makensis.exe',
].find((p) => fs.existsSync(p));
if (!makensis) { console.error('makensis.exe (NSIS 3+) not found.'); process.exit(1); }
run(makensis, ['installer.nsi']);

console.log('5/5  Signing installer...');
sign('release/support.exe');

console.log('\nDone: release/support.exe' + (signingConfigured() ? ' (signed)' : ' (UNSIGNED — configure signing to remove SmartScreen/SAC)'));
