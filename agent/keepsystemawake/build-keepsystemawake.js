'use strict';

// Compiles the two keep-awake toolbox executables with the .NET Framework C#
// compiler shipped in Windows (same pattern as the other native helpers in
// this repo: injector, blanker, sdcap).
//
//   node agent/keepsystemawake/build-keepsystemawake.js
//
// Outputs (next to the sources):
//   keepsystemawake.exe       — start the lock (default 8h, /duration N, /stop)
//   offkeepsystemawake.exe    — signal a running keepsystemawake to clean-exit

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const CSC = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
].find((p) => fs.existsSync(p));
if (!CSC) { console.error('csc.exe not found. Expected .NET Framework 4 compiler.'); process.exit(1); }

const TARGETS = [
  { src: 'KeepSystemAwake.cs',    out: 'keepsystemawake.exe' },
  { src: 'OffKeepSystemAwake.cs', out: 'offkeepsystemawake.exe' },
];

for (const t of TARGETS) {
  try {
    // /target:winexe (Windows subsystem) instead of /target:exe (console
    // subsystem) so launching the binary doesn't flash a black console window on
    // the remote. We never read stdin and only log to a file in Full mode, so
    // there's nothing to lose by dropping the console.
    execFileSync(CSC, [
      '/nologo', '/optimize+', '/target:winexe',
      '/out:' + path.join(DIR, t.out),
      path.join(DIR, t.src),
    ], { stdio: 'inherit' });
    console.log('Built ' + t.out);
  } catch (e) {
    console.error('Compile failed for ' + t.src + ':', e.message);
    process.exit(1);
  }
}
