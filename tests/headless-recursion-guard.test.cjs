'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// End-to-end recursion guard: a headless `claude -p` spawned by nubos-pilot
// re-fires the very SessionStart/Stop hooks that spawned it. Without a guard
// each generation spawns another headless claude → fork bomb. The Stop hooks
// must no-op when NUBOS_PILOT_HEADLESS=1 so the chain stops at one level.

const HOOKS_DIR = path.join(__dirname, '..', 'templates', 'claude', 'payload', 'hooks');
const SECURITY_HOOK = path.join(HOOKS_DIR, 'np-security-hook.cjs');
const LEARNINGS_HOOK = path.join(HOOKS_DIR, 'np-learnings-hook.cjs');

const _sandboxes = [];

function _mkRoot() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'np-recursion-guard-'));
  const binDir = path.join(r, '.nubos-pilot', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  // A stand-in np-tools that records the fact it was invoked. If a hook spawns
  // it, this marker appears — that is exactly the spawn we must suppress.
  fs.writeFileSync(
    path.join(binDir, 'np-tools.cjs'),
    "'use strict';\nconst fs=require('node:fs');const path=require('node:path');\n"
      + "fs.appendFileSync(path.join(process.cwd(),'SPAWNED'), process.argv.slice(2).join(' ')+'\\n');\n",
    'utf-8',
  );
  _sandboxes.push(r);
  return r;
}

function _runHook(hookPath, verb, cwd, env) {
  return cp.spawnSync(process.execPath, [hookPath, verb], {
    cwd,
    input: '{"session_id":"sid-test"}',
    encoding: 'utf-8',
    timeout: 10000,
    env: { ...process.env, ...env },
  });
}

afterEach(() => {
  while (_sandboxes.length) {
    const r = _sandboxes.pop();
    try { fs.rmSync(r, { recursive: true, force: true }); } catch {}
  }
});

test('RG-1: security Stop hook does NOT spawn np-tools when NUBOS_PILOT_HEADLESS=1', () => {
  const r = _mkRoot();
  const res = _runHook(SECURITY_HOOK, 'review', r, { NUBOS_PILOT_HEADLESS: '1' });
  assert.equal(res.status, 0, 'hook must always exit 0');
  assert.equal(fs.existsSync(path.join(r, 'SPAWNED')), false,
    'a headless security hook must not spawn np-tools (recursion guard)');
});

test('RG-2: learnings Stop hook does NOT spawn np-tools when NUBOS_PILOT_HEADLESS=1', () => {
  const r = _mkRoot();
  const res = _runHook(LEARNINGS_HOOK, 'capture', r, { NUBOS_PILOT_HEADLESS: '1' });
  assert.equal(res.status, 0, 'hook must always exit 0');
  assert.equal(fs.existsSync(path.join(r, 'SPAWNED')), false,
    'a headless learnings hook must not spawn np-tools (recursion guard)');
});

test('RG-3: control — without the headless flag the security hook DOES spawn np-tools', () => {
  const r = _mkRoot();
  const env = { ...process.env };
  delete env.NUBOS_PILOT_HEADLESS;
  const res = cp.spawnSync(process.execPath, [SECURITY_HOOK, 'review'], {
    cwd: r,
    input: '{"session_id":"sid-test"}',
    encoding: 'utf-8',
    timeout: 10000,
    env,
  });
  assert.equal(res.status, 0);
  assert.equal(fs.existsSync(path.join(r, 'SPAWNED')), true,
    'a normal (non-headless) hook must still drive the np-tools backend — proves the guard is the only thing suppressing it');
});

test('RG-4: control — without the headless flag the learnings hook DOES spawn np-tools', () => {
  const r = _mkRoot();
  const env = { ...process.env };
  delete env.NUBOS_PILOT_HEADLESS;
  const res = cp.spawnSync(process.execPath, [LEARNINGS_HOOK, 'capture'], {
    cwd: r,
    input: '{"session_id":"sid-test"}',
    encoding: 'utf-8',
    timeout: 10000,
    env,
  });
  assert.equal(res.status, 0);
  assert.equal(fs.existsSync(path.join(r, 'SPAWNED')), true,
    'a normal (non-headless) learnings hook must still drive the np-tools backend');
});
