'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');

const subcmd = require('./rollup.cjs');
const { _resetParseRoadmapCacheForTests } = require('../../lib/roadmap.cjs');

const _sandboxes = [];

function _sandbox(milestones) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-rollupcli-'));
  _sandboxes.push(root);
  const sd = path.join(root, '.nubos-pilot');
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, 'PROJECT.md'), '# Demo\n', 'utf-8');

  const defs = milestones || [{ number: 1, tasks: ['done', 'done'] }];
  fs.writeFileSync(
    path.join(sd, 'roadmap.yaml'),
    YAML.stringify({
      schema_version: 2,
      milestones: defs.map((m) => ({
        id: 'M' + String(m.number).padStart(3, '0'),
        number: m.number,
        name: 'm' + m.number,
        status: 'pending',
        success_criteria: ['w'],
        slices: [{ id: 'S001', name: 'S001', goal: 'g' }],
      })),
    }),
    'utf-8',
  );

  for (const m of defs) {
    const mid = 'M' + String(m.number).padStart(3, '0');
    m.tasks.forEach((status, i) => {
      const tid = 'T' + String(i + 1).padStart(4, '0');
      const dir = path.join(sd, 'milestones', mid, 'slices', 'S001', 'tasks', tid);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, tid + '-PLAN.md'),
        '---\ntask: ' + tid + '\nslice: ' + mid + '-S001\nstatus: ' + status + '\n---\n# t\n',
        'utf-8',
      );
    });
  }
  _resetParseRoadmapCacheForTests();
  return root;
}

function _capture() {
  let b = '';
  return { stub: { write: (s) => { b += s; return true; } }, get: () => b };
}

afterEach(() => {
  while (_sandboxes.length) {
    try { fs.rmSync(_sandboxes.pop(), { recursive: true, force: true }); } catch {}
  }
});

test('RC-1: bare verb rolls up every milestone', () => {
  const sb = _sandbox([
    { number: 1, tasks: ['done', 'done'] },
    { number: 2, tasks: ['pending'] },
  ]);
  const cap = _capture();
  const payload = subcmd.run([], { cwd: sb, stdout: cap.stub });
  assert.equal(payload.count, 2);
  assert.deepEqual(JSON.parse(cap.get()).results.length, 2);

  _resetParseRoadmapCacheForTests();
  const doc = YAML.parse(fs.readFileSync(path.join(sb, '.nubos-pilot', 'roadmap.yaml'), 'utf-8'));
  assert.equal(doc.milestones[0].slices[0].status, 'done');
  assert.equal(doc.milestones[1].slices[0].status, 'pending');
});

test('RC-2: "all" is the same as the bare verb', () => {
  const sb = _sandbox();
  const payload = subcmd.run(['all'], { cwd: sb, stdout: _capture().stub });
  assert.equal(payload.count, 1);
});

test('RC-3: a single milestone rolls up only that one', () => {
  const sb = _sandbox([
    { number: 1, tasks: ['done'] },
    { number: 2, tasks: ['done'] },
  ]);
  subcmd.run(['2'], { cwd: sb, stdout: _capture().stub });

  _resetParseRoadmapCacheForTests();
  const doc = YAML.parse(fs.readFileSync(path.join(sb, '.nubos-pilot', 'roadmap.yaml'), 'utf-8'));
  assert.equal(doc.milestones[0].slices[0].status, undefined, 'M001 must be untouched');
  assert.equal(doc.milestones[1].slices[0].status, 'done');
});

test('RC-4: inspect reports without writing', () => {
  const sb = _sandbox();
  const yamlPath = path.join(sb, '.nubos-pilot', 'roadmap.yaml');
  const before = fs.readFileSync(yamlPath, 'utf-8');

  const payload = subcmd.run(['inspect', '1'], { cwd: sb, stdout: _capture().stub });
  assert.equal(payload.all_done, true);
  assert.equal(payload.slices[0].derived, 'done');
  assert.equal(payload.slices[0].persisted, null);
  assert.equal(fs.readFileSync(yamlPath, 'utf-8'), before, 'inspect must not mutate');
});

test('RC-5: a non-numeric milestone is refused', () => {
  const sb = _sandbox();
  for (const bad of ['abc', '0', '-1']) {
    assert.throws(
      () => subcmd.run([bad], { cwd: sb, stdout: _capture().stub }),
      (err) => err.code === 'rollup-invalid-milestone',
      'expected refusal for ' + bad,
    );
  }
  assert.throws(
    () => subcmd.run(['inspect'], { cwd: sb, stdout: _capture().stub }),
    (err) => err.code === 'rollup-invalid-milestone',
  );
});

test('RC-6: "all" covers a declared milestone that has no directory yet', () => {
  const sb = _sandbox([{ number: 1, tasks: ['done'] }]);
  const yamlPath = path.join(sb, '.nubos-pilot', 'roadmap.yaml');
  const doc = YAML.parse(fs.readFileSync(yamlPath, 'utf-8'));
  doc.milestones.push({
    id: 'M002', number: 2, name: 'planned', status: 'pending',
    success_criteria: ['w'], slices: [{ id: 'S001', name: 'S001', goal: 'g' }],
  });
  fs.writeFileSync(yamlPath, YAML.stringify(doc), 'utf-8');
  _resetParseRoadmapCacheForTests();

  const payload = subcmd.run(['all'], { cwd: sb, stdout: _capture().stub });
  assert.equal(
    payload.count,
    2,
    'enumerating milestone directories would skip M002 entirely — the roadmap declares the set',
  );
  assert.ok(payload.results.some((r) => r.milestone === 'M002'));
});
