'use strict';

const test = require('node:test');
const assert = require('node:assert');

const bench = require('./elision-bench.cjs');

test('BENCH-1: fidelity crushes every fixture and holds all invariants', () => {
  const report = bench.runFidelity();
  assert.equal(report.cases.length, 5);
  assert.ok(report.summary.invariants_ok, 'invariants must hold: ' + report.summary.failed.join(', '));
  assert.equal(report.summary.compressed, 5, 'all fixtures should compress');
  for (const c of report.cases) {
    assert.ok(c.critical_preserved, c.name + ' lost a critical line');
    assert.ok(c.retrieval_exact, c.name + ' is not byte-exact reversible');
    assert.ok(c.ratio < 0.9, c.name + ' did not save enough to count');
  }
});

test('BENCH-2: detection routes each fixture to the intended crusher', () => {
  const byName = Object.fromEntries(bench.runFidelity().cases.map((c) => [c.name, c.type]));
  assert.equal(byName['json-array-with-error'], 'json-array');
  assert.equal(byName['build-log-with-fatal'], 'log');
  assert.equal(byName['grep-search-results'], 'search');
  assert.equal(byName['unified-diff'], 'diff');
  assert.equal(byName['source-code'], 'code');
});

test('BENCH-5: scale corpus exercises every crusher type at size and holds invariants', () => {
  const report = bench.runScale({ size: 'medium', holdoutRatio: 0.2 });
  assert.equal(report.summary.fixtures, 60);
  assert.ok(report.summary.invariants_ok, 'treatment + held-out control invariants must hold: ' + report.summary.failed.join(', '));
  assert.ok(report.summary.control_invariants_ok, 'held-out control fixtures must also pass every fidelity invariant');
  assert.ok(report.summary.treatment_saved_pct > 50, 'meaningful savings on treatment');
  assert.ok(report.summary.generalization_gap_pct <= 25, 'control savings track treatment — no overfit (gap ' + report.summary.generalization_gap_pct + '%)');
  const types = report.strata.map((s) => s.type).sort();
  assert.deepEqual(types, ['code', 'diff', 'json-array', 'log', 'search'], 'all five crusher types represented');
  for (const s of report.strata) assert.ok(s.invariants_ok, s.type + ' stratum lost an invariant');
});

test('BENCH-6: holdout arm assignment is deterministic and ratio-monotone', () => {
  const a = bench.runScale({ size: 'medium', holdoutRatio: 0.2 });
  const b = bench.runScale({ size: 'medium', holdoutRatio: 0.2 });
  assert.equal(a.summary.control_n, b.summary.control_n, 'same corpus + ratio → same partition (sha256, not random)');
  const more = bench.runScale({ size: 'medium', holdoutRatio: 0.5 });
  assert.ok(more.summary.control_n >= a.summary.control_n, 'a larger holdout ratio never shrinks the control arm');
  assert.equal(a.summary.control_n + a.summary.treatment_n, 60);
});

test('BENCH-7: buildCorpusScale sizes and rejects an unknown size', () => {
  assert.equal(bench.buildCorpusScale('small').length, 5);
  assert.equal(bench.buildCorpusScale('medium').length, 60);
  assert.equal(bench.buildCorpusScale('large').length, 300);
  assert.throws(() => bench.buildCorpusScale('huge'), /unknown corpus size/);
});

function needsExpandCase() {
  const lines = [];
  for (let i = 0; i < 80; i += 1) {
    lines.push(i === 57
      ? '[2026-06-23T10:00:57Z] FATAL migration 0042 failed: duplicate key'
      : '[2026-06-23T10:00:' + String(i).padStart(2, '0') + 'Z] INFO step ' + i + ' done token-' + i + '-marker');
  }
  return [{ name: 'needs-expand', context: lines.join('\n'),
    question: 'What token is logged on step 40?', must_contain: ['token-40-marker'] }];
}

test('BENCH-3: expanding the marker recovers an elided fact (stub round-trip)', async () => {
  const chat = async ({ messages, tools }) => {
    const seen = messages.map((m) => String(m.content || '')).join('\n');
    const marker = seen.match(/⟦elided:([a-f0-9]{12})\b/);
    const alreadyExpanded = messages.some((m) => m.role === 'tool');
    if (tools && marker && !alreadyExpanded) {
      return { content: '', toolCalls: [{ id: 't1', name: 'context-expand', arguments: { hash: marker[1] } }] };
    }
    return { content: seen, toolCalls: [] };
  };
  const report = await bench.runEquivalence({ chatImpl: chat, provider: { baseUrl: 'http://stub', model: 'stub' }, cases: needsExpandCase() });
  assert.ok(report.summary.no_regression, 'regressions: ' + report.summary.regressions.join(', '));
  assert.ok(report.cases[0].compressed_ok, 'expanding agent should recover the elided token');
});

test('BENCH-4: a marker-blind model surfaces as a regression', async () => {
  const chat = async ({ messages }) => ({ content: messages.map((m) => String(m.content || '')).join('\n'), toolCalls: [] });
  const report = await bench.runEquivalence({ chatImpl: chat, provider: { baseUrl: 'http://stub', model: 'stub' }, cases: needsExpandCase() });
  assert.equal(report.cases[0].raw_ok, true, 'raw context must contain the answer');
  assert.equal(report.cases[0].compressed_ok, false, 'marker-blind compressed answer must miss the elided token');
  assert.ok(report.summary.regressions.length >= 1, 'must be reported as a regression');
});
