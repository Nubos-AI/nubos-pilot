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

test('parseInstallFlags: handles --agent, --scope, --yes in space and equals form', () => {
  const { parseInstallFlags } = require('../../bin/install.js');
  const cases = [
    [['--agent', 'gemini'], { agent: 'gemini', agents: null, scope: null, yes: false, dryRun: false }],
    [['--agent=codex'], { agent: 'codex', agents: null, scope: null, yes: false, dryRun: false }],
    [['--scope', 'global'], { agent: null, agents: null, scope: 'global', yes: false, dryRun: false }],
    [['--scope=local'], { agent: null, agents: null, scope: 'local', yes: false, dryRun: false }],
    [['--yes'], { agent: null, agents: null, scope: null, yes: true, dryRun: false }],
    [['-y'], { agent: null, agents: null, scope: null, yes: true, dryRun: false }],
    [['--agent=claude', '--scope=local', '--yes'],
      { agent: 'claude', agents: null, scope: 'local', yes: true, dryRun: false }],
    [['-a', 'opencode', '-s', 'global'],
      { agent: 'opencode', agents: null, scope: 'global', yes: false, dryRun: false }],
    [['--dry-run'], { agent: null, agents: null, scope: null, yes: false, dryRun: true }],
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
  assert.deepEqual(rest, ['update'], '--dry-run is a flag, not a positional');
});

test('parseInstallFlags: --dry-run is recognised after a subcommand (P2.1)', () => {
  const { parseInstallFlags } = require('../../bin/install.js');
  // The defect: `update --dry-run` put --dry-run at rest[1], where the dispatch
  // never looked, so a preview performed a full install.
  const { flags, rest } = parseInstallFlags(['update', '--dry-run']);
  assert.equal(flags.dryRun, true, '--dry-run must be honoured in any position');
  assert.deepEqual(rest, ['update']);
});

test('install CLI: `update --dry-run` previews and writes nothing (P2.1)', (t) => {
  const { execFileSync } = require('node:child_process');
  const root = mkTmp('dryrun-update');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

  // Seed an existing install so detectMode() reports 're-install' (non-interactive).
  // config.json included: an install whose runtime list is unresolvable now fails
  // closed rather than guessing ['claude'] (D2).
  const payloadDir = path.join(root, '.claude', 'nubos-pilot');
  fs.mkdirSync(payloadDir, { recursive: true });
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  fs.writeFileSync(path.join(root, '.nubos-pilot', 'config.json'),
    JSON.stringify({ runtime: 'claude', runtimes: ['claude'], scope: 'local' }, null, 2));
  fs.writeFileSync(path.join(payloadDir, 'sentinel.md'), 'ORIGINAL');
  fs.writeFileSync(path.join(payloadDir, '.manifest.json'), JSON.stringify({
    version: '0.0.1', timestamp: '2026-04-10T00:00:00Z', files: { 'sentinel.md': 'aa' },
  }));
  const manifestBefore = fs.readFileSync(path.join(payloadDir, '.manifest.json'), 'utf-8');

  const cli = path.join(__dirname, '..', '..', 'bin', 'install.js');
  const out = execFileSync(process.execPath, [cli, 'update', '--dry-run'], {
    cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
  });

  assert.match(out, /"dryRun":\s*true/, 'must report a dry-run summary');
  assert.equal(fs.readFileSync(path.join(payloadDir, 'sentinel.md'), 'utf-8'), 'ORIGINAL',
    'dry-run must not swap the payload');
  assert.equal(fs.readFileSync(path.join(payloadDir, '.manifest.json'), 'utf-8'), manifestBefore,
    'dry-run must not rewrite the manifest');
  assert.ok(!fs.existsSync(path.join(root, '.claude', 'settings.local.json')),
    'dry-run must not register hooks');
});

// D4: --dry-run claimed to be a preview but mkdir'd .nubos-pilot, took the lock
// file, and staged the COMPLETE payload into .claude/nubos-pilot.tmp before
// returning. No data loss, but "writes nothing" was not true. The old tests only
// checked that specific files were absent; this one checks the whole tree.
test('install CLI: `--dry-run` in an empty project is strictly write-free (D4)', (t) => {
  const { execFileSync } = require('node:child_process');
  const root = mkTmp('dryrun-writefree');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  writeClaudeMd(root);

  const before = fs.readdirSync(root).sort();
  const cli = path.join(__dirname, '..', '..', 'bin', 'install.js');
  const out = execFileSync(process.execPath, [cli, '--dry-run', '--yes', '--agent=claude'], {
    cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
  });

  assert.match(out, /"dryRun":\s*true/, 'must report a dry-run summary');
  assert.deepEqual(fs.readdirSync(root).sort(), before,
    'a dry-run must not create ANY path — not .claude, not .nubos-pilot');
  assert.ok(!fs.existsSync(path.join(root, '.claude')), 'no .claude/ from a preview');
  assert.ok(!fs.existsSync(path.join(root, '.nubos-pilot')), 'no .nubos-pilot/ from a preview');
});

test('install: dry-run stages no payload and takes no lock (D4)', async (t) => {
  const install = require('../../bin/install.js');
  const root = mkTmp('dryrun-nostaging');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  writeClaudeMd(root);

  const summary = await install.runInstall({
    cwd: root, mode: 'init', dryRun: true,
    flags: { yes: true, agent: 'claude', agents: ['claude'], scope: 'local' },
    askUser: async (spec) => ({ value: spec && spec.default, source: 'test' }),
  });

  assert.ok(summary.wouldWrite > 0, 'the preview must still report the payload it would write');
  assert.ok(!fs.existsSync(path.join(root, '.claude', 'nubos-pilot.tmp')),
    'dry-run must not stage the payload');
  assert.ok(!fs.existsSync(path.join(root, '.nubos-pilot', '.install.lock')),
    'dry-run must not create the lock file');
});

test('install CLI: unknown args after a subcommand are rejected, not ignored (P2.1)', (t) => {
  const { execFileSync } = require('node:child_process');
  const root = mkTmp('dryrun-reject');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

  const cli = path.join(__dirname, '..', '..', 'bin', 'install.js');
  assert.throws(() => {
    execFileSync(process.execPath, [cli, 'update', '--frobnicate'], {
      cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  }, /./, 'an unsupported flag must fail loudly rather than perform a full install');
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

test('install-flags: --agent=gemini skips runtime prompt and persists scope in config', async (t) => {
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
    flags: { agent: 'gemini', scope: 'local' },
  });

  for (const q of askedQuestions) {
    assert.doesNotMatch(q, /Welche Runtime/, 'runtime question must be skipped when --agent set');
    assert.doesNotMatch(q, /Installation scope/, 'scope question must be skipped when --scope set');
  }

  const cfg = JSON.parse(fs.readFileSync(path.join(root, '.nubos-pilot', 'config.json'), 'utf-8'));
  assert.equal(cfg.runtime, 'gemini', 'runtime must reflect --agent value');
  assert.equal(cfg.runtime_source, 'flag', 'runtime_source must record flag origin');
  assert.equal(cfg.scope, 'local', 'scope must persist from flag');
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
  assert.equal(cfg.model_profile, 'frontier');
  assert.equal(cfg.workflow.commit_docs, true);
  assert.equal(cfg.workflow.commit_artifacts, false, '--yes uses the safer init-question default (FIX-B2)');
  assert.equal(cfg.agents.parallelization, true);
  assert.equal(cfg.response_language, 'en');
  assert.ok(!('branching_strategy' in cfg), 'branching_strategy must be removed');
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

  assert.ok(asked.some((q) => /Which runtime/i.test(q)),
    'runtime question must be asked when --agent absent');
  assert.ok(asked.some((q) => /Installation scope/.test(q)),
    'scope question must be asked when --scope absent');

  const cfg = JSON.parse(fs.readFileSync(path.join(root, '.nubos-pilot', 'config.json'), 'utf-8'));
  assert.equal(cfg.scope, 'local', 'scope defaults to local when user accepts default');
});
