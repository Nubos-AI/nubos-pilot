const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const rt = require('./index.cjs');

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
function forceRedetect() {
  process.env.NUBOS_PILOT_REDETECT_RUNTIME = '1';
}

function mkTmp(scope) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'np-runtime-' + scope + '-'));
}

function writeConfig(cwd, json) {
  const dir = path.join(cwd, '.nubos-pilot');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(json), 'utf-8');
}

test('RTI-1: listRuntimes returns four known runtimes in canonical order', () => {
  assert.deepEqual(rt.listRuntimes(), ['claude', 'opencode', 'codex', 'gemini']);
});

test('RTI-2: listRuntimes returns defensive copy — mutation does not leak', () => {
  const a = rt.listRuntimes();
  a.push('pwned');
  const b = rt.listRuntimes();
  assert.deepEqual(b, ['claude', 'opencode', 'codex', 'gemini']);
});

test('RTI-3: getAdapter("nonexistent") throws NubosPilotError with code runtime-unknown', () => {
  assert.throws(
    () => rt.getAdapter('nonexistent'),
    (err) => err && err.name === 'NubosPilotError' && err.code === 'runtime-unknown',
  );
});

test('RTI-4: getAdapter unknown-runtime error details.known lists KNOWN_RUNTIMES', () => {
  try {
    rt.getAdapter('mystery');
    assert.fail('should throw');
  } catch (err) {
    assert.equal(err.code, 'runtime-unknown');
    assert.deepEqual(err.details.known, ['claude', 'opencode', 'codex', 'gemini']);
    assert.equal(err.details.name, 'mystery');
  }
});

test('RTI-5: detect honors .nubos-pilot/config.json runtime + runtime_source', () => {
  const snap = snapshotEnv();
  const tmp = mkTmp('cfg-honored');
  try {
    clearAllRuntimeEnv();
    forceRedetect();
    writeConfig(tmp, { runtime: 'codex', runtime_source: 'asked' });
    const d = rt.detect({ cwd: tmp });
    assert.equal(d.runtime, 'codex');
    assert.equal(d.source, 'asked');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    restoreEnv(snap);
  }
});

test('RTI-6: detect config without runtime_source defaults source to "config"', () => {
  const snap = snapshotEnv();
  const tmp = mkTmp('cfg-no-src');
  try {
    clearAllRuntimeEnv();
    forceRedetect();
    writeConfig(tmp, { runtime: 'gemini' });
    const d = rt.detect({ cwd: tmp });
    assert.equal(d.runtime, 'gemini');
    assert.equal(d.source, 'config');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    restoreEnv(snap);
  }
});

test('RTI-7: detect falls through when config.runtime is unknown', () => {
  const snap = snapshotEnv();
  const tmp = mkTmp('cfg-unknown');
  try {
    clearAllRuntimeEnv();
    forceRedetect();
    writeConfig(tmp, { runtime: 'mystery' });

    const d = rt.detect({ cwd: tmp });
    assert.equal(d.runtime, 'codex');
    assert.equal(d.source, 'default');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    restoreEnv(snap);
  }
});

test('RTI-8: detect with no config + CLAUDECODE=1 returns {runtime:claude, source:env}', () => {
  const snap = snapshotEnv();
  const tmp = mkTmp('env-claude');
  try {
    clearAllRuntimeEnv();
    process.env.CLAUDECODE = '1';
    forceRedetect();
    const d = rt.detect({ cwd: tmp });
    assert.equal(d.runtime, 'claude');
    assert.equal(d.source, 'env');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    restoreEnv(snap);
  }
});

test('RTI-9: detect with no config + no env returns {runtime:codex, source:default}', () => {
  const snap = snapshotEnv();
  const tmp = mkTmp('default');
  try {
    clearAllRuntimeEnv();
    forceRedetect();
    const d = rt.detect({ cwd: tmp });
    assert.equal(d.runtime, 'codex');
    assert.equal(d.source, 'default');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    restoreEnv(snap);
  }
});

test('RTI-10: detect tolerates malformed config.json (silent fall-through to env/default)', () => {
  const snap = snapshotEnv();
  const tmp = mkTmp('bad-json');
  try {
    clearAllRuntimeEnv();
    forceRedetect();
    const dir = path.join(tmp, '.nubos-pilot');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), '{ not json', 'utf-8');
    const d = rt.detect({ cwd: tmp });
    assert.equal(d.runtime, 'codex');
    assert.equal(d.source, 'default');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    restoreEnv(snap);
  }
});

test('RTI-11: module exports exactly listRuntimes, getAdapter, getCurrent, detect', () => {
  const keys = Object.keys(rt).sort();
  assert.deepEqual(keys, ['detect', 'getAdapter', 'getCurrent', 'listRuntimes']);
});

