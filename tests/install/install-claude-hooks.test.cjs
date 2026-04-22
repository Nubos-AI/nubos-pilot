'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function mkTmp(suffix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'np-install-hooks-' + suffix + '-'));
}

function mockAskUser(pick) {
  return async (spec) => ({
    value: spec && spec.default !== undefined ? spec.default : pick,
    source: 'test',
  });
}

test('install: auto-registers Claude hooks when claude runtime selected', async (t) => {
  const install = require('../../bin/install.js');
  const root = mkTmp('init-claude');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

  await install.runInstall({
    cwd: root,
    mode: 'init',
    askUser: mockAskUser('claude'),
  });

  const statuslineScript = path.join(root, '.claude', 'nubos-pilot', 'hooks', 'np-statusline.js');
  const ctxMonitorScript = path.join(root, '.claude', 'nubos-pilot', 'hooks', 'np-ctx-monitor.js');
  assert.ok(fs.existsSync(statuslineScript), 'statusline script must be copied into payload');
  assert.ok(fs.existsSync(ctxMonitorScript), 'ctx-monitor script must be copied into payload');

  const settingsPath = path.join(root, '.claude', 'settings.local.json');
  assert.ok(fs.existsSync(settingsPath), 'settings.local.json must be written');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  assert.equal(settings.statusLine.type, 'command');
  assert.ok(settings.statusLine.command.includes('np-statusline.js'));
  assert.ok(Array.isArray(settings.hooks.PostToolUse));
  assert.ok(settings.hooks.PostToolUse.some((e) => (e.hooks || []).some((h) => h.command && h.command.includes('np-ctx-monitor.js'))));
});

test('update: re-running install in update mode refreshes Claude hook paths', async (t) => {
  const install = require('../../bin/install.js');
  const root = mkTmp('update-claude');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

  await install.runInstall({ cwd: root, mode: 'init', askUser: mockAskUser('claude') });
  await install.runInstall({ cwd: root, mode: 'update', askUser: mockAskUser('claude') });

  const settingsPath = path.join(root, '.claude', 'settings.local.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  assert.ok(settings.statusLine.command.includes('np-statusline.js'));
  const ctxEntries = settings.hooks.PostToolUse.filter((e) => (e.hooks || []).some((h) => h.command && h.command.includes('np-ctx-monitor.js')));
  assert.equal(ctxEntries.length, 1, 'update must not duplicate ctx-monitor hook');
});

test('install: preserves foreign statusLine (no --force in auto-register)', async (t) => {
  const install = require('../../bin/install.js');
  const root = mkTmp('foreign-statusline');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'settings.local.json'),
    JSON.stringify({ statusLine: { type: 'command', command: 'echo my-bar' } }));

  await install.runInstall({ cwd: root, mode: 'init', askUser: mockAskUser('claude') });

  const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.local.json'), 'utf-8'));
  assert.equal(settings.statusLine.command, 'echo my-bar',
    'foreign statusLine must survive auto-register without --force');
  assert.ok(Array.isArray(settings.hooks && settings.hooks.PostToolUse),
    'ctx-monitor hook must still be registered even when statusLine is foreign');
});

test('install: skips Claude hooks when claude runtime not selected', async (t) => {
  const install = require('../../bin/install.js');
  const root = mkTmp('no-claude');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

  await install.runInstall({
    cwd: root,
    mode: 'init',
    askUser: mockAskUser('codex'),
    flags: { agent: 'codex' },
  });

  const settingsPath = path.join(root, '.claude', 'settings.local.json');
  if (fs.existsSync(settingsPath)) {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    assert.ok(!settings.statusLine || !String(settings.statusLine.command || '').includes('np-statusline.js'),
      'codex-only install must not register our statusLine');
  }
});
