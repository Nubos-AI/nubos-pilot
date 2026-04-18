const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function mkTmp(scope) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'np-' + scope + '-'));
}

test('install-stale-cleanup: stale files removed from .claude/nubos-pilot/ on re-install (INST-08, D-06)', async (t) => {
  const install = require('../../bin/install.js');
  const root = mkTmp('stale-cleanup');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

  
  const payloadDir = path.join(root, '.claude', 'nubos-pilot');
  fs.mkdirSync(payloadDir, { recursive: true });
  fs.writeFileSync(path.join(payloadDir, 'stale.md'), 'stale payload');
  fs.writeFileSync(path.join(payloadDir, 'kept.md'), 'kept payload');
  fs.writeFileSync(path.join(payloadDir, '.manifest.json'), JSON.stringify({
    version: '0.0.1',
    timestamp: '2026-04-10T00:00:00Z',
    files: { 'stale.md': 'aa', 'kept.md': 'bb' },
  }));

  const coresident = path.join(root, '.claude', 'other-tool');
  fs.mkdirSync(coresident, { recursive: true });
  fs.writeFileSync(path.join(coresident, 'dummy.md'), 'co-resident tool');

  const sourceDir = mkTmp('stale-src');
  t.after(() => { try { fs.rmSync(sourceDir, { recursive: true, force: true }); } catch {} });
  fs.writeFileSync(path.join(sourceDir, 'kept.md'), 'kept payload v2');

  await install.runInstall({
    cwd: root,
    mode: 're-install',
    sourceDir,
    askUser: async (spec) => ({ value: spec && spec.default, source: 'test' }),
  });

  assert.ok(!fs.existsSync(path.join(payloadDir, 'stale.md')),
    'stale payload file must be removed via manifest-diff');
  assert.ok(fs.existsSync(path.join(coresident, 'dummy.md')),
    'co-resident sibling files must remain untouched (D-23)');
});
