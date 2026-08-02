'use strict';

// Packages the Aegis Remote AGENT into a standalone Windows app folder + exe,
// so it can be installed on any machine without Node/Electron. Uses the same
// manual-portable technique as the browser (the npm packagers fail in this env).
//
//   node build-agent.js   ->   release/AegisRemoteAgent/AegisRemoteAgent.exe
//
// The agent has no runtime node_modules deps (it uses the browser WebSocket in
// the renderer and only built-in modules in main), so only agent/ + build/ ship.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { rcedit } = require('rcedit');

const ROOT = __dirname;
const ELECTRON_DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');
const OUT = path.join(ROOT, 'release', 'AegisRemoteAgent');
const ICON = path.join(ROOT, 'build', 'icon.ico');
const INJECTOR = path.join(ROOT, 'agent', 'injector', 'injector.exe');

function rimraf(p) { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); }
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}

if (!fs.existsSync(ELECTRON_DIST)) { console.error('Run `npm install` first.'); process.exit(1); }

// Ensure the input injector is compiled.
if (!fs.existsSync(INJECTOR)) {
  console.log('Building injector.exe ...');
  execFileSync(process.execPath, [path.join(ROOT, 'agent', 'injector', 'build-injector.js')], { stdio: 'inherit' });
}

console.log('Cleaning ...');
rimraf(OUT);

console.log('Copying Electron runtime ...');
copyDir(ELECTRON_DIST, OUT);
fs.rmSync(path.join(OUT, 'resources', 'default_app.asar'), { force: true });

const appDir = path.join(OUT, 'resources', 'app');
copyDir(path.join(ROOT, 'agent'), path.join(appDir, 'agent'));
copyDir(path.join(ROOT, 'build'), path.join(appDir, 'build'));
fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify(
  { name: 'aegis-remote-agent', version: '0.1.0', productName: 'Aegis Remote Agent', main: 'agent/main.js' },
  null, 2));

const exePath = path.join(OUT, 'AegisRemoteAgent.exe');
fs.renameSync(path.join(OUT, 'electron.exe'), exePath);

(async () => {
  if (fs.existsSync(ICON)) {
    await rcedit(exePath, {
      icon: ICON,
      'version-string': {
        ProductName: 'Aegis Remote Agent',
        FileDescription: 'Aegis Remote Agent',
        CompanyName: 'Aegis',
        OriginalFilename: 'AegisRemoteAgent.exe',
      },
      'file-version': '0.1.0.0',
      'product-version': '0.1.0.0',
    });
    console.log('Embedded icon + metadata.');
  }
  console.log('\nDone: ' + path.join('release', 'AegisRemoteAgent', 'AegisRemoteAgent.exe'));
  console.log('Install on a target machine: copy the AegisRemoteAgent folder, run the exe,');
  console.log('set the relay + key, tick "Start automatically", done.');
})();
