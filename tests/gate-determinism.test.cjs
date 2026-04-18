const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { computeNextStep } = require('../lib/next.cjs');
const { makeSandbox, seedRoadmapYaml, seedPhaseDir, cleanupAll } = require('./helpers/fixture.cjs');

afterEach(() => { cleanupAll(); });

function _roadmap() {
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
            goal: 'determinism-goal',
            depends_on: null,
            requirements: [],
            success_criteria: [],
            plans: [{ id: '01-01', title: '', complete: false }],
            status: 'pending',
          },
        ],
      },
    ],
  };
}

function _planMd() {
  return [
    '---',
    'phase: 1',
    'plan: "01-01"',
    'type: execute',
    'wave: 1',
    'depends_on: []',
    'files_modified: []',
    'autonomous: true',
    'must_haves: []',
    '---',
    '',
    '<objective>seed</objective>',
    '<tasks></tasks>',
    '<success_criteria></success_criteria>',
    '',
  ].join('\n');
}

function _taskMd(idSuffix, wave, deps) {
  return [
    '---',
    `id: 01-01-T${idSuffix}`,
    'status: pending',
    'tier: sonnet',
    'owner: np-executor',
    'phase: 1',
    'plan: "01-01"',
    'type: execute',
    `wave: ${wave}`,
    `depends_on: ${JSON.stringify(deps || [])}`,
    'files_modified: []',
    'autonomous: true',
    'must_haves:',
    '  truths:',
    '    - "stub"',
    '  artifacts: []',
    '  key_links: []',
    '---',
    '',
    `Task ${idSuffix} body.`,
    '',
  ].join('\n');
}

test('GD-1: computeNextStep is byte-identical across 100 iterations (rule 3, multiple pending tasks)', () => {
  const root = makeSandbox();
  seedRoadmapYaml(root, _roadmap());
  seedPhaseDir(root, 1, 'foo', {
    '01-CONTEXT.md': '# ctx\n',
    '01-01-PLAN.md': _planMd(),
    'tasks/01-01-T01.md': _taskMd('01', 1, []),
    'tasks/01-01-T02.md': _taskMd('02', 1, []),
    'tasks/01-01-T03.md': _taskMd('03', 2, ['01-01-T01']),
  });

  const first = computeNextStep(root);

  assert.equal(first.next_step.command, '/np:execute-phase 1');
  assert.ok(first.task && first.task.id);

  const firstSerialized = JSON.stringify(first);

  const iterations = 100;
  for (let i = 1; i < iterations; i++) {
    const cur = computeNextStep(root);
    assert.deepEqual(
      cur,
      first,
      `Iteration ${i} diverged from iteration 0`,
    );
    assert.equal(JSON.stringify(cur), firstSerialized, `Iteration ${i} byte-differs`);
  }
});

test('GD-2: determinism on rule-1 fresh sandbox (no roadmap) across 100 iterations', () => {
  const root = makeSandbox();
  const first = computeNextStep(root);
  for (let i = 1; i < 100; i++) {
    assert.deepEqual(computeNextStep(root), first);
  }
});
