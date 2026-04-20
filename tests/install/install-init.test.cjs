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

test('install-init: full init flow writes .nubos-pilot/config.json with all canonical keys (INST-02, D-21)', async (t) => {
  const install = require('../../bin/install.js');
  const root = mkTmp('init-full');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

  const mockAskUser = async (spec) => ({
    value: spec && spec.default !== undefined ? spec.default : 'claude',
    source: 'test',
  });

  await install.runInstall({
    cwd: root,
    mode: 'init',
    askUser: mockAskUser,
  });

  const configPath = path.join(root, '.nubos-pilot', 'config.json');
  assert.ok(fs.existsSync(configPath), '.nubos-pilot/config.json must be written');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  const expected = [
    'runtime',
    'model_profile',
    'commit_docs',
    'branching_strategy',
    'phase_branch_template',
    'milestone_branch_template',
    'parallelization',
    'research',
    'plan_checker',
    'verifier',
    'response_language',
  ];
  for (const key of expected) {
    assert.ok(key in config, 'config.json must contain key: ' + key);
  }
});

test('install-p8-02: writes .opencode/nubos-pilot/ payload tree and merges manifest (RUN-02, 8.1 D-02)', async (t) => {
  const install = require('../../bin/install.js');
  const root = mkTmp('p8-02');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  writeClaudeMd(root);
  await install.runInstall({
    cwd: root,
    mode: 'init',
    flags: { agents: ['claude', 'opencode'] },
    askUser: async (spec) => ({ value: spec && spec.default !== undefined ? spec.default : 'codex', source: 'test' }),
  });
  assert.ok(fs.existsSync(path.join(root, '.opencode', 'nubos-pilot', 'AGENTS.md')),
    '.opencode/nubos-pilot/AGENTS.md must be installed');
  assert.ok(!fs.existsSync(path.join(root, '.opencode', 'AGENTS.md')),
    'flat .opencode/AGENTS.md must NOT be written (regression guard for 8.1 D-02)');
  assert.ok(fs.existsSync(path.join(root, 'opencode.json')),
    'opencode.json must still land at project root (D-03 regression guard)');
  const manifestPath = path.join(root, '.claude', 'nubos-pilot', '.manifest.json');
  assert.ok(fs.existsSync(manifestPath), 'manifest must exist after install');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const hasOpencodeEntry = Object.keys(manifest.files).some((k) => k.startsWith('.opencode/nubos-pilot/'));
  assert.ok(hasOpencodeEntry, 'manifest.files must include .opencode/nubos-pilot/* entries');
});

test('install-p8-03: writes GEMINI.md with Gemini-specific notice (RUN-04, D-17)', async (t) => {
  const install = require('../../bin/install.js');
  const root = mkTmp('p8-03-gemini');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  writeClaudeMd(root);
  await install.runInstall({
    cwd: root,
    mode: 'init',
    askUser: async (spec) => ({ value: spec && spec.default !== undefined ? spec.default : 'codex', source: 'test' }),
  });
  const geminiPath = path.join(root, 'GEMINI.md');
  assert.ok(fs.existsSync(geminiPath), 'GEMINI.md must be written on install');
  const gemini = fs.readFileSync(geminiPath, 'utf-8');
  assert.match(gemini, /GEMINI\.md/, 'GEMINI.md body must contain the Gemini notice');
  assert.match(gemini, /readline/i, 'GEMINI.md notice must reference readline');
});

test('install-p8-03: writes opencode.json when absent (D-13)', async (t) => {
  const install = require('../../bin/install.js');
  const root = mkTmp('p8-03-opencode-fresh');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  writeClaudeMd(root);
  assert.ok(!fs.existsSync(path.join(root, 'opencode.json')));
  await install.runInstall({
    cwd: root,
    mode: 'init',
    flags: { agents: ['opencode'] },
    askUser: async (spec) => ({ value: spec && spec.default !== undefined ? spec.default : 'codex', source: 'test' }),
  });
  const jsonPath = path.join(root, 'opencode.json');
  assert.ok(fs.existsSync(jsonPath));
  const cfg = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  assert.equal(cfg.$schema, 'https://opencode.ai/config.json',
    '$schema must match the OpenCode config schema URL');
  assert.ok(!('model' in cfg), 'opencode.json must NOT declare a model field (inherit via omission)');
});

test('install-p8-03: preserves existing opencode.json (RESEARCH Pitfall 6)', async (t) => {
  const install = require('../../bin/install.js');
  const root = mkTmp('p8-03-opencode-existing');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  writeClaudeMd(root);
  const userCfg = '{"custom": true}';
  fs.writeFileSync(path.join(root, 'opencode.json'), userCfg);
  await install.runInstall({
    cwd: root,
    mode: 'init',
    askUser: async (spec) => ({ value: spec && spec.default !== undefined ? spec.default : 'codex', source: 'test' }),
  });
  assert.equal(fs.readFileSync(path.join(root, 'opencode.json'), 'utf-8'), userCfg,
    'Existing opencode.json must NOT be overwritten');
});

test('install-p8-04: persists runtime and runtime_source in .nubos-pilot/config.json (D-11)', async (t) => {
  const install = require('../../bin/install.js');
  const root = mkTmp('p8-04-runtime-persist');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  writeClaudeMd(root);
  await install.runInstall({
    cwd: root,
    mode: 'init',
    askUser: async (spec) => ({ value: spec && spec.default !== undefined ? spec.default : 'codex', source: 'test' }),
  });
  const cfg = JSON.parse(fs.readFileSync(path.join(root, '.nubos-pilot', 'config.json'), 'utf-8'));
  assert.equal(typeof cfg.runtime, 'string',
    'config.json must persist runtime as string');
  assert.equal(typeof cfg.runtime_source, 'string',
    'config.json must persist runtime_source as string');
  assert.ok(cfg.runtime.length > 0, 'runtime must be non-empty');
  assert.ok(cfg.runtime_source.length > 0, 'runtime_source must be non-empty');
  assert.ok('model_profile' in cfg,
    'existing init-question fields must be preserved alongside runtime persistence');
});

test('install-p8-04: dry-run does not write opencode.json, GEMINI.md, or .opencode/', async (t) => {
  const install = require('../../bin/install.js');
  const root = mkTmp('p8-04-dryrun-files');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  writeClaudeMd(root);
  const summary = await install.runInstall({
    cwd: root,
    mode: 'init',
    dryRun: true,
    askUser: async (spec) => ({ value: spec && spec.default !== undefined ? spec.default : 'codex', source: 'test' }),
  });
  assert.equal(summary.dryRun, true, 'summary.dryRun must be true');
  assert.ok(!fs.existsSync(path.join(root, 'opencode.json')),
    'dry-run must NOT create opencode.json');
  assert.ok(!fs.existsSync(path.join(root, 'GEMINI.md')),
    'dry-run must NOT create GEMINI.md');
  assert.ok(!fs.existsSync(path.join(root, '.opencode', 'nubos-pilot')),
    'dry-run must NOT create .opencode/nubos-pilot/');
  assert.ok(!fs.existsSync(path.join(root, '.opencode')),
    'dry-run must NOT create .opencode/ parent dir either');
  assert.ok(!fs.existsSync(path.join(root, '.nubos-pilot', 'config.json')),
    'dry-run must NOT write .nubos-pilot/config.json');
});

test('install-p8-04: dry-run summary exposes wouldWriteGemini and wouldWriteOpencodeJson', async (t) => {
  const install = require('../../bin/install.js');
  const root = mkTmp('p8-04-dryrun-summary');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  writeClaudeMd(root);
  const summary = await install.runInstall({
    cwd: root,
    mode: 'init',
    dryRun: true,
    flags: { agents: ['opencode'] },
    askUser: async (spec) => ({ value: spec && spec.default !== undefined ? spec.default : 'codex', source: 'test' }),
  });
  assert.equal(typeof summary.wouldWriteGemini, 'boolean',
    'summary.wouldWriteGemini must be a boolean');
  assert.equal(typeof summary.wouldWriteOpencodeJson, 'boolean',
    'summary.wouldWriteOpencodeJson must be a boolean');
  assert.equal(summary.wouldWriteOpencodeJson, true,
    'Fresh sandbox has no opencode.json → wouldWriteOpencodeJson must be true');
});

test('install-p8-02: claude-only install does NOT create .opencode/ or opencode.json', async (t) => {
  const install = require('../../bin/install.js');
  const root = mkTmp('p8-02-claude-only');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  writeClaudeMd(root);
  await install.runInstall({
    cwd: root,
    mode: 'init',
    flags: { agents: ['claude'] },
    askUser: async (spec) => ({ value: spec && spec.default !== undefined ? spec.default : 'claude', source: 'test' }),
  });
  assert.ok(!fs.existsSync(path.join(root, '.opencode')),
    'claude-only install must NOT create .opencode/ parent');
  assert.ok(!fs.existsSync(path.join(root, 'opencode.json')),
    'claude-only install must NOT create opencode.json');
});

test('install-assets: claude install copies workflows → .claude/commands/np/ and agents → .claude/agents/', async (t) => {
  const install = require('../../bin/install.js');
  const root = mkTmp('assets-claude');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  writeClaudeMd(root);
  await install.runInstall({
    cwd: root,
    mode: 'init',
    flags: { agents: ['claude'] },
    askUser: async (spec) => ({ value: spec && spec.default !== undefined ? spec.default : 'claude', source: 'test' }),
  });
  assert.ok(fs.existsSync(path.join(root, '.claude', 'commands', 'np', 'help.md')),
    'workflow help.md must be installed at .claude/commands/np/help.md');
  assert.ok(fs.existsSync(path.join(root, '.claude', 'commands', 'np', 'plan-phase.md')),
    'workflow plan-phase.md must be installed at .claude/commands/np/plan-phase.md');
  assert.ok(fs.existsSync(path.join(root, '.claude', 'agents', 'np-planner.md')),
    'agent np-planner.md must be installed at .claude/agents/np-planner.md');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'nubos-pilot', '.manifest.json'), 'utf-8'));
  assert.ok(manifest.files['.claude/commands/np/help.md'],
    'manifest must track .claude/commands/np/help.md');
  assert.ok(manifest.files['.claude/agents/np-planner.md'],
    'manifest must track .claude/agents/np-planner.md');
});

test('install-assets: uninstall removes installed commands, agents, and empty parent dirs', async (t) => {
  const install = require('../../bin/install.js');
  const root = mkTmp('assets-uninstall');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  writeClaudeMd(root);
  await install.runInstall({
    cwd: root,
    mode: 'init',
    flags: { agents: ['claude'] },
    askUser: async (spec) => ({ value: spec && spec.default !== undefined ? spec.default : 'claude', source: 'test' }),
  });
  assert.ok(fs.existsSync(path.join(root, '.claude', 'commands', 'np', 'help.md')));
  await install.runUninstall({ cwd: root });
  assert.ok(!fs.existsSync(path.join(root, '.claude', 'commands', 'np', 'help.md')),
    'command file must be removed on uninstall');
  assert.ok(!fs.existsSync(path.join(root, '.claude', 'agents', 'np-planner.md')),
    'agent file must be removed on uninstall');
  assert.ok(!fs.existsSync(path.join(root, '.claude', 'commands')),
    'empty .claude/commands/ must be pruned');
  assert.ok(!fs.existsSync(path.join(root, '.claude', 'agents')),
    'empty .claude/agents/ must be pruned');
});

test('install-p8-04: dry-run preserves existing opencode.json reflected in summary', async (t) => {
  const install = require('../../bin/install.js');
  const root = mkTmp('p8-04-dryrun-existing');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  writeClaudeMd(root);
  fs.writeFileSync(path.join(root, 'opencode.json'), '{"custom": true}');
  const summary = await install.runInstall({
    cwd: root,
    mode: 'init',
    dryRun: true,
    askUser: async (spec) => ({ value: spec && spec.default !== undefined ? spec.default : 'codex', source: 'test' }),
  });
  assert.equal(summary.wouldWriteOpencodeJson, false,
    'Existing opencode.json → wouldWriteOpencodeJson must be false');
});
