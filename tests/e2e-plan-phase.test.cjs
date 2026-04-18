const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { makeSandbox, seedRoadmapYaml, seedPhaseDir, cleanupAll } =
  require('./helpers/fixture.cjs');
const planPhase = require('../bin/np-tools/plan-phase.cjs');
const stubPlanner = require('./stubs/planner.cjs');
const stubChecker = require('./stubs/checker.cjs');

function _roadmap() {
  return {
    schema_version: 1,
    milestones: [{
      id: 'v1.0', name: 'first',
      phases: [{
        number: 5, name: 'Planning Workflows', slug: 'planning-workflows',
        goal: 'Ship plan-phase', depends_on: [], requirements: ['PLAN-04'],
        success_criteria: ['plan-phase ships'], status: 'planned', plans: [],
      }],
    }],
  };
}

function _setupSandbox(mode) {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmap());
  const phaseDir = seedPhaseDir(sandbox, 5, 'planning-workflows', {
    '05-CONTEXT.md': '# context\n',
  });
  if (mode) {
    fs.writeFileSync(
      path.join(sandbox, '.test-checker-mode.json'),
      JSON.stringify({ mode }),
      'utf-8',
    );
  }
  return { sandbox, phaseDir };
}

function _cap() {
  let buf = '';
  return { stub: { write: (s) => { buf += s; return true; } }, get: () => buf };
}

function _writeVerdict(sandbox, iter, verdict) {
  const p = path.join(sandbox, '.tmp-verdict-' + iter + '.json');
  fs.writeFileSync(p, JSON.stringify(verdict), 'utf-8');
  return p;
}

function _runLoop(sandbox, onIter2Fail) {
  let lastVerdict = null;
  let finalIter = 0;
  for (let iter = 1; iter <= 2; iter++) {
    finalIter = iter;
    stubPlanner.plan(sandbox, 5, iter === 1 ? 'initial' : 'revise', iter);
    const verdict = stubChecker.check(sandbox, iter);
    lastVerdict = verdict;
    const verdictPath = _writeVerdict(sandbox, iter, verdict);
    planPhase.run(
      ['plan-review-append', '5', String(iter), verdictPath],
      { cwd: sandbox, stdout: _cap().stub },
    );
    if (verdict.status === 'passed') break;
    if (iter === 2 && typeof onIter2Fail === 'function') {
      onIter2Fail(sandbox);
    }
  }
  return { lastVerdict, finalIter };
}

afterEach(cleanupAll);

test('E2E-1: happy path (fail-pass) — 2 iteration sections, PLAN.md survives', () => {
  const { sandbox, phaseDir } = _setupSandbox('fail-pass');
  const { lastVerdict, finalIter } = _runLoop(sandbox);
  assert.equal(lastVerdict.status, 'passed');
  assert.equal(finalIter, 2);
  const planPath = path.join(phaseDir, '05-01-PLAN.md');
  assert.ok(fs.existsSync(planPath));
  const review = fs.readFileSync(path.join(phaseDir, '05-PLAN-REVIEW.md'), 'utf-8');
  const iterHeaders = review.match(/^## Iteration \d+ - /gm) || [];
  assert.equal(iterHeaders.length, 2);
});

test('E2E-2: pass first iter — 1 iteration section only', () => {
  const { sandbox, phaseDir } = _setupSandbox('pass');
  const { lastVerdict, finalIter } = _runLoop(sandbox);
  assert.equal(lastVerdict.status, 'passed');
  assert.equal(finalIter, 1);
  const review = fs.readFileSync(path.join(phaseDir, '05-PLAN-REVIEW.md'), 'utf-8');
  const iterHeaders = review.match(/^## Iteration \d+ - /gm) || [];
  assert.equal(iterHeaders.length, 1);
});

test('E2E-3: 2-iter stall → abort deletes PLAN.md but preserves PLAN-REVIEW.md', () => {
  const { sandbox, phaseDir } = _setupSandbox('fail-fail');
  _runLoop(sandbox, (sbx) => {

    planPhase.run(['plan-phase-abort', '5'], { cwd: sbx, stdout: _cap().stub });
  });
  assert.ok(!fs.existsSync(path.join(phaseDir, '05-01-PLAN.md')));
  const reviewPath = path.join(phaseDir, '05-PLAN-REVIEW.md');
  assert.ok(fs.existsSync(reviewPath));
  const body = fs.readFileSync(reviewPath, 'utf-8');
  const iterHeaders = body.match(/^## Iteration \d+ - /gm) || [];
  assert.equal(iterHeaders.length, 2);
});

test('E2E-4: iter-2 gate "commit-with-warnings" → PLAN.md stays, 2 sections in PLAN-REVIEW', () => {
  const { sandbox, phaseDir } = _setupSandbox('fail-fail');
  _runLoop(sandbox, (_sbx) => {

    

    

  });
  assert.ok(fs.existsSync(path.join(phaseDir, '05-01-PLAN.md')),
    'PLAN.md must survive commit-with-warnings path');
  const review = fs.readFileSync(path.join(phaseDir, '05-PLAN-REVIEW.md'), 'utf-8');
  const iterHeaders = review.match(/^## Iteration \d+ - /gm) || [];
  assert.equal(iterHeaders.length, 2);
});

test('E2E-5: append-only invariant — iter-1 bytes are byte-identical prefix of iter-2 bytes', () => {
  const { sandbox, phaseDir } = _setupSandbox('fail-fail');
  const reviewPath = path.join(phaseDir, '05-PLAN-REVIEW.md');

  stubPlanner.plan(sandbox, 5, 'initial', 1);
  const v1 = stubChecker.check(sandbox, 1);
  const v1Path = _writeVerdict(sandbox, 1, v1);
  planPhase.run(['plan-review-append', '5', '1', v1Path], { cwd: sandbox, stdout: _cap().stub });
  const afterIter1 = fs.readFileSync(reviewPath, 'utf-8');

  stubPlanner.plan(sandbox, 5, 'revise', 2);
  const v2 = stubChecker.check(sandbox, 2);
  const v2Path = _writeVerdict(sandbox, 2, v2);
  planPhase.run(['plan-review-append', '5', '2', v2Path], { cwd: sandbox, stdout: _cap().stub });
  const afterIter2 = fs.readFileSync(reviewPath, 'utf-8');

  assert.ok(afterIter2.startsWith(afterIter1),
    'append-only invariant: iter-1 must be a byte-identical prefix of iter-2');
  assert.ok(afterIter2.length > afterIter1.length);
});

test('E2E-6: promote-check — linear plan returns promote:false, parallel plan returns promote:true', () => {
  const { sandbox, phaseDir } = _setupSandbox('pass');

  stubPlanner.plan(sandbox, 5, 'initial', 1);
  const cap1 = _cap();
  planPhase.run(['plan-phase-promote-check', '5'], { cwd: sandbox, stdout: cap1.stub });
  const decision1 = JSON.parse(cap1.get().trim());
  assert.equal(decision1.promote, false);

  const parallelPlan = [
    '---', 'phase: "5"', 'plan: "05-01"', '---',
    '',
    '<tasks>',
    '<task id="T01" wave="1" tier="sonnet" depends_on="[]">a</task>',
    '<task id="T02" wave="1" tier="sonnet" depends_on="[]">b</task>',
    '<task id="T03" wave="2" tier="opus" depends_on="[T01, T02]">c</task>',
    '</tasks>',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(phaseDir, '05-01-PLAN.md'), parallelPlan, 'utf-8');

  const cap2 = _cap();
  planPhase.run(['plan-phase-promote-check', '5'], { cwd: sandbox, stdout: cap2.stub });
  const decision2 = JSON.parse(cap2.get().trim());
  assert.equal(decision2.promote, true);
  assert.ok(decision2.triggers.includes('parallelism'));
});
