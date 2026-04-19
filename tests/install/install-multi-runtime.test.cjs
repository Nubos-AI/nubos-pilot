const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function mkTmp(scope) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'np-' + scope + '-'));
}

function writeClaudeMd(dir) {
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'),
    '---\nname: test\n---\n# Test\n\n<!-- nubos-pilot:begin v1 -->\nold\n<!-- nubos-pilot:end -->\n');
}

test('registry: listRuntimeIds returns 14 runtimes', () => {
  const registry = require('../../lib/install/runtimes-registry.cjs');
  const ids = registry.listRuntimeIds();
  assert.equal(ids.length, 14, 'must list 14 runtimes');
  for (const id of ['claude', 'antigravity', 'augment', 'cline', 'codebuddy',
    'codex', 'copilot', 'cursor', 'gemini', 'kilo',
    'opencode', 'qwen', 'trae', 'windsurf']) {
    assert.ok(ids.includes(id), 'registry must include runtime: ' + id);
  }
});

test('parseInstallFlags: --agents accepts comma-separated runtimes', () => {
  const { parseInstallFlags } = require('../../bin/install.js');
  const { flags } = parseInstallFlags(['--agents', 'claude,cursor,windsurf']);
  assert.deepEqual(flags.agents, ['claude', 'cursor', 'windsurf']);
  assert.equal(flags.agent, 'claude', '--agents sets agent to first value');
});

test('parseInstallFlags: --agents space-separated also works', () => {
  const { parseInstallFlags } = require('../../bin/install.js');
  const { flags } = parseInstallFlags(['--agents', 'codex cline kilo']);
  assert.deepEqual(flags.agents, ['codex', 'cline', 'kilo']);
});

test('parseInstallFlags: --all selects every runtime', () => {
  const { parseInstallFlags } = require('../../bin/install.js');
  const { flags } = parseInstallFlags(['--all']);
  assert.equal(flags.agents.length, 14);
  assert.ok(flags.agents.includes('cursor') && flags.agents.includes('windsurf'));
});

test('parseInstallFlags: --agents rejects unknown runtime', () => {
  const { parseInstallFlags } = require('../../bin/install.js');
  assert.throws(
    () => parseInstallFlags(['--agents', 'claude,bogus']),
    /must be one of/,
  );
});

test('install: --agents cursor writes .cursor/rules/nubos-pilot.mdc with managed block', async (t) => {
  const install = require('../../bin/install.js');
  const root = mkTmp('cursor');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  writeClaudeMd(root);

  await install.runInstall({
    cwd: root,
    mode: 'init',
    flags: { agents: ['cursor'], agent: 'cursor', scope: 'local', yes: true },
    askUser: async (spec) => ({ value: spec && spec.default !== undefined ? spec.default : null, source: 'test' }),
  });

  const cursorFile = path.join(root, '.cursor', 'rules', 'nubos-pilot.mdc');
  assert.ok(fs.existsSync(cursorFile), '.cursor/rules/nubos-pilot.mdc must exist');
  const content = fs.readFileSync(cursorFile, 'utf-8');
  assert.match(content, /nubos-pilot:begin/);
  assert.match(content, /nubos-pilot:end/);
});

test('install: --agents cline writes .clinerules with managed block', async (t) => {
  const install = require('../../bin/install.js');
  const root = mkTmp('cline');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  writeClaudeMd(root);

  await install.runInstall({
    cwd: root,
    mode: 'init',
    flags: { agents: ['cline'], agent: 'cline', scope: 'local', yes: true },
    askUser: async (spec) => ({ value: spec && spec.default !== undefined ? spec.default : null, source: 'test' }),
  });

  const clineFile = path.join(root, '.clinerules');
  assert.ok(fs.existsSync(clineFile), '.clinerules must exist');
  const content = fs.readFileSync(clineFile, 'utf-8');
  assert.match(content, /nubos-pilot:begin/);
});

test('install: --agents windsurf writes .windsurfrules with managed block', async (t) => {
  const install = require('../../bin/install.js');
  const root = mkTmp('windsurf');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  writeClaudeMd(root);

  await install.runInstall({
    cwd: root,
    mode: 'init',
    flags: { agents: ['windsurf'], agent: 'windsurf', scope: 'local', yes: true },
    askUser: async (spec) => ({ value: spec && spec.default !== undefined ? spec.default : null, source: 'test' }),
  });

  const wsFile = path.join(root, '.windsurfrules');
  assert.ok(fs.existsSync(wsFile), '.windsurfrules must exist');
  const content = fs.readFileSync(wsFile, 'utf-8');
  assert.match(content, /nubos-pilot:begin/);
});

test('install: --agents copilot writes .github/copilot-instructions.md with managed block', async (t) => {
  const install = require('../../bin/install.js');
  const root = mkTmp('copilot');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  writeClaudeMd(root);

  await install.runInstall({
    cwd: root,
    mode: 'init',
    flags: { agents: ['copilot'], agent: 'copilot', scope: 'local', yes: true },
    askUser: async (spec) => ({ value: spec && spec.default !== undefined ? spec.default : null, source: 'test' }),
  });

  const cp = path.join(root, '.github', 'copilot-instructions.md');
  assert.ok(fs.existsSync(cp), '.github/copilot-instructions.md must exist');
  const content = fs.readFileSync(cp, 'utf-8');
  assert.match(content, /nubos-pilot:begin/);
});

test('install: --agents multi-pick writes rules files for all selected runtimes', async (t) => {
  const install = require('../../bin/install.js');
  const root = mkTmp('multi');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  writeClaudeMd(root);

  await install.runInstall({
    cwd: root,
    mode: 'init',
    flags: {
      agents: ['claude', 'cursor', 'cline'],
      agent: 'claude',
      scope: 'local',
      yes: true,
    },
    askUser: async (spec) => ({ value: spec && spec.default !== undefined ? spec.default : null, source: 'test' }),
  });

  assert.ok(fs.existsSync(path.join(root, 'CLAUDE.md')), 'CLAUDE.md written');
  assert.ok(fs.existsSync(path.join(root, '.cursor', 'rules', 'nubos-pilot.mdc')), 'cursor rule written');
  assert.ok(fs.existsSync(path.join(root, '.clinerules')), '.clinerules written');
});

test('registry: runtimeAgentsPath resolves dir-scoped and project-scoped correctly', () => {
  const registry = require('../../lib/install/runtimes-registry.cjs');
  const cursor = registry.getRuntimeMeta('cursor');
  const p = registry.runtimeAgentsPath(cursor, 'local', '/tmp/proj');
  assert.equal(p, '/tmp/proj/.cursor/rules/nubos-pilot.mdc');

  const cline = registry.getRuntimeMeta('cline');
  const c = registry.runtimeAgentsPath(cline, 'local', '/tmp/proj');
  assert.equal(c, '/tmp/proj/.clinerules');

  const windsurf = registry.getRuntimeMeta('windsurf');
  const w = registry.runtimeAgentsPath(windsurf, 'local', '/tmp/proj');
  assert.equal(w, '/tmp/proj/.windsurfrules');

  const copilot = registry.getRuntimeMeta('copilot');
  const cp = registry.runtimeAgentsPath(copilot, 'local', '/tmp/proj');
  assert.equal(cp, '/tmp/proj/.github/copilot-instructions.md');
});
