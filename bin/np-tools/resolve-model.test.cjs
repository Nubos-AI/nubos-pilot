const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const subcmd = require('./resolve-model.cjs');

const _sandboxes = [];

function _sandbox(config, agents) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-resolve-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  if (config !== undefined) {
    fs.writeFileSync(
      path.join(root, '.nubos-pilot', 'config.json'),
      JSON.stringify(config),
      'utf-8',
    );
  }
  if (agents) {
    fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
    for (const [name, content] of Object.entries(agents)) {
      fs.writeFileSync(path.join(root, 'agents', name + '.md'), content, 'utf-8');
    }
  }
  _sandboxes.push(root);
  return root;
}

function _captureStdout(fn) {
  const chunks = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const errChunks = [];
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  process.stderr.write = (c) => { errChunks.push(String(c)); return true; };
  let rc;
  try { rc = fn(); } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { stdout: chunks.join(''), stderr: errChunks.join(''), rc };
}

afterEach(() => {
  while (_sandboxes.length) {
    const p = _sandboxes.pop();
    try { fs.rmSync(p, { recursive: true, force: true }); } catch {  }
  }
});

const _plannerAgent = [
  '---',
  'name: np-planner',
  'description: Test planner agent for resolve-model tests.',
  'tier: opus',
  'tools: Read, Write, Bash',
  'color: green',
  '---',
  '',
  '# Planner (test fixture)',
  '',
].join('\n');

test('RM-1: tier branch with empty config returns alias mode, default balanced profile', () => {
  const cwd = _sandbox({});
  const out = subcmd.resolveFromConfig({ agentOrTier: 'opus', cwd });
  assert.deepEqual(out, {
    tier: 'opus',
    profile: 'balanced',
    alias: 'opus',
    resolved: 'opus',
    mode: 'alias',
  });
});

test('RM-2: profileOverride=budget drops opus to sonnet per matrix D-01', () => {
  const cwd = _sandbox({});
  const out = subcmd.resolveFromConfig({ agentOrTier: 'opus', profileOverride: 'budget', cwd });
  assert.equal(out.tier, 'opus');
  assert.equal(out.profile, 'budget');
  assert.equal(out.alias, 'sonnet');
  assert.equal(out.resolved, 'sonnet');
  assert.equal(out.mode, 'alias');
});

test('RM-3: resolve_model_ids=true returns full-id from MODEL_ALIAS_MAP', () => {
  const cwd = _sandbox({ resolve_model_ids: true });
  const out = subcmd.resolveFromConfig({ agentOrTier: 'opus', cwd });
  assert.equal(out.mode, 'full-id');
  assert.equal(out.resolved, 'claude-opus-4-7');
  assert.equal(out.alias, 'opus');
});

test('RM-4: resolve_model_ids="omit" returns empty string and mode=omit (Pitfall 3 string check)', () => {
  const cwd = _sandbox({ resolve_model_ids: 'omit' });
  const out = subcmd.resolveFromConfig({ agentOrTier: 'opus', cwd });
  assert.equal(out.mode, 'omit');
  assert.equal(out.resolved, '');
  assert.equal(out.alias, 'opus');
});

test('RM-5: model_profile="inherit" short-circuits to mode=inherit, alias="", resolved=""', () => {
  const cwd = _sandbox({ model_profile: 'inherit' });
  const out = subcmd.resolveFromConfig({ agentOrTier: 'opus', cwd });
  assert.equal(out.profile, 'inherit');
  assert.equal(out.alias, '');
  assert.equal(out.resolved, '');
  assert.equal(out.mode, 'inherit');
});

test('RM-6: agent-name branch reads tier from agents/<name>.md frontmatter', () => {
  const cwd = _sandbox({}, { 'np-planner': _plannerAgent });
  const out = subcmd.resolveFromConfig({ agentOrTier: 'np-planner', cwd });
  assert.equal(out.tier, 'opus');
  assert.equal(out.profile, 'balanced');
  assert.equal(out.alias, 'opus');
  assert.equal(out.resolved, 'opus');
  assert.equal(out.mode, 'alias');
});

test('RM-7: unknown agent name propagates NubosPilotError with code=agent-not-found', () => {
  const cwd = _sandbox({});
  let thrown = null;
  try { subcmd.resolveFromConfig({ agentOrTier: 'nonexistent-agent', cwd }); } catch (e) { thrown = e; }
  assert.ok(thrown);
  assert.equal(thrown.name, 'NubosPilotError');
  assert.equal(thrown.code, 'agent-not-found');
});

test('RM-8: model_overrides.tier_map beats MODEL_ALIAS_MAP in full-id mode (D-02)', () => {
  const cwd = _sandbox({
    resolve_model_ids: true,
    model_overrides: { tier_map: { opus: 'custom-opus-id' } },
  });
  const out = subcmd.resolveFromConfig({ agentOrTier: 'opus', cwd });
  assert.equal(out.mode, 'full-id');
  assert.equal(out.resolved, 'custom-opus-id');
  assert.equal(out.alias, 'opus');
});

test('RM-9: run(["opus","--profile","budget"]) prints "sonnet\\n" to stdout and returns 0', () => {
  const cwd = _sandbox({});
  const origCwd = process.cwd();
  process.chdir(cwd);
  try {
    const cap = _captureStdout(() => subcmd.run(['opus', '--profile', 'budget']));
    assert.equal(cap.stdout, 'sonnet\n');
    assert.equal(cap.rc, 0);
  } finally {
    process.chdir(origCwd);
  }
});

test('RM-10: run(["opus","--format","omit"]) prints empty line and returns 0', () => {
  const cwd = _sandbox({});
  const origCwd = process.cwd();
  process.chdir(cwd);
  try {
    const cap = _captureStdout(() => subcmd.run(['opus', '--format', 'omit']));
    assert.equal(cap.stdout, '\n');
    assert.equal(cap.rc, 0);
  } finally {
    process.chdir(origCwd);
  }
});

test('RM-11: --format=id forces full-id mode regardless of config default', () => {
  const cwd = _sandbox({});
  const out = subcmd.resolveFromConfig({ agentOrTier: 'opus', cwd, format: 'id' });
  assert.equal(out.mode, 'full-id');
  assert.equal(out.resolved, 'claude-opus-4-7');
});

test('RM-12: malformed config.json falls back to defaults without throwing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-resolve-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  fs.writeFileSync(path.join(root, '.nubos-pilot', 'config.json'), '{not valid json', 'utf-8');
  _sandboxes.push(root);
  const out = subcmd.resolveFromConfig({ agentOrTier: 'opus', cwd: root });
  assert.equal(out.mode, 'alias');
  assert.equal(out.resolved, 'opus');
  assert.equal(out.profile, 'balanced');
});

test('RM-13: run() on NubosPilotError writes JSON error envelope to stderr and returns 1', () => {
  const cwd = _sandbox({});
  const origCwd = process.cwd();
  process.chdir(cwd);
  try {
    const cap = _captureStdout(() => subcmd.run(['nonexistent-agent']));
    assert.equal(cap.rc, 1);
    assert.match(cap.stderr, /agent-not-found/);
    const parsed = JSON.parse(cap.stderr.trim());
    assert.equal(parsed.code, 'agent-not-found');
  } finally {
    process.chdir(origCwd);
  }
});
