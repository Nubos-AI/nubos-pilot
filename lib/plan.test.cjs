const { test, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const plan = require('./plan.cjs');
const { shouldPromoteToTasks } = require('./plan.cjs');

const FIXTURES = path.join(__dirname, 'fixtures', 'plans');
const sandboxes = [];

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-plan-'));
  sandboxes.push(root);
  return root;
}

process.on('exit', () => {
  for (const s of sandboxes) {
    try { fs.rmSync(s, { recursive: true, force: true }); } catch {}
  }
});

test('PL-1: parsePlan returns frontmatter + body + path for valid PLAN.md', () => {
  const p = path.join(FIXTURES, 'linear', 'PLAN.md');
  const result = plan.parsePlan(p);
  assert.equal(result.path, p);
  assert.equal(result.frontmatter.phase, 99);
  assert.equal(typeof result.body, 'string');
  assert.ok(result.body.length > 0);
});

test('PL-2: parsePlan on missing path throws plan-not-found', () => {
  const p = path.join(FIXTURES, 'does-not-exist', 'PLAN.md');
  assert.throws(
    () => plan.parsePlan(p),
    (err) => err.name === 'NubosPilotError' && err.code === 'plan-not-found',
  );
});

test('PL-3: parsePlan on malformed frontmatter propagates frontmatter-parse-error', () => {
  const root = makeSandbox();
  const p = path.join(root, 'BAD.md');
  fs.writeFileSync(p, '---\n\tbad: tab\n---\n\nbody\n');
  assert.throws(
    () => plan.parsePlan(p),
    (err) => err.name === 'NubosPilotError' && err.code === 'frontmatter-parse-error',
  );
});

test('PL-4: listPlans returns sorted absolute paths of PLAN.md variants', () => {
  const root = makeSandbox();
  fs.writeFileSync(path.join(root, '01-02-PLAN.md'), '---\nphase: 1\n---\n');
  fs.writeFileSync(path.join(root, '01-01-PLAN.md'), '---\nphase: 1\n---\n');
  const result = plan.listPlans(root);
  assert.equal(result.length, 2);
  assert.equal(result[0], path.join(root, '01-01-PLAN.md'));
  assert.equal(result[1], path.join(root, '01-02-PLAN.md'));
  assert.ok(path.isAbsolute(result[0]));
});

test('PL-5: enumerateTasks returns sorted absolute paths of task files', () => {
  const planPath = path.join(FIXTURES, 'linear', 'PLAN.md');
  const result = plan.enumerateTasks(planPath);
  assert.equal(result.length, 3);
  assert.equal(path.basename(result[0]), 'T-01.md');
  assert.equal(path.basename(result[1]), 'T-02.md');
  assert.equal(path.basename(result[2]), 'T-03.md');
  assert.ok(path.isAbsolute(result[0]));
});

test('PL-6: enumerateTasks on plan with no tasks/ dir returns empty array', () => {
  const root = makeSandbox();
  const planPath = path.join(root, 'PLAN.md');
  fs.writeFileSync(planPath, '---\nphase: 1\n---\n');
  const result = plan.enumerateTasks(planPath);
  assert.deepEqual(result, []);
});

test('PL-7: parsePlan integration on real 02-01-PLAN.md preserves requirements array', () => {
  const realPlan = path.resolve(
    __dirname,
    '..',
    '.planning',
    'phases',
    '02-core-lib-atomic-state-primitives',
    '02-01-PLAN.md',
  );
  if (!fs.existsSync(realPlan)) {

    return;
  }
  const result = plan.parsePlan(realPlan);
  assert.ok(Array.isArray(result.frontmatter.requirements), 'requirements must be an array');
  assert.deepEqual(result.frontmatter.requirements, ['LIB-01']);
});

function mkTask(id, { tier = 'sonnet', deps = [] } = {}) {
  return {
    id,
    frontmatter: { id, status: 'pending', tier, owner: 'claude', depends_on: deps },
    body: '',
  };
}

function mkPlan(tasks) {
  return { frontmatter: {}, tasks };
}

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('shouldPromoteToTasks (D-18 heuristic)', () => {
  it('returns {promote:false, triggers:[]} for empty tasks', () => {
    assert.deepStrictEqual(shouldPromoteToTasks(mkPlan([])), {
      promote: false,
      triggers: [],
    });
  });

  it('returns {promote:false, triggers:[]} for a single task with no deps', () => {
    const p = mkPlan([mkTask('T-01')]);
    assert.deepStrictEqual(shouldPromoteToTasks(p), { promote: false, triggers: [] });
  });

  it('three tasks in one wave (all same tier, no deps) does NOT promote', () => {

    const p = mkPlan([mkTask('T-01'), mkTask('T-02'), mkTask('T-03')]);
    const r = shouldPromoteToTasks(p);
    assert.deepStrictEqual(r, { promote: false, triggers: [] });
  });

  it('parallelism trigger fires: 2 parallel roots + 2 dependents (waves.length=2, maxSize=2)', () => {
    const p = mkPlan([
      mkTask('T-01'),
      mkTask('T-02'),
      mkTask('T-03', { deps: ['T-01'] }),
      mkTask('T-04', { deps: ['T-02'] }),
    ]);
    const r = shouldPromoteToTasks(p);
    assert.equal(r.promote, true);
    assert.ok(r.triggers.includes('parallelism'));
  });

  it('parallelism NOT fired for strictly sequential chain (maxSize < 2)', () => {
    const p = mkPlan([
      mkTask('T-01'),
      mkTask('T-02', { deps: ['T-01'] }),
      mkTask('T-03', { deps: ['T-02'] }),
    ]);
    const r = shouldPromoteToTasks(p);
    assert.ok(!r.triggers.includes('parallelism'));
  });

  it('mixed-tiers trigger fires when tier cardinality >= 2', () => {
    const p = mkPlan([
      mkTask('T-01', { tier: 'haiku' }),
      mkTask('T-02', { tier: 'opus' }),
    ]);
    const r = shouldPromoteToTasks(p);
    assert.equal(r.promote, true);
    assert.ok(r.triggers.includes('mixed-tiers'));
  });

  it('mixed-tiers NOT fired when all tasks share a tier', () => {
    const p = mkPlan([
      mkTask('T-01', { tier: 'sonnet' }),
      mkTask('T-02', { tier: 'sonnet' }),
      mkTask('T-03', { tier: 'sonnet' }),
    ]);
    const r = shouldPromoteToTasks(p);
    assert.ok(!r.triggers.includes('mixed-tiers'));
  });

  it('non-linear-deps trigger fires when any task has depends_on.length >= 2', () => {
    const p = mkPlan([
      mkTask('T-01'),
      mkTask('T-02'),
      mkTask('T-03', { deps: ['T-01', 'T-02'] }),
    ]);
    const r = shouldPromoteToTasks(p);
    assert.equal(r.promote, true);
    assert.ok(r.triggers.includes('non-linear-deps'));
  });

  it('non-linear-deps NOT fired when every task has depends_on.length <= 1', () => {
    const p = mkPlan([
      mkTask('T-01'),
      mkTask('T-02', { deps: ['T-01'] }),
      mkTask('T-03', { deps: ['T-02'] }),
    ]);
    const r = shouldPromoteToTasks(p);
    assert.ok(!r.triggers.includes('non-linear-deps'));
  });

  it('combined: all three triggers fire together', () => {

    

    const p = mkPlan([
      mkTask('T-01', { tier: 'haiku' }),
      mkTask('T-02', { tier: 'opus' }),
      mkTask('T-03', { tier: 'haiku', deps: ['T-01'] }),
      mkTask('T-04', { tier: 'opus', deps: ['T-01', 'T-02'] }),
    ]);
    const r = shouldPromoteToTasks(p);
    assert.equal(r.promote, true);
    assert.deepStrictEqual(
      [...r.triggers].sort(),
      ['mixed-tiers', 'non-linear-deps', 'parallelism'],
    );
  });

  it('purity property: 100 random deterministic plans produce byte-identical output on repeat', () => {
    const rand = mulberry32(12345);
    const TIERS = ['haiku', 'sonnet', 'opus'];
    for (let trial = 0; trial < 100; trial++) {
      const n = Math.floor(rand() * 11); 
      const tasks = [];
      for (let i = 0; i < n; i++) {
        const id = `T-${String(i + 1).padStart(2, '0')}`;
        const tier = TIERS[Math.floor(rand() * TIERS.length)];
        const deps = [];

        const numDeps = Math.min(i, Math.floor(rand() * 3));
        const priorIds = tasks.map((t) => t.id);

        const shuffled = [...priorIds];
        for (let k = shuffled.length - 1; k > 0; k--) {
          const j = Math.floor(rand() * (k + 1));
          [shuffled[k], shuffled[j]] = [shuffled[j], shuffled[k]];
        }
        for (let d = 0; d < numDeps && d < shuffled.length; d++) {
          deps.push(shuffled[d]);
        }
        tasks.push(mkTask(id, { tier, deps }));
      }
      const p = mkPlan(tasks);
      const a = shouldPromoteToTasks(p);
      const b = shouldPromoteToTasks(p);
      assert.equal(
        JSON.stringify(a),
        JSON.stringify(b),
        `purity violated at trial ${trial} with ${n} tasks`,
      );
    }
  });

  it('edge case: tasks missing frontmatter.tier — all undefined means tierSet size=1, mixed-tiers NOT fired', () => {

    const t1 = { id: 'T-01', frontmatter: { id: 'T-01', status: 'pending', owner: 'c', depends_on: [] }, body: '' };
    const t2 = { id: 'T-02', frontmatter: { id: 'T-02', status: 'pending', owner: 'c', depends_on: [] }, body: '' };
    const r = shouldPromoteToTasks(mkPlan([t1, t2]));
    assert.ok(!r.triggers.includes('mixed-tiers'));
  });
});
