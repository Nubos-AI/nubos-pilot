'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { collectTree } = require('./planning-tree.cjs');
const { _resetParseRoadmapCacheForTests } = require('./roadmap.cjs');

function _project(opts) {
  const o = opts || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-tree-'));
  const state = path.join(root, '.nubos-pilot');
  fs.mkdirSync(state, { recursive: true });
  if (o.roadmap !== null) {
    fs.writeFileSync(path.join(state, 'roadmap.yaml'), o.roadmap || [
      'schema_version: 2',
      'milestones:',
      '  - id: M001',
      '    name: Password reset',
      '    status: in-progress',
      '    slices:',
      '      - id: S001',
      '        name: Token plumbing',
      '        status: done',
      '  - id: M002',
      '    name: Audit log',
      '    status: pending',
      '    depends_on: M001',
      '    slices: []',
      '',
    ].join('\n'), 'utf-8');
  }
  for (const t of (o.tasks || [{ m: 'M001', s: 'S001', t: 'T0001', fm: 'status: done\ntitle: generate tokens' }])) {
    const dir = path.join(state, 'milestones', t.m, 'slices', t.s, 'tasks', t.t);
    fs.mkdirSync(dir, { recursive: true });
    if (t.fm !== null) {
      fs.writeFileSync(path.join(dir, t.t + '-PLAN.md'), '---\n' + t.fm + '\n---\n\nBody.\n', 'utf-8');
    }
  }
  // parseRoadmap caches on mtime+size; two fixtures written in the same
  // millisecond with the same length would otherwise share a cache entry.
  _resetParseRoadmapCacheForTests();
  return root;
}

function _cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

test('PT-1: the tree carries milestone, slice and task identity', () => {
  const root = _project();
  try {
    const tree = collectTree(root);
    assert.equal(tree.length, 2);
    assert.equal(tree[0].id, 'M001');
    assert.equal(tree[0].number, 1);
    assert.equal(tree[0].name, 'Password reset');
    assert.equal(tree[0].slices[0].id, 'M001-S001');
    assert.equal(tree[0].slices[0].local_id, 'S001');
    assert.equal(tree[0].slices[0].tasks[0].id, 'M001-S001-T0001');
    assert.equal(tree[0].slices[0].tasks[0].local_id, 'T0001');
  } finally {
    _cleanup(root);
  }
});

test('PT-2: task status comes from the plan on disk, not from roadmap.yaml', () => {
  // roadmap slice status is derived FROM task state by `rollup`, so reading task
  // state out of roadmap would be reading a cache of the thing we want.
  const root = _project({
    tasks: [{ m: 'M001', s: 'S001', t: 'T0001', fm: 'status: in-progress\ntitle: half done' }],
  });
  try {
    const tree = collectTree(root);
    assert.equal(tree[0].slices[0].status, 'done', 'roadmap still declares the slice done');
    assert.equal(tree[0].slices[0].tasks[0].status, 'in-progress', 'the task plan is authoritative');
  } finally {
    _cleanup(root);
  }
});

test('PT-3: milestone depends_on travels with the node', () => {
  const root = _project();
  try {
    const tree = collectTree(root);
    const m2 = tree.find((m) => m.id === 'M002');
    assert.ok(m2.depends_on, 'depends_on must not be dropped');
    assert.match(String(m2.depends_on), /M001/);
  } finally {
    _cleanup(root);
  }
});

test('PT-4: task depends_on travels with the node', () => {
  const root = _project({
    tasks: [
      { m: 'M001', s: 'S001', t: 'T0001', fm: 'status: done\ntitle: first' },
      { m: 'M001', s: 'S001', t: 'T0002', fm: 'status: done\ntitle: second\ndepends_on: [T0001]' },
    ],
  });
  try {
    const tasks = collectTree(root)[0].slices[0].tasks;
    assert.equal(tasks.length, 2);
    assert.ok(tasks[1].depends_on, 'task depends_on must survive the read');
  } finally {
    _cleanup(root);
  }
});

test('PT-5: the milestone filter narrows the tree', () => {
  const root = _project();
  try {
    assert.equal(collectTree(root, { milestone: 1 }).length, 1);
    assert.equal(collectTree(root, { milestone: 2 })[0].id, 'M002');
    assert.equal(collectTree(root, { milestone: 99 }).length, 0);
  } finally {
    _cleanup(root);
  }
});

test('PT-6: a task whose plan is missing or unreadable is still reported as a unit', () => {
  // An unreadable task is a finding for doctor, not something a view should hide.
  const root = _project({ tasks: [{ m: 'M001', s: 'S001', t: 'T0001', fm: null }] });
  try {
    const tasks = collectTree(root)[0].slices[0].tasks;
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].status, null);
    assert.equal(tasks[0].name, null);
  } finally {
    _cleanup(root);
  }
});

test('PT-7: a missing or unparseable roadmap yields an empty tree rather than throwing', () => {
  const none = _project({ roadmap: null, tasks: [] });
  try {
    assert.deepEqual(collectTree(none), []);
  } finally {
    _cleanup(none);
  }
  const broken = _project({ roadmap: 'milestones: [oops\n', tasks: [] });
  try {
    assert.doesNotThrow(() => collectTree(broken));
  } finally {
    _cleanup(broken);
  }
});

test('PT-8: malformed roadmap nodes are skipped rather than aborting the read', () => {
  const root = _project({
    roadmap: [
      'schema_version: 2',
      'milestones:',
      '  - name: no id here',
      '    slices: []',
      '  - id: NOT-A-MILESTONE-ID',
      '    slices: []',
      '  - id: M001',
      '    name: Real',
      '    slices:',
      '      - name: slice with no id',
      '      - id: BAD-SLICE',
      '      - id: S001',
      '        name: Good',
      '',
    ].join('\n'),
  });
  try {
    const tree = collectTree(root);
    assert.equal(tree.length, 1, 'only the well-formed milestone survives');
    assert.equal(tree[0].id, 'M001');
    assert.equal(tree[0].slices.length, 1);
    assert.equal(tree[0].slices[0].local_id, 'S001');
  } finally {
    _cleanup(root);
  }
});

test('PT-9: a blank name or status reads as null rather than an empty string', () => {
  const root = _project({
    roadmap: [
      'schema_version: 2',
      'milestones:',
      '  - id: M001',
      '    name: ""',
      '    slices: []',
      '',
    ].join('\n'),
    tasks: [],
  });
  try {
    assert.equal(collectTree(root)[0].name, null);
  } finally {
    _cleanup(root);
  }
});

test('PT-10: collectTree tolerates being called outside a project', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-noproj-'));
  try {
    assert.deepEqual(collectTree(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PT-11: a slice `when` travels with the node', () => {
  const root = _project({
    roadmap: [
      'schema_version: 3',
      'milestones:',
      '  - id: M001',
      '    name: Migration',
      '    status: in-progress',
      '    slices:',
      '      - id: S001',
      '        name: migrate',
      '        status: done',
      '      - id: S002',
      '        name: verify',
      '        status: pending',
      '        when:',
      '          slice: S001',
      '          status: done',
      '',
    ].join('\n'),
  });
  try {
    const slices = collectTree(root)[0].slices;
    assert.equal(slices[0].when, undefined);
    assert.deepEqual(slices[1].when, { slice: 'S001', status: 'done' });
  } finally {
    _cleanup(root);
  }
});
