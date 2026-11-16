const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const NP_TOOLS = path.join(REPO_ROOT, 'np-tools.cjs');

const TOP_LEVEL_KEYS = [
  'askuser',
  'commit',
  'commit-task',
  'checkpoint',
  'config-get',
  'doctor',
  'generate-slug',
  'metrics',
  'resolve-model',
  'scan-codebase',
  'stats',
  'update-docs',
];

test('TD-1: topLevelCommands routes metrics/resolve-model/plan-diff and siblings', () => {
  const np = require('../../np-tools.cjs');
  assert.ok(np.topLevelCommands && typeof np.topLevelCommands === 'object');
  for (const key of TOP_LEVEL_KEYS) {
    const mod = np.topLevelCommands[key];
    assert.ok(mod, `topLevelCommands[${key}] missing`);
    assert.equal(typeof mod.run, 'function');
  }
});

test('TD-1b: verify-work is reachable as top-level command (not only via init)', () => {
  const np = require('../../np-tools.cjs');
  assert.ok(np.topLevelCommands['verify-work'], 'verify-work must be exposed at top level for agents/workflows');
  assert.equal(typeof np.topLevelCommands['verify-work'].run, 'function');
});

test('TD-1c: every initWorkflow is also exposed top-level (registry-parity invariant)', () => {
  const np = require('../../np-tools.cjs');
  for (const key of Object.keys(np.initWorkflows)) {
    assert.ok(
      np.topLevelCommands[key],
      'initWorkflow "' + key + '" missing from topLevelCommands — both registries must list every agent-callable verb',
    );
    assert.strictEqual(
      np.topLevelCommands[key],
      np.initWorkflows[key],
      'topLevelCommands["' + key + '"] must be the SAME module as initWorkflows["' + key + '"]',
    );
  }
});

test('TD-2: initWorkflows exposes plan-milestone + execute-milestone entries', () => {
  const np = require('../../np-tools.cjs');
  assert.ok(np.initWorkflows && typeof np.initWorkflows === 'object');
  for (const key of ['plan-milestone', 'execute-milestone', 'verify-work', 'new-project', 'new-milestone', 'discuss-phase', 'research-phase']) {
    const mod = np.initWorkflows[key];
    assert.ok(mod, `initWorkflows[${key}] missing`);
    assert.equal(typeof mod.run, 'function');
  }
});

test('TD-3: unknown topLevelCommand returns unknown-command envelope', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'np-dispatch-unknown-'));
  const res = spawnSync('node', [NP_TOOLS, 'definitely-unknown-xyz'], {
    cwd: tmp,
    encoding: 'utf-8',
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /"code":\s*"unknown-command"/);
});

test('TD-4: unknown init workflow returns unknown-init-workflow envelope', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'np-dispatch-bogus-'));
  const res = spawnSync('node', [NP_TOOLS, 'init', 'not-a-workflow', '1'], {
    cwd: tmp,
    encoding: 'utf-8',
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /"code":\s*"unknown-init-workflow"/);
});

test('TD-5: metrics now subcommand prints ISO timestamp on stdout', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'np-dispatch-metrics-'));
  const res = spawnSync('node', [NP_TOOLS, 'metrics', 'now'], {
    cwd: tmp,
    encoding: 'utf-8',
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.equal(res.status, 0);
  assert.match(res.stdout.trim(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});
