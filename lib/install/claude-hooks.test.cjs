'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const mod = require('./claude-hooks.cjs');

function _mkSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-claude-hooks-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude', 'nubos-pilot', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'nubos-pilot', 'hooks', 'np-statusline.js'), '// stub\n');
  fs.writeFileSync(path.join(dir, '.claude', 'nubos-pilot', 'hooks', 'np-ctx-monitor.js'), '// stub\n');
  return dir;
}

test('claude-hooks: fresh install writes both hooks to local settings', () => {
  const dir = _mkSandbox();
  try {
    const res = mod.installClaudeHooks({ projectRoot: dir, scope: 'local' });
    assert.equal(res.dryRun, false);
    assert.equal(res.results.statusline.action, 'installed');
    assert.equal(res.results.ctxMonitor.action, 'installed');
    const settings = JSON.parse(fs.readFileSync(res.path, 'utf-8'));
    assert.equal(settings.statusLine.type, 'command');
    assert.ok(settings.statusLine.command.includes('np-statusline.js'));
    assert.ok(Array.isArray(settings.hooks.PostToolUse));
    assert.equal(settings.hooks.PostToolUse[0].matcher, '.*');
    assert.ok(settings.hooks.PostToolUse[0].hooks[0].command.includes('np-ctx-monitor.js'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('claude-hooks: existing foreign statusLine is preserved without force', () => {
  const dir = _mkSandbox();
  try {
    const settingsPath = path.join(dir, '.claude', 'settings.local.json');
    fs.writeFileSync(settingsPath, JSON.stringify({
      statusLine: { type: 'command', command: 'echo my-custom-bar' },
    }));
    const res = mod.installClaudeHooks({ projectRoot: dir, scope: 'local' });
    assert.equal(res.results.statusline.action, 'skipped-existing');
    assert.equal(res.results.statusline.existingCommand, 'echo my-custom-bar');
    const settings = JSON.parse(fs.readFileSync(res.path, 'utf-8'));
    assert.equal(settings.statusLine.command, 'echo my-custom-bar');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('claude-hooks: --force overwrites foreign statusLine', () => {
  const dir = _mkSandbox();
  try {
    const settingsPath = path.join(dir, '.claude', 'settings.local.json');
    fs.writeFileSync(settingsPath, JSON.stringify({
      statusLine: { type: 'command', command: 'echo other' },
    }));
    const res = mod.installClaudeHooks({ projectRoot: dir, scope: 'local', force: true });
    assert.equal(res.results.statusline.action, 'overwrote');
    const settings = JSON.parse(fs.readFileSync(res.path, 'utf-8'));
    assert.ok(settings.statusLine.command.includes('np-statusline.js'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('claude-hooks: re-install is idempotent (updates nubos-pilot hook path)', () => {
  const dir = _mkSandbox();
  try {
    mod.installClaudeHooks({ projectRoot: dir, scope: 'local' });
    const res2 = mod.installClaudeHooks({ projectRoot: dir, scope: 'local' });
    assert.equal(res2.results.statusline.action, 'updated');
    assert.equal(res2.results.ctxMonitor.action, 'updated');
    const settings = JSON.parse(fs.readFileSync(res2.path, 'utf-8'));
    assert.equal(settings.hooks.PostToolUse.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('claude-hooks: preserves unrelated PostToolUse hooks', () => {
  const dir = _mkSandbox();
  try {
    const settingsPath = path.join(dir, '.claude', 'settings.local.json');
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PostToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo other-hook' }] },
        ],
      },
    }));
    const res = mod.installClaudeHooks({ projectRoot: dir, scope: 'local', which: 'ctx-monitor' });
    assert.equal(res.results.ctxMonitor.action, 'installed');
    const settings = JSON.parse(fs.readFileSync(res.path, 'utf-8'));
    assert.equal(settings.hooks.PostToolUse.length, 2);
    assert.equal(settings.hooks.PostToolUse[0].matcher, 'Bash');
    assert.ok(settings.hooks.PostToolUse[1].hooks[0].command.includes('np-ctx-monitor.js'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('claude-hooks: uninstall removes only our entries', () => {
  const dir = _mkSandbox();
  try {
    const settingsPath = path.join(dir, '.claude', 'settings.local.json');
    fs.writeFileSync(settingsPath, JSON.stringify({
      statusLine: { type: 'command', command: 'echo custom' },
      hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo foreign' }] }] },
    }));
    mod.installClaudeHooks({ projectRoot: dir, scope: 'local', which: 'ctx-monitor' });
    const res = mod.uninstallClaudeHooks({ projectRoot: dir, scope: 'local' });
    assert.equal(res.results.ctxMonitor.action, 'removed');
    assert.equal(res.results.statusline.action, 'not-ours');
    const settings = JSON.parse(fs.readFileSync(res.path, 'utf-8'));
    assert.equal(settings.statusLine.command, 'echo custom');
    assert.equal(settings.hooks.PostToolUse.length, 1);
    assert.equal(settings.hooks.PostToolUse[0].matcher, 'Bash');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('claude-hooks: missing hook script throws structured error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-claude-hooks-no-scripts-'));
  try {
    assert.throws(
      () => mod.installClaudeHooks({ projectRoot: dir, scope: 'local' }),
      (err) => err && err.code === 'claude-hooks-script-missing',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('claude-hooks: dryRun returns planned settings without writing', () => {
  const dir = _mkSandbox();
  try {
    const res = mod.installClaudeHooks({ projectRoot: dir, scope: 'local', dryRun: true });
    assert.equal(res.dryRun, true);
    assert.ok(res.settings.statusLine);
    assert.equal(fs.existsSync(res.path), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('claude-hooks: invalid JSON in settings yields structured error', () => {
  const dir = _mkSandbox();
  try {
    fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), '{broken');
    assert.throws(
      () => mod.installClaudeHooks({ projectRoot: dir, scope: 'local' }),
      (err) => err && err.code === 'claude-settings-invalid-json',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
