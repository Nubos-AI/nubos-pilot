'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('./learnings.cjs');

function _capture() {
  const out = { text: '' };
  return { stdout: { write: (s) => { out.text += s; return true; } }, out };
}

test('LV-1: capture with no session → no-session, no spawn', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-lv-'));
  try {
    const c = _capture();
    c.cwd = dir;
    const code = await run(['capture'], c);
    assert.strictEqual(code, 0);
    assert.match(c.out.text, /no-session/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('LV-2: capture disabled via config → disabled, no spawn', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-lv-'));
  try {
    fs.mkdirSync(path.join(dir, '.nubos-pilot'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.nubos-pilot', 'config.json'),
      JSON.stringify({ learnings: { auto_capture: false } }),
    );
    const c = _capture();
    c.cwd = dir;
    const code = await run(['capture', '--payload', JSON.stringify({ session_id: 'abc' })], c);
    assert.strictEqual(code, 0);
    assert.match(c.out.text, /disabled/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('LV-3: run-extract on a non-repo cwd → ran:false not-a-repo', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-lv-'));
  try {
    const c = _capture();
    c.cwd = dir;
    const code = await run(['run-extract', '--session', 'abc'], c);
    assert.strictEqual(code, 0);
    const parsed = JSON.parse(c.out.text);
    assert.strictEqual(parsed.ran, false);
    assert.strictEqual(parsed.reason, 'not-a-repo');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('LV-4: unknown verb → error envelope, exit 1', async () => {
  const c = _capture();
  const code = await run(['bogus'], c);
  assert.strictEqual(code, 1);
  assert.match(c.out.text, /unknown-verb/);
});

test('LV-5: reset is a no-op without a session and never throws', async () => {
  const c = _capture();
  const code = await run(['reset'], c);
  assert.strictEqual(code, 0);
});
