const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

const PLAN_PHASE = fs.readFileSync(path.join(REPO_ROOT, 'workflows', 'plan-phase.md'), 'utf-8');
const PLANNER = fs.readFileSync(path.join(REPO_ROOT, 'agents', 'np-planner.md'), 'utf-8');
const PLAN_CHECKER = fs.readFileSync(path.join(REPO_ROOT, 'agents', 'np-plan-checker.md'), 'utf-8');

function _actionContract(body, marker) {
  const start = body.indexOf(marker);
  assert.notEqual(start, -1, 'ACTION CONTRACT marker not found: ' + marker);
  const end = body.indexOf('ACTION CONTRACT', start + marker.length);
  return body.slice(start, end === -1 ? body.length : end);
}

test('PPI-1: plan-phase builds an evidence block from the init payload', () => {
  assert.match(PLAN_PHASE, /milestone_research_path/,
    'plan-phase must read milestone_research_path from `init plan-milestone init`');
  assert.match(PLAN_PHASE, /milestone_architecture_path/);
  assert.match(PLAN_PHASE, /has_research/);
  assert.match(PLAN_PHASE, /FILES_TO_READ=/,
    'the evidence block must be assembled once and shared by both spawns');
});

test('PPI-2: both the planner and the plan-checker spawn receive <files_to_read>', () => {
  for (const marker of ['ACTION CONTRACT — Step 2a: Spawn np-planner',
    'ACTION CONTRACT — Step 2b: Spawn np-plan-checker']) {
    const contract = _actionContract(PLAN_PHASE, marker);
    assert.match(contract, /<files_to_read>\$FILES_TO_READ<\/files_to_read>/,
      marker + ' must name the evidence block — an agent reads only what its prompt names, '
      + 'and a RESEARCH.md that is not in the block is a research swarm spent for nothing');
  }
});

test('PPI-3: the off-host branches render the same evidence block', () => {
  const offhostComments = PLAN_PHASE.split('\n')
    .filter((l) => l.includes('render the SAME'))
    .join('\n');
  const occurrences = (offhostComments.match(/files_to_read/g) || []).length;
  assert.ok(occurrences >= 2,
    'both spawn-offhost branches must state that files_to_read is part of the rendered prompt, '
    + 'otherwise the off-host path silently drops the evidence (got ' + occurrences + ')');
});

test('PPI-4: agent docs cite RESEARCH.md at milestone level, never as a slice artefact', () => {
  for (const [name, body] of [['np-planner', PLANNER], ['np-plan-checker', PLAN_CHECKER]]) {
    assert.match(body, /M<NNN>-RESEARCH\.md/, name + ' must name the milestone-level RESEARCH.md');
    assert.equal(/S<NNN>-RESEARCH\.md/.test(body), false,
      name + ' still references a slice-level S<NNN>-RESEARCH.md — nothing writes that path, '
      + 'so the reference reads as "research is optional and absent"');
  }
});

test('PPI-5: the contradiction gate is wired and cannot fall through', () => {
  assert.match(PLANNER, /## PLAN CONTRADICTION/,
    'np-planner must have a structured return for two colliding locked decisions');
  const gate = _actionContract(PLAN_PHASE, 'ACTION CONTRACT — Step 2a-bis: Contradiction gate');
  assert.match(gate, /PLAN CONTRADICTION/);
  assert.match(gate, /LOCKED_RESOLUTION=/, 'the chosen resolution must be fed back to the planner');
  assert.match(gate, /unrecognised answer/,
    'the gate must refuse to fall through — planning one side of a user-owned decision '
    + 'without the user choosing it is the failure this gate exists for');
});
