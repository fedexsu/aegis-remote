'use strict';

// Compiles SecureCapture.cs -> sdcap.exe with the in-box .NET Framework csc.exe.
// Needs System.Drawing (present on every Windows install). No external SDK.
//   node agent/sdcap/build-sdcap.js

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const SRC = path.join(DIR, 'SecureCapture.cs');
const OUT = path.join(DIR, 'sdcap.exe');

const csc = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
].find((p) => fs.existsSync(p));
if (!csc) { console.error('csc.exe (.NET Framework compiler) not found.'); process.exit(1); }

try {
  // /target:winexe so no console window flashes; stdout is still usable when the
  // parent redirects it (the agent spawns us with a piped stdout/stdin).
  execFileSync(csc, ['/nologo', '/optimize+', '/target:winexe',
    '/r:System.Drawing.dll', '/out:' + OUT, SRC], { stdio: 'inherit' });
  console.log('Built ' + OUT);
} catch (err) {
  console.error('Compilation failed:', err.message);
  process.exit(1);
}
