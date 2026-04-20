const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const tasks = require('./tasks.cjs');

const FIXTURES = path.join(__dirname, 'fixtures', 'plans');

function validFm(overrides) {
  return Object.assign({
    id: 'M099-S001-T0001',
    slice: 'M099-S001',
    milestone: 'M099',
    type: 'execute',
    status: 'pending',
    tier: 'sonnet',
    owner: 'np-executor',
    wave: 1,
    depends_on: [],
    files_modified: [],
    autonomous: true,
    must_haves: { truths: ['stub'], artifacts: [], key_links: [] },
  }, overrides || {});
}

test('TA-1: validateTaskFrontmatter on complete valid fm does not throw', () => {
  assert.doesNotThrow(() => tasks.validateTaskFrontmatter(validFm(), 'T-01'));
});

test('TA-2: missing depends_on throws tasks-invalid-frontmatter with missing field', () => {
  const fm = validFm();
  delete fm.depends_on;
  assert.throws(
    () => tasks.validateTaskFrontmatter(fm, 'T-01'),
    (err) => {
      return err.name === 'NubosPilotError'
        && err.code === 'tasks-invalid-frontmatter'
        && Array.isArray(err.details.missing)
        && err.details.missing.includes('depends_on');
    },
  );
});

test('TA-3: depends_on as string instead of array throws wrong_type', () => {
  const fm = validFm({ depends_on: 'T-01' });
  assert.throws(
    () => tasks.validateTaskFrontmatter(fm, 'T-02'),
    (err) => {
      return err.code === 'tasks-invalid-frontmatter'
        && Array.isArray(err.details.wrong_type)
        && err.details.wrong_type.includes('depends_on');
    },
  );
});

test('TA-4: autonomous as string throws tasks-invalid-frontmatter', () => {
  const fm = validFm({ autonomous: 'true' });
  assert.throws(
    () => tasks.validateTaskFrontmatter(fm, 'T-01'),
    (err) => {
      return err.code === 'tasks-invalid-frontmatter'
        && Array.isArray(err.details.wrong_type)
        && err.details.wrong_type.includes('autonomous');
    },
  );
});

test('TA-5: computeWaves linear chain produces three sequential waves', () => {
  const result = tasks.computeWaves([
    { id: 'T-01', depends_on: [] },
    { id: 'T-02', depends_on: ['T-01'] },
    { id: 'T-03', depends_on: ['T-02'] },
  ]);
  assert.deepEqual(result.waves, [['T-01'], ['T-02'], ['T-03']]);
  assert.equal(result.wavesById.get('T-01'), 1);
  assert.equal(result.wavesById.get('T-03'), 3);
  assert.deepEqual(result.warnings, []);
});

test('TA-6: computeWaves parallel fanout yields two waves with sorted tie-break', () => {
  const result = tasks.computeWaves([
    { id: 'T-03', depends_on: ['T-01'] },
    { id: 'T-01', depends_on: [] },
    { id: 'T-02', depends_on: ['T-01'] },
  ]);
  assert.deepEqual(result.waves, [['T-01'], ['T-02', 'T-03']]);
});

test('TA-7: computeWaves cycle throws tasks-cyclic with concrete closed cycle', () => {
  assert.throws(
    () => tasks.computeWaves([
      { id: 'T-01', depends_on: ['T-03'] },
      { id: 'T-02', depends_on: ['T-01'] },
      { id: 'T-03', depends_on: ['T-02'] },
    ]),
    (err) => {
      return err.code === 'tasks-cyclic'
        && Array.isArray(err.details.cycle)
        && err.details.cycle.length >= 3
        && err.details.cycle[0] === err.details.cycle[err.details.cycle.length - 1];
    },
  );
});

test('TA-8: computeWaves with unknown dep throws tasks-unknown-dep', () => {
  assert.throws(
    () => tasks.computeWaves([
      { id: 'T-01', depends_on: ['T-99'] },
    ]),
    (err) => {
      return err.code === 'tasks-unknown-dep'
        && err.details.task === 'T-01'
        && err.details.missing_dep === 'T-99';
    },
  );
});

test('TA-9: computeWaves wave-override-conflict warning emitted (computed wins)', () => {
  const result = tasks.computeWaves([
    { id: 'T-01', depends_on: [], wave: 1 },
    { id: 'T-02', depends_on: ['T-01'], wave: 5 },
  ]);
  assert.deepEqual(result.waves, [['T-01'], ['T-02']]);
  assert.equal(result.warnings.length, 1);
  const w = result.warnings[0];
  assert.equal(w.code, 'wave-override-conflict');
  assert.equal(w.task, 'T-02');
  assert.equal(w.user_wave, 5);
  assert.equal(w.computed_wave, 2);
});

test('TA-10: loadTaskGraph linear fixture returns full graph + waves', () => {
  const result = tasks.loadTaskGraph(path.join(FIXTURES, 'linear'));
  assert.equal(result.tasks.length, 3);
  const ids = ['M099-S001-T0001', 'M099-S001-T0002', 'M099-S001-T0003'];
  assert.deepEqual(result.tasks.map((t) => t.id), ids);
  assert.deepEqual(result.waves, [[ids[0]], [ids[1]], [ids[2]]]);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.errors, []);
  assert.ok(result.wavesById instanceof Map);
});

test('TA-11: loadTaskGraph on plan with no tasks/ dir returns empty result', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-tasks-'));
  try {
    const result = tasks.loadTaskGraph(root);
    assert.deepEqual(result.tasks, []);
    assert.deepEqual(result.waves, []);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.errors, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('TA-12: loadTaskGraph cycle fixture throws tasks-cyclic', () => {
  assert.throws(
    () => tasks.loadTaskGraph(path.join(FIXTURES, 'cycle')),
    (err) => err.code === 'tasks-cyclic',
  );
});

test('TA-13: loadTaskGraph wave-conflict fixture surfaces override warning', () => {
  const result = tasks.loadTaskGraph(path.join(FIXTURES, 'wave-conflict'));
  assert.equal(result.tasks.length, 2);
  const conflict = result.warnings.find((w) => w.code === 'wave-override-conflict');
  assert.ok(conflict, 'expected wave-override-conflict warning');
  assert.equal(conflict.task, 'M099-S001-T0002');
  assert.equal(conflict.user_wave, 5);
  assert.equal(conflict.computed_wave, 2);
});

test('TA-14: task id comes from frontmatter.id, not the directory name', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-tasks-'));
  try {
    fs.mkdirSync(path.join(root, 'tasks', 'T0001'), { recursive: true });
    const fmBlock =
      '---\nid: M099-S001-T0001\nmilestone: M099\nslice: M099-S001\ntype: execute\nstatus: pending\ntier: sonnet\nowner: executor\nwave: 1\ndepends_on: []\nfiles_modified: []\nautonomous: true\nmust_haves:\n  truths:\n    - "stub"\n  artifacts: []\n  key_links: []\n---\n\nbody\n';
    fs.writeFileSync(path.join(root, 'tasks', 'T0001', 'T0001-PLAN.md'), fmBlock);
    const result = tasks.loadTaskGraph(root);
    assert.deepEqual(result.tasks.map((t) => t.id), ['M099-S001-T0001']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('TA-15: computeWaves output is deterministic across runs (sorted tie-break)', () => {
  const input = [
    { id: 'T-03', depends_on: ['T-01'] },
    { id: 'T-02', depends_on: ['T-01'] },
    { id: 'T-01', depends_on: [] },
  ];
  function serialize(r) {
    return JSON.stringify({
      waves: r.waves,
      wavesById: [...r.wavesById.entries()].sort(),
      warnings: r.warnings,
    });
  }
  const a = serialize(tasks.computeWaves(input));
  const b = serialize(tasks.computeWaves(input));
  assert.equal(a, b);
});

test('TA-16: TASK_REQUIRED_FIELDS lists milestone/slice-based schema', () => {
  assert.ok(Array.isArray(tasks.TASK_REQUIRED_FIELDS));
  for (const f of ['id', 'slice', 'milestone', 'type', 'wave', 'depends_on', 'files_modified', 'autonomous', 'must_haves']) {
    assert.ok(tasks.TASK_REQUIRED_FIELDS.includes(f), `missing ${f}`);
  }
});

test('TA-17: invalid status throws tasks-invalid-status with allowed enum in details', () => {
  const fm = validFm({ status: 'bogus' });
  assert.throws(
    () => tasks.validateTaskFrontmatter(fm, 'T-01'),
    (err) => {
      return err.name === 'NubosPilotError'
        && err.code === 'tasks-invalid-status'
        && err.details.got === 'bogus'
        && Array.isArray(err.details.allowed)
        && err.details.allowed.includes('pending')
        && err.details.allowed.includes('done');
    },
  );
});

test('TA-18: invalid tier throws tasks-invalid-tier with allowed enum in details', () => {
  const fm = validFm({ tier: 'gpt' });
  assert.throws(
    () => tasks.validateTaskFrontmatter(fm, 'T-01'),
    (err) => {
      return err.code === 'tasks-invalid-tier'
        && err.details.got === 'gpt'
        && Array.isArray(err.details.allowed)
        && err.details.allowed.includes('sonnet');
    },
  );
});

test('TA-19: empty-string owner throws tasks-invalid-owner', () => {
  const fm = validFm({ owner: '' });
  assert.throws(
    () => tasks.validateTaskFrontmatter(fm, 'T-01'),
    (err) => err.code === 'tasks-invalid-owner',
  );
});

test('TA-20: non-string owner throws tasks-invalid-owner', () => {
  const fm = validFm({ owner: 42 });
  assert.throws(
    () => tasks.validateTaskFrontmatter(fm, 'T-01'),
    (err) => err.code === 'tasks-invalid-owner',
  );
});

test('TA-21: malformed id throws tasks-invalid-frontmatter with field=id', () => {
  const fm = validFm({ id: 'T-01' });
  assert.throws(
    () => tasks.validateTaskFrontmatter(fm, 'T-01'),
    (err) => {
      return err.code === 'tasks-invalid-frontmatter'
        && err.details.field === 'id'
        && err.details.expected === 'M<NNN>-S<NNN>-T<NNNN>';
    },
  );
});

test('TA-22: missing id / status / tier / owner reported as missing fields (tasks-invalid-frontmatter)', () => {
  const fm = validFm();
  delete fm.id;
  delete fm.status;
  delete fm.tier;
  delete fm.owner;
  assert.throws(
    () => tasks.validateTaskFrontmatter(fm, 'T-01'),
    (err) => {
      if (err.code !== 'tasks-invalid-frontmatter') return false;
      const m = err.details.missing;
      return Array.isArray(m)
        && m.includes('id') && m.includes('status')
        && m.includes('tier') && m.includes('owner');
    },
  );
});

test('TA-23: 12-field round-trip — all fields preserved through validateTaskFrontmatter', () => {
  const fm = validFm({ id: 'M004-S001-T0007', status: 'in-progress', tier: 'opus', owner: 'np-planner' });

  const before = JSON.parse(JSON.stringify(fm));
  tasks.validateTaskFrontmatter(fm, 'M004-S001-T0007');

  assert.deepEqual(fm, before);

  for (const f of tasks.TASK_REQUIRED_FIELDS) {
    assert.ok(f in fm, `field ${f} missing after round-trip`);
  }
});

test('TA-24: TASK_REQUIRED_FIELDS exports the full Phase-4 superset', () => {
  for (const f of ['id', 'status', 'tier', 'owner']) {
    assert.ok(tasks.TASK_REQUIRED_FIELDS.includes(f), `missing phase-4 field ${f}`);
  }
});

const fs6 = require('node:fs');
const os6 = require('node:os');

function makeTaskFile(root, mNum, sNum, tNum, status) {
  const mId = 'M' + String(mNum).padStart(3, '0');
  const sId = 'S' + String(sNum).padStart(3, '0');
  const tId = 'T' + String(tNum).padStart(4, '0');
  const fullId = mId + '-' + sId + '-' + tId;
  const dir = path.join(root, '.nubos-pilot', 'milestones', mId, 'slices', sId, 'tasks', tId);
  fs6.mkdirSync(dir, { recursive: true });
  const fm = [
    '---',
    `id: ${fullId}`,
    `milestone: ${mId}`,
    `slice: ${mId}-${sId}`,
    'type: execute',
    `status: ${status}`,
    'tier: sonnet',
    'owner: np-executor',
    'wave: 1',
    'depends_on: []',
    'files_modified: []',
    'autonomous: true',
    'must_haves:',
    '  truths:',
    '    - "stub"',
    '  artifacts: []',
    '  key_links: []',
    '---',
    '',
    'task body',
    '',
  ].join('\n');
  const file = path.join(dir, tId + '-PLAN.md');
  fs6.writeFileSync(file, fm, 'utf-8');
  return { file, fullId };
}

function makeSandbox(mNum, sNum, tNum, status) {
  const root = fs6.mkdtempSync(path.join(os6.tmpdir(), 'np-tasks-st-'));
  fs6.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  const { fullId } = makeTaskFile(root, mNum, sNum, tNum, status);
  return { root, fullId };
}

test('TA-25: setTaskStatus mutates frontmatter.status and persists round-trip', () => {
  const { root, fullId } = makeSandbox(6, 1, 1, 'pending');
  try {
    tasks.setTaskStatus(fullId, 'done', root);
    const sliceDir = path.join(root, '.nubos-pilot', 'milestones', 'M006', 'slices', 'S001');
    const reloaded = tasks.loadTaskGraph(sliceDir);
    const t = reloaded.tasks.find((x) => x.id === fullId);
    assert.ok(t, 'task must still be findable after status mutation');
    assert.equal(t.frontmatter.status, 'done');
  } finally {
    fs6.rmSync(root, { recursive: true, force: true });
  }
});

test('TA-26: setTaskStatus rejects out-of-enum status with NubosPilotError', () => {
  const { root, fullId } = makeSandbox(6, 1, 2, 'pending');
  try {
    assert.throws(
      () => tasks.setTaskStatus(fullId, 'bogus', root),
      (err) => {
        return err.name === 'NubosPilotError'
          && err.code === 'invalid-task-status'
          && err.details.newStatus === 'bogus';
      },
    );
  } finally {
    fs6.rmSync(root, { recursive: true, force: true });
  }
});

test('TA-27: setTaskStatus on missing task throws task-not-found', () => {
  const { root } = makeSandbox(6, 1, 3, 'pending');
  try {
    assert.throws(
      () => tasks.setTaskStatus('M006-S001-T0099', 'done', root),
      (err) => err.name === 'NubosPilotError' && err.code === 'task-not-found',
    );
  } finally {
    fs6.rmSync(root, { recursive: true, force: true });
  }
});
