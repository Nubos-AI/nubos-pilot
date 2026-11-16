'use strict';

// Conditional slice edges (ADR-0028).
//
// Until now a milestone's slice list was a fixed serial sequence: after
// plan-phase, every slice runs, in order, unconditionally. That is the right
// default and stays the default. What it cannot express is the case that shows up
// in real plans — a slice whose work only makes sense depending on how an earlier
// slice turned out. A migration-verification wave that only matters if the
// migration wave actually ran; a fallback wave that only matters if the preferred
// approach failed.
//
// The shape borrowed here is the Flows-vs-Crews split: autonomous delegation for
// the inside of a wave, deterministic branching for the order between waves. The
// waves stay deterministic — nubos-pilot's whole trust model is that the plan is
// a reviewable text file — so the condition is data in roadmap.yaml, evaluated by
// this module, never a judgement the executor makes at runtime.
//
// The safety property that drives every decision below: an unresolvable condition
// NEVER means "run". A condition referencing a slice that does not exist, or a
// malformed condition, is an error that stops the milestone. Defaulting to run
// would silently execute work the plan explicitly gated, and a gate that opens
// when it breaks is not a gate.
//
// Decisions are three-valued, not two:
//   run   — the condition holds; execute the slice
//   skip  — the condition cannot hold any more; the slice is permanently out
//   wait  — the condition is not decided yet; the referenced slice has not
//           reached a terminal state
// Collapsing `wait` into `skip` is the subtle bug this avoids: a slice whose
// predecessor is still in-progress is not a slice that should be skipped.

const { NubosPilotError } = require('./core.cjs');

const DECISIONS = Object.freeze(['run', 'skip', 'wait']);

// Slice statuses, from roadmap-schema. `done` is the only terminal one, which is
// why a not-yet-done slice makes a condition undecided rather than false.
const TERMINAL_SLICE_STATUSES = Object.freeze(['done']);

// The operators a condition may use. Deliberately small: each one has an
// unambiguous meaning against a slice status, and a bigger vocabulary would
// invite conditions nobody can review at a glance.
const OPERATORS = Object.freeze(['status', 'status_not']);

const COMBINATORS = Object.freeze(['all_of', 'any_of']);

const SLICE_REF_RE = /^S\d{3,}$/;

function _err(code, message, details) {
  return new NubosPilotError(code, message, details || {});
}

function _isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Does this roadmap document use conditional edges anywhere?
 *
 * Used to decide the required schema_version: a `when` changes execution
 * semantics, so a reader that does not understand it must refuse the file rather
 * than ignore the field and run a gated slice.
 */
function hasConditionalEdges(doc) {
  if (!doc || !Array.isArray(doc.milestones)) return false;
  for (const ms of doc.milestones) {
    if (!ms) continue;
    for (const sl of (Array.isArray(ms.slices) ? ms.slices : [])) {
      if (sl && sl.when !== undefined && sl.when !== null) return true;
    }
  }
  return false;
}

/**
 * Validate one condition node. Throws on the first defect.
 *
 * @param {*} when the raw `when` value from a slice
 * @param {object} [ctx] {slice, milestone} for error details
 * @returns {object} normalised {kind: 'all_of'|'any_of', terms: [{slice, op, value}]}
 */
function normalizeCondition(when, ctx) {
  const where = ctx || {};

  // A bare list is an AND. This is the common case ("after S001 is done and S002
  // is done") and giving it a shorthand keeps the explicit combinators for when
  // they are actually needed.
  if (Array.isArray(when)) {
    if (when.length === 0) {
      throw _err(
        'slice-condition-empty-condition',
        'A slice `when` must not be an empty list. An empty condition is refused rather than treated as '
        + 'satisfied — remove the `when` to make the slice unconditional, which says so explicitly.',
        Object.assign({ when }, where),
      );
    }
    return { kind: 'all_of', terms: when.map((t) => _normalizeTerm(t, where)) };
  }

  if (!_isPlainObject(when)) {
    throw _err(
      'slice-condition-not-object',
      'A slice `when` must be a condition object or a list of them (got ' + (when === null ? 'null' : typeof when) + ')',
      Object.assign({ when }, where),
    );
  }

  const combinator = COMBINATORS.find((c) => when[c] !== undefined);
  if (combinator) {
    const list = when[combinator];
    if (!Array.isArray(list) || list.length === 0) {
      throw _err(
        'slice-condition-empty-combinator',
        combinator + ' must be a non-empty list of conditions',
        Object.assign({ combinator }, where),
      );
    }
    const others = COMBINATORS.filter((c) => c !== combinator && when[c] !== undefined);
    if (others.length) {
      throw _err(
        'slice-condition-multiple-combinators',
        'A condition may use one of ' + COMBINATORS.join(' | ') + ', not several — nesting must be explicit',
        Object.assign({ found: [combinator, ...others] }, where),
      );
    }
    return { kind: combinator, terms: list.map((t) => _normalizeTerm(t, where)) };
  }

  return { kind: 'all_of', terms: [_normalizeTerm(when, where)] };
}

function _normalizeTerm(term, where) {
  if (!_isPlainObject(term)) {
    throw _err(
      'slice-condition-bad-term',
      'Each condition term must be an object naming a slice and an operator',
      Object.assign({ term }, where),
    );
  }
  const ref = term.slice;
  if (typeof ref !== 'string' || !SLICE_REF_RE.test(ref)) {
    throw _err(
      'slice-condition-bad-slice-ref',
      'A condition term must name a slice as S<NNN> (got ' + JSON.stringify(ref) + ')',
      Object.assign({ slice_ref: ref }, where),
    );
  }
  const ops = OPERATORS.filter((o) => term[o] !== undefined);
  if (ops.length === 0) {
    throw _err(
      'slice-condition-no-operator',
      'A condition term needs one of ' + OPERATORS.join(' | '),
      Object.assign({ term, allowed: OPERATORS }, where),
    );
  }
  if (ops.length > 1) {
    throw _err(
      'slice-condition-multiple-operators',
      'A condition term may use exactly one of ' + OPERATORS.join(' | ') + ' (got ' + ops.join(', ') + ')',
      Object.assign({ found: ops }, where),
    );
  }
  const op = ops[0];
  const value = term[op];
  if (typeof value !== 'string' || !value.trim()) {
    throw _err(
      'slice-condition-bad-operator-value',
      op + ' must be a non-empty status string',
      Object.assign({ op, value }, where),
    );
  }
  return { slice: ref, op, value: value.trim() };
}

/**
 * Evaluate one normalised term against the observed slice statuses.
 *
 * @param {object} term
 * @param {Map<string,string|null>} statuses local slice id -> status
 * @param {Set<string>} [finalized] slice ids whose status can no longer change
 * @returns {'run'|'skip'|'wait'}
 */
function _evaluateTerm(term, statuses, finalized) {
  if (!statuses.has(term.slice)) {
    // Not "skip", and emphatically not "run": the plan references something that
    // is not in the milestone, which is a defect the caller must surface.
    throw _err(
      'slice-condition-unknown-slice',
      'Condition references slice ' + term.slice + ', which this milestone does not declare. '
      + 'An unresolvable condition is never treated as satisfied — a gate that opens when it breaks is not a gate.',
      { slice_ref: term.slice, known: Array.from(statuses.keys()) },
    );
  }
  const actual = statuses.get(term.slice);
  const settled = (typeof actual === 'string' && TERMINAL_SLICE_STATUSES.includes(actual))
    || Boolean(finalized && finalized.has(term.slice));

  if (term.op === 'status') {
    if (actual === term.value) return 'run';
    // The referenced slice has not finished, so whether it will end in the
    // required status is still open.
    if (!settled) return 'wait';
    return 'skip';
  }
  // status_not
  if (!settled) return 'wait';
  return actual === term.value ? 'skip' : 'run';
}

/**
 * Evaluate a slice's condition.
 *
 * @param {*} when raw `when` value (null/undefined ⇒ unconditional)
 * @param {object} statusesByLocalId {S001: 'done', …}
 * @param {object} [ctx] {milestone, slice, finalized} — `finalized` is an iterable
 *   of slice ids whose status can no longer change (e.g. already skipped)
 * @returns {{decision: string, reason: string, terms: object[]}}
 */
function evaluate(when, statusesByLocalId, ctx) {
  if (when === undefined || when === null) {
    return { decision: 'run', reason: 'unconditional slice', terms: [] };
  }
  const cond = normalizeCondition(when, ctx);
  const statuses = new Map(Object.entries(statusesByLocalId || {}));
  const finalized = new Set((ctx && ctx.finalized) || []);

  const results = cond.terms.map((t) => ({ term: t, decision: _evaluateTerm(t, statuses, finalized) }));
  const describe = (r) => r.term.slice + ' ' + r.term.op + ' ' + r.term.value + ' → ' + r.decision;

  if (cond.kind === 'all_of') {
    // Order matters for the reported reason, not for the outcome: a definite skip
    // beats an undecided term, because no later resolution can rescue an AND that
    // already has a false conjunct.
    const skipped = results.find((r) => r.decision === 'skip');
    if (skipped) {
      return { decision: 'skip', reason: 'all_of failed: ' + describe(skipped), terms: cond.terms };
    }
    const waiting = results.find((r) => r.decision === 'wait');
    if (waiting) {
      return { decision: 'wait', reason: 'all_of undecided: ' + describe(waiting), terms: cond.terms };
    }
    return { decision: 'run', reason: 'all_of satisfied', terms: cond.terms };
  }

  // any_of: one satisfied term is enough, but an undecided term must not be read
  // as failure while it could still become true.
  const satisfied = results.find((r) => r.decision === 'run');
  if (satisfied) {
    return { decision: 'run', reason: 'any_of satisfied: ' + describe(satisfied), terms: cond.terms };
  }
  const waiting = results.find((r) => r.decision === 'wait');
  if (waiting) {
    return { decision: 'wait', reason: 'any_of undecided: ' + describe(waiting), terms: cond.terms };
  }
  return { decision: 'skip', reason: 'any_of exhausted, no term can hold', terms: cond.terms };
}

/**
 * Plan a whole milestone's slice sequence.
 *
 * Re-evaluates to a fixpoint rather than once in declaration order, so a
 * condition resolves against every slice this call decided to skip — including
 * one declared after it. A single pass only threads decisions backwards, which
 * leaves a slice gated on a later-skipped slice waiting on a status that will
 * never change. A skipped slice keeps its recorded status (usually `pending`) —
 * the decision is reported, not written — because this module is a pure
 * evaluator and persisting a status belongs to the workflow that acts on it.
 *
 * `stalled` reports waiting slices with no slice left to execute: nothing
 * runnable that is not already `done`, nothing in flight. No future
 * re-evaluation can change that answer, so the caller must refuse rather than
 * loop. A completed slice is still `run` — its gate holds — which is why the
 * check is against outstanding work rather than against `runnable`.
 *
 * @param {object} milestoneNode raw roadmap milestone node
 * @returns {{slices: object[], errors: object[], runnable: string[], skipped: string[], waiting: string[], stalled: boolean}}
 */
function planMilestone(milestoneNode) {
  const ms = milestoneNode || {};
  const declared = Array.isArray(ms.slices) ? ms.slices : [];
  const statuses = {};
  for (const sl of declared) {
    if (sl && typeof sl.id === 'string') {
      statuses[sl.id] = typeof sl.status === 'string' ? sl.status : null;
    }
  }

  const finalized = new Set();
  const evaluateAll = () => {
    const rows = [];
    const errs = [];
    for (const sl of declared) {
      if (!sl || typeof sl.id !== 'string' || !sl.id) continue;
      let result;
      try {
        result = evaluate(sl.when, statuses, { milestone: ms.id, slice: sl.id, finalized });
      } catch (err) {
        errs.push({
          slice: sl.id,
          code: (err && err.code) || 'slice-condition-error',
          message: (err && err.message) || String(err),
        });
        // A slice whose condition cannot be evaluated is neither run nor skipped:
        // the milestone is not executable until the plan is fixed.
        result = { decision: 'error', reason: (err && err.message) || String(err), terms: [] };
      }
      if (result.decision === 'skip') finalized.add(sl.id);
      rows.push({
        id: sl.id,
        status: statuses[sl.id],
        conditional: sl.when !== undefined && sl.when !== null,
        decision: result.decision,
        reason: result.reason,
      });
    }
    return { rows, errs };
  };

  // A decision only ever moves wait → run|skip as `finalized` grows, never back,
  // so each round that changes anything adds at least one id and the loop is
  // bounded by the slice count. The bound is asserted rather than assumed.
  let pass = null;
  for (let round = 0; round <= declared.length; round += 1) {
    const before = finalized.size;
    pass = evaluateAll();
    if (finalized.size === before) break;
  }

  const out = pass.rows;
  const errors = pass.errs;

  const runnable = out.filter((s) => s.decision === 'run').map((s) => s.id);
  const skipped = out.filter((s) => s.decision === 'skip').map((s) => s.id);
  const waiting = out.filter((s) => s.decision === 'wait').map((s) => s.id);
  // A `done` slice keeps decision `run` — its gate holds — but it is not work the
  // caller can dispatch, so counting it as progress is what let the stall check
  // pass on a milestone where nothing could move.
  const outstanding = out.filter((s) => s.decision === 'run' && s.status !== 'done');
  const inFlight = out.some((s) => s.status === 'in-progress');
  const stalled = waiting.length > 0 && outstanding.length === 0 && !inFlight && errors.length === 0;

  return {
    slices: out,
    errors,
    runnable,
    skipped,
    waiting,
    stalled,
    stall_reason: stalled
      ? 'Slices ' + waiting.join(', ') + ' are waiting, nothing is runnable and nothing is in progress, '
        + 'so no future re-evaluation can change the answer. Fix the conditions in roadmap.yaml — a slice '
        + 'that can never be decided must not be left to a loop that will never terminate.'
      : null,
    ok: errors.length === 0,
  };
}

/**
 * Static lint over the whole document: every condition parses, references a slice
 * declared in the same milestone, and does not reference itself or form a cycle.
 *
 * Cross-milestone references are rejected on purpose. A slice condition is
 * evaluated while executing one milestone, so a reference outside it would be
 * evaluated against statuses this evaluator does not have — and milestone-level
 * ordering already has `depends_on` for exactly that job.
 */
function lintDocument(doc) {
  const findings = [];
  const milestones = doc && Array.isArray(doc.milestones) ? doc.milestones : [];

  for (const ms of milestones) {
    if (!ms) continue;
    const slices = Array.isArray(ms.slices) ? ms.slices : [];
    const declared = new Set(slices.filter((s) => s && typeof s.id === 'string').map((s) => s.id));
    const deps = new Map();

    for (const sl of slices) {
      if (!sl || typeof sl.id !== 'string') continue;
      if (sl.when === undefined || sl.when === null) {
        deps.set(sl.id, []);
        continue;
      }
      let cond;
      try {
        cond = normalizeCondition(sl.when, { milestone: ms.id, slice: sl.id });
      } catch (err) {
        findings.push({
          milestone: ms.id, slice: sl.id,
          code: (err && err.code) || 'slice-condition-error',
          message: (err && err.message) || String(err),
        });
        deps.set(sl.id, []);
        continue;
      }
      const refs = cond.terms.map((t) => t.slice);
      deps.set(sl.id, refs);

      for (const ref of refs) {
        if (ref === sl.id) {
          findings.push({
            milestone: ms.id, slice: sl.id,
            code: 'slice-condition-self-reference',
            message: 'Slice ' + sl.id + ' has a condition on itself, which can never resolve',
          });
          continue;
        }
        if (!declared.has(ref)) {
          findings.push({
            milestone: ms.id, slice: sl.id,
            code: 'slice-condition-unknown-slice',
            message: 'Slice ' + sl.id + ' references ' + ref + ', which milestone ' + (ms.id || '?')
              + ' does not declare. Cross-milestone ordering belongs in the milestone depends_on field.',
          });
        }
      }
    }

    for (const cycle of _findCycles(deps)) {
      findings.push({
        milestone: ms.id, slice: cycle[0],
        code: 'slice-condition-cycle',
        message: 'Conditional cycle: ' + cycle.join(' → ') + '. No slice in the cycle can ever be decided.',
      });
    }
  }

  return { ok: findings.length === 0, findings };
}

// Depth-first cycle detection. Returns each cycle once, normalised to start at
// its smallest member so the same cycle is not reported from every entry point.
function _findCycles(deps) {
  const seen = new Set();
  const cycles = [];
  const stack = [];
  const onStack = new Set();
  const visited = new Set();

  const visit = (node) => {
    if (onStack.has(node)) {
      const at = stack.indexOf(node);
      const cycle = stack.slice(at);
      const min = cycle.reduce((a, b) => (a < b ? a : b));
      const rotated = cycle.slice(cycle.indexOf(min)).concat(cycle.slice(0, cycle.indexOf(min)));
      const key = rotated.join('>');
      if (!seen.has(key)) {
        seen.add(key);
        cycles.push(rotated.concat(rotated[0]));
      }
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    stack.push(node);
    onStack.add(node);
    for (const next of (deps.get(node) || [])) {
      if (deps.has(next)) visit(next);
    }
    stack.pop();
    onStack.delete(node);
  };

  for (const node of deps.keys()) visit(node);
  return cycles;
}

module.exports = {
  DECISIONS,
  OPERATORS,
  COMBINATORS,
  TERMINAL_SLICE_STATUSES,
  hasConditionalEdges,
  normalizeCondition,
  evaluate,
  planMilestone,
  lintDocument,
  _evaluateTerm,
  _findCycles,
};
