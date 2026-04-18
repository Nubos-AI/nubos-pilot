const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const WORKFLOWS = ['ai-integration-phase', 'ui-phase', 'ui-review', 'eval-review'];
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const NP_TOOLS = path.join(REPO_ROOT, 'np-tools.cjs');

for (const wf of WORKFLOWS) {
  test(`DISP-${wf}: dispatcher routes argv past the verb-gate`, () => {

    
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'np-dispatch-'));
    const res = spawnSync('node', [NP_TOOLS, 'init', wf, '99'], {
      cwd: tmp,
      encoding: 'utf-8',
    });
    fs.rmSync(tmp, { recursive: true, force: true });

    assert.doesNotMatch(
      res.stderr,
      /^Usage: np-tools\.cjs init/m,
      `expected no Usage error on stderr for ${wf}, got: ${res.stderr}`,
    );

    
  });
}

const TOP_LEVEL_PHASE10_KEYS = [
  'askuser',
  'commit',
  'config-get',
  'dispatch',
  'doctor',
  'generate-slug',
  'metrics',
  'phase',
  'plan-diff',
  'queue',
  'resolve-model',
  'stats',
  'triage',
];

test('TD-1: Phase 10 topLevelCommands routes metrics/resolve-model/plan-diff and 10 siblings', () => {
  const np = require('../../np-tools.cjs');
  assert.ok(np.topLevelCommands && typeof np.topLevelCommands === 'object');
  for (const key of TOP_LEVEL_PHASE10_KEYS) {
    const mod = np.topLevelCommands[key];
    assert.ok(mod, `topLevelCommands[${key}] missing`);
    assert.equal(
      typeof mod.run,
      'function',
      `topLevelCommands[${key}].run must be a function`,
    );
  }
});

test('TD-2: Phase 10 initWorkflows exposes code-review init entry', () => {
  const np = require('../../np-tools.cjs');
  assert.ok(np.initWorkflows && typeof np.initWorkflows === 'object');
  const mod = np.initWorkflows['code-review'];
  assert.ok(mod, 'initWorkflows[code-review] missing');
  assert.equal(typeof mod.run, 'function');
});

test('TD-3: unknown topLevelCommand still returns unknown-command envelope', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'np-dispatch-unknown-'));
  const res = spawnSync('node', [NP_TOOLS, 'definitely-unknown-xyz'], {
    cwd: tmp,
    encoding: 'utf-8',
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /"code":\s*"unknown-command"/);
});

test('TD-4: metrics now subcommand prints ISO timestamp on stdout', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'np-dispatch-metrics-'));
  const res = spawnSync('node', [NP_TOOLS, 'metrics', 'now'], {
    cwd: tmp,
    encoding: 'utf-8',
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.equal(res.status, 0);
  assert.match(res.stdout.trim(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});
