const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { makeSandbox, seedRoadmapYaml, seedPhaseDir, cleanupAll } =
  require('../../tests/helpers/fixture.cjs');
const subcmd = require('./plan-phase.cjs');

function _baseRoadmap() {
  return {
    schema_version: 1,
    milestones: [
      {
        id: 'v1.0',
        name: 'first',
        phases: [
          {
            number: 5,
            name: 'Planning Workflows',
            slug: 'planning-workflows',
            goal: 'Ship the plan-phase orchestrator',
            depends_on: [],
            requirements: ['PLAN-04'],
            success_criteria: ['plan-phase workflow exists'],
            status: 'planned',
            plans: [],
          },
        ],
      },
    ],
  };
}

function _capture() {
  let buf = '';
  const stub = { write: (s) => { buf += s; return true; } };
  return { stub, get: () => buf };
}

function _seed(phaseFiles) {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _baseRoadmap());
  const dir = seedPhaseDir(sandbox, 5, 'planning-workflows', phaseFiles || {});
  return { sandbox, phaseDir: dir };
}

afterEach(cleanupAll);

test('PP-1: run(["init", "5"]) returns payload with expected shape', () => {
  const { sandbox, phaseDir } = _seed({
    '05-CONTEXT.md': '# ctx',
    '05-RESEARCH.md': '# res',
  });
  const cap = _capture();
  const payload = subcmd.run(['init', '5'], { cwd: sandbox, stdout: cap.stub });
  const raw = cap.get().trim();
  assert.ok(!raw.startsWith('@file:'));
  const parsed = JSON.parse(raw);
  assert.equal(parsed.phase, '5');
  assert.equal(parsed.padded, '05');
  assert.equal(parsed.phase_dir, phaseDir);
  assert.equal(parsed.phase_name, 'Planning Workflows');
  assert.equal(parsed.goal, 'Ship the plan-phase orchestrator');
  assert.deepEqual(parsed.requirements, ['PLAN-04']);
  assert.equal(parsed.has_context, true);
  assert.equal(parsed.has_research, true);
  assert.equal(parsed.has_plan, false);
  assert.equal(parsed.planner_tier, 'opus');
  assert.equal(parsed.checker_tier, 'opus');
  assert.ok(parsed.plan_review_path.endsWith('05-PLAN-REVIEW.md'));
  assert.ok(parsed.agent_skills && 'np-planner' in parsed.agent_skills);
  assert.ok(parsed.agent_skills && 'np-plan-checker' in parsed.agent_skills);

  assert.equal(payload.phase, '5');
});

test('PP-2: init payload has_context/has_research/has_plan reflect actual disk state', () => {
  const { sandbox } = _seed({});
  const cap = _capture();
  subcmd.run(['init', '5'], { cwd: sandbox, stdout: cap.stub });
  const parsed = JSON.parse(cap.get().trim());
  assert.equal(parsed.has_context, false);
  assert.equal(parsed.has_research, false);
  assert.equal(parsed.has_plan, false);

  fs.writeFileSync(path.join(parsed.phase_dir, '05-01-PLAN.md'), '---\nphase: "5"\n---\n');
  const cap2 = _capture();
  subcmd.run(['init', '5'], { cwd: sandbox, stdout: cap2.stub });
  const p2 = JSON.parse(cap2.get().trim());
  assert.equal(p2.has_plan, true);
});

test('PP-3: plan-review-append creates PLAN-REVIEW.md with dated iteration section', () => {
  const { sandbox, phaseDir } = _seed({});
  const verdict = { status: 'issues_found', findings: [
    { category: 'missing-success-criterion', severity: 'critical',
      target: 'PLAN.md §SC-3', message: 'No task addresses SC-3.' },
  ]};
  const verdictPath = path.join(sandbox, 'verdict-1.json');
  fs.writeFileSync(verdictPath, JSON.stringify(verdict), 'utf-8');

  const cap = _capture();
  subcmd.run(['plan-review-append', '5', '1', verdictPath], { cwd: sandbox, stdout: cap.stub });

  const reviewPath = path.join(phaseDir, '05-PLAN-REVIEW.md');
  assert.ok(fs.existsSync(reviewPath));
  const body = fs.readFileSync(reviewPath, 'utf-8');
  assert.match(body, /## Iteration 1 - \d{4}-\d{2}-\d{2}T/);
  assert.match(body, /\*\*Checker verdict:\*\* issues_found/);
  assert.match(body, /```yaml[\s\S]*missing-success-criterion[\s\S]*```/);
});

test('PP-4: plan-review-append is append-only (iteration 1 bytes preserved in iter 2)', () => {
  const { sandbox, phaseDir } = _seed({});
  const reviewPath = path.join(phaseDir, '05-PLAN-REVIEW.md');

  const v1 = { status: 'issues_found', findings: [
    { category: 'non-atomic-task', severity: 'major', target: 'T02', message: 'T02 bundles concerns' },
  ]};
  const v2 = { status: 'passed', findings: [] };
  const v1Path = path.join(sandbox, 'v1.json');
  const v2Path = path.join(sandbox, 'v2.json');
  fs.writeFileSync(v1Path, JSON.stringify(v1), 'utf-8');
  fs.writeFileSync(v2Path, JSON.stringify(v2), 'utf-8');

  subcmd.run(['plan-review-append', '5', '1', v1Path], { cwd: sandbox, stdout: _capture().stub });
  const afterIter1 = fs.readFileSync(reviewPath, 'utf-8');
  const iter1Sha = crypto.createHash('sha256').update(afterIter1).digest('hex');

  subcmd.run(['plan-review-append', '5', '2', v2Path], { cwd: sandbox, stdout: _capture().stub });
  const afterIter2 = fs.readFileSync(reviewPath, 'utf-8');

  assert.ok(afterIter2.startsWith(afterIter1),
    'iter 1 bytes must be a prefix of iter 2 contents (append-only invariant)');

  const iter1Sha2 = crypto.createHash('sha256').update(afterIter2.slice(0, afterIter1.length)).digest('hex');
  assert.equal(iter1Sha, iter1Sha2);
  assert.match(afterIter2, /## Iteration 2 - /);
});

test('PP-5: plan-phase-abort deletes PLAN.md + tasks/ but preserves PLAN-REVIEW.md', () => {
  const { sandbox, phaseDir } = _seed({
    '05-01-PLAN.md': '---\nphase: "5"\n---\n',
    '05-PLAN-REVIEW.md': '## Iteration 1 - 2026-01-01T00:00:00Z\npreserve me\n',
  });
  const tasksDir = path.join(phaseDir, 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(tasksDir, 'T01.md'), 'x', 'utf-8');

  const cap = _capture();
  subcmd.run(['plan-phase-abort', '5'], { cwd: sandbox, stdout: cap.stub });

  assert.ok(!fs.existsSync(path.join(phaseDir, '05-01-PLAN.md')));
  assert.ok(!fs.existsSync(tasksDir));
  assert.ok(fs.existsSync(path.join(phaseDir, '05-PLAN-REVIEW.md')));
  const body = fs.readFileSync(path.join(phaseDir, '05-PLAN-REVIEW.md'), 'utf-8');
  assert.match(body, /preserve me/);
});

test('PP-6: plan-phase-promote-check returns {promote:false} on linear same-tier plan', () => {
  const plan = [
    '---',
    'phase: "5"',
    'plan: "05-01"',
    '---',
    '',
    '<tasks>',
    '<task id="T01" wave="1" tier="sonnet" depends_on="[]">one</task>',
    '<task id="T02" wave="2" tier="sonnet" depends_on="[T01]">two</task>',
    '</tasks>',
  ].join('\n');
  const { sandbox, phaseDir } = _seed({ '05-01-PLAN.md': plan });
  const cap = _capture();
  subcmd.run(['plan-phase-promote-check', '5'], { cwd: sandbox, stdout: cap.stub });
  const out = JSON.parse(cap.get().trim());
  assert.equal(out.promote, false);
  assert.deepEqual(out.triggers, []);

  void phaseDir;
});

test('PP-7: plan-phase-promote-check flags parallelism on parallel-tier plan', () => {
  const plan = [
    '---',
    'phase: "5"',
    'plan: "05-01"',
    '---',
    '',
    '<tasks>',
    '<task id="T01" wave="1" tier="sonnet" depends_on="[]">one</task>',
    '<task id="T02" wave="1" tier="sonnet" depends_on="[]">two</task>',
    '<task id="T03" wave="2" tier="opus" depends_on="[T01, T02]">three</task>',
    '</tasks>',
  ].join('\n');
  const { sandbox } = _seed({ '05-01-PLAN.md': plan });
  const cap = _capture();
  subcmd.run(['plan-phase-promote-check', '5'], { cwd: sandbox, stdout: cap.stub });
  const out = JSON.parse(cap.get().trim());
  assert.equal(out.promote, true);
  assert.ok(out.triggers.includes('parallelism'));
});

test('PP-8: unknown verb throws NubosPilotError("plan-phase-unknown-verb")', () => {
  const { sandbox } = _seed({});
  const cap = _capture();
  assert.throws(
    () => subcmd.run(['bad', '5'], { cwd: sandbox, stdout: cap.stub }),
    (err) => err && err.name === 'NubosPilotError' && err.code === 'plan-phase-unknown-verb'
      && err.details && err.details.verb === 'bad',
  );
});

test('PP-9: oversized payload emits @file: pointer', () => {
  const { sandbox } = _seed({});

  const cfgDir = path.join(sandbox, '.nubos-pilot');
  const big = [];
  for (let i = 0; i < 3000; i++) big.push('skill-' + i);
  fs.writeFileSync(
    path.join(cfgDir, 'config.json'),
    JSON.stringify({ agent_skills: { planner: big, 'np-plan-checker': big } }),
    'utf-8',
  );
  const cap = _capture();
  subcmd.run(['init', '5'], { cwd: sandbox, stdout: cap.stub });
  const raw = cap.get().trim();
  assert.ok(raw.startsWith('@file:'), 'expected @file: pointer for oversized payload');
});

const { execFileSync } = require('node:child_process');

function _initGitRepo(root) {
  execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main'], { stdio: 'pipe' });
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@nubos-pilot.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'nubos-test']);
  execFileSync('git', ['-C', root, 'commit', '--allow-empty', '-q', '-m', 'chore: init'], { stdio: 'pipe' });
}

test('PP-PD-1: init payload has plan_diff_required=true when HEAD has 05-01-PLAN.md committed', () => {
  const { sandbox, phaseDir } = _seed({});
  _initGitRepo(sandbox);
  const rel = path.relative(sandbox, path.join(phaseDir, '05-01-PLAN.md'));
  fs.writeFileSync(path.join(sandbox, rel), '---\nphase: "5"\n---\n', 'utf-8');
  execFileSync('git', ['-C', sandbox, 'add', '--', rel], { stdio: 'pipe' });
  execFileSync('git', ['-C', sandbox, 'commit', '-q', '-m', 'seed PLAN.md'], { stdio: 'pipe' });
  const cap = _capture();
  subcmd.run(['init', '5'], { cwd: sandbox, stdout: cap.stub });
  const parsed = JSON.parse(cap.get().trim());
  assert.equal(parsed.plan_diff_required, true);
  assert.equal(parsed.plan_diff_plan_path, rel);
});

test('PP-PD-2: init payload has plan_diff_required=false for first-time planning', () => {
  const { sandbox } = _seed({});
  _initGitRepo(sandbox);
  const cap = _capture();
  subcmd.run(['init', '5'], { cwd: sandbox, stdout: cap.stub });
  const parsed = JSON.parse(cap.get().trim());
  assert.equal(parsed.plan_diff_required, false);
  assert.match(parsed.plan_diff_plan_path, /05-01-PLAN\.md$/);
});
