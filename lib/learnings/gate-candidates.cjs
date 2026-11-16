'use strict';

const learnings = require('../learnings.cjs');

const NEGATIVE_OUTCOMES = Object.freeze(new Set(['failed', 'reverted']));
const DEFAULT_CLUSTER_THRESHOLD = 0.5;
const MIN_SHARED_TOKENS = 4;
const DEFAULT_MIN_CLUSTER = 2;
const MAX_CANDIDATES = 20;

function _isNegative(outcome) {
  return NEGATIVE_OUTCOMES.has(String(outcome || '').trim().toLowerCase());
}

function _negativeWeight(l) {
  let n = _isNegative(l.outcome) ? (Number(l.occurrence) || 1) : 0;
  const history = Array.isArray(l.outcome_history) ? l.outcome_history : [];
  for (const h of history) {
    if (h && _isNegative(h.outcome)) n += 1;
  }
  return n;
}

function _tokensOf(l) {
  const t = Array.isArray(l.tokens) && l.tokens.length ? l.tokens : learnings._tokenize(l.pattern);
  return new Set(t);
}

function _containment(a, b) {
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;
  if (!smaller.size) return 0;
  let shared = 0;
  for (const t of smaller) if (larger.has(t)) shared += 1;
  return { score: shared / smaller.size, shared };
}

function _sharedTokens(members) {
  if (!members.length) return [];
  let shared = new Set(members[0].tokens);
  for (const m of members.slice(1)) {
    shared = new Set([...shared].filter((t) => m.tokens.has(t)));
  }
  return Array.from(shared).sort();
}

function clusterNegatives(records, opts) {
  const o = opts || {};
  const threshold = Number.isFinite(o.threshold) ? o.threshold : DEFAULT_CLUSTER_THRESHOLD;
  const pool = records
    .map((l) => ({ learning: l, tokens: _tokensOf(l), weight: _negativeWeight(l) }))
    .filter((e) => e.weight > 0 && e.tokens.size > 0)
    .sort((a, b) => b.weight - a.weight);

  const clusters = [];
  const taken = new Set();
  for (let i = 0; i < pool.length; i += 1) {
    if (taken.has(i)) continue;
    const members = [pool[i]];
    taken.add(i);
    for (let j = i + 1; j < pool.length; j += 1) {
      if (taken.has(j)) continue;
      const c = _containment(pool[i].tokens, pool[j].tokens);
      if (c.score >= threshold && c.shared >= MIN_SHARED_TOKENS) {
        members.push(pool[j]);
        taken.add(j);
      }
    }
    clusters.push(members);
  }
  return clusters;
}

function gateCandidates(cwd, opts) {
  const o = opts || {};
  const minCluster = Number.isFinite(o.minCluster) ? o.minCluster : DEFAULT_MIN_CLUSTER;
  let all;
  try { all = learnings.listLearnings(cwd); }
  catch { return { candidates: [], scanned: 0, negatives: 0 }; }

  const negatives = all.filter((l) => _negativeWeight(l) > 0);
  const clusters = clusterNegatives(all, o).filter((c) => c.length >= minCluster);

  const candidates = clusters
    .map((members) => ({
      occurrences: members.reduce((n, m) => n + m.weight, 0),
      members: members.length,
      shared_tokens: _sharedTokens(members),
      patterns: members.map((m) => m.learning.pattern),
      fingerprints: members.map((m) => m.learning.fingerprint),
      task_ids: Array.from(new Set(members.flatMap((m) => m.learning.task_ids || []))).slice(0, 20),
    }))
    .sort((a, b) => b.occurrences - a.occurrences || b.members - a.members)
    .slice(0, MAX_CANDIDATES);

  return { candidates, scanned: all.length, negatives: negatives.length };
}

module.exports = {
  NEGATIVE_OUTCOMES,
  DEFAULT_CLUSTER_THRESHOLD,
  DEFAULT_MIN_CLUSTER,
  clusterNegatives,
  gateCandidates,
};
