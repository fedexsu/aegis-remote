'use strict';

// Compiles Blanker.cs -> blanker.exe using the .NET Framework C# compiler that
// ships with Windows. Needs the WinForms + Drawing framework assemblies (present
// on every Windows install). No external SDK required.
//
//   node agent/blanker/build-blanker.js

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const SRC = path.join(DIR, 'Blanker.cs');
const OUT = path.join(DIR, 'blanker.exe');

const CSC_CANDIDATES = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
];

const csc = CSC_CANDIDATES.find((p) => fs.existsSync(p));
if (!csc) {
  console.error('Could not find csc.exe (.NET Framework compiler). Expected at one of:\n  ' +
    CSC_CANDIDATES.join('\n  '));
  process.exit(1);
}

try {
  // /target:winexe so no console window flashes; reference WinForms + Drawing.
  execFileSync(csc, [
    '/nologo', '/optimize+', '/target:winexe',
    '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:Microsoft.CSharp.dll',
    '/out:' + OUT, SRC,
  ], { stdio: 'inherit' });
  console.log('Built ' + OUT);
} catch (err) {
  console.error('Compilation failed:', err.message);
  process.exit(1);
}
