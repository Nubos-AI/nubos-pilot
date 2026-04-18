const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const next = require('./next.cjs');

const sandboxes = [];

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-next-test-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'));
  sandboxes.push(root);
  return root;
}

function writeState(root, fm) {
  const lines = ['---'];
  for (const k of Object.keys(fm)) {
    const v = fm[k];
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const nk of Object.keys(v)) lines.push(`  ${nk}: ${v[nk] == null ? 'null' : v[nk]}`);
    } else {
      lines.push(`${k}: ${v == null ? 'null' : v}`);
    }
  }
  lines.push('---', '', '');
  fs.writeFileSync(path.join(root, '.nubos-pilot', 'STATE.md'), lines.join('\n'));
}

function writeRoadmap(root, phases) {
  const ms = {
    schema_version: 1,
    milestones: [{ id: 'v1.0', name: 'milestone', phases }],
  };
  const YAML = require('yaml');
  fs.writeFileSync(path.join(root, '.nubos-pilot', 'roadmap.yaml'), YAML.stringify(ms, { indent: 2 }));
}

function mkPhase(root, n, slug, { context = false, plan = false, tasks = null, verification = false } = {}) {
  const padded = String(n).padStart(2, '0');
  const dir = path.join(root, '.nubos-pilot', 'phases', padded + '-' + slug);
  fs.mkdirSync(dir, { recursive: true });
  if (context) fs.writeFileSync(path.join(dir, padded + '-CONTEXT.md'), '# ctx\n');
  if (plan) fs.writeFileSync(path.join(dir, padded + '-01-PLAN.md'), '---\nphase: ' + n + '\nplan: "' + padded + '-01"\n---\nbody\n');
  if (verification) fs.writeFileSync(path.join(dir, padded + '-VERIFICATION.md'), '# verify\n');
  if (tasks) {
    const tdir = path.join(dir, 'tasks');
    fs.mkdirSync(tdir, { recursive: true });
    for (const t of tasks) {
      const body =
        '---\n' +
        `id: ${padded}-01-T${String(t.num).padStart(2, '0')}\n` +
        `status: ${t.status || 'pending'}\n` +
        'tier: sonnet\n' +
        'owner: np-executor\n' +
        `phase: ${n}\n` +
        `plan: ${padded}-01\n` +
        'type: execute\n' +
        `wave: ${t.wave || 1}\n` +
        `depends_on: ${t.depends_on ? JSON.stringify(t.depends_on) : '[]'}\n` +
        'files_modified: []\n' +
        'autonomous: true\n' +
        'must_haves:\n  truths: []\n  artifacts: []\n  key_links: []\n' +
        '---\nbody\n';
      fs.writeFileSync(path.join(tdir, `T-${String(t.num).padStart(2, '0')}.md`), body);
    }
  }
  return dir;
}

afterEach(() => {
  while (sandboxes.length) {
    const p = sandboxes.pop();
    try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
  }
});

test('N1 (rule 1): phase missing CONTEXT.md → discuss-phase', () => {
  const root = makeSandbox();
  writeRoadmap(root, [{ number: 1, name: 'Foundation', slug: 'foundation', status: 'pending' }]);
  writeState(root, { schema_version: 2, current_phase: 1, current_plan: null, current_task: null });

  const out = next.computeNextStep(root);
  assert.equal(out.next_step.command, '/np:discuss-phase 1');
  assert.equal(out.task, null);
  assert.equal(out.phase, 1);
});

test('N2 (rule 2): CONTEXT.md exists but no PLAN.md → plan-phase', () => {
  const root = makeSandbox();
  writeRoadmap(root, [{ number: 1, name: 'Foundation', slug: 'foundation', status: 'pending' }]);
  writeState(root, { schema_version: 2, current_phase: 1, current_plan: null, current_task: null });
  mkPhase(root, 1, 'foundation', { context: true });
  const out = next.computeNextStep(root);
  assert.equal(out.next_step.command, '/np:plan-phase 1');
  assert.equal(out.task, null);
  assert.equal(out.phase, 1);
});

test('N3 (rule 3): PLAN.md exists + pending tasks → execute-phase + task pointer', () => {
  const root = makeSandbox();
  writeRoadmap(root, [{ number: 1, name: 'Foundation', slug: 'foundation', status: 'pending' }]);
  writeState(root, { schema_version: 2, current_phase: 1, current_plan: null, current_task: null });
  mkPhase(root, 1, 'foundation', {
    context: true,
    plan: true,
    tasks: [
      { num: 1, status: 'pending', wave: 1 },
      { num: 2, status: 'pending', wave: 1, depends_on: ['T-01'] },
    ],
  });
  const out = next.computeNextStep(root);
  assert.equal(out.next_step.command, '/np:execute-phase 1');
  assert.ok(out.task);
  assert.equal(out.task.id, '01-01-T01', 'task.id comes from frontmatter.id');
  assert.equal(out.task.owner, 'np-executor');
  assert.equal(out.task.tier, 'sonnet');
  assert.equal(out.task.wave, 1);
});

test('N4 (rule 4): all tasks done but no VERIFICATION.md → verify-work', () => {
  const root = makeSandbox();
  writeRoadmap(root, [{ number: 1, name: 'Foundation', slug: 'foundation', status: 'pending' }]);
  writeState(root, { schema_version: 2, current_phase: 1, current_plan: null, current_task: null });
  mkPhase(root, 1, 'foundation', {
    context: true,
    plan: true,
    tasks: [{ num: 1, status: 'done', wave: 1 }],
  });
  const out = next.computeNextStep(root);
  assert.equal(out.next_step.command, '/np:verify-work 1');
  assert.equal(out.task, null);
});

test('N5 (rule 5): phase done+verified → next phase rules recursed', () => {
  const root = makeSandbox();
  writeRoadmap(root, [
    { number: 1, name: 'Foundation', slug: 'foundation', status: 'done' },
    { number: 2, name: 'Second', slug: 'second', status: 'pending' },
  ]);
  writeState(root, { schema_version: 2, current_phase: 1, current_plan: null, current_task: null });
  mkPhase(root, 1, 'foundation', {
    context: true, plan: true, verification: true,
    tasks: [{ num: 1, status: 'done', wave: 1 }],
  });

  const out = next.computeNextStep(root);
  assert.equal(out.next_step.command, '/np:discuss-phase 2');
  assert.equal(out.phase, 2);
});

test('N6 (rule 6): all phases done → complete-milestone', () => {
  const root = makeSandbox();
  writeRoadmap(root, [
    { number: 1, name: 'Foundation', slug: 'foundation', status: 'done' },
  ]);
  writeState(root, { schema_version: 2, current_phase: 1, current_plan: null, current_task: null });
  mkPhase(root, 1, 'foundation', {
    context: true, plan: true, verification: true,
    tasks: [{ num: 1, status: 'done', wave: 1 }],
  });
  const out = next.computeNextStep(root);
  assert.equal(out.next_step.command, '/np:complete-milestone');
  assert.equal(out.task, null);
  assert.equal(out.phase, null);
  assert.equal(out.plan, null);
});

test('N7: fresh project (no STATE.md, no roadmap.yaml) → rule 1 for phase 1 (Pattern S-7)', () => {
  const root = makeSandbox();

  const out = next.computeNextStep(root);
  assert.equal(out.next_step.command, '/np:discuss-phase 1');
  assert.equal(out.phase, 1);
});

test('N8: rule 3 deterministic task pointer = lexicographically-first pending in waves[0]', () => {
  const root = makeSandbox();
  writeRoadmap(root, [{ number: 1, name: 'Foundation', slug: 'foundation', status: 'pending' }]);
  writeState(root, { schema_version: 2, current_phase: 1, current_plan: null, current_task: null });
  mkPhase(root, 1, 'foundation', {
    context: true, plan: true,
    tasks: [
      { num: 2, status: 'pending', wave: 1 },
      { num: 1, status: 'pending', wave: 1 },
      { num: 3, status: 'pending', wave: 1, depends_on: ['T-01'] },
    ],
  });
  const out = next.computeNextStep(root);
  assert.equal(out.task.id, '01-01-T01');
});
