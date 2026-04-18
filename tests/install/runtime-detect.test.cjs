const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function mkTmp(scope) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'np-' + scope + '-'));
}

const RUNTIME_ENV_KEYS = [
  'NUBOS_RUNTIME',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CODEX_HOME',
  'CODEX_VERSION',
  'GEMINI_CLI',
  'GEMINI_VERSION',
  'OPENCODE',
  'OPENCODE_VERSION',
  'NUBOS_PILOT_REDETECT_RUNTIME',
];

function snapshotEnv() {
  const snap = {};
  for (const k of RUNTIME_ENV_KEYS) snap[k] = process.env[k];
  return snap;
}
function restoreEnv(snap) {
  for (const k of RUNTIME_ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}
function clearAllRuntimeEnv() {
  for (const k of RUNTIME_ENV_KEYS) delete process.env[k];
}

test('runtime-detect: env precedence — CLAUDECODE=1 yields runtime=claude via env source (D-22)', (t) => {
  const { detectRuntime } = require('../../lib/install/runtime-detect.cjs');
  const snap = snapshotEnv();
  t.after(() => restoreEnv(snap));
  clearAllRuntimeEnv();
  process.env.CLAUDECODE = '1';
  process.env.NUBOS_PILOT_REDETECT_RUNTIME = '1';
  const res = detectRuntime();
  assert.equal(res.runtime, 'claude');
  assert.equal(res.source, 'env');
});

test('runtime-detect: path precedence when no env present (D-22)', (t) => {
  const { detectRuntime } = require('../../lib/install/runtime-detect.cjs');
  const snap = snapshotEnv();
  t.after(() => restoreEnv(snap));
  clearAllRuntimeEnv();
  process.env.NUBOS_PILOT_REDETECT_RUNTIME = '1';

  

  const res = detectRuntime({ cwd: mkTmp('rd-path') });
  assert.notEqual(res.source, 'env');
  assert.ok(['path', 'disk', 'default'].includes(res.source));
});

test('runtime-detect: disk precedence — cwd with .claude/ yields runtime=claude source=disk (D-22)', (t) => {
  const { detectRuntime } = require('../../lib/install/runtime-detect.cjs');
  const snap = snapshotEnv();
  const tmp = mkTmp('rd-disk');
  t.after(() => {
    restoreEnv(snap);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  });
  clearAllRuntimeEnv();
  process.env.NUBOS_PILOT_REDETECT_RUNTIME = '1';
  fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });

  const res = detectRuntime({ cwd: tmp, pathProbe: () => null });
  assert.equal(res.runtime, 'claude');
  assert.equal(res.source, 'disk');
});
