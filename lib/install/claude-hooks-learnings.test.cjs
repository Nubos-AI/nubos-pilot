'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const mod = require('./claude-hooks.cjs');

function _mkSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-learn-hooks-'));
  const hooksDir = path.join(dir, '.claude', 'nubos-pilot', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(hooksDir, 'np-statusline.cjs'), '// stub\n');
  fs.writeFileSync(path.join(hooksDir, 'np-ctx-monitor.cjs'), '// stub\n');
  fs.writeFileSync(path.join(hooksDir, 'np-security-hook.cjs'), '// stub\n');
  fs.writeFileSync(path.join(hooksDir, 'np-learnings-hook.cjs'), '// stub\n');
  return dir;
}

test('LH-1: which=learnings registers capture on Stop + reset on UserPromptSubmit', () => {
  const dir = _mkSandbox();
  try {
    const res = mod.installClaudeHooks({ projectRoot: dir, scope: 'local', which: 'learnings' });
    assert.equal(res.results.learnings.capture.action, 'installed');
    assert.equal(res.results.learnings.reset.action, 'installed');
    const settings = JSON.parse(fs.readFileSync(res.path, 'utf-8'));
    const stop = JSON.stringify(settings.hooks.Stop);
    const ups = JSON.stringify(settings.hooks.UserPromptSubmit);
    assert.ok(stop.includes('np-learnings-hook.cjs'));
    assert.ok(stop.includes(' capture'));
    assert.ok(ups.includes('np-learnings-hook.cjs'));
    assert.ok(ups.includes(' reset'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('LH-2: which=all installs learnings alongside security', () => {
  const dir = _mkSandbox();
  try {
    const res = mod.installClaudeHooks({ projectRoot: dir, scope: 'local', which: 'all' });
    assert.ok(res.results.learnings);
    assert.ok(res.results.security);
    assert.equal(res.results.learnings.capture.action, 'installed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('LH-3: install is idempotent — second run updates, not duplicates', () => {
  const dir = _mkSandbox();
  try {
    mod.installClaudeHooks({ projectRoot: dir, scope: 'local', which: 'learnings' });
    const res2 = mod.installClaudeHooks({ projectRoot: dir, scope: 'local', which: 'learnings' });
    assert.equal(res2.results.learnings.capture.action, 'updated');
    const settings = JSON.parse(fs.readFileSync(res2.path, 'utf-8'));
    const stopLearnings = settings.hooks.Stop.filter((e) =>
      JSON.stringify(e).includes('np-learnings-hook.cjs'));
    assert.equal(stopLearnings.length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('LH-4: uninstall removes learnings hooks', () => {
  const dir = _mkSandbox();
  try {
    mod.installClaudeHooks({ projectRoot: dir, scope: 'local', which: 'all' });
    const res = mod.uninstallClaudeHooks({ projectRoot: dir, scope: 'local' });
    assert.equal(res.results.learnings.action, 'removed');
    const settings = JSON.parse(fs.readFileSync(res.path, 'utf-8'));
    const dump = JSON.stringify(settings.hooks || {});
    assert.ok(!dump.includes('np-learnings-hook.cjs'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('LH-5: missing learnings hook script throws claude-hooks-script-missing', () => {
  const dir = _mkSandbox();
  try {
    fs.rmSync(path.join(dir, '.claude', 'nubos-pilot', 'hooks', 'np-learnings-hook.cjs'));
    assert.throws(
      () => mod.installClaudeHooks({ projectRoot: dir, scope: 'local', which: 'learnings' }),
      (e) => e.code === 'claude-hooks-script-missing',
    );
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
