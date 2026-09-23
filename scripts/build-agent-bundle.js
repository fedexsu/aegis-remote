'use strict';

// Builds server/agent-bundle.json — the payload the relay serves at
// /api/agent-update so installed agents can self-update their JS without a
// reinstall. Run this whenever the agent code changes (and bump
// agent/version.json's codeVersion first).
//
//   node scripts/build-agent-bundle.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const AGENT = path.join(ROOT, 'agent');
const OUT = path.join(ROOT, 'server', 'agent-bundle.json');

// Text files that are safe to hot-swap and relaunch. The .cs sources are kept so
// the agent can still self-heal (recompile) as a LAST resort if a signed binary
// is ever missing. NOT config.default.json (holds the per-install relay+key).
const FILES = ['main.js', 'preload.js', 'capture.js', 'index.html', 'version.json', 'injector/Injector.cs', 'blanker/Blanker.cs', 'runas/RunAsUser.cs'];

// Compiled native helper binaries, shipped base64 so a self-update carries the
// SIGNED .exe instead of forcing the client to recompile an UNSIGNED one (which
// antivirus then flags → the "Control blocked" banner). The agent writes these
// out and prefers them over recompiling. Build+sign them first (build-all.js).
const BIN = ['injector/injector.exe', 'blanker/blanker.exe', 'runas/RunAsUser.exe'];

const version = JSON.parse(fs.readFileSync(path.join(AGENT, 'version.json'), 'utf8')).codeVersion;
const files = {};
for (const f of FILES) {
  const p = path.join(AGENT, f);
  if (fs.existsSync(p)) files[f] = fs.readFileSync(p, 'utf8');
}
const bin = {};
for (const f of BIN) {
  const p = path.join(AGENT, f);
  if (fs.existsSync(p)) bin[f] = fs.readFileSync(p).toString('base64');
}

fs.writeFileSync(OUT, JSON.stringify({ version, files, bin }, null, 2));
console.log(`agent-bundle.json written: codeVersion ${version}, ${Object.keys(files).length} files, ${Object.keys(bin).length} signed binaries`);
