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
  fs.writeFileSync(path.join(dir, '.claude', 'nubos-pilot', 'hooks', 'np-statusline.cjs'), '// stub\n');
  fs.writeFileSync(path.join(dir, '.claude', 'nubos-pilot', 'hooks', 'np-ctx-monitor.cjs'), '// stub\n');
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
    assert.ok(settings.statusLine.command.includes('np-statusline.cjs'));
    assert.ok(Array.isArray(settings.hooks.PostToolUse));
    assert.equal(settings.hooks.PostToolUse[0].matcher, '.*');
    assert.ok(settings.hooks.PostToolUse[0].hooks[0].command.includes('np-ctx-monitor.cjs'));
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
    assert.ok(settings.statusLine.command.includes('np-statusline.cjs'));
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
    assert.ok(settings.hooks.PostToolUse[1].hooks[0].command.includes('np-ctx-monitor.cjs'));
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

test('claude-hooks: details payload uses basename only (no path leak)', () => {
  const dir = _mkSandbox();
  try {
    fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), '{broken');
    try {
      mod.installClaudeHooks({ projectRoot: dir, scope: 'local' });
      assert.fail('expected throw');
    } catch (err) {
      assert.equal(err.code, 'claude-settings-invalid-json');
      assert.equal(err.details.file, 'settings.local.json');
      const detailStr = JSON.stringify(err.details);
      assert.ok(!detailStr.includes('/'), 'no path separators: ' + detailStr);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('claude-hooks: concurrent installs serialize (last-writer keeps both hooks)', async () => {
  const dir = _mkSandbox();
  try {
    const runs = await Promise.all([
      Promise.resolve().then(() => mod.installClaudeHooks({ projectRoot: dir, scope: 'local' })),
      Promise.resolve().then(() => mod.installClaudeHooks({ projectRoot: dir, scope: 'local' })),
      Promise.resolve().then(() => mod.installClaudeHooks({ projectRoot: dir, scope: 'local' })),
    ]);
    assert.equal(runs.length, 3);
    const settings = JSON.parse(fs.readFileSync(runs[0].path, 'utf-8'));
    assert.ok(settings.statusLine && settings.statusLine.command);
    assert.ok(Array.isArray(settings.hooks.PostToolUse) && settings.hooks.PostToolUse.length === 1);
    assert.equal(settings.hooks.PostToolUse[0].hooks.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('claude-hooks: concurrent install + foreign-key write — foreign key survives', async () => {
  const dir = _mkSandbox();
  const settingsPath = path.join(dir, '.claude', 'settings.local.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ foreignKey: 'value-A' }));
  try {
    await Promise.all([
      Promise.resolve().then(() => mod.installClaudeHooks({ projectRoot: dir, scope: 'local' })),
      Promise.resolve().then(() => mod.installClaudeHooks({ projectRoot: dir, scope: 'local' })),
    ]);
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    assert.equal(settings.foreignKey, 'value-A', 'foreign field must survive concurrent installs');
    assert.ok(settings.statusLine, 'statusLine installed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('claude-hooks: settings file with only whitespace is treated as empty', () => {
  const dir = _mkSandbox();
  try {
    fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), '   \n\n  \t  ');
    const res = mod.installClaudeHooks({ projectRoot: dir, scope: 'local' });
    assert.equal(res.results.statusline.action, 'installed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function _mkSandboxAll() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-claude-hooks-all-'));
  const hooksDir = path.join(dir, '.claude', 'nubos-pilot', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  for (const f of ['np-statusline.cjs', 'np-ctx-monitor.cjs', 'np-security-hook.cjs', 'np-learnings-hook.cjs']) {
    fs.writeFileSync(path.join(hooksDir, f), '// stub\n');
  }
  return dir;
}

test('claude-hooks SEC: which=all registers all five security lifecycle hooks', () => {
  const dir = _mkSandboxAll();
  try {
    const res = mod.installClaudeHooks({ projectRoot: dir, scope: 'local', which: 'all' });
    const r = res.results.security;
    assert.equal(r['session-start'].action, 'installed');
    assert.equal(r.baseline.action, 'installed');
    assert.equal(r.scan.action, 'installed');
    assert.equal(r.review.action, 'installed');
    assert.equal(r.commit.action, 'installed');
    const s = JSON.parse(fs.readFileSync(res.path, 'utf-8'));
    assert.equal(s.hooks.SessionStart[0].hooks[0].command.replace(/.*np-security-hook\.cjs"\s*/, '').trim(), 'session-start');
    assert.equal(s.hooks.UserPromptSubmit[0].hooks[0].command.trim().endsWith('baseline'), true);
    assert.equal(s.hooks.Stop[0].hooks[0].command.trim().endsWith('review'), true);
    const ptu = s.hooks.PostToolUse;
    const scan = ptu.find((e) => e.matcher === 'Edit|Write|MultiEdit|NotebookEdit');
    const commit = ptu.find((e) => e.matcher === 'Bash');
    assert.ok(scan && scan.hooks[0].command.trim().endsWith('scan'));
    assert.ok(commit && commit.hooks[0].command.trim().endsWith('commit'));
    assert.ok(ptu.find((e) => e.matcher === '.*'), 'ctx-monitor still present under all');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('claude-hooks SEC: re-install is idempotent (no duplicate entries)', () => {
  const dir = _mkSandboxAll();
  try {
    mod.installClaudeHooks({ projectRoot: dir, scope: 'local', which: 'all' });
    const res2 = mod.installClaudeHooks({ projectRoot: dir, scope: 'local', which: 'all' });
    assert.equal(res2.results.security.scan.action, 'updated');
    const s = JSON.parse(fs.readFileSync(res2.path, 'utf-8'));
    assert.equal(s.hooks.SessionStart.length, 2);
    assert.equal(s.hooks.SessionStart.filter((e) => e.hooks[0].command.includes('np-security-hook.')).length, 1);
    assert.equal(s.hooks.SessionStart.filter((e) => e.hooks[0].command.includes('np-learnings-hook.')).length, 1);
    assert.equal(s.hooks.PreCompact.length, 1);
    assert.equal(s.hooks.PreCompact.filter((e) => e.hooks[0].command.includes('np-learnings-hook.')).length, 1);
    assert.equal(s.hooks.Stop.length, 2);
    assert.equal(s.hooks.Stop.filter((e) => e.hooks[0].command.includes('np-security-hook.')).length, 1);
    assert.equal(s.hooks.Stop.filter((e) => e.hooks[0].command.includes('np-learnings-hook.')).length, 1);
    assert.equal(s.hooks.PostToolUse.filter((e) => e.hooks[0].command.includes('np-security-hook.')).length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('claude-hooks SEC: which=both does NOT install security hooks (legacy unchanged)', () => {
  const dir = _mkSandboxAll();
  try {
    const res = mod.installClaudeHooks({ projectRoot: dir, scope: 'local', which: 'both' });
    assert.equal(res.results.security, undefined);
    const s = JSON.parse(fs.readFileSync(res.path, 'utf-8'));
    assert.ok(!s.hooks.SessionStart);
    assert.ok(!s.hooks.Stop);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('claude-hooks SEC: uninstall removes security hooks but preserves foreign ones', () => {
  const dir = _mkSandboxAll();
  try {
    const settingsPath = path.join(dir, '.claude', 'settings.local.json');
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo foreign-stop' }] }] },
    }));
    mod.installClaudeHooks({ projectRoot: dir, scope: 'local', which: 'all' });
    const res = mod.uninstallClaudeHooks({ projectRoot: dir, scope: 'local' });
    assert.equal(res.results.security.action, 'removed');
    const s = JSON.parse(fs.readFileSync(res.path, 'utf-8'));
    assert.equal(s.hooks.Stop.length, 1);
    assert.equal(s.hooks.Stop[0].hooks[0].command, 'echo foreign-stop');
    assert.ok(!s.hooks.SessionStart, 'our SessionStart removed');
    assert.ok(!s.hooks.PostToolUse || !s.hooks.PostToolUse.some((e) => e.hooks[0].command.includes('np-security-hook.')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('claude-hooks SEC: which=security missing script throws structured error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-claude-hooks-nosec-'));
  fs.mkdirSync(path.join(dir, '.claude', 'nubos-pilot', 'hooks'), { recursive: true });
  try {
    assert.throws(
      () => mod.installClaudeHooks({ projectRoot: dir, scope: 'local', which: 'security' }),
      (err) => err && err.code === 'claude-hooks-script-missing',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
