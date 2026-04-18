const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const { makeSandbox, seedRoadmapYaml, seedPhaseDir, cleanupAll } = require('./helpers/fixture.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const NP_TOOLS = path.join(REPO_ROOT, 'np-tools.cjs');

function runCmd(subcmd, cwd, extraArgs) {
  const args = [NP_TOOLS, subcmd].concat(extraArgs || []);
  try {
    return execFileSync('node', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const stderr = err && err.stderr ? err.stderr.toString() : '';
    const stdout = err && err.stdout ? err.stdout.toString() : '';
    throw new Error(
      `execFileSync(node np-tools.cjs ${subcmd}) failed in ${cwd}\n` +
        `exit=${err && err.status}\nstdout=${stdout}\nstderr=${stderr}`,
    );
  }
}

afterEach(() => { cleanupAll(); });

test('E2E-1: fresh empty sandbox — np:next returns rule-1 /np:discuss-phase 1', () => {
  const root = makeSandbox();
  const out = runCmd('next', root);
  const payload = JSON.parse(out);
  assert.equal(payload.next_step.command, '/np:discuss-phase 1');
  assert.equal(payload.phase, 1);
  assert.equal(payload.plan, null);
  assert.equal(payload.task, null);
});

test('E2E-2: fresh empty sandbox — np:help returns the five base commands', () => {
  const root = makeSandbox();
  const out = runCmd('help', root);
  const payload = JSON.parse(out);
  assert.ok(payload.text && typeof payload.text === 'string');
  for (const cmd of ['next', 'progress', 'state', 'help']) {
    assert.ok(payload.text.includes(cmd), 'help text missing ' + cmd);
  }
});

test('E2E-3: fresh empty sandbox — np:help --json lists the four base commands', () => {
  const root = makeSandbox();
  const out = runCmd('help', root, ['--json']);
  const payload = JSON.parse(out);
  assert.ok(Array.isArray(payload.commands));
  const names = payload.commands.map((c) => c.name);
  for (const cmd of ['next', 'progress', 'state', 'help']) {
    assert.ok(names.includes(cmd), 'commands missing ' + cmd);
  }
});

test('E2E-4: fresh empty sandbox — np:progress returns zeroed progress block', () => {
  const root = makeSandbox();
  const out = runCmd('progress', root);
  const payload = JSON.parse(out);
  assert.equal(payload.total_phases, 0);
  assert.equal(payload.completed_phases, 0);
  assert.equal(payload.percent, 0);
});

test('E2E-5: fresh empty sandbox — np:state returns documented error envelope', () => {
  const root = makeSandbox();
  const out = runCmd('state', root);
  const payload = JSON.parse(out);

  assert.ok(payload.error && typeof payload.error === 'object');
  assert.ok(typeof payload.error.code === 'string');
  assert.ok(typeof payload.error.message === 'string');
});

function _singlePhaseRoadmap() {
  return {
    schema_version: 1,
    milestones: [
      {
        id: 'v1.0',
        name: 'milestone',
        phases: [
          {
            number: 1,
            name: 'Foo',
            slug: 'foo',
            goal: 'smoke-goal',
            depends_on: null,
            requirements: ['FOO-01'],
            success_criteria: ['exists'],
            plans: [],
            status: 'pending',
          },
        ],
      },
    ],
  };
}

test('E2E-6: seeded roadmap (no CONTEXT.md) — np:next routes to /np:discuss-phase 1', () => {
  const root = makeSandbox();
  seedRoadmapYaml(root, _singlePhaseRoadmap());
  const out = runCmd('next', root);
  const payload = JSON.parse(out);
  assert.equal(payload.next_step.command, '/np:discuss-phase 1');
  assert.equal(payload.phase, 1);
});

test('E2E-7: seeded CONTEXT.md (no PLAN.md) — np:next routes to /np:plan-phase 1', () => {
  const root = makeSandbox();
  seedRoadmapYaml(root, _singlePhaseRoadmap());
  seedPhaseDir(root, 1, 'foo', { '01-CONTEXT.md': '# Phase 1 Context\n' });
  const out = runCmd('next', root);
  const payload = JSON.parse(out);
  assert.equal(payload.next_step.command, '/np:plan-phase 1');
  assert.equal(payload.phase, 1);
  assert.equal(payload.plan, null);
});
