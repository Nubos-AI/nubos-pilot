'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const swarm = require('./researcher-swarm.cjs');

function _mkRoot(cfg) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'np-swarm-'));
  fs.mkdirSync(path.join(r, '.nubos-pilot'), { recursive: true });
  if (cfg !== undefined) {
    fs.writeFileSync(path.join(r, '.nubos-pilot', 'config.json'), JSON.stringify(cfg), 'utf-8');
  }
  return r;
}

test('SW-1: resolveSwarmOpts defaults to k=3, threshold=0.2, minOccurrence=1', () => {
  const r = _mkRoot();
  try {
    const o = swarm.resolveSwarmOpts(r);
    assert.equal(o.k, 3);
    assert.equal(o.threshold, 0.2);
    assert.equal(o.minOccurrence, 1);
    assert.equal(o.minConfidence, 0.3);
    assert.equal(o.bypassThreshold, 0.5);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('SW-2: resolveSwarmOpts reads config overrides', () => {
  const r = _mkRoot({ swarm: { research: { k: 5, threshold: 0.85, minOccurrence: 2 } } });
  try {
    const o = swarm.resolveSwarmOpts(r);
    assert.equal(o.k, 5);
    assert.equal(o.threshold, 0.85);
    assert.equal(o.minOccurrence, 2);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('SW-3: resolveSwarmOpts clamps k to [MIN_K, MAX_K]', () => {
  const r = _mkRoot({ swarm: { research: { k: 99 } } });
  try {
    assert.equal(swarm.resolveSwarmOpts(r).k, swarm.MAX_K);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
  const r2 = _mkRoot({ swarm: { research: { k: 0 } } });
  try {
    assert.equal(swarm.resolveSwarmOpts(r2).k, swarm.MIN_K);
  } finally { fs.rmSync(r2, { recursive: true, force: true }); }
});

test('SW-4: buildSpawnSpecs emits k records, each with a distinct seed_delta', () => {
  const specs = swarm.buildSpawnSpecs({ ticket: 'M001-S001-T0001' }, 3);
  assert.equal(specs.length, 3);
  const deltas = specs.map((s) => s.seed_delta);
  assert.equal(new Set(deltas).size, 3, 'seed_deltas must be distinct');
  for (let i = 0; i < specs.length; i += 1) assert.equal(specs[i].index, i);
});

test('SW-5: buildSpawnSpecs validates input object', () => {
  assert.throws(() => swarm.buildSpawnSpecs(null, 3), TypeError);
  assert.throws(() => swarm.buildSpawnSpecs('string', 3), TypeError);
});

test('SW-6: mergeConsensus — Mehrheit on decisions (3-of-3)', () => {
  const out = swarm.mergeConsensus([
    { decisions: [{ claim: 'use jose@6.0.10 for jwt verification', provenance: '[VERIFIED]' }] },
    { decisions: [{ claim: 'Use jose@6.0.10 for JWT verification', provenance: '[CITED:url]' }] },
    { decisions: [{ claim: 'use jose@6.0.10 for jwt verification', provenance: '[ASSUMED]' }] },
  ]);
  assert.equal(out.decisions.length, 1);
  assert.equal(out.decisions[0].agreement, 3);
  assert.equal(out.decisions[0].flagged, false);
  assert.equal(out.decisions[0].provenance, '[VERIFIED]', 'should upgrade provenance to highest seen');
  assert.equal(out.flagged_decisions.length, 0);
});

test('SW-7: mergeConsensus — solo decision is FLAGGED', () => {
  const out = swarm.mergeConsensus([
    { decisions: [{ claim: 'use jose for jwt' }] },
    { decisions: [{ claim: 'use my own custom rolled jwt code' }] },
    { decisions: [{ claim: 'use a different totally unrelated library' }] },
  ]);
  assert.equal(out.decisions.length, 0);
  assert.equal(out.flagged_decisions.length, 3);
  for (const d of out.flagged_decisions) assert.equal(d.flagged, true);
});

test('SW-8: mergeConsensus — Union on risks dedupes by semantic fingerprint', () => {
  const out = swarm.mergeConsensus([
    { risks: [{ description: 'JWT key rotation breaks running sessions', severity: 'HIGH' }] },
    { risks: [{ description: 'jwt key rotation breaks running sessions', severity: 'MEDIUM' }] },
    { risks: [{ description: 'rate limiting absent on token endpoint', severity: 'MEDIUM' }] },
  ]);
  assert.equal(out.risks.length, 2);
  const rotation = out.risks.find((r) => /rotation/i.test(r.description));
  assert.ok(rotation);
  assert.equal(rotation.severity, 'HIGH', 'severity should rise to highest seen');
  assert.equal(rotation.seen_by.length, 2);
});

test('SW-9: mergeConsensus — Schnittmenge on patterns (≥2 spawns)', () => {
  const out = swarm.mergeConsensus([
    { patterns: [{ name: 'Repository pattern' }, { name: 'Solo only here' }] },
    { patterns: [{ name: 'Repository Pattern' }] },
    { patterns: [{ name: 'Repository pattern' }] },
  ]);
  assert.equal(out.patterns.length, 1, 'Repository pattern shows in 3 spawns');
  assert.equal(out.patterns[0].agreement, 3);
  assert.equal(out.demoted_patterns.length, 1);
  assert.equal(out.demoted_patterns[0].provenance, '[ASSUMED]');
});

test('SW-10: mergeConsensus — open questions union with dedup', () => {
  const out = swarm.mergeConsensus([
    { open_questions: ['What is the token TTL?'] },
    { open_questions: [{ question: 'what is the token ttl?' }] },
    { open_questions: ['Is refresh-token reuse allowed?'] },
  ]);
  assert.equal(out.open_questions.length, 2);
  const ttl = out.open_questions.find((q) => /ttl/i.test(q.question));
  assert.equal(ttl.seen_by.length, 2);
});

test('SW-11: mergeConsensus — sources keyed by URL with credibility = max', () => {
  const out = swarm.mergeConsensus([
    { sources: [{ url: 'https://github.com/panva/jose', credibility: 'MEDIUM' }] },
    { sources: [{ url: 'https://github.com/panva/jose', credibility: 'HIGH' }] },
    { sources: [{ url: 'https://example.com/blog', credibility: 'LOW' }] },
  ]);
  const jose = out.sources.find((s) => /panva/.test(s.url));
  assert.equal(jose.credibility, 'HIGH');
  assert.equal(jose.seen_by.length, 2);
});

test('SW-12: mergeConsensus — empty input returns zero-everything skeleton', () => {
  const out = swarm.mergeConsensus([]);
  assert.equal(out.decisions.length, 0);
  assert.equal(out.meta.k, 0);
  assert.equal(out.meta.agreement_score, 0);
});

test('SW-13: mergeConsensus output sort order is deterministic per input', () => {
  // Identical input must produce identical output across runs.
  const inputs = [
    { decisions: [{ claim: 'X' }, { claim: 'Y' }] },
    { decisions: [{ claim: 'Y' }, { claim: 'X' }] },
    { decisions: [{ claim: 'Z' }] },
  ];
  const a = swarm.mergeConsensus(inputs);
  const b = swarm.mergeConsensus(inputs);
  assert.deepEqual(a, b);
  // Permuting the spawn order is a different input — `from_spawns` will
  // differ — but the sort criterion (agreement desc, claim asc as tie-breaker)
  // means the claim sequence in the flagged list is stable.
  const c = swarm.mergeConsensus([inputs[2], inputs[1], inputs[0]]);
  assert.deepEqual(
    a.flagged_decisions.map((d) => d.claim),
    c.flagged_decisions.map((d) => d.claim),
  );
});

test('SW-14: renderConsensusToMarkdown emits expected sections', () => {
  const consensus = swarm.mergeConsensus([
    { decisions: [{ claim: 'use jose' }], risks: [{ description: 'rotation breaks sessions', severity: 'HIGH' }] },
    { decisions: [{ claim: 'use jose' }] },
    { decisions: [{ claim: 'use jose' }] },
  ]);
  const md = swarm.renderConsensusToMarkdown(consensus);
  assert.match(md, /# Researcher-Schwarm Consensus/);
  assert.match(md, /<consensus_meta>/);
  assert.match(md, /## Decisions \(Mehrheit\)/);
  assert.match(md, /## Risks \(Union\)/);
  assert.match(md, /## Patterns \(Schnittmenge ≥ 2\)/);
  assert.match(md, /agreement=3/);
});

test('SW-15: invalid mergeConsensus input → TypeError', () => {
  assert.throws(() => swarm.mergeConsensus(null), TypeError);
  assert.throws(() => swarm.mergeConsensus({}), TypeError);
});

test('SW-16: agreement_score = 1.0 when every decision is unanimous (3/3)', () => {
  const out = swarm.mergeConsensus([
    { decisions: [{ claim: 'use jose@6.0.10' }, { claim: 'use bcrypt' }] },
    { decisions: [{ claim: 'use jose@6.0.10' }, { claim: 'use bcrypt' }] },
    { decisions: [{ claim: 'use jose@6.0.10' }, { claim: 'use bcrypt' }] },
  ]);
  assert.equal(out.meta.k, 3);
  assert.equal(out.meta.agreement_score, 1.0);
});

test('SW-17: agreement_score = 1/3 when every decision is solo (1 of 3 spawns)', () => {
  // Claims must be ≥2 alphabetic chars so _tokenize produces non-empty fingerprints
  const out = swarm.mergeConsensus([
    { decisions: [{ claim: 'use jose for jwt' }] },
    { decisions: [{ claim: 'use bcrypt for hashing' }] },
    { decisions: [{ claim: 'use argon2id for hashing' }] },
  ]);
  assert.equal(out.meta.k, 3);
  assert.equal(out.meta.agreement_score, 0.333);
  assert.equal(out.decisions.length, 0);
  assert.equal(out.flagged_decisions.length, 3);
});

test('SW-18: agreement_score is the mean of per-decision agreement ratios', () => {
  // Three distinct claims with longer text so each gets its own fingerprint:
  //   "alpha library" — appears in spawn 0, 1, 2 → 3/3 = 1.0
  //   "beta library"  — appears in spawn 0, 1    → 2/3 ≈ 0.667
  //   "gamma library" — appears in spawn 0       → 1/3 ≈ 0.333
  // Mean = (1.0 + 0.667 + 0.333) / 3 = 0.667
  const out = swarm.mergeConsensus([
    { decisions: [{ claim: 'use alpha library' }, { claim: 'use beta library' }, { claim: 'use gamma library' }] },
    { decisions: [{ claim: 'use alpha library' }, { claim: 'use beta library' }] },
    { decisions: [{ claim: 'use alpha library' }] },
  ]);
  assert.equal(out.meta.k, 3);
  assert.equal(out.decisions.length + out.flagged_decisions.length, 3,
    'three distinct claims must produce three buckets');
  assert.ok(Math.abs(out.meta.agreement_score - 0.667) < 0.005,
    'expected ≈0.667, got ' + out.meta.agreement_score);
});

test('SW-19a: order-distinct claims do NOT merge into one bucket (R18 from fourth review)', () => {
  const out = swarm.mergeConsensus([
    { decisions: [{ claim: 'Cache uses Redis' }] },
    { decisions: [{ claim: 'Redis uses cache' }] },
  ]);
  // Two semantically distinct claims must remain two separate buckets — both
  // FLAGGED because each has only 1-of-2 spawn support.
  assert.equal(out.decisions.length + out.flagged_decisions.length, 2,
    'order-distinct claims must produce two buckets');
});

test('SW-PROV-1: Mehrheit on [ASSUMED] decisions does NOT auto-promote to [VERIFIED]', () => {
  // Per ADR-0011 §"Provenance Semantics" — agreement is not verification.
  // Three spawns agreeing on [ASSUMED] keeps the merged provenance [ASSUMED]
  // even though flagged turns false. Plan-checker uses BOTH fields.
  const out = swarm.mergeConsensus([
    { decisions: [{ claim: 'use jose for jwt', confidence: 'HIGH', provenance: '[ASSUMED]' }] },
    { decisions: [{ claim: 'use jose for jwt', confidence: 'HIGH', provenance: '[ASSUMED]' }] },
    { decisions: [{ claim: 'use jose for jwt', confidence: 'HIGH', provenance: '[ASSUMED]' }] },
  ]);
  const dec = out.decisions[0];
  assert.equal(dec.provenance, '[ASSUMED]', 'Mehrheit must NOT silently grant [VERIFIED]');
  assert.equal(dec.flagged, false, 'Mehrheit DOES set flagged:false');
});

test('SW-PROV-2: a single [VERIFIED] spawn promotes the merged decision to [VERIFIED]', () => {
  const out = swarm.mergeConsensus([
    { decisions: [{ claim: 'use jose for jwt', provenance: '[ASSUMED]' }] },
    { decisions: [{ claim: 'use jose for jwt', provenance: '[VERIFIED]' }] },
    { decisions: [{ claim: 'use jose for jwt', provenance: '[ASSUMED]' }] },
  ]);
  assert.equal(out.decisions[0].provenance, '[VERIFIED]');
});

test('SW-K1-1: k=1 patterns are accepted (Schnittmenge gracefully degrades, not all demoted to [ASSUMED])', () => {
  const out = swarm.mergeConsensus([
    { decisions: [], risks: [], patterns: [{ name: 'Repository pattern', description: 'd' }] },
  ]);
  // For k=1 the threshold is min(2,1)=1 — single-spawn pattern is still accepted.
  assert.equal(out.patterns.length, 1);
  assert.equal(out.patterns[0].name, 'Repository pattern');
  assert.equal(out.demoted_patterns.length, 0);
});

test('SW-19: agreement_score is 0 when no decisions present', () => {
  const out = swarm.mergeConsensus([
    { decisions: [], risks: [{ description: 'x' }] },
    { decisions: [] },
  ]);
  assert.equal(out.meta.agreement_score, 0);
});
