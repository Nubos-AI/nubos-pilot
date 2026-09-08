'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loop = require('./nubosloop.cjs');
const checkpoint = require('./checkpoint.cjs');

function _mkRoot() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'np-skill-audit-'));
  fs.mkdirSync(path.join(r, '.nubos-pilot', 'checkpoints'), { recursive: true });
  fs.writeFileSync(
    path.join(r, '.nubos-pilot', 'STATE.md'),
    '---\nschema_version: 2\ncurrent_phase: null\ncurrent_plan: null\ncurrent_task: null\n---\n',
    'utf-8',
  );
  return r;
}
const TID = 'M001-S001-T0001';
function _nubosloop(r) { return (checkpoint.readCheckpoint(TID, r) || {}).nubosloop || {}; }

test('SA-1: expected-but-unacked skill → skill-bar-unconsulted finding', () => {
  const r = _mkRoot();
  try {
    checkpoint.startTask({ id: TID }, r);
    loop.recordExpectedSkills(TID, ['np-secure-code-review', 'np-api-design'], r);
    loop.recordSkillEvidence(TID, 'np-api-design', r); // only one acked
    const findings = loop.skillFindingsFromState(_nubosloop(r), 1, TID);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].category, 'skill-bar-unconsulted');
    assert.deepEqual(findings[0].raw.missing_skills, ['np-secure-code-review']);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('SA-2: all expected skills acked → no finding', () => {
  const r = _mkRoot();
  try {
    checkpoint.startTask({ id: TID }, r);
    loop.recordExpectedSkills(TID, ['np-api-design'], r);
    loop.recordSkillEvidence(TID, 'np-api-design', r);
    assert.equal(loop.skillFindingsFromState(_nubosloop(r), 1, TID).length, 0);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('SA-3: no expected skills → no finding (skill block was correctly omitted)', () => {
  const r = _mkRoot();
  try {
    checkpoint.startTask({ id: TID }, r);
    assert.equal(loop.skillFindingsFromState(_nubosloop(r), 1, TID).length, 0);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('SA-4: ack tolerates a SKILL.md path, not just a bare name', () => {
  const r = _mkRoot();
  try {
    checkpoint.startTask({ id: TID }, r);
    loop.recordExpectedSkills(TID, ['np-encryption'], r);
    loop.recordSkillEvidence(TID, '.claude/skills/np-encryption/SKILL.md', r);
    assert.equal(loop.skillFindingsFromState(_nubosloop(r), 1, TID).length, 0);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('SA-5: routed round is not re-emitted (anti-spurious-loop)', () => {
  const r = _mkRoot();
  try {
    checkpoint.startTask({ id: TID }, r);
    loop.recordExpectedSkills(TID, ['np-secure-code-review'], r);
    assert.equal(loop.skillFindingsFromState(_nubosloop(r), 1, TID).length, 1);
    // simulate the loop marking round 1 routed
    checkpoint.mergeCheckpoint(TID, (cur) => {
      const prev = (cur && cur.nubosloop) || {};
      return { nubosloop: Object.assign({}, prev, { skill_routed_rounds: [1] }) };
    }, r);
    assert.equal(loop.skillFindingsFromState(_nubosloop(r), 1, TID).length, 0);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('SA-6: a skill finding routes to executor, never stuck (ROUTE_TABLE wired)', () => {
  const r = _mkRoot();
  try {
    checkpoint.startTask({ id: TID }, r);
    loop.recordExpectedSkills(TID, ['np-secure-code-review'], r);
    const findings = loop.skillFindingsFromState(_nubosloop(r), 1, TID);
    const evalRes = loop.evaluateLoop({ round: 1 }, [], { maxRounds: 3, auditFindings: findings });
    assert.equal(evalRes.next_action, 'executor');
    assert.equal(evalRes.stuck, false);
    // and the merged finding kept its category (not downgraded to unknown→stuck)
    assert.ok(evalRes.findings.some((f) => f.category === 'skill-bar-unconsulted' && f.route === 'executor'));
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('SA-7: markSkillFindingsRoutedInArray is idempotent', () => {
  assert.deepEqual(loop.markSkillFindingsRoutedInArray([], 1), [1]);
  assert.deepEqual(loop.markSkillFindingsRoutedInArray([1], 1), [1]);
  assert.deepEqual(loop.markSkillFindingsRoutedInArray([1], 2), [1, 2]);
});
