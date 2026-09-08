'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const sc = require('./slice-conditions.cjs');
const schema = require('./roadmap-schema.cjs');

function _code(code) {
  return (err) => err && err.name === 'NubosPilotError' && err.code === code;
}

// ------------------------------------------------------------- detection

test('SC-1: hasConditionalEdges finds a when anywhere in the document', () => {
  assert.equal(sc.hasConditionalEdges(null), false);
  assert.equal(sc.hasConditionalEdges({}), false);
  assert.equal(sc.hasConditionalEdges({ milestones: [] }), false);
  assert.equal(sc.hasConditionalEdges({ milestones: [{ slices: [{ id: 'S001' }] }] }), false);
  assert.equal(
    sc.hasConditionalEdges({ milestones: [{ slices: [{ id: 'S001', when: { slice: 'S002', status: 'done' } }] }] }),
    true,
  );
});

test('SC-2: an explicitly null when is not a condition', () => {
  // A YAML author writing `when:` with no value must not accidentally push the
  // file to v3 and lock out older installs for nothing.
  assert.equal(sc.hasConditionalEdges({ milestones: [{ slices: [{ id: 'S001', when: null }] }] }), false);
});

// -------------------------------------------------------------- normalize

test('SC-3: a bare object is a single-term all_of', () => {
  const c = sc.normalizeCondition({ slice: 'S001', status: 'done' });
  assert.equal(c.kind, 'all_of');
  assert.deepEqual(c.terms, [{ slice: 'S001', op: 'status', value: 'done' }]);
});

test('SC-4: a bare list is shorthand for all_of', () => {
  const c = sc.normalizeCondition([
    { slice: 'S001', status: 'done' },
    { slice: 'S002', status: 'done' },
  ]);
  assert.equal(c.kind, 'all_of');
  assert.equal(c.terms.length, 2);
});

test('SC-5: explicit all_of and any_of are honoured', () => {
  assert.equal(sc.normalizeCondition({ all_of: [{ slice: 'S001', status: 'done' }] }).kind, 'all_of');
  assert.equal(sc.normalizeCondition({ any_of: [{ slice: 'S001', status: 'done' }] }).kind, 'any_of');
});

test('SC-6: an empty combinator list is refused', () => {
  assert.throws(() => sc.normalizeCondition({ all_of: [] }), _code('slice-condition-empty-combinator'));
  assert.throws(() => sc.normalizeCondition({ any_of: 'S001' }), _code('slice-condition-empty-combinator'));
});

test('SC-7: mixing combinators in one node is refused — nesting must be explicit', () => {
  assert.throws(
    () => sc.normalizeCondition({
      all_of: [{ slice: 'S001', status: 'done' }],
      any_of: [{ slice: 'S002', status: 'done' }],
    }),
    _code('slice-condition-multiple-combinators'),
  );
});

test('SC-8: a term must name a slice as S<NNN>', () => {
  for (const bad of [undefined, '', 'S1', 'M001-S001', 'slice one', 42]) {
    assert.throws(
      () => sc.normalizeCondition({ slice: bad, status: 'done' }),
      _code('slice-condition-bad-slice-ref'),
    );
  }
});

test('SC-9: a term needs exactly one operator', () => {
  assert.throws(() => sc.normalizeCondition({ slice: 'S001' }), _code('slice-condition-no-operator'));
  assert.throws(
    () => sc.normalizeCondition({ slice: 'S001', status: 'done', status_not: 'done' }),
    _code('slice-condition-multiple-operators'),
  );
});

test('SC-10: an operator value must be a non-empty status string', () => {
  assert.throws(() => sc.normalizeCondition({ slice: 'S001', status: '' }), _code('slice-condition-bad-operator-value'));
  assert.throws(() => sc.normalizeCondition({ slice: 'S001', status: 7 }), _code('slice-condition-bad-operator-value'));
});

test('SC-11: a non-object condition is refused', () => {
  assert.throws(() => sc.normalizeCondition('S001'), _code('slice-condition-not-object'));
  assert.throws(() => sc.normalizeCondition(42), _code('slice-condition-not-object'));
});

// --------------------------------------------------------------- evaluate

test('SC-12: no condition means run', () => {
  assert.equal(sc.evaluate(undefined, {}).decision, 'run');
  assert.equal(sc.evaluate(null, {}).decision, 'run');
});

test('SC-13: status satisfied runs; status contradicted by a finished slice skips', () => {
  assert.equal(sc.evaluate({ slice: 'S001', status: 'done' }, { S001: 'done' }).decision, 'run');
  // S001 is done, so it will never be 'pending' — the condition is settled false.
  assert.equal(sc.evaluate({ slice: 'S001', status: 'pending' }, { S001: 'done' }).decision, 'skip');
});

test('SC-14: an unfinished referenced slice makes the condition wait, not skip', () => {
  // The bug this prevents: collapsing wait into skip permanently drops a slice
  // whose predecessor merely has not finished yet.
  assert.equal(sc.evaluate({ slice: 'S001', status: 'done' }, { S001: 'pending' }).decision, 'wait');
  assert.equal(sc.evaluate({ slice: 'S001', status: 'done' }, { S001: 'in-progress' }).decision, 'wait');
  assert.equal(sc.evaluate({ slice: 'S001', status: 'done' }, { S001: null }).decision, 'wait');
});

test('SC-15: status_not waits until the referenced slice settles', () => {
  assert.equal(sc.evaluate({ slice: 'S001', status_not: 'done' }, { S001: 'pending' }).decision, 'wait');
  assert.equal(sc.evaluate({ slice: 'S001', status_not: 'done' }, { S001: 'done' }).decision, 'skip');
});

test('SC-16: an unresolvable reference throws — it is never treated as satisfied', () => {
  // A gate that opens when it breaks is not a gate.
  assert.throws(
    () => sc.evaluate({ slice: 'S099', status: 'done' }, { S001: 'done' }),
    _code('slice-condition-unknown-slice'),
  );
});

test('SC-17: all_of reports a definite skip over an undecided term', () => {
  const r = sc.evaluate(
    [{ slice: 'S001', status: 'pending' }, { slice: 'S002', status: 'done' }],
    { S001: 'done', S002: 'pending' },
  );
  // No later resolution can rescue an AND that already has a false conjunct.
  assert.equal(r.decision, 'skip');
  assert.match(r.reason, /S001/);
});

test('SC-18: all_of waits while any term is undecided and none has failed', () => {
  const r = sc.evaluate(
    [{ slice: 'S001', status: 'done' }, { slice: 'S002', status: 'done' }],
    { S001: 'done', S002: 'in-progress' },
  );
  assert.equal(r.decision, 'wait');
});

test('SC-19: all_of runs only when every term holds', () => {
  const r = sc.evaluate(
    [{ slice: 'S001', status: 'done' }, { slice: 'S002', status: 'done' }],
    { S001: 'done', S002: 'done' },
  );
  assert.equal(r.decision, 'run');
});

test('SC-20: any_of runs on the first satisfied term', () => {
  const r = sc.evaluate(
    { any_of: [{ slice: 'S001', status: 'done' }, { slice: 'S002', status: 'done' }] },
    { S001: 'pending', S002: 'done' },
  );
  assert.equal(r.decision, 'run');
});

test('SC-21: any_of waits rather than failing while a term could still become true', () => {
  const r = sc.evaluate(
    { any_of: [{ slice: 'S001', status: 'done' }, { slice: 'S002', status: 'done' }] },
    { S001: 'pending', S002: 'done-not' },
  );
  assert.equal(r.decision, 'wait');
});

test('SC-22: any_of skips only once no term can hold', () => {
  const r = sc.evaluate(
    { any_of: [{ slice: 'S001', status: 'pending' }, { slice: 'S002', status: 'pending' }] },
    { S001: 'done', S002: 'done' },
  );
  assert.equal(r.decision, 'skip');
});

// ----------------------------------------------------------- planMilestone

test('SC-23: planMilestone decides every slice and buckets the results', () => {
  const plan = sc.planMilestone({
    id: 'M001',
    slices: [
      { id: 'S001', status: 'done' },
      { id: 'S002', status: 'pending', when: { slice: 'S001', status: 'done' } },
      { id: 'S003', status: 'pending', when: { slice: 'S001', status: 'pending' } },
      { id: 'S004', status: 'pending', when: { slice: 'S002', status: 'done' } },
    ],
  });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.runnable, ['S001', 'S002']);
  assert.deepEqual(plan.skipped, ['S003']);
  assert.deepEqual(plan.waiting, ['S004']);
});

test('SC-24: an unconditional slice is marked as such', () => {
  const plan = sc.planMilestone({ id: 'M001', slices: [{ id: 'S001', status: 'pending' }] });
  assert.equal(plan.slices[0].conditional, false);
  assert.equal(plan.slices[0].decision, 'run');
});

test('SC-25: a broken condition yields decision error and blocks the milestone', () => {
  const plan = sc.planMilestone({
    id: 'M001',
    slices: [{ id: 'S001', status: 'pending', when: { slice: 'S099', status: 'done' } }],
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.errors.length, 1);
  assert.equal(plan.slices[0].decision, 'error');
  // Neither runnable nor skipped: the milestone is not executable until fixed.
  assert.deepEqual(plan.runnable, []);
  assert.deepEqual(plan.skipped, []);
});

test('SC-26: planMilestone tolerates malformed nodes', () => {
  assert.doesNotThrow(() => sc.planMilestone(null));
  assert.doesNotThrow(() => sc.planMilestone({ slices: [null, {}, { id: '' }] }));
  assert.equal(sc.planMilestone({ slices: [null, {}] }).slices.length, 0);
});

// ------------------------------------------------------------------- lint

test('SC-27: a clean document lints clean', () => {
  const res = sc.lintDocument({
    milestones: [{
      id: 'M001',
      slices: [{ id: 'S001' }, { id: 'S002', when: { slice: 'S001', status: 'done' } }],
    }],
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.findings, []);
});

test('SC-28: a reference to a slice outside the milestone is a finding', () => {
  // Cross-milestone ordering is what the milestone depends_on field is for; a
  // slice condition is evaluated inside one milestone and cannot see beyond it.
  const res = sc.lintDocument({
    milestones: [
      { id: 'M001', slices: [{ id: 'S001' }] },
      { id: 'M002', slices: [{ id: 'S001', when: { slice: 'S002', status: 'done' } }] },
    ],
  });
  assert.equal(res.ok, false);
  assert.equal(res.findings[0].code, 'slice-condition-unknown-slice');
  assert.match(res.findings[0].message, /depends_on/);
});

test('SC-29: a self-reference is a finding — it can never resolve', () => {
  const res = sc.lintDocument({
    milestones: [{ id: 'M001', slices: [{ id: 'S001', when: { slice: 'S001', status: 'done' } }] }],
  });
  assert.ok(res.findings.some((f) => f.code === 'slice-condition-self-reference'));
});

test('SC-30: a conditional cycle is reported once, not once per entry point', () => {
  const res = sc.lintDocument({
    milestones: [{
      id: 'M001',
      slices: [
        { id: 'S001', when: { slice: 'S002', status: 'done' } },
        { id: 'S002', when: { slice: 'S003', status: 'done' } },
        { id: 'S003', when: { slice: 'S001', status: 'done' } },
      ],
    }],
  });
  const cycles = res.findings.filter((f) => f.code === 'slice-condition-cycle');
  assert.equal(cycles.length, 1, 'got: ' + JSON.stringify(res.findings, null, 2));
  assert.match(cycles[0].message, /S001 → S002 → S003 → S001|S001 → S003 → S002 → S001/);
});

test('SC-31: a malformed condition is reported by the linter rather than thrown', () => {
  const res = sc.lintDocument({
    milestones: [{ id: 'M001', slices: [{ id: 'S001', when: { slice: 'S001' } }] }],
  });
  assert.equal(res.ok, false);
  assert.ok(res.findings.some((f) => f.code === 'slice-condition-no-operator'));
});

test('SC-32: lintDocument tolerates an absent or malformed document', () => {
  assert.equal(sc.lintDocument(null).ok, true);
  assert.equal(sc.lintDocument({ milestones: [null, {}] }).ok, true);
});

// --------------------------------------------------------- schema coupling

test('SC-33: a document with conditions requires schema_version 3', () => {
  const conditional = { schema_version: 3, milestones: [{ id: 'M001', slices: [{ id: 'S001', when: { slice: 'S002', status: 'done' } }, { id: 'S002' }] }] };
  const plain = { schema_version: 2, milestones: [{ id: 'M001', slices: [{ id: 'S001' }] }] };
  assert.equal(schema.requiredSchemaVersion(conditional), 3);
  assert.equal(schema.requiredSchemaVersion(plain), 2);
});

test('SC-34: the required version drops back to 2 when the last condition is removed', () => {
  // Bidirectional on purpose: the file becomes readable by older installs again,
  // and honestly so, because there is nothing left for them to mishandle.
  const doc = { schema_version: 3, milestones: [{ id: 'M001', slices: [{ id: 'S001' }] }] };
  assert.equal(schema.requiredSchemaVersion(doc), 2);
});

test('SC-35: conditions declared under an older version are refused', () => {
  // This is the file an older install would read successfully and then execute
  // wrongly, running a slice the plan gated.
  for (const version of [1, 2]) {
    assert.throws(
      () => schema.validateConditionalVersion({
        schema_version: version,
        milestones: [{ id: 'M001', slices: [{ id: 'S001', when: { slice: 'S002', status: 'done' } }] }],
      }, '/tmp/roadmap.yaml'),
      _code('roadmap-conditional-requires-v3'),
    );
  }
});

test('SC-36: a v3 document with conditions passes, and a v3 document without them also passes', () => {
  assert.doesNotThrow(() => schema.validateConditionalVersion({
    schema_version: 3,
    milestones: [{ id: 'M001', slices: [{ id: 'S001', when: { slice: 'S002', status: 'done' } }] }],
  }, '/tmp/roadmap.yaml'));
  assert.doesNotThrow(() => schema.validateConditionalVersion({
    schema_version: 3, milestones: [{ id: 'M001', slices: [{ id: 'S001' }] }],
  }, '/tmp/roadmap.yaml'));
});

test('SC-37: 3 is in the supported set and CURRENT stays 2', () => {
  assert.deepEqual(schema.SUPPORTED_SCHEMA_VERSIONS, [1, 2, 3]);
  assert.equal(schema.CURRENT_SCHEMA_VERSION, 2);
  assert.equal(schema.CONDITIONAL_SCHEMA_VERSION, 3);
});

test('SC-38: an empty `when` list is refused rather than read as satisfied', () => {
  assert.throws(
    () => sc.normalizeCondition([], { milestone: 'M001', slice: 'S002' }),
    _code('slice-condition-empty-condition'),
  );
  const plan = sc.planMilestone({
    id: 'M001',
    slices: [{ id: 'S001', status: 'done' }, { id: 'S002', status: 'pending', when: [] }],
  });
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.runnable, ['S001']);
  assert.equal(plan.slices[1].decision, 'error');
});

test('SC-39: a skipped slice settles, so a dependent condition resolves instead of waiting forever', () => {
  const plan = sc.planMilestone({
    id: 'M001',
    slices: [
      { id: 'S001', status: 'done' },
      { id: 'S002', status: 'pending', when: { slice: 'S001', status_not: 'done' } },
      { id: 'S003', status: 'pending', when: { slice: 'S002', status: 'done' } },
    ],
  });
  assert.deepEqual(plan.skipped, ['S002', 'S003']);
  assert.deepEqual(plan.waiting, []);
  assert.equal(plan.stalled, false);
});

test('SC-40: a skipped predecessor satisfies a status_not condition on it', () => {
  const plan = sc.planMilestone({
    id: 'M001',
    slices: [
      { id: 'S001', status: 'done' },
      { id: 'S002', status: 'pending', when: { slice: 'S001', status_not: 'done' } },
      { id: 'S003', status: 'pending', when: { slice: 'S002', status_not: 'done' } },
    ],
  });
  assert.deepEqual(plan.skipped, ['S002']);
  assert.deepEqual(plan.runnable, ['S001', 'S003']);
});

test('SC-41: finalized is threaded, not inferred from the persisted status', () => {
  const statuses = { S001: 'pending' };
  assert.equal(sc.evaluate({ slice: 'S001', status: 'done' }, statuses).decision, 'wait');
  assert.equal(
    sc.evaluate({ slice: 'S001', status: 'done' }, statuses, { finalized: ['S001'] }).decision,
    'skip',
  );
});

test('SC-42: waiting with nothing runnable and nothing in flight is reported as a stall', () => {
  const plan = sc.planMilestone({
    id: 'M001',
    slices: [
      { id: 'S001', status: 'pending', when: { slice: 'S002', status: 'done' } },
      { id: 'S002', status: 'pending', when: { slice: 'S001', status: 'done' } },
    ],
  });
  assert.deepEqual(plan.runnable, []);
  assert.deepEqual(plan.waiting, ['S001', 'S002']);
  assert.equal(plan.stalled, true);
  assert.match(plan.stall_reason, /no future re-evaluation can change the answer/);
});

test('SC-43: a normal wave in progress is not a stall', () => {
  const inFlight = sc.planMilestone({
    id: 'M001',
    slices: [
      { id: 'S001', status: 'in-progress' },
      { id: 'S002', status: 'pending', when: { slice: 'S001', status: 'done' } },
    ],
  });
  assert.deepEqual(inFlight.waiting, ['S002']);
  assert.equal(inFlight.stalled, false);

  const firstWave = sc.planMilestone({
    id: 'M001',
    slices: [
      { id: 'S001', status: 'pending' },
      { id: 'S002', status: 'pending', when: { slice: 'S001', status: 'done' } },
    ],
  });
  assert.deepEqual(firstWave.runnable, ['S001']);
  assert.equal(firstWave.stalled, false);
});

test('SC-44: a skip is threaded backwards too, not only to later slices', () => {
  // S002 is declared before the slice it depends on. A single evaluation pass in
  // declaration order decides S002 while S003 is still pending and never revisits
  // it, so S002 waits forever on a slice that was skipped in the same call.
  const plan = sc.planMilestone({
    id: 'M001',
    slices: [
      { id: 'S001', status: 'done' },
      { id: 'S002', status: 'pending', when: { slice: 'S003', status: 'done' } },
      { id: 'S003', status: 'pending', when: { slice: 'S001', status_not: 'done' } },
    ],
  });
  assert.deepEqual(plan.skipped, ['S002', 'S003']);
  assert.deepEqual(plan.waiting, []);
});

test('SC-45: a skip can unblock a later slice, not only skip it', () => {
  const plan = sc.planMilestone({
    id: 'M001',
    slices: [
      { id: 'S001', status: 'done' },
      { id: 'S002', status: 'pending', when: { slice: 'S003', status_not: 'done' } },
      { id: 'S003', status: 'pending', when: { slice: 'S001', status_not: 'done' } },
    ],
  });
  assert.deepEqual(plan.skipped, ['S003']);
  assert.deepEqual(plan.runnable, ['S001', 'S002']);
  assert.equal(plan.stalled, false);
});

test('SC-46: a completed slice is not progress, so it cannot mask a stall', () => {
  // S001 is `done` and unconditional, so its decision stays `run` — but there is
  // nothing left to dispatch, and counting it as runnable let the deadlock below
  // exit 0 and hand the orchestrator a loop with no exit condition.
  const plan = sc.planMilestone({
    id: 'M001',
    slices: [
      { id: 'S001', status: 'done' },
      { id: 'S002', status: 'pending', when: { slice: 'S003', status: 'done' } },
      { id: 'S003', status: 'pending', when: { slice: 'S002', status: 'done' } },
    ],
  });
  assert.deepEqual(plan.runnable, ['S001']);
  assert.deepEqual(plan.waiting, ['S002', 'S003']);
  assert.equal(plan.stalled, true);
});

test('SC-47: a fully finished milestone is not a stall', () => {
  const plan = sc.planMilestone({
    id: 'M001',
    slices: [
      { id: 'S001', status: 'done' },
      { id: 'S002', status: 'done', when: { slice: 'S001', status: 'done' } },
    ],
  });
  assert.deepEqual(plan.waiting, []);
  assert.equal(plan.stalled, false);
  assert.equal(plan.ok, true);
});
