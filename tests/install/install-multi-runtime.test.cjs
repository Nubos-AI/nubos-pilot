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

// P2.2: on a re-install `initConfig` is null, so the late call site recomputed
// selectedRuntimes as [] — and _rewriteManagedMarkdown reads [] as ['claude'].
// A codex+gemini user lost AGENTS.md/GEMINI.md and gained a CLAUDE.md they
// never asked for; response_language "de" silently reverted to English.
test('install: update preserves non-Claude managed blocks and language (P2.2)', async (t) => {
  const install = require('../../bin/install.js');
  const root = mkTmp('p22-update');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

  await install.runInstall({
    cwd: root,
    mode: 'init',
    flags: { agents: ['codex', 'gemini'], agent: 'codex', scope: 'local', yes: true },
    askUser: async (spec) => ({
      value: spec && spec.key === 'response_language' ? 'de'
        : (spec && spec.default !== undefined ? spec.default : null),
      source: 'test',
    }),
  });

  const agentsMd = path.join(root, 'AGENTS.md');
  const geminiMd = path.join(root, 'GEMINI.md');
  assert.ok(fs.existsSync(agentsMd), 'precondition: AGENTS.md written by init');
  assert.ok(fs.existsSync(geminiMd), 'precondition: GEMINI.md written by init');
  const cfg = JSON.parse(fs.readFileSync(path.join(root, '.nubos-pilot', 'config.json'), 'utf-8'));
  assert.deepEqual(cfg.runtimes, ['codex', 'gemini']);

  await install.runInstall({
    cwd: root,
    mode: 'update',
    askUser: async (spec) => ({ value: spec && spec.default, source: 'test' }),
  });

  assert.ok(fs.existsSync(agentsMd), 'AGENTS.md must survive an update');
  assert.match(fs.readFileSync(agentsMd, 'utf-8'), /nubos-pilot:begin/,
    'AGENTS.md must keep its managed block');
  assert.ok(fs.existsSync(geminiMd), 'GEMINI.md must survive an update');
  assert.match(fs.readFileSync(geminiMd, 'utf-8'), /nubos-pilot:begin/,
    'GEMINI.md must keep its managed block');
  assert.ok(!fs.existsSync(path.join(root, 'CLAUDE.md')),
    'update must not invent a CLAUDE.md for a codex+gemini install');
});

// D2: P2.2 only closed the "initConfig null, config valid" entrance. The
// fallback crutch `runtimes.length ? runtimes : ['claude']` stayed, so any
// config whose runtimes list is missing/empty/mistyped reproduced the exact P2.2
// damage through a different door: AGENTS.md/GEMINI.md stripped, .gemini/ assets
// deleted, an unwanted CLAUDE.md invented — all at rc=0 with no warning.
// A degraded install is an error, not a guess: fail closed (silent→loud).
const DEGRADED = [
  ['runtimes-missing', (cfg) => { delete cfg.runtimes; delete cfg.runtime; }],
  ['runtimes-empty', (cfg) => { cfg.runtimes = []; delete cfg.runtime; }],
  ['runtimes-broken', (cfg) => { cfg.runtimes = 'claude'; delete cfg.runtime; }],
];

for (const [label, degrade] of DEGRADED) {
  test('install: update fails closed when config.runtimes is unusable [' + label + '] (D2)', async (t) => {
    const install = require('../../bin/install.js');
    const root = mkTmp('d2-' + label);
    t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

    await install.runInstall({
      cwd: root,
      mode: 'init',
      flags: { agents: ['codex', 'gemini'], agent: 'codex', scope: 'local', yes: true },
      askUser: async (spec) => ({ value: spec && spec.default, source: 'test' }),
    });

    const agentsMd = path.join(root, 'AGENTS.md');
    const geminiMd = path.join(root, 'GEMINI.md');
    const geminiDir = path.join(root, '.gemini');
    assert.ok(fs.existsSync(agentsMd) && fs.existsSync(geminiMd),
      'precondition: init wrote both managed files');
    const agentsBefore = fs.readFileSync(agentsMd, 'utf-8');
    const geminiBefore = fs.readFileSync(geminiMd, 'utf-8');
    const geminiDirBefore = fs.existsSync(geminiDir);

    const cfgPath = path.join(root, '.nubos-pilot', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    degrade(cfg);
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

    await assert.rejects(
      () => install.runInstall({
        cwd: root,
        mode: 'update',
        askUser: async (spec) => ({ value: spec && spec.default, source: 'test' }),
      }),
      (err) => err.code === 'install-runtimes-unreadable',
      'a degraded runtimes list must abort loudly, never fall back to claude',
    );

    assert.equal(fs.readFileSync(agentsMd, 'utf-8'), agentsBefore,
      'AGENTS.md must be byte-identical after the refusal');
    assert.equal(fs.readFileSync(geminiMd, 'utf-8'), geminiBefore,
      'GEMINI.md must be byte-identical after the refusal');
    assert.equal(fs.existsSync(geminiDir), geminiDirBefore,
      '.gemini/ assets must not be deleted by a refused update');
    assert.ok(!fs.existsSync(path.join(root, 'CLAUDE.md')),
      'a refused update must not invent a CLAUDE.md');
  });
}

test('install: dry-run update also fails closed on an unusable runtimes list (D2)', async (t) => {
  const install = require('../../bin/install.js');
  const root = mkTmp('d2-dryrun');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

  await install.runInstall({
    cwd: root,
    mode: 'init',
    flags: { agents: ['codex'], agent: 'codex', scope: 'local', yes: true },
    askUser: async (spec) => ({ value: spec && spec.default, source: 'test' }),
  });
  const cfgPath = path.join(root, '.nubos-pilot', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
  cfg.runtimes = [];
  delete cfg.runtime;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  await assert.rejects(
    () => install.runInstall({
      cwd: root, mode: 'update', dryRun: true,
      askUser: async (spec) => ({ value: spec && spec.default, source: 'test' }),
    }),
    (err) => err.code === 'install-runtimes-unreadable',
    'a preview must report the same refusal a real run would hit',
  );
});

// Guard rails for D2: these must stay green — they are the paths that legitimately
// carry a runtime list and were already fixed.
test('install: legacy config with singular `runtime` still updates (D2 regression guard)', async (t) => {
  const install = require('../../bin/install.js');
  const root = mkTmp('d2-legacy');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

  await install.runInstall({
    cwd: root,
    mode: 'init',
    flags: { agents: ['codex'], agent: 'codex', scope: 'local', yes: true },
    askUser: async (spec) => ({ value: spec && spec.default, source: 'test' }),
  });
  const cfgPath = path.join(root, '.nubos-pilot', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
  delete cfg.runtimes;
  cfg.runtime = 'codex';
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  await install.runInstall({
    cwd: root, mode: 'update',
    askUser: async (spec) => ({ value: spec && spec.default, source: 'test' }),
  });
  assert.match(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf-8'), /nubos-pilot:begin/,
    'a legacy singular runtime is a usable list — it must not fail closed');
  assert.ok(!fs.existsSync(path.join(root, 'CLAUDE.md')),
    'and it must not invent a CLAUDE.md either');
});
