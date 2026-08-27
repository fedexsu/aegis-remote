'use strict';

// Packages the HatchConnect HOST (technician client) into a standalone Windows app,
// same manual-portable technique as build-agent.js (npm packagers fail in this env).
//   node build-host.js   ->   release/Host/HatchConnect.exe

const fs = require('fs');
const path = require('path');
const { rcedit } = require('rcedit');

const ROOT = __dirname;
const ELECTRON_DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');
const OUT = path.join(ROOT, 'release', 'Host');

function rimraf(p) { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); }
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}

if (!fs.existsSync(ELECTRON_DIST)) { console.error('Run `npm install` first.'); process.exit(1); }

console.log('Cleaning ...');
rimraf(OUT);
console.log('Copying Electron runtime ...');
copyDir(ELECTRON_DIST, OUT);
fs.rmSync(path.join(OUT, 'resources', 'default_app.asar'), { force: true });

const appDir = path.join(OUT, 'resources', 'app');
copyDir(path.join(ROOT, 'host'), appDir);
fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify(
  { name: 'hatchconnect', version: '0.1.0', productName: 'HatchConnect', main: 'main.js' },
  null, 2));

const exePath = path.join(OUT, 'HatchConnect.exe');
fs.renameSync(path.join(OUT, 'electron.exe'), exePath);

(async () => {
  try {
    await rcedit(exePath, {
      'version-string': {
        ProductName: 'HatchConnect',
        FileDescription: 'HatchConnect',
        CompanyName: 'HatchConnect',
        OriginalFilename: 'HatchConnect.exe',
      },
      'file-version': '0.1.0.0',
      'product-version': '0.1.0.0',
    });
    console.log('Embedded metadata.');
  } catch (e) { console.log('rcedit skipped: ' + e.message); }
  console.log('\nDone: ' + path.join('release', 'Host', 'HatchConnect.exe'));
})();
