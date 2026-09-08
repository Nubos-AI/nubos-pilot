'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const extract = require('./extract.cjs');

function _gitRepo(withCommit) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-extract-'));
  const run = (args) => cp.spawnSync('git', args, { cwd: dir, encoding: 'utf-8' });
  run(['init', '-q']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Test']);
  run(['config', 'commit.gpgsign', 'false']);
  if (withCommit) {
    fs.writeFileSync(path.join(dir, 'a.js'), 'function add(a,b){return a+b;}\n');
    run(['add', '-A']);
    run(['commit', '-q', '-m', 'add helper']);
  }
  return dir;
}

test('EX-1: buildExtractorPrompt frames a learning_capture block with diff + files', () => {
  const p = extract.buildExtractorPrompt({ files: ['a.js'], truncatedFiles: false, diffText: '+ code' });
  assert.match(p, /<learning_capture>/);
  assert.match(p, /a\.js/);
  assert.match(p, /```diff/);
  assert.match(p, /"learnings"/);
});

test('EX-2: parseExtractorOutput unwraps {result} envelope', () => {
  const raw = JSON.stringify({ result: JSON.stringify({ learnings: [{ pattern: 'use jose for jwt', outcome: 'verified' }] }) });
  const r = extract.parseExtractorOutput(raw);
  assert.strictEqual(r.parse_ok, true);
  assert.strictEqual(r.candidates.length, 1);
  assert.strictEqual(r.candidates[0].pattern, 'use jose for jwt');
});

test('EX-3: parseExtractorOutput strips a markdown fence', () => {
  const raw = '```json\n{"learnings":[{"pattern":"p","outcome":"failed"}]}\n```';
  const r = extract.parseExtractorOutput(raw);
  assert.strictEqual(r.candidates.length, 1);
  assert.strictEqual(r.candidates[0].outcome, 'failed');
});

test('EX-4: invalid outcome defaults to verified; empty pattern dropped', () => {
  const raw = JSON.stringify({ learnings: [
    { pattern: 'good', outcome: 'banana' },
    { pattern: '   ', outcome: 'verified' },
  ] });
  const r = extract.parseExtractorOutput(raw);
  assert.strictEqual(r.candidates.length, 1);
  assert.strictEqual(r.candidates[0].outcome, 'verified');
});

test('EX-5: caps candidates at MAX_CANDIDATES', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ pattern: 'p' + i, outcome: 'verified' }));
  const r = extract.parseExtractorOutput(JSON.stringify({ learnings: many }));
  assert.strictEqual(r.candidates.length, extract.MAX_CANDIDATES);
});

test('EX-6: non-JSON output → parse_ok false', () => {
  assert.strictEqual(extract.parseExtractorOutput('totally not json').parse_ok, false);
  assert.strictEqual(extract.parseExtractorOutput('').parse_ok, false);
});

test('EX-7: runExtract on a non-repo returns not-a-repo, logs nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-norepo-'));
  try {
    const logged = [];
    const r = await extract.runExtract({ cwd: dir, spawnImpl: () => '{}', logImpl: (c) => logged.push(c) });
    assert.strictEqual(r.ran, false);
    assert.strictEqual(r.reason, 'not-a-repo');
    assert.strictEqual(logged.length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('EX-8: runExtract on empty repo (no commit, no changes) → empty-diff', async () => {
  const dir = _gitRepo(false);
  try {
    const r = await extract.runExtract({ cwd: dir, spawnImpl: () => '{}', logImpl: () => {} });
    assert.strictEqual(r.ran, true);
    assert.strictEqual(r.reason, 'empty-diff');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('EX-9: runExtract over a commit logs parsed candidates', async () => {
  const dir = _gitRepo(true);
  try {
    const logged = [];
    const r = await extract.runExtract({
      cwd: dir,
      spawnImpl: () => JSON.stringify({ result: JSON.stringify({ learnings: [
        { pattern: 'keep add() pure and total', outcome: 'verified' },
      ] }) }),
      logImpl: (c) => logged.push(c),
    });
    assert.strictEqual(r.ran, true);
    assert.strictEqual(r.logged, 1);
    assert.strictEqual(logged[0].pattern, 'keep add() pure and total');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('EX-10: runExtract with unparseable spawn output → parse-failed, no log', async () => {
  const dir = _gitRepo(true);
  try {
    const logged = [];
    const r = await extract.runExtract({ cwd: dir, spawnImpl: () => 'garbage', logImpl: (c) => logged.push(c) });
    assert.strictEqual(r.reason, 'parse-failed');
    assert.strictEqual(logged.length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
