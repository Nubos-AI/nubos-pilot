#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const swarm = require('../lib/researcher-swarm.cjs');
const { atomicWriteFileSync } = require('../lib/core.cjs');

const USAGE = [
  'Usage:',
  '  researcher-merge.cjs <spawn-output-1.json> [spawn-output-2.json] [...] [options]',
  '  researcher-merge.cjs --stdin [options]',
  '',
  'Options:',
  '  --stdin            Read a JSON array of spawn outputs from stdin instead of file args',
  '  --out <path>       Write rendered consensus markdown to <path> (default: stdout)',
  '  --json             Emit the merged consensus as JSON instead of markdown',
  '  --heading <text>   Markdown heading (default: "Researcher-Schwarm Consensus")',
  '  -h, --help         Show this help',
  '',
  'Each spawn output must be a JSON object with shape:',
  '  { decisions[], risks[], patterns[], open_questions[], sources[] }',
  '',
  'Exit codes:',
  '  0 success, 2 invalid usage, 3 unreadable input, 4 invalid spawn output',
].join('\n');

function _hasFlag(argv, name) { return argv.includes(name); }
function _flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

function _die(code, msg) {
  process.stderr.write(msg + '\n');
  process.exit(code);
}

function _readJson(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf-8'); }
  catch (err) { _die(3, 'researcher-merge: cannot read ' + file + ': ' + err.message); }
  try { return JSON.parse(raw); }
  catch (err) { _die(4, 'researcher-merge: invalid JSON in ' + file + ': ' + err.message); }
}

function _readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { buf += chunk; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

async function _collectInputs(argv) {
  if (_hasFlag(argv, '--stdin')) {
    const raw = await _readStdin();
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (err) { _die(4, 'researcher-merge: invalid JSON on stdin: ' + err.message); }
    if (!Array.isArray(parsed)) {
      _die(4, 'researcher-merge: --stdin payload must be a JSON array of spawn outputs');
    }
    return parsed;
  }
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out' || a === '--heading') { i++; continue; }
    if (a.startsWith('-')) continue;
    files.push(a);
  }
  if (!files.length) _die(2, USAGE);
  return files.map(_readJson);
}

async function main() {
  const argv = process.argv.slice(2);
  if (_hasFlag(argv, '-h') || _hasFlag(argv, '--help')) {
    process.stdout.write(USAGE + '\n');
    process.exit(0);
  }
  if (!argv.length) _die(2, USAGE);
  const outPath = _flag(argv, '--out');
  const heading = _flag(argv, '--heading');
  const asJson = _hasFlag(argv, '--json');
  const inputs = await _collectInputs(argv);
  for (let i = 0; i < inputs.length; i += 1) {
    const o = inputs[i];
    if (!o || typeof o !== 'object' || Array.isArray(o)) {
      _die(4, 'researcher-merge: spawn output #' + i + ' must be a JSON object');
    }
  }
  const consensus = swarm.mergeConsensus(inputs);
  const payload = asJson
    ? JSON.stringify(consensus, null, 2) + '\n'
    : swarm.renderConsensusToMarkdown(consensus, heading ? { heading } : undefined);
  if (outPath) {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    atomicWriteFileSync(outPath, payload);
    process.stdout.write(outPath + '\n');
  } else {
    process.stdout.write(payload);
  }
}

main().catch((err) => _die(1, 'researcher-merge: ' + (err && err.stack ? err.stack : String(err))));
