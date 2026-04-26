'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const subcmd = require('./dashboard.cjs');

const _roots = [];

function _sandbox(configLanguage) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-dashboard-cli-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  if (configLanguage !== undefined) {
    fs.writeFileSync(
      path.join(root, '.nubos-pilot', 'config.json'),
      JSON.stringify({ response_language: configLanguage }),
      'utf-8',
    );
  }
  _roots.push(root);
  return root;
}

function _capture() {
  let buf = '';
  return { stub: { write: (s) => { buf += s; }, isTTY: false }, get: () => buf };
}

after(() => {
  while (_roots.length) {
    const r = _roots.pop();
    try { fs.rmSync(r, { recursive: true, force: true }); } catch {}
  }
});

test('CLI-DB-1: parses --lang flag (space form)', () => {
  const parsed = subcmd._parseArgs(['--lang', 'de']);
  assert.equal(parsed.lang, 'de');
});

test('CLI-DB-2: parses --lang=xx flag (equals form)', () => {
  const parsed = subcmd._parseArgs(['--lang=de']);
  assert.equal(parsed.lang, 'de');
});

test('CLI-DB-3: dashboard reads response_language from config.json', () => {
  const root = _sandbox('de');
  const cap = _capture();
  const code = subcmd.run([], { cwd: root, stdout: cap.stub });
  assert.equal(code, 0);
  assert.match(cap.get(), /Noch keine Milestones/);
});

test('CLI-DB-4: --lang overrides config language', () => {
  const root = _sandbox('de');
  const cap = _capture();
  const code = subcmd.run(['--lang', 'en'], { cwd: root, stdout: cap.stub });
  assert.equal(code, 0);
  assert.match(cap.get(), /No milestones yet/);
});

test('CLI-DB-5: missing config falls back to English', () => {
  const root = _sandbox();
  const cap = _capture();
  const code = subcmd.run([], { cwd: root, stdout: cap.stub });
  assert.equal(code, 0);
  assert.match(cap.get(), /No milestones yet/);
});

test('CLI-DB-6: --json snapshot stays language-neutral', () => {
  const root = _sandbox('de');
  const cap = _capture();
  const code = subcmd.run(['--json'], { cwd: root, stdout: cap.stub });
  assert.equal(code, 0);
  const parsed = JSON.parse(cap.get());
  assert.deepEqual(Object.keys(parsed), ['milestones']);
});
