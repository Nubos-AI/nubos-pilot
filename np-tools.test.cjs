const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const nt = require('./np-tools.cjs');

const repoRoot = __dirname;

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'np-tools-test-'));
}

test('NT-1: emit small payload writes JSON to stdout without @file: pointer', () => {
  const chunks = [];
  const fakeStdout = { write: (c) => { chunks.push(String(c)); return true; } };
  nt.emit({ _workflow: 'test', foo: 'bar' }, fakeStdout, repoRoot);
  const out = chunks.join('');
  assert.ok(!out.startsWith('@file:'));
  const parsed = JSON.parse(out);
  assert.equal(parsed.foo, 'bar');
});

test('NT-2: emit big payload writes @file: pointer + temp file contains full JSON', () => {
  const tmp = mkTmp();
  fs.mkdirSync(path.join(tmp, '.nubos-pilot'), { recursive: true });
  const chunks = [];
  const fakeStdout = { write: (c) => { chunks.push(String(c)); return true; } };
  const big = { _workflow: 'big-test', data: 'x'.repeat(20 * 1024) };
  nt.emit(big, fakeStdout, tmp);
  const out = chunks.join('');
  assert.ok(out.startsWith('@file:'), 'expected @file: pointer');
  const tmpPath = out.slice('@file:'.length).trim();
  assert.ok(tmpPath.includes('init-big-test-'));
  assert.match(tmpPath, /init-big-test-\d+-[0-9a-f]{8}\.json$/);
  const parsed = JSON.parse(fs.readFileSync(tmpPath, 'utf-8'));
  assert.equal(parsed._workflow, 'big-test');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('NT-3: two emits on big payloads produce distinct temp files', () => {
  const tmp = mkTmp();
  fs.mkdirSync(path.join(tmp, '.nubos-pilot'), { recursive: true });
  const outs = [[], []];
  const fakeStdout0 = { write: (c) => { outs[0].push(String(c)); return true; } };
  const fakeStdout1 = { write: (c) => { outs[1].push(String(c)); return true; } };
  const big = { _workflow: 'dup', data: 'y'.repeat(20 * 1024) };
  nt.emit(big, fakeStdout0, tmp);
  nt.emit(big, fakeStdout1, tmp);
  const p0 = outs[0].join('').slice('@file:'.length).trim();
  const p1 = outs[1].join('').slice('@file:'.length).trim();
  assert.notEqual(p0, p1);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('NT-4: main invoked via child_process with unknown init workflow → exit 1 with error envelope', () => {
  const { spawnSync } = require('node:child_process');
  const res = spawnSync(process.execPath, ['np-tools.cjs', 'init', 'bogus-workflow', '99'], {
    cwd: repoRoot,
    encoding: 'utf-8',
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /"error"/);
  assert.match(res.stderr, /"code":\s*"unknown-init-workflow"/);
});
