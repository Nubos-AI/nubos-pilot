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
    loop.recordSkillEvidence(TID, 'np-unlazy', r, 'np-executor');
    loop.recordSkillEvidence(TID, 'np-api-design', r, 'np-executor');
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
    loop.recordSkillEvidence(TID, 'np-unlazy', r, 'np-executor');
    loop.recordSkillEvidence(TID, 'np-api-design', r, 'np-executor');
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
    loop.recordSkillEvidence(TID, '.claude/skills/np-unlazy/SKILL.md', r, 'np-executor');
    loop.recordSkillEvidence(TID, '.claude/skills/np-encryption/SKILL.md', r, 'np-executor');
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

test('SA-8: np-unlazy is expected alongside every non-empty injected skill set', () => {
  const r = _mkRoot();
  try {
    checkpoint.startTask({ id: TID }, r);
    const res = loop.recordExpectedSkills(TID, ['np-api-design'], r);
    assert.deepEqual(res.expected, ['np-unlazy', 'np-api-design']);
    loop.recordSkillEvidence(TID, 'np-api-design', r, 'np-executor');
    const findings = loop.skillFindingsFromState(_nubosloop(r), 1, TID);
    assert.equal(findings.length, 1);
    assert.deepEqual(findings[0].raw.missing_skills, ['np-unlazy']);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('SA-9: an explicit np-unlazy in the injected set is not duplicated', () => {
  const r = _mkRoot();
  try {
    checkpoint.startTask({ id: TID }, r);
    const res = loop.recordExpectedSkills(TID, ['np-api-design', 'np-unlazy'], r);
    assert.deepEqual(res.expected, ['np-unlazy', 'np-api-design']);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('SA-10: withMandatorySkillExpectation adds the mandatory set once per round', () => {
  assert.deepEqual(loop.MANDATORY_SKILLS, ['np-unlazy']);
  const r1 = loop.withMandatorySkillExpectation(undefined, 1);
  assert.equal(r1.length, 1);
  assert.deepEqual(r1[0].skills, ['np-unlazy']);
  assert.equal(r1[0].round, 1);
  assert.equal(r1[0].source, 'mandatory');
  assert.equal(loop.withMandatorySkillExpectation(r1, 1).length, 1);
  const r2 = loop.withMandatorySkillExpectation(r1, 2);
  assert.equal(r2.length, 2);
  assert.equal(r2[1].round, 2);
  assert.deepEqual(loop.withMandatorySkillExpectation([], 0), []);
  const explicit = [{ round: 3, skills: ['np-unlazy', 'np-api-design'] }];
  assert.equal(loop.withMandatorySkillExpectation(explicit, 3).length, 1);
});

test('SA-11: mandatory expectation without an ack yields a finding; the ack clears it', () => {
  const state = { skill_expect: loop.withMandatorySkillExpectation([], 1) };
  const findings = loop.skillFindingsFromState(state, 1, TID);
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].raw.missing_skills, ['np-unlazy']);
  state.skill_evidence = [{ round: 1, skill: 'np-unlazy', agent: 'np-executor' }];
  assert.equal(loop.skillFindingsFromState(state, 1, TID).length, 0);
});

test('SA-12: an ack from a role other than executor or build-fixer is not recorded', () => {
  const r = _mkRoot();
  try {
    checkpoint.startTask({ id: TID }, r);
    assert.equal(loop.recordSkillEvidence(TID, 'np-unlazy', r, 'np-critic'), null);
    assert.equal(loop.recordSkillEvidence(TID, 'np-unlazy', r), null);
    assert.equal(_nubosloop(r).skill_evidence, undefined);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('SA-13: evidence without an eligible agent does not clear the finding', () => {
  const state = {
    skill_expect: [{ round: 1, skills: ['np-unlazy'] }],
    skill_evidence: [{ round: 1, skill: 'np-unlazy' }, { round: 1, skill: 'np-unlazy', agent: 'np-critic' }],
  };
  assert.equal(loop.skillFindingsFromState(state, 1, TID).length, 1);
  state.skill_evidence.push({ round: 1, skill: 'np-unlazy', agent: 'np-build-fixer' });
  assert.equal(loop.skillFindingsFromState(state, 1, TID).length, 0);
});

test('SA-14: a runtime without a skill directory expects no skills', () => {
  const r = _mkRoot();
  try {
    fs.writeFileSync(path.join(r, '.nubos-pilot', 'config.json'), JSON.stringify({ runtime: 'gemini' }));
    checkpoint.startTask({ id: TID }, r);
    assert.deepEqual(loop.mandatorySkillsFor(r), []);
    assert.deepEqual(loop.recordExpectedSkills(TID, ['np-unlazy', 'np-api-design'], r).expected, []);
    assert.deepEqual(loop.withMandatorySkillExpectation([], 1, loop.mandatorySkillsFor(r)), []);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('SA-15: runtimes with a skill directory keep the mandatory skill', () => {
  for (const runtime of ['claude', 'codex']) {
    const r = _mkRoot();
    try {
      fs.writeFileSync(path.join(r, '.nubos-pilot', 'config.json'), JSON.stringify({ runtime }));
      assert.deepEqual(Array.from(loop.mandatorySkillsFor(r)), ['np-unlazy']);
    } finally { fs.rmSync(r, { recursive: true, force: true }); }
  }
});
