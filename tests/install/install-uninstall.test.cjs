const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function mkTmp(scope) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'np-' + scope + '-'));
}

test('install-uninstall: removes manifest-tracked files, strips managed blocks, leaves .bak files (D-20)', async (t) => {
  const install = require('../../bin/install.js');
  const root = mkTmp('uninstall');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

  const payloadDir = path.join(root, '.claude', 'nubos-pilot');
  fs.mkdirSync(payloadDir, { recursive: true });
  fs.writeFileSync(path.join(payloadDir, 'a.md'), 'payload a');
  fs.writeFileSync(path.join(payloadDir, 'b.md'), 'payload b');
  fs.writeFileSync(path.join(payloadDir, '.manifest.json'), JSON.stringify({
    version: '1.0.0',
    timestamp: '2026-04-16T00:00:00Z',
    files: { 'a.md': 'aa', 'b.md': 'bb' },
  }));

  const claude = [
    '# My Project',
    '',
    '<!-- nubos-pilot:begin v1 -->',
    'managed content',
    '<!-- nubos-pilot:end -->',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), claude);
  fs.writeFileSync(path.join(root, 'AGENTS.md'), claude);

  fs.writeFileSync(path.join(payloadDir, 'a.md.bak'), 'prior user version');

  await install.runUninstall({ cwd: root });

  assert.ok(!fs.existsSync(path.join(payloadDir, 'a.md')), 'manifest-tracked a.md removed');
  assert.ok(!fs.existsSync(path.join(payloadDir, 'b.md')), 'manifest-tracked b.md removed');
  assert.ok(!fs.existsSync(path.join(payloadDir, '.manifest.json')), 'manifest self-destruct');

  assert.ok(fs.existsSync(path.join(payloadDir, 'a.md.bak')),
    '.bak files must be left untouched');

  const claudeAfter = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf-8');
  const agentsAfter = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf-8');
  assert.ok(!claudeAfter.includes('nubos-pilot:begin'), 'CLAUDE.md managed block stripped');
  assert.ok(!agentsAfter.includes('nubos-pilot:begin'), 'AGENTS.md managed block stripped');
  assert.ok(claudeAfter.includes('# My Project'), 'user content preserved in CLAUDE.md');
});

test('install-uninstall: OpenCode uninstall is surgical — removes .opencode/nubos-pilot/ only, user content in .opencode/ survives (8.1 D-02)', async (t) => {
  const install = require('../../bin/install.js');
  const root = mkTmp('uninstall-opencode-surgical');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  fs.writeFileSync(path.join(root, 'CLAUDE.md'),
    '---\nname: test\n---\n# Test\n\n<!-- nubos-pilot:begin v1 -->\nold\n<!-- nubos-pilot:end -->\n');
  await install.runInstall({
    cwd: root,
    mode: 'init',
    askUser: async (spec) => ({ value: spec && spec.default !== undefined ? spec.default : 'codex', source: 'test' }),
  });
  assert.ok(fs.existsSync(path.join(root, '.opencode', 'nubos-pilot', 'AGENTS.md')),
    'precondition: .opencode/nubos-pilot/AGENTS.md present after install');
  const userFile = path.join(root, '.opencode', 'user-owned.md');
  fs.writeFileSync(userFile, 'user-owned sibling in .opencode/');
  await install.runUninstall({ cwd: root });
  assert.ok(!fs.existsSync(path.join(root, '.opencode', 'nubos-pilot')),
    '.opencode/nubos-pilot/ must be removed on uninstall');
  assert.ok(fs.existsSync(userFile),
    'user-owned file in .opencode/ must survive uninstall (surgical scoping)');
  assert.equal(fs.readFileSync(userFile, 'utf-8'), 'user-owned sibling in .opencode/',
    'user content bytes unchanged');
  assert.ok(fs.existsSync(path.join(root, '.opencode')),
    '.opencode/ parent survives because user-owned sibling is non-empty');
});

test('install-uninstall: OpenCode parent .opencode/ is rmdir-ed when empty after uninstall (8.1 D-02)', async (t) => {
  const install = require('../../bin/install.js');
  const root = mkTmp('uninstall-opencode-empty-parent');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  fs.writeFileSync(path.join(root, 'CLAUDE.md'),
    '---\nname: test\n---\n# Test\n\n<!-- nubos-pilot:begin v1 -->\nold\n<!-- nubos-pilot:end -->\n');
  await install.runInstall({
    cwd: root,
    mode: 'init',
    askUser: async (spec) => ({ value: spec && spec.default !== undefined ? spec.default : 'codex', source: 'test' }),
  });
  assert.ok(fs.existsSync(path.join(root, '.opencode', 'nubos-pilot')),
    'precondition: .opencode/nubos-pilot/ present after install');
  await install.runUninstall({ cwd: root });
  assert.ok(!fs.existsSync(path.join(root, '.opencode')),
    'empty .opencode/ parent must be rmdir-ed after uninstall');
});
