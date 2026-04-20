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
    'parallelization',
    'research',
    'plan_checker',
    'verifier',
    'response_language',
  ];
  for (const key of expected) {
    assert.ok(key in config, 'config.json must contain key: ' + key);
  }
  for (const removed of ['branching_strategy', 'phase_branch_template', 'milestone_branch_template']) {
    assert.ok(!(removed in config), 'config.json must NOT contain dead key: ' + removed);
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
    flags: { agents: ['gemini'] },
    askUser: async (spec) => ({ value: spec && spec.default !== undefined ? spec.default : 'codex', source: 'test' }),
  });
  const geminiPath = path.join(root, 'GEMINI.md');
  assert.ok(fs.existsSync(geminiPath), 'GEMINI.md must be written when gemini runtime is selected');
  const gemini = fs.readFileSync(geminiPath, 'utf-8');
  assert.match(gemini, /GEMINI\.md/, 'GEMINI.md body must contain the Gemini notice');
  assert.match(gemini, /readline/i, 'GEMINI.md notice must reference readline');
});

test('install-managed-block: stale AGENTS.md from prior install is removed on claude-only re-install', async (t) => {
  const install = require('../../bin/install.js');
  const root = mkTmp('stale-agents-md');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  fs.writeFileSync(path.join(root, 'AGENTS.md'),
    '<!-- nubos-pilot:begin v1 -->\nold managed content\n<!-- nubos-pilot:end -->\n');
  fs.writeFileSync(path.join(root, 'GEMINI.md'),
    '<!-- nubos-pilot:begin v1 -->\nold managed content\n<!-- nubos-pilot:end -->\n');
  await install.runInstall({
    cwd: root,
    mode: 'init',
    flags: { agents: ['claude'] },
    askUser: async (spec) => ({ value: spec && spec.default !== undefined ? spec.default : 'claude', source: 'test' }),
  });
  assert.ok(!fs.existsSync(path.join(root, 'AGENTS.md')),
    'stale managed-only AGENTS.md must be cleaned up on claude-only install');
  assert.ok(!fs.existsSync(path.join(root, 'GEMINI.md')),
    'stale managed-only GEMINI.md must be cleaned up on claude-only install');
});

test('install-managed-block: user-authored AGENTS.md survives, only managed block stripped', async (t) => {
  const install = require('../../bin/install.js');
  const root = mkTmp('user-agents-md');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  const userContent = '# Team Rules\n\n- Write tests first.\n';
  fs.writeFileSync(path.join(root, 'AGENTS.md'),
    userContent + '\n<!-- nubos-pilot:begin v1 -->\nold\n<!-- nubos-pilot:end -->\n');
  await install.runInstall({
    cwd: root,
    mode: 'init',
    flags: { agents: ['claude'] },
    askUser: async (spec) => ({ value: spec && spec.default !== undefined ? spec.default : 'claude', source: 'test' }),
  });
  assert.ok(fs.existsSync(path.join(root, 'AGENTS.md')),
    'AGENTS.md with user content must survive');
  const kept = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf-8');
  assert.match(kept, /Team Rules/, 'user content must be preserved');
  assert.doesNotMatch(kept, /nubos-pilot:begin/, 'managed block must be stripped');
});

test('install-managed-block: claude-only install does NOT write AGENTS.md or GEMINI.md', async (t) => {
  const install = require('../../bin/install.js');
  const root = mkTmp('claude-only-agents');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  await install.runInstall({
    cwd: root,
    mode: 'init',
    flags: { agents: ['claude'] },
    askUser: async (spec) => ({ value: spec && spec.default !== undefined ? spec.default : 'claude', source: 'test' }),
  });
  assert.ok(fs.existsSync(path.join(root, 'CLAUDE.md')), 'CLAUDE.md must exist');
  assert.ok(!fs.existsSync(path.join(root, 'AGENTS.md')),
    'AGENTS.md must NOT be written for claude-only install');
  assert.ok(!fs.existsSync(path.join(root, 'GEMINI.md')),
    'GEMINI.md must NOT be written for claude-only install');
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

test('install-managed-block: response_language=de injects German language directive into CLAUDE.md', async (t) => {
  const install = require('../../bin/install.js');
  const root = mkTmp('managed-lang-de');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  await install.runInstall({
    cwd: root,
    mode: 'init',
    askUser: async (spec) => {
      if (spec && spec.question && /language/i.test(spec.question)) {
        return { value: 'de', source: 'test' };
      }
      return { value: spec && spec.default !== undefined ? spec.default : 'claude', source: 'test' };
    },
  });
  const claude = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf-8');
  assert.match(claude, /<!-- nubos-pilot:begin v1 -->/, 'managed block must be present');
  assert.match(claude, /Sprache:\s+\*\*Deutsch/, 'German language directive must be injected when response_language=de');
  const config = JSON.parse(fs.readFileSync(path.join(root, '.nubos-pilot', 'config.json'), 'utf-8'));
  assert.equal(config.response_language, 'de', 'config.json must persist response_language=de');
});

test('install-assets: writes .nubos-pilot/bin/np-tools.cjs shim with abs path to package np-tools.cjs', async (t) => {
  const install = require('../../bin/install.js');
  const root = mkTmp('assets-shim');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  writeClaudeMd(root);
  await install.runInstall({
    cwd: root,
    mode: 'init',
    flags: { agents: ['claude'] },
    askUser: async (spec) => ({ value: spec && spec.default !== undefined ? spec.default : 'claude', source: 'test' }),
  });
  const shimPath = path.join(root, '.nubos-pilot', 'bin', 'np-tools.cjs');
  assert.ok(fs.existsSync(shimPath), '.nubos-pilot/bin/np-tools.cjs shim must exist');
  const shim = fs.readFileSync(shimPath, 'utf-8');
  const pkgNpTools = path.resolve(__dirname, '..', '..', 'np-tools.cjs');
  assert.ok(shim.includes(JSON.stringify(pkgNpTools)),
    'shim must embed absolute path to package np-tools.cjs');
  assert.match(shim, /^#!\/usr\/bin\/env node/, 'shim must be a node shebang script');
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
