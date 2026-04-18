const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const progress = require('./progress.cjs');

const sandboxes = [];

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-progress-test-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'));
  sandboxes.push(root);
  return root;
}

function seedState(root, progressBlock) {
  const lines = ['---', 'schema_version: 2', 'milestone: v1.0', 'current_phase: 1',
    'current_plan: null', 'current_task: null', 'last_updated: 2026-04-15'];
  if (progressBlock) {
    lines.push('progress:');
    for (const k of Object.keys(progressBlock)) lines.push(`  ${k}: ${progressBlock[k]}`);
  }
  lines.push('---', '', '# State\n');
  fs.writeFileSync(path.join(root, '.nubos-pilot', 'STATE.md'), lines.join('\n'));
}

function seedRoadmap(root, phases) {
  const YAML = require('yaml');
  fs.writeFileSync(
    path.join(root, '.nubos-pilot', 'roadmap.yaml'),
    YAML.stringify({ schema_version: 1, milestones: [{ id: 'v1.0', name: 'm', phases }] }, { indent: 2 }),
  );
}

function seedPhaseDir(root, n, slug, planIds) {
  const padded = String(n).padStart(2, '0');
  const dir = path.join(root, '.nubos-pilot', 'phases', padded + '-' + slug);
  fs.mkdirSync(dir, { recursive: true });
  for (const id of planIds || []) {
    fs.writeFileSync(path.join(dir, id + '-PLAN.md'), '---\nphase: ' + n + '\n---\nbody\n');
  }
}

afterEach(() => {
  while (sandboxes.length) {
    const p = sandboxes.pop();
    try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
  }
});

test('P1: recomputeProgress writes aggregated block to STATE.md', () => {
  const root = makeSandbox();
  seedState(root);
  seedRoadmap(root, [
    { number: 1, name: 'One', slug: 'one', status: 'done', plans: [{ id: '01-01', complete: true }] },
    { number: 2, name: 'Two', slug: 'two', status: 'pending', plans: [{ id: '02-01', complete: false }, { id: '02-02', complete: false }] },
  ]);
  seedPhaseDir(root, 1, 'one', ['01-01']);
  seedPhaseDir(root, 2, 'two', ['02-01', '02-02']);
  const out = progress.recomputeProgress(root);
  assert.equal(out.total_phases, 2);
  assert.equal(out.completed_phases, 1);
  assert.equal(out.total_plans, 3);
  assert.equal(out.completed_plans, 1);

  assert.ok(typeof out.percent === 'number');

  const raw = fs.readFileSync(path.join(root, '.nubos-pilot', 'STATE.md'), 'utf-8');
  assert.match(raw, /progress:/);
  assert.match(raw, /total_phases: 2/);
});

test('P2: readProgress returns persisted block (O(1) read, no recomputation)', () => {
  const root = makeSandbox();
  seedState(root, {
    total_phases: 7, completed_phases: 3, total_plans: 12, completed_plans: 5, percent: 42,
  });
  const out = progress.readProgress(root);
  assert.equal(out.total_phases, 7);
  assert.equal(out.completed_phases, 3);
  assert.equal(out.total_plans, 12);
  assert.equal(out.completed_plans, 5);
  assert.equal(out.percent, 42);
});

test('P3: missing phase dir = zero-contribution (Pattern S-7)', () => {
  const root = makeSandbox();
  seedState(root);
  seedRoadmap(root, [
    { number: 1, name: 'One', slug: 'one', status: 'pending', plans: [{ id: '01-01', complete: false }] },

    { number: 2, name: 'Two', slug: 'two', status: 'pending', plans: [] },
  ]);
  seedPhaseDir(root, 1, 'one', ['01-01']);
  const out = progress.recomputeProgress(root);
  assert.equal(out.total_phases, 2);
  assert.equal(out.completed_phases, 0);

  assert.equal(out.total_plans, 1);
  assert.equal(out.completed_plans, 0);
});

test('P4: recomputeProgress uses mutateState (STATE.md updated atomically)', () => {
  const root = makeSandbox();
  seedState(root);
  seedRoadmap(root, [
    { number: 1, name: 'One', slug: 'one', status: 'done', plans: [{ id: '01-01', complete: true }] },
  ]);
  seedPhaseDir(root, 1, 'one', ['01-01']);
  progress.recomputeProgress(root);
  const after = progress.readProgress(root);
  assert.equal(after.total_phases, 1);
  assert.equal(after.completed_phases, 1);
});
