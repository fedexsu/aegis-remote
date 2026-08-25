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

// Files that are safe to hot-swap and relaunch. NOT config.default.json (holds
// the per-install relay+key) and NOT the compiled injector.exe (binary/locked).
const FILES = ['main.js', 'preload.js', 'capture.js', 'index.html', 'version.json'];

const version = JSON.parse(fs.readFileSync(path.join(AGENT, 'version.json'), 'utf8')).codeVersion;
const files = {};
for (const f of FILES) {
  const p = path.join(AGENT, f);
  if (fs.existsSync(p)) files[f] = fs.readFileSync(p, 'utf8');
}

fs.writeFileSync(OUT, JSON.stringify({ version, files }, null, 2));
console.log(`agent-bundle.json written: codeVersion ${version}, ${Object.keys(files).length} files`);
