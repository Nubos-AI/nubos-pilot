'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const adapter = require('./knowledge-adapter.cjs');

function _mkRoot(cfg) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'np-adapter-'));
  fs.mkdirSync(path.join(r, '.nubos-pilot'), { recursive: true });
  if (cfg !== undefined) {
    fs.writeFileSync(path.join(r, '.nubos-pilot', 'config.json'), JSON.stringify(cfg), 'utf-8');
  }
  return r;
}

test('KA-1: missing config defaults to local adapter', () => {
  const r = _mkRoot();
  try {
    const a = adapter.getAdapter(r);
    assert.equal(a.name, 'local');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('KA-2: explicit local in config returns local adapter', () => {
  const r = _mkRoot({ swarm: { knowledge_adapter: 'local' } });
  try {
    const a = adapter.getAdapter(r);
    assert.equal(a.name, 'local');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('KA-4: unsupported adapter in config falls back to local', () => {
  const r = _mkRoot({ swarm: { knowledge_adapter: 'pinecone' } });
  try {
    const a = adapter.getAdapter(r);
    assert.equal(a.name, 'local');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('KA-6: unknown explicit override throws', () => {
  const r = _mkRoot();
  try {
    assert.throws(
      () => adapter.getAdapter(r, 'pinecone'),
      (err) => err && err.name === 'NubosPilotError' && err.code === 'knowledge-adapter-unknown',
    );
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('KA-CFG-1: readConfigPath refuses to walk through __proto__ keys (RISK-β)', () => {
  const config = require('./config.cjs');
  const r = _mkRoot({ '__proto__': { polluted: true } });
  try {
    const v = config.readConfigPath(r, '__proto__.polluted', 'fallback-default');
    assert.equal(v, 'fallback-default');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('KA-CFG-2: readConfigPath uses hasOwnProperty — inherited keys not walked', () => {
  const config = require('./config.cjs');
  const r = _mkRoot({ swarm: { knowledge_adapter: 'local' } });
  try {
    const v = config.readConfigPath(r, 'toString', 'fallback');
    assert.equal(v, 'fallback', 'inherited Object.prototype.toString must not leak');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('KA-7: local adapter round-trips a learning (memory off → retrieval=bm25)', async () => {
  const r = _mkRoot();
  try {
    const a = adapter.getAdapter(r);
    a.log({ pattern: 'use jose for jwt verification', outcome: 'ok' });
    a.log({ pattern: 'use jose for jwt verification', outcome: 'ok' });
    a.log({ pattern: 'use jose for jwt verification', outcome: 'ok' });
    const m = await a.match('jose jwt verification', { threshold: 0.5, minOccurrence: 3 });
    assert.ok(m.best);
    assert.equal(m.best.occurrence, 3);
    assert.equal(m.best.retrieval, 'bm25');
    assert.equal(m.degraded, null);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('KA-8: _hybridMerge falls back to BM25 when vector hits empty', () => {
  const merged = adapter._hybridMerge(
    [{ fingerprint: 'fp1', pattern: 'p1', similarity: 0.8, occurrence: 3 }],
    [],
    0.6,
    new Map(),
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].similarity, 0.8);
  assert.equal(merged[0].retrieval, 'bm25');
});

test('KA-9: _hybridMerge blends BM25 + vector by alpha when both signals present', () => {
  const bm25 = [{ fingerprint: 'fp-a', pattern: 'a', similarity: 0.5, occurrence: 5 }];
  const vector = [{ fingerprint: 'fp-a', score: 0.9 }];
  const merged = adapter._hybridMerge(bm25, vector, 0.5, new Map());
  assert.equal(merged.length, 1);
  assert.ok(Math.abs(merged[0].similarity - 0.7) < 1e-9);
  assert.equal(merged[0].retrieval, 'hybrid');
});

test('KA-10: _hybridMerge — a vector miss is an absent signal, BM25 score unchanged (H2)', () => {
  const bm25 = [
    { fingerprint: 'fp-a', pattern: 'a', similarity: 0.7, occurrence: 3 },
    { fingerprint: 'fp-b', pattern: 'b', similarity: 0.5, occurrence: 2 },
  ];
  const vector = [{ fingerprint: 'fp-a', score: 0.8 }];
  const merged = adapter._hybridMerge(bm25, vector, 0.6, new Map());
  assert.equal(merged.length, 2);
  const a = merged.find((h) => h.fingerprint === 'fp-a');
  const b = merged.find((h) => h.fingerprint === 'fp-b');
  assert.ok(Math.abs(a.similarity - (0.6 * 0.7 + 0.4 * 0.8)) < 1e-9);
  assert.equal(a.retrieval, 'hybrid');
  assert.ok(Math.abs(b.similarity - 0.5) < 1e-9, 'a vector miss must not pull fp-b toward zero');
  assert.equal(b.retrieval, 'bm25');
});

test('KA-13: _hybridMerge surfaces a vector-only hit, materialised from byFp (H1)', () => {
  const bm25 = [{ fingerprint: 'fp-a', pattern: 'a', similarity: 0.9, occurrence: 4 }];
  const vector = [
    { fingerprint: 'fp-a', score: 0.6 },
    { fingerprint: 'fp-v', score: 0.95 },
  ];
  const byFp = new Map([
    ['fp-v', { fingerprint: 'fp-v', pattern: 'vector-only pattern', outcome: 'ok', occurrence: 7, tokens: ['x'] }],
  ]);
  const merged = adapter._hybridMerge(bm25, vector, 0.6, byFp);
  const v = merged.find((h) => h.fingerprint === 'fp-v');
  assert.ok(v, 'vector-only hit must appear in the merge');
  assert.equal(v.retrieval, 'vector');
  assert.equal(v.occurrence, 7, 'occurrence resolved from the learnings store');
  assert.equal(v.tokens, undefined, 'tokens[] projected away');
  assert.ok(Math.abs(v.similarity - 0.95) < 1e-9);
});

test('KA-11: hybrid match blends a memoryOverride vector hit with the BM25 fingerprint', async () => {
  const r = _mkRoot({ memory: { enabled: true, alpha: 0.5 } });
  try {
    const a = adapter.getAdapter(r);
    a.log({ pattern: 'use jose for jwt', outcome: 'ok' });
    a.log({ pattern: 'use jose for jwt', outcome: 'ok' });
    a.log({ pattern: 'use jose for jwt', outcome: 'ok' });

    const learnings = require('./learnings.cjs');
    const bm25 = learnings.matchExistingLearning('jose jwt verification', r, { threshold: 0.5, minOccurrence: 3 });
    const fp = bm25.best.fingerprint;

    const memoryOverride = {
      query() {
        return [{ id: fp, score: 0.95, record: { id: fp } }];
      },
    };

    const m = await a.match('jose jwt verification', { threshold: 0.5, minOccurrence: 3, memoryOverride });
    assert.ok(m.best);
    assert.equal(m.best.retrieval, 'hybrid');
    assert.equal(m.degraded, null);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('KA-14: a failing vector query degrades to lexical with an explicit degraded marker (M1)', async () => {
  const r = _mkRoot({ memory: { enabled: true } });
  try {
    const a = adapter.getAdapter(r);
    a.log({ pattern: 'use jose for jwt', outcome: 'ok' });
    a.log({ pattern: 'use jose for jwt', outcome: 'ok' });
    a.log({ pattern: 'use jose for jwt', outcome: 'ok' });

    const memoryOverride = {
      query() { throw new Error('vector backend down'); },
    };

    const m = await a.match('jose jwt verification', { threshold: 0.5, minOccurrence: 3, memoryOverride });
    assert.ok(m.best, 'the lexical hit is still returned');
    assert.equal(m.best.retrieval, 'bm25');
    assert.ok(m.degraded, 'a failed vector layer must surface a degraded marker, not be masked');
    assert.match(String(m.degraded.message || ''), /vector backend down/);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('KA-12: memory.enabled=false → lexical-only, retrieval=bm25, degraded=null', async () => {
  const r = _mkRoot({ memory: { enabled: false } });
  try {
    const a = adapter.getAdapter(r);
    a.log({ pattern: 'use jose', outcome: 'ok' });
    a.log({ pattern: 'use jose', outcome: 'ok' });
    a.log({ pattern: 'use jose', outcome: 'ok' });
    const m = await a.match('jose', { threshold: 0.5, minOccurrence: 3 });
    assert.ok(m.best);
    assert.equal(m.best.retrieval, 'bm25');
    assert.equal(m.degraded, null);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});
