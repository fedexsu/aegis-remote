'use strict';

// Compiles KeepAwake.cs → keepawake.exe with the .NET Framework C# compiler
// shipped in Windows (same pattern as the other native helpers in this repo:
// injector, blanker, sdcap).
//
//   node agent/keepawake/build-keepawake.js

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const SRC = path.join(DIR, 'KeepAwake.cs');
const OUT = path.join(DIR, 'keepawake.exe');

const CSC_CANDIDATES = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
];

const csc = CSC_CANDIDATES.find((p) => fs.existsSync(p));
if (!csc) { console.error('csc.exe not found. Expected .NET Framework 4 compiler.'); process.exit(1); }

try {
  // Plain console exe. No window flash on run (we hide it when deployed via the
  // dashboard — the agent spawns with CREATE_NO_WINDOW).
  execFileSync(csc, [
    '/nologo', '/optimize+', '/target:exe',
    '/out:' + OUT,
    SRC,
  ], { stdio: 'inherit' });
  console.log('Built ' + OUT);
} catch (e) {
  console.error('Compile failed:', e.message);
  process.exit(1);
}
