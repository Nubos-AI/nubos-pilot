'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');

const rollup = require('./rollup.cjs');
const tasks = require('./tasks.cjs');
const { parseRoadmap, _resetParseRoadmapCacheForTests } = require('./roadmap.cjs');

const _sandboxes = [];

function _sandbox(opts) {
  const o = opts || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-rollup-'));
  _sandboxes.push(root);
  const sd = path.join(root, '.nubos-pilot');
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, 'PROJECT.md'), '# Demo\n', 'utf-8');

  const sliceDefs = o.slices || [{ id: 'S001', tasks: ['pending', 'pending'] }];
  fs.writeFileSync(
    path.join(sd, 'roadmap.yaml'),
    YAML.stringify({
      schema_version: 2,
      milestones: [{
        id: 'M001',
        number: 1,
        name: 'demo',
        status: o.milestoneStatus || 'pending',
        success_criteria: ['works'],
        slices: sliceDefs.map((s) => ({ id: s.id, name: s.id, goal: 'g' })),
      }],
    }),
    'utf-8',
  );

  for (const s of sliceDefs) {
    const sNum = Number(s.id.slice(1));
    s.tasks.forEach((status, i) => {
      const tid = 'T' + String(i + 1).padStart(4, '0');
      const dir = path.join(sd, 'milestones', 'M001', 'slices', s.id, 'tasks', tid);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, tid + '-PLAN.md'),
        '---\ntask: ' + tid + '\nslice: M001-' + s.id + '\nstatus: ' + status + '\n---\n# ' + tid + '\n',
        'utf-8',
      );
      void sNum;
    });
  }
  return root;
}

function _read(root) {
  _resetParseRoadmapCacheForTests();
  const ms = parseRoadmap(root).doc.milestones[0];
  const slices = {};
  for (const s of ms.slices) slices[s.id] = s.status || null;
  return { milestone: ms.status, slices };
}

afterEach(() => {
  while (_sandboxes.length) {
    try { fs.rmSync(_sandboxes.pop(), { recursive: true, force: true }); } catch {}
  }
});

test('RU-1: deriveSliceStatus maps task sets to a slice status', () => {
  assert.equal(rollup.deriveSliceStatus([]), null);
  assert.equal(rollup.deriveSliceStatus(['pending', 'pending']), 'pending');
  assert.equal(rollup.deriveSliceStatus(['in-progress', 'pending']), 'in-progress');
  assert.equal(rollup.deriveSliceStatus(['done', 'pending']), 'in-progress');
  assert.equal(rollup.deriveSliceStatus(['done', 'done']), 'done');
  assert.equal(rollup.deriveSliceStatus(['done', 'skipped']), 'done');
  assert.equal(rollup.deriveSliceStatus(['done', 'parked']), 'in-progress', 'parked is not terminal');
});

test('RU-2: starting a task moves slice and milestone off pending', () => {
  const sb = _sandbox();
  assert.deepEqual(_read(sb), { milestone: 'pending', slices: { S001: null } });

  tasks.setTaskStatus('M001-S001-T0001', 'in-progress', sb);
  assert.deepEqual(_read(sb), { milestone: 'in-progress', slices: { S001: 'in-progress' } });
});

test('RU-3: all tasks done completes the slice but never the milestone', () => {
  const sb = _sandbox();
  tasks.setTaskStatus('M001-S001-T0001', 'done', sb);
  tasks.setTaskStatus('M001-S001-T0002', 'done', sb);

  const state = _read(sb);
  assert.equal(state.slices.S001, 'done');
  assert.equal(
    state.milestone,
    'in-progress',
    'terminal milestone status belongs to verify-work; task completion must not fake it',
  );
});

test('RU-4: a verified milestone whose work is still complete stays verified', () => {
  const sb = _sandbox({ milestoneStatus: 'verified', slices: [{ id: 'S001', tasks: ['done', 'done'] }] });
  tasks.setTaskStatus('M001-S001-T0001', 'done', sb);
  assert.equal(_read(sb).milestone, 'verified', 'rollup must not disturb a consistent terminal status');
});

test('RU-4b: undoing work revokes a terminal status instead of leaving a contradiction', () => {
  const sb = _sandbox({ milestoneStatus: 'verified', slices: [{ id: 'S001', tasks: ['done', 'done'] }] });
  tasks.setTaskStatus('M001-S001-T0001', 'pending', sb);

  const state = _read(sb);
  assert.equal(
    state.milestone,
    'in-progress',
    'a milestone claiming verified while its slices are unfinished points at a stale verification',
  );
  assert.equal(state.slices.S001, 'in-progress');
});

test('RU-4c: rollup lifts failed and deferred milestones when work resumes', () => {
  for (const start of ['failed', 'deferred']) {
    const sb = _sandbox({ milestoneStatus: start });
    tasks.setTaskStatus('M001-S001-T0001', 'in-progress', sb);
    assert.equal(
      _read(sb).milestone,
      'in-progress',
      start + ' must not stick while the milestone is being reworked',
    );
  }
});

test('RU-4d: rollup never grants a terminal status', () => {
  const sb = _sandbox({ slices: [{ id: 'S001', tasks: ['done'] }] });
  tasks.setTaskStatus('M001-S001-T0001', 'done', sb);
  const state = _read(sb);
  assert.equal(state.slices.S001, 'done');
  assert.equal(state.milestone, 'in-progress', 'terminal is verify-work territory only');
});

test('RU-5: a plan without slice frontmatter still rolls up', () => {
  const sb = _sandbox();
  const plan = path.join(
    sb, '.nubos-pilot', 'milestones', 'M001', 'slices', 'S001', 'tasks', 'T0001', 'T0001-PLAN.md',
  );
  fs.writeFileSync(plan, '---\ntask: T0001\nstatus: pending\n---\n# T0001\n', 'utf-8');

  tasks.setTaskStatus('M001-S001-T0001', 'done', sb);
  assert.equal(_read(sb).slices.S001, 'in-progress');
});

test('RU-6: slices roll up independently', () => {
  const sb = _sandbox({
    slices: [
      { id: 'S001', tasks: ['pending'] },
      { id: 'S002', tasks: ['pending'] },
    ],
  });
  tasks.setTaskStatus('M001-S001-T0001', 'done', sb);
  assert.deepEqual(_read(sb).slices, { S001: 'done', S002: 'pending' });
});

test('RU-7: a no-op rollup does not rewrite roadmap.yaml at all', () => {
  const sb = _sandbox();
  tasks.setTaskStatus('M001-S001-T0001', 'done', sb);

  const yamlPath = path.join(sb, '.nubos-pilot', 'roadmap.yaml');
  const before = fs.statSync(yamlPath);
  const beforeBody = fs.readFileSync(yamlPath, 'utf-8');

  const second = rollup.rollupMilestone(1, sb);
  assert.equal(second.changed, false);
  assert.deepEqual(second.slices_changed, []);

  const after = fs.statSync(yamlPath);
  assert.equal(fs.readFileSync(yamlPath, 'utf-8'), beforeBody);
  assert.equal(
    after.mtimeMs,
    before.mtimeMs,
    'rollup runs on every task transition — an unchanged milestone must not rewrite the file',
  );
});

test('RU-8: all_slices_done reports readiness for verification', () => {
  const sb = _sandbox();
  tasks.setTaskStatus('M001-S001-T0001', 'done', sb);
  assert.equal(rollup.rollupMilestone(1, sb).all_slices_done, false);
  tasks.setTaskStatus('M001-S001-T0002', 'done', sb);
  assert.equal(rollup.rollupMilestone(1, sb).all_slices_done, true);
});

test('RU-9: a vanished PLAN.md blocks completion instead of being ignored', () => {
  const sb = _sandbox({ slices: [{ id: 'S001', tasks: ['done', 'pending', 'pending'] }] });
  const base = path.join(sb, '.nubos-pilot', 'milestones', 'M001', 'slices', 'S001', 'tasks');
  fs.rmSync(path.join(base, 'T0002', 'T0002-PLAN.md'));
  fs.rmSync(path.join(base, 'T0003', 'T0003-PLAN.md'));

  const result = rollup.rollupMilestone(1, sb);
  assert.equal(_read(sb).slices.S001, 'in-progress', 'two thirds of the slice is unreadable');
  assert.equal(result.all_slices_done, false);
  assert.equal(result.unreadable_tasks, 2, 'the gap must be reported, not swallowed');
});

test('RU-10: a declared but unscaffolded slice blocks readiness', () => {
  const sb = _sandbox({ slices: [{ id: 'S001', tasks: ['done'] }] });
  const yamlPath = path.join(sb, '.nubos-pilot', 'roadmap.yaml');
  const doc = YAML.parse(fs.readFileSync(yamlPath, 'utf-8'));
  doc.milestones[0].slices.push({ id: 'S002', name: 'S002', goal: 'g' });
  doc.milestones[0].slices.push({ id: 'S003', name: 'S003', goal: 'g' });
  fs.writeFileSync(yamlPath, YAML.stringify(doc), 'utf-8');
  _resetParseRoadmapCacheForTests();

  const result = rollup.rollupMilestone(1, sb);
  assert.equal(
    result.all_slices_done,
    false,
    'a milestone is not verification-ready while declared slices have no tasks yet',
  );
  const inspected = rollup.inspectMilestone(1, sb);
  assert.equal(inspected.slices.length, 3, 'roadmap declares the slice set, not the filesystem');
});

test('RU-11: a task transition survives an unwritable roadmap', () => {
  const sb = _sandbox();
  const yamlPath = path.join(sb, '.nubos-pilot', 'roadmap.yaml');
  fs.writeFileSync(yamlPath, 'milestones: [\n', 'utf-8');
  _resetParseRoadmapCacheForTests();

  const applied = tasks.setTaskStatus('M001-S001-T0001', 'done', sb);
  assert.equal(applied, 'done', 'the rollup is an aggregate — it must never lose real work');

  const planPath = path.join(
    sb, '.nubos-pilot', 'milestones', 'M001', 'slices', 'S001', 'tasks', 'T0001', 'T0001-PLAN.md',
  );
  assert.match(fs.readFileSync(planPath, 'utf-8'), /status: done/);
});

test('RU-12: rollup on an unknown milestone reports rather than throws', () => {
  const sb = _sandbox();
  const result = rollup.rollupMilestone(99, sb);
  assert.equal(result.changed, false);
  assert.equal(result.reason, 'phase-not-found');
});

test('RU-13: a slice of nothing but skips completes, with zero work done', () => {
  assert.equal(rollup.deriveSliceStatus(['skipped', 'skipped']), 'done');

  const sb = _sandbox({ slices: [{ id: 'S001', tasks: ['pending', 'pending'] }] });
  tasks.setTaskStatus('M001-S001-T0001', 'skipped', sb);
  tasks.setTaskStatus('M001-S001-T0002', 'skipped', sb);

  const state = _read(sb);
  assert.equal(state.slices.S001, 'done', 'a dropped task leaves no work behind');
  assert.equal(state.milestone, 'in-progress', 'still only verification may make it terminal');
  assert.equal(rollup.rollupMilestone(1, sb).all_slices_done, true);
});

test('RU-14: a fully parked slice stays open and is reported as such', () => {
  assert.equal(rollup.deriveSliceStatus(['parked', 'parked']), 'in-progress');

  const sb = _sandbox({ slices: [{ id: 'S001', tasks: ['pending', 'pending'] }] });
  tasks.setTaskStatus('M001-S001-T0001', 'parked', sb);
  tasks.setTaskStatus('M001-S001-T0002', 'parked', sb);

  assert.equal(_read(sb).slices.S001, 'in-progress', 'parked means "coming back", not "done"');
  const inspected = rollup.inspectMilestone(1, sb);
  assert.deepEqual(inspected.fully_parked, ['S001']);
  assert.equal(inspected.all_done, false);
});

test('RU-15: planning a new slice must not destroy a verified milestone', () => {
  const sb = _sandbox({ milestoneStatus: 'verified', slices: [{ id: 'S001', tasks: ['done'] }] });
  const yamlPath = path.join(sb, '.nubos-pilot', 'roadmap.yaml');
  const doc = YAML.parse(fs.readFileSync(yamlPath, 'utf-8'));
  doc.milestones[0].slices[0].status = 'done';
  doc.milestones[0].slices.push({ id: 'S002', name: 'S002', goal: 'g' });
  fs.writeFileSync(yamlPath, YAML.stringify(doc), 'utf-8');
  _resetParseRoadmapCacheForTests();

  const result = rollup.rollupMilestone(1, sb);
  assert.equal(
    _read(sb).milestone,
    'verified',
    'a slice with no tasks is absence of evidence, not evidence of regression',
  );
  assert.equal(result.all_slices_done, false, 'but it is still not verification-ready');
});

test('RU-16: pruning a finished task tree must not revoke the verification', () => {
  const sb = _sandbox({ milestoneStatus: 'verified', slices: [{ id: 'S001', tasks: ['done', 'done'] }] });
  const yamlPath = path.join(sb, '.nubos-pilot', 'roadmap.yaml');
  const doc = YAML.parse(fs.readFileSync(yamlPath, 'utf-8'));
  doc.milestones[0].slices[0].status = 'done';
  fs.writeFileSync(yamlPath, YAML.stringify(doc), 'utf-8');
  fs.rmSync(path.join(sb, '.nubos-pilot', 'milestones', 'M001', 'slices', 'S001', 'tasks'), { recursive: true });
  _resetParseRoadmapCacheForTests();

  rollup.rollupMilestone(1, sb);
  const state = _read(sb);
  assert.equal(state.milestone, 'verified');
  assert.equal(state.slices.S001, 'done', 'and the roadmap must not contradict itself either');
});

test('RU-17: real regression still revokes', () => {
  const sb = _sandbox({ milestoneStatus: 'verified', slices: [{ id: 'S001', tasks: ['done', 'done'] }] });
  tasks.setTaskStatus('M001-S001-T0002', 'pending', sb);
  assert.equal(_read(sb).milestone, 'in-progress', 'a slice that reads unfinished is positive evidence');
});

test('RU-18: a malformed PLAN.md degrades to unknown instead of killing the rollup', () => {
  const sb = _sandbox({ slices: [{ id: 'S001', tasks: ['done', 'done'] }] });
  const plan = path.join(
    sb, '.nubos-pilot', 'milestones', 'M001', 'slices', 'S001', 'tasks', 'T0002', 'T0002-PLAN.md',
  );
  fs.writeFileSync(plan, '---\ntask: T0002\n\tstatus: done\n---\n# bad\n', 'utf-8');

  const result = rollup.rollupMilestone(1, sb);
  assert.equal(result.unreadable_tasks, 1);
  assert.equal(result.all_slices_done, false);
  assert.doesNotThrow(() => rollup.inspectMilestone(1, sb), 'inspect must not crash on a bad plan');
});

test('RU-19: a legacy phases-shaped roadmap is visible to the read path', () => {
  const sb = _sandbox();
  const yamlPath = path.join(sb, '.nubos-pilot', 'roadmap.yaml');
  fs.writeFileSync(yamlPath, YAML.stringify({
    schema_version: 2,
    milestones: [{
      id: 'v1',
      phases: [{
        number: 1, name: 'legacy', status: 'verified',
        slices: [{ id: 'S001', name: 'S001', goal: 'g', status: 'done' }],
      }],
    }],
  }), 'utf-8');
  _resetParseRoadmapCacheForTests();

  const inspected = rollup.inspectMilestone(1, sb);
  assert.equal(inspected.milestone_status, 'verified', 'the reader must see what the writer mutates');
  assert.equal(inspected.slices.length, 1);
  assert.equal(inspected.slices[0].persisted, 'done');
});

test('RU-20: an out-of-shape slice id is reported rather than silently misread', () => {
  const sb = _sandbox({ slices: [{ id: 'S001', tasks: ['done'] }] });
  const yamlPath = path.join(sb, '.nubos-pilot', 'roadmap.yaml');
  const doc = YAML.parse(fs.readFileSync(yamlPath, 'utf-8'));
  doc.milestones[0].slices.push({ id: 'S1', name: 'loose', goal: 'g' });
  fs.writeFileSync(yamlPath, YAML.stringify(doc), 'utf-8');
  _resetParseRoadmapCacheForTests();

  const inspected = rollup.inspectMilestone(1, sb);
  assert.deepEqual(inspected.invalid_slice_ids, ['S1']);
  const loose = inspected.slices.find((s) => s.id === 'S1');
  assert.equal(loose.task_count, 0, 'S1 must not borrow the tasks of S001');
  assert.equal(loose.derived, null);
});

test('RU-21: several slices land in a single write', () => {
  const sb = _sandbox({
    slices: [
      { id: 'S001', tasks: ['done'] },
      { id: 'S002', tasks: ['done'] },
      { id: 'S003', tasks: ['done'] },
    ],
  });
  const yamlPath = path.join(sb, '.nubos-pilot', 'roadmap.yaml');
  let renames = 0;
  const orig = fs.renameSync;
  fs.renameSync = function (a, b) {
    if (/roadmap\.yaml/.test(String(b))) renames++;
    return orig.apply(fs, arguments);
  };
  let result;
  try { result = rollup.rollupMilestone(1, sb); } finally { fs.renameSync = orig; }

  assert.equal(result.slices_changed.length, 3);
  assert.equal(renames, 1, 'three slice changes must be one transaction, not three');
  void yamlPath;
});

test('RU-22: a throwing derive leaves roadmap.yaml byte-identical', () => {
  const sb = _sandbox();
  const yamlPath = path.join(sb, '.nubos-pilot', 'roadmap.yaml');
  const before = fs.readFileSync(yamlPath, 'utf-8');

  const { mutateMilestoneNode } = require('./roadmap.cjs');
  assert.throws(() => mutateMilestoneNode(1, () => { throw new Error('boom'); }, sb));
  assert.equal(fs.readFileSync(yamlPath, 'utf-8'), before);
});

test('RU-23: markMilestoneStarted lifts what it may and leaves the rest alone', () => {
  for (const [start, expected] of [
    ['pending', 'in-progress'], ['failed', 'in-progress'], ['deferred', 'in-progress'],
    ['verified', 'verified'], ['done', 'done'],
  ]) {
    const sb = _sandbox({ milestoneStatus: start });
    rollup.markMilestoneStarted(1, sb);
    assert.equal(_read(sb).milestone, expected, start + ' -> ' + expected);
  }
});

test('RU-24: revoking a terminal status also brings META.json down', () => {
  const sb = _sandbox({ milestoneStatus: 'verified', slices: [{ id: 'S001', tasks: ['done', 'done'] }] });
  const metaPath = path.join(sb, '.nubos-pilot', 'milestones', 'M001', 'M001-META.json');
  fs.writeFileSync(metaPath, JSON.stringify({ status: 'verified' }), 'utf-8');

  tasks.setTaskStatus('M001-S001-T0001', 'pending', sb);

  assert.equal(_read(sb).milestone, 'in-progress');
  assert.equal(
    JSON.parse(fs.readFileSync(metaPath, 'utf-8')).status,
    'in-progress',
    'the dashboard reads META — leaving it at verified is the stale lie the sync exists to stop',
  );
});

test('RU-25: a missing META.json does not make the revoke fail', () => {
  const sb = _sandbox({ milestoneStatus: 'verified', slices: [{ id: 'S001', tasks: ['done', 'done'] }] });
  assert.doesNotThrow(() => tasks.setTaskStatus('M001-S001-T0001', 'pending', sb));
  assert.equal(_read(sb).milestone, 'in-progress');
});

test('RU-26: a no-op leaves a legacy schema_version untouched', () => {
  const sb = _sandbox({ slices: [{ id: 'S001', tasks: ['done'] }] });
  const yamlPath = path.join(sb, '.nubos-pilot', 'roadmap.yaml');
  rollup.rollupMilestone(1, sb);

  const doc = YAML.parse(fs.readFileSync(yamlPath, 'utf-8'));
  doc.schema_version = 1;
  fs.writeFileSync(yamlPath, YAML.stringify(doc), 'utf-8');
  _resetParseRoadmapCacheForTests();
  const before = fs.readFileSync(yamlPath, 'utf-8');

  const result = rollup.rollupMilestone(1, sb);
  assert.equal(result.changed, false);
  assert.equal(
    fs.readFileSync(yamlPath, 'utf-8'),
    before,
    'stamping the version on a no-op would give every idle transition something to persist',
  );

  tasks.setTaskStatus('M001-S001-T0001', 'pending', sb);
  _resetParseRoadmapCacheForTests();
  assert.equal(
    YAML.parse(fs.readFileSync(yamlPath, 'utf-8')).schema_version,
    2,
    'a real change still migrates it forward',
  );
});
