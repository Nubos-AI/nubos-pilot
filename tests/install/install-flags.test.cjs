const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function mkTmp(scope) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'np-flags-' + scope + '-'));
}

function writeClaudeMd(dir) {
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'),
    '---\nname: test\n---\n# Test\n\n<!-- nubos-pilot:begin v1 -->\nold\n<!-- nubos-pilot:end -->\n');
}

test('parseInstallFlags: handles --agent, --scope, --mcp, --yes in space and equals form', () => {
  const { parseInstallFlags } = require('../../bin/install.js');
  const cases = [
    [['--agent', 'gemini'], { agent: 'gemini', scope: null, mcp: false, yes: false }],
    [['--agent=codex'], { agent: 'codex', scope: null, mcp: false, yes: false }],
    [['--scope', 'global'], { agent: null, scope: 'global', mcp: false, yes: false }],
    [['--scope=local'], { agent: null, scope: 'local', mcp: false, yes: false }],
    [['--mcp'], { agent: null, scope: null, mcp: true, yes: false }],
    [['--yes'], { agent: null, scope: null, mcp: false, yes: true }],
    [['-y'], { agent: null, scope: null, mcp: false, yes: true }],
    [['--agent=claude', '--scope=local', '--mcp', '--yes'],
      { agent: 'claude', scope: 'local', mcp: true, yes: true }],
    [['-a', 'opencode', '-s', 'global'],
      { agent: 'opencode', scope: 'global', mcp: false, yes: false }],
  ];
  for (const [args, expected] of cases) {
    const { flags } = parseInstallFlags(args);
    assert.deepEqual(flags, expected, 'args=' + JSON.stringify(args));
  }
});

test('parseInstallFlags: preserves non-flag args in rest', () => {
  const { parseInstallFlags } = require('../../bin/install.js');
  const { flags, rest } = parseInstallFlags(['--dry-run', '--agent=claude', 'update']);
  assert.equal(flags.agent, 'claude');
  assert.deepEqual(rest, ['--dry-run', 'update']);
});

test('parseInstallFlags: throws on invalid --agent', () => {
  const { parseInstallFlags } = require('../../bin/install.js');
  assert.throws(() => parseInstallFlags(['--agent=bogus']),
    (err) => err.code === 'invalid-flag' && /--agent/.test(err.message));
});

test('parseInstallFlags: throws on invalid --scope', () => {
  const { parseInstallFlags } = require('../../bin/install.js');
  assert.throws(() => parseInstallFlags(['--scope=everywhere']),
    (err) => err.code === 'invalid-flag' && /--scope/.test(err.message));
});

test('install-flags: --agent=gemini skips runtime prompt and persists scope + mcp in config', async (t) => {
  const install = require('../../bin/install.js');
  const root = mkTmp('agent-flag');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  writeClaudeMd(root);

  const askedQuestions = [];
  const mockAskUser = async (spec) => {
    askedQuestions.push(spec.question);
    return { value: spec && spec.default !== undefined ? spec.default : 'codex', source: 'test' };
  };

  await install.runInstall({
    cwd: root,
    mode: 'init',
    askUser: mockAskUser,
    flags: { agent: 'gemini', scope: 'local', mcp: true },
  });

  for (const q of askedQuestions) {
    assert.doesNotMatch(q, /Welche Runtime/, 'runtime question must be skipped when --agent set');
    assert.doesNotMatch(q, /Installation scope/, 'scope question must be skipped when --scope set');
  }

  const cfg = JSON.parse(fs.readFileSync(path.join(root, '.nubos-pilot', 'config.json'), 'utf-8'));
  assert.equal(cfg.runtime, 'gemini', 'runtime must reflect --agent value');
  assert.equal(cfg.runtime_source, 'flag', 'runtime_source must record flag origin');
  assert.equal(cfg.scope, 'local', 'scope must persist from flag');
  assert.equal(cfg.mcp, true, 'mcp must persist from flag');
});

test('install-flags: --yes asks zero questions and uses all defaults', async (t) => {
  const install = require('../../bin/install.js');
  const root = mkTmp('yes-flag');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  writeClaudeMd(root);

  let asked = 0;
  const askUser = async () => { asked++; return { value: null, source: 'test' }; };

  await install.runInstall({
    cwd: root,
    mode: 'init',
    askUser,
    flags: { yes: true, agent: 'claude', scope: 'local' },
  });

  assert.equal(asked, 0, '--yes must short-circuit all askUser calls');
  const cfg = JSON.parse(fs.readFileSync(path.join(root, '.nubos-pilot', 'config.json'), 'utf-8'));
  assert.equal(cfg.model_profile, 'inherit');
  assert.equal(cfg.commit_docs, true);
  assert.equal(cfg.branching_strategy, 'single-branch');
  assert.equal(cfg.parallelization, true);
  assert.equal(cfg.response_language, 'en');
});

test('install-flags: --yes works without --agent, still non-interactive', async (t) => {
  const install = require('../../bin/install.js');
  const root = mkTmp('yes-no-agent');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  writeClaudeMd(root);

  let asked = 0;
  const askUser = async () => { asked++; return { value: null, source: 'test' }; };

  await install.runInstall({
    cwd: root,
    mode: 'init',
    askUser,
    flags: { yes: true },
  });

  assert.equal(asked, 0, '--yes alone must still short-circuit askUser');
  const cfg = JSON.parse(fs.readFileSync(path.join(root, '.nubos-pilot', 'config.json'), 'utf-8'));
  assert.ok(cfg.runtime, 'runtime must still be set (default from auto)');
  assert.equal(cfg.scope, 'local', 'scope defaults to local');
});

test('install-flags: --scope=global writes Claude payload to $HOME/.claude/nubos-pilot', async (t) => {
  const install = require('../../bin/install.js');
  const root = mkTmp('scope-global');
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'np-home-'));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  t.after(() => { try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {} });
  const oldHome = process.env.HOME;
  process.env.HOME = fakeHome;
  t.after(() => {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  });
  writeClaudeMd(root);

  await install.runInstall({
    cwd: root,
    mode: 'init',
    askUser: async (spec) => ({ value: spec.default !== undefined ? spec.default : 'claude', source: 'test' }),
    flags: { yes: true, agent: 'claude', scope: 'global' },
  });

  const homePayload = path.join(fakeHome, '.claude', 'nubos-pilot');
  assert.ok(fs.existsSync(homePayload), '$HOME/.claude/nubos-pilot must exist for scope=global');
  assert.ok(fs.existsSync(path.join(homePayload, '.manifest.json')),
    'manifest must be written in $HOME path');
  const projectPayload = path.join(root, '.claude', 'nubos-pilot');
  assert.ok(!fs.existsSync(projectPayload),
    'project-local .claude/nubos-pilot must NOT be written under scope=global');
  const cfg = JSON.parse(fs.readFileSync(path.join(root, '.nubos-pilot', 'config.json'), 'utf-8'));
  assert.equal(cfg.scope, 'global', 'scope=global must be persisted in project config');
});

test('install-flags: without flags, asks runtime and scope questions', async (t) => {
  const install = require('../../bin/install.js');
  const root = mkTmp('no-flags');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  writeClaudeMd(root);

  const asked = [];
  await install.runInstall({
    cwd: root,
    mode: 'init',
    askUser: async (spec) => {
      asked.push(spec.question);
      return { value: spec && spec.default !== undefined ? spec.default : 'codex', source: 'test' };
    },
  });

  assert.ok(asked.some((q) => /Welche Runtime/.test(q)),
    'runtime question must be asked when --agent absent');
  assert.ok(asked.some((q) => /Installation scope/.test(q)),
    'scope question must be asked when --scope absent');

  const cfg = JSON.parse(fs.readFileSync(path.join(root, '.nubos-pilot', 'config.json'), 'utf-8'));
  assert.equal(cfg.scope, 'local', 'scope defaults to local when user accepts default');
  assert.equal(cfg.mcp, false, 'mcp is false when --mcp flag absent');
});
