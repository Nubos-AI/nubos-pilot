'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createMemory } = require('./memory.cjs');

function _sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-memory-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  return root;
}

function _hashEmbed(text, dim) {
  const v = new Float32Array(dim);
  let seed = 0;
  for (let i = 0; i < text.length; i++) seed = (seed * 31 + text.charCodeAt(i)) & 0xffff;
  let s = seed || 1;
  for (let i = 0; i < dim; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    v[i] = (s % 1000) / 1000;
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) v[i] /= norm;
  return v;
}

function _mockProvider(modelId = 'mock-model-v1', dim = 16) {
  return {
    modelId,
    dim,
    async embed(texts) {
      return texts.map((t) => _hashEmbed(t, dim));
    },
  };
}

function _mockIndex() {
  let entries = new Map();
  return {
    add(id, vector) { entries.set(id, vector); },
    remove(id) { entries.delete(id); },
    size() { return entries.size; },
    isEmpty() { return entries.size === 0; },
    clear() { entries = new Map(); },
    search(vector, k) {
      const hits = [];
      for (const [id, v] of entries.entries()) {
        let dot = 0;
        for (let i = 0; i < vector.length; i++) dot += vector[i] * v[i];
        hits.push({ id, score: dot });
      }
      hits.sort((a, b) => b.score - a.score);
      return hits.slice(0, k);
    },
    saveSync(filePath) {
      const dump = {};
      for (const [id, v] of entries.entries()) dump[id] = Array.from(v);
      fs.writeFileSync(filePath, JSON.stringify(dump));
    },
    loadSync(filePath) {
      if (!fs.existsSync(filePath)) return;
      const dump = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      entries = new Map(Object.entries(dump).map(([id, arr]) => [id, new Float32Array(arr)]));
    },
  };
}

test('MEM-1: createMemory rejects without provider/index', () => {
  assert.throws(
    () => createMemory({ indexEngine: _mockIndex() }),
    (err) => err.code === 'memory-missing-provider',
  );
  assert.throws(
    () => createMemory({ provider: _mockProvider() }),
    (err) => err.code === 'memory-missing-index',
  );
});

test('MEM-2: index adds new records and returns added/skipped counts', async () => {
  const root = _sandbox();
  try {
    const memory = createMemory({ provider: _mockProvider(), indexEngine: _mockIndex(), cwd: root });
    const r1 = { type: 'learning', title: 'A', body: 'first body' };
    const r2 = { type: 'learning', title: 'B', body: 'second body' };
    const result = await memory.index([r1, r2]);
    assert.equal(result.added, 2);
    assert.equal(result.skipped, 0);

    const recordsPath = path.join(root, '.nubos-pilot', 'memory', 'records.jsonl');
    assert.ok(fs.existsSync(recordsPath));
    const lines = fs.readFileSync(recordsPath, 'utf-8').split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    const ids = lines.map((l) => JSON.parse(l).id);
    assert.equal(new Set(ids).size, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MEM-3: index is idempotent on the same id (skipped)', async () => {
  const root = _sandbox();
  try {
    const memory = createMemory({ provider: _mockProvider(), indexEngine: _mockIndex(), cwd: root });
    const rec = { id: 'fixed-id', type: 'learning', title: 'X', body: 'b' };
    await memory.index([rec]);
    const r2 = await memory.index([rec]);
    assert.equal(r2.added, 0);
    assert.equal(r2.skipped, 1);

    const recordsPath = path.join(root, '.nubos-pilot', 'memory', 'records.jsonl');
    const lines = fs.readFileSync(recordsPath, 'utf-8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MEM-4: query returns top-k hits sorted by score (descending)', async () => {
  const root = _sandbox();
  try {
    const memory = createMemory({ provider: _mockProvider(), indexEngine: _mockIndex(), cwd: root });
    await memory.index([
      { type: 'learning', title: 'apple', body: 'a fruit' },
      { type: 'learning', title: 'banana', body: 'a yellow fruit' },
      { type: 'learning', title: 'carpenter', body: 'wood worker' },
    ]);

    const hits = await memory.query('apple', { k: 3 });
    assert.equal(hits.length, 3);
    for (let i = 0; i < hits.length - 1; i++) assert.ok(hits[i].score >= hits[i + 1].score);

    const top1 = await memory.query('whatever', { k: 1 });
    assert.equal(top1.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MEM-5: query filter by type', async () => {
  const root = _sandbox();
  try {
    const memory = createMemory({ provider: _mockProvider(), indexEngine: _mockIndex(), cwd: root });
    await memory.index([
      { type: 'learning', title: 'L', body: 'x' },
      { type: 'critic',   title: 'C', body: 'x' },
      { type: 'research', title: 'R', body: 'x' },
    ]);
    const learnings = await memory.query('x', { k: 10, filter: { type: 'learning' } });
    assert.equal(learnings.length, 1);
    assert.equal(learnings[0].record.type, 'learning');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MEM-6: query filter by phase', async () => {
  const root = _sandbox();
  try {
    const memory = createMemory({ provider: _mockProvider(), indexEngine: _mockIndex(), cwd: root });
    await memory.index([
      { type: 'learning', phase: 'M001-S001', title: 'A', body: 'x' },
      { type: 'learning', phase: 'M002-S001', title: 'B', body: 'x' },
    ]);
    const hits = await memory.query('x', { k: 10, filter: { phase: 'M001-S001' } });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].record.phase, 'M001-S001');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MEM-7: query filter by tags overlap', async () => {
  const root = _sandbox();
  try {
    const memory = createMemory({ provider: _mockProvider(), indexEngine: _mockIndex(), cwd: root });
    await memory.index([
      { type: 'learning', title: 'A', body: 'x', tags: ['filament', 'feature-flags'] },
      { type: 'learning', title: 'B', body: 'x', tags: ['vue', 'inertia'] },
      { type: 'learning', title: 'C', body: 'x', tags: ['filament'] },
    ]);
    const hits = await memory.query('x', { k: 10, filter: { tags: ['filament'] } });
    assert.equal(hits.length, 2);
    for (const h of hits) assert.ok(h.record.tags.includes('filament'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MEM-8: rebuild re-embeds all records and clears index', async () => {
  const root = _sandbox();
  try {
    const memory = createMemory({ provider: _mockProvider(), indexEngine: _mockIndex(), cwd: root });
    await memory.index([
      { type: 'learning', title: 'A', body: 'x' },
      { type: 'learning', title: 'B', body: 'y' },
    ]);
    const result = await memory.rebuild();
    assert.equal(result.reembedded, 2);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, '.nubos-pilot', 'memory', 'manifest.json'), 'utf-8'));
    assert.ok(manifest.rebuilt_at);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MEM-9: stats returns count, dim, model from manifest', async () => {
  const root = _sandbox();
  try {
    const memory = createMemory({ provider: _mockProvider('m-v1', 8), indexEngine: _mockIndex(), cwd: root });
    let s = memory.stats();
    assert.equal(s.count, 0);
    assert.equal(s.dim, 8);
    assert.equal(s.model, 'm-v1');

    await memory.index([{ type: 'learning', title: 'A', body: 'x' }]);
    s = memory.stats();
    assert.equal(s.count, 1);
    assert.equal(s.schema_version, 1);
    assert.ok(s.created_at);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MEM-10: model mismatch on subsequent index throws memory-model-mismatch', async () => {
  const root = _sandbox();
  try {
    const m1 = createMemory({ provider: _mockProvider('model-v1', 16), indexEngine: _mockIndex(), cwd: root });
    await m1.index([{ type: 'learning', title: 'A', body: 'x' }]);

    const m2 = createMemory({ provider: _mockProvider('model-v2', 16), indexEngine: _mockIndex(), cwd: root });
    await assert.rejects(
      m2.index([{ type: 'learning', title: 'B', body: 'y' }]),
      (err) => err.code === 'memory-model-mismatch',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MEM-11: dim mismatch on subsequent index throws memory-dim-mismatch', async () => {
  const root = _sandbox();
  try {
    const m1 = createMemory({ provider: _mockProvider('mod', 16), indexEngine: _mockIndex(), cwd: root });
    await m1.index([{ type: 'learning', title: 'A', body: 'x' }]);

    const m2 = createMemory({ provider: _mockProvider('mod', 32), indexEngine: _mockIndex(), cwd: root });
    await assert.rejects(
      m2.query('q', {}),
      (err) => err.code === 'memory-dim-mismatch',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MEM-12: invalid type rejected with memory-invalid-type', async () => {
  const root = _sandbox();
  try {
    const memory = createMemory({ provider: _mockProvider(), indexEngine: _mockIndex(), cwd: root });
    await assert.rejects(
      memory.index([{ type: 'todo', title: 'x', body: 'y' }]),
      (err) => err.code === 'memory-invalid-type',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MEM-13: add wraps index for a single record and returns id', async () => {
  const root = _sandbox();
  try {
    const memory = createMemory({ provider: _mockProvider(), indexEngine: _mockIndex(), cwd: root });
    const result = await memory.add({ type: 'critic', title: 'finding', body: 'unmet criterion at line 42' });
    assert.equal(result.added, true);
    assert.match(result.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MEM-14: empty query rejected with memory-empty-query', async () => {
  const root = _sandbox();
  try {
    const memory = createMemory({ provider: _mockProvider(), indexEngine: _mockIndex(), cwd: root });
    await assert.rejects(memory.query('', {}), (err) => err.code === 'memory-empty-query');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MEM-15: query on empty index returns empty array', async () => {
  const root = _sandbox();
  try {
    const memory = createMemory({ provider: _mockProvider(), indexEngine: _mockIndex(), cwd: root });
    const hits = await memory.query('something', { k: 5 });
    assert.deepEqual(hits, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MEM-16: index persists records.jsonl as append-only across instances', async () => {
  const root = _sandbox();
  try {
    const m1 = createMemory({ provider: _mockProvider(), indexEngine: _mockIndex(), cwd: root });
    await m1.index([{ type: 'learning', title: 'A', body: 'x' }]);

    const m2 = createMemory({ provider: _mockProvider(), indexEngine: _mockIndex(), cwd: root });
    await m2.index([{ type: 'learning', title: 'B', body: 'y' }]);

    const lines = fs.readFileSync(path.join(root, '.nubos-pilot', 'memory', 'records.jsonl'), 'utf-8').split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MEM-17: index writes records.jsonl BEFORE the durable saveSync (records-as-source-of-truth)', async () => {
  // Pin the inverted crash-safety order: records.jsonl is committed first so
  // a crash between the two writes leaves a rebuild-able state (records ≥
  // index). The inverse order (index first) would leave an index referencing
  // ids that have no JSONL row — `query()` silently drops those hits and
  // recall degrades without a signal. Recovery from this state is
  // `np memory-rebuild`, which re-derives the index from records.jsonl.
  const root = _sandbox();
  const origAppend = fs.appendFileSync;
  let observedDuringAppend = null;
  try {
    const idx = _mockIndex();
    const memory = createMemory({ provider: _mockProvider(), indexEngine: idx, cwd: root });
    fs.appendFileSync = function (...args) {
      const indexPath = path.join(root, '.nubos-pilot', 'memory', 'index.usearch');
      observedDuringAppend = {
        indexExistsDuringAppend: fs.existsSync(indexPath),
      };
      return origAppend.apply(fs, args);
    };
    await memory.index([{ type: 'learning', title: 'A', body: 'first' }]);
    assert.ok(observedDuringAppend, 'appendFileSync was called');
    assert.equal(
      observedDuringAppend.indexExistsDuringAppend,
      false,
      'index.usearch must NOT yet exist on disk when records.jsonl is appended (proves records-before-index order)',
    );
  } finally {
    fs.appendFileSync = origAppend;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MEM-18: drift detected (jsonl > index) emits stderr warning on next open', async () => {
  const root = _sandbox();
  const origWrite = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = (chunk) => { captured += String(chunk); return true; };
  try {
    const m1 = createMemory({ provider: _mockProvider(), indexEngine: _mockIndex(), cwd: root });
    await m1.index([{ type: 'learning', title: 'A', body: 'x' }]);
    fs.appendFileSync(
      path.join(root, '.nubos-pilot', 'memory', 'records.jsonl'),
      JSON.stringify({ id: 'ghost-1', type: 'learning', title: 'G', body: 'g', tags: [], provenance: null, created_at: '2026-01-01T00:00:00Z' }) + '\n',
      'utf-8',
    );
    const m2 = createMemory({ provider: _mockProvider(), indexEngine: _mockIndex(), cwd: root });
    await m2.query('probe', { k: 1 });
    assert.match(captured, /drift detected/);
    assert.match(captured, /memory-rebuild/);
  } finally {
    process.stderr.write = origWrite;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MEM-19: drift detected (index > jsonl) emits stderr warning on next open', async () => {
  const root = _sandbox();
  const origWrite = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = (chunk) => { captured += String(chunk); return true; };
  try {
    const idx = _mockIndex();
    const m1 = createMemory({ provider: _mockProvider(), indexEngine: idx, cwd: root });
    await m1.index([{ type: 'learning', title: 'A', body: 'x' }]);
    fs.writeFileSync(
      path.join(root, '.nubos-pilot', 'memory', 'records.jsonl'),
      '',
      'utf-8',
    );
    const m2 = createMemory({ provider: _mockProvider(), indexEngine: _mockIndex(), cwd: root });
    await m2.query('probe', { k: 1 });
    assert.match(captured, /drift detected/);
  } finally {
    process.stderr.write = origWrite;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MEM-20: index() throws memory-drift-detected when drift is present', async () => {
  const root = _sandbox();
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  try {
    const m1 = createMemory({ provider: _mockProvider(), indexEngine: _mockIndex(), cwd: root });
    await m1.index([{ type: 'learning', title: 'A', body: 'x' }]);
    fs.appendFileSync(
      path.join(root, '.nubos-pilot', 'memory', 'records.jsonl'),
      JSON.stringify({ id: 'ghost-1', type: 'learning', title: 'G', body: 'g', tags: [], provenance: null, created_at: '2026-01-01T00:00:00Z' }) + '\n',
      'utf-8',
    );
    const m2 = createMemory({ provider: _mockProvider(), indexEngine: _mockIndex(), cwd: root });
    await assert.rejects(
      m2.index([{ type: 'learning', title: 'B', body: 'y' }]),
      (err) =>
        err && err.code === 'memory-drift-detected'
        && /memory-rebuild/.test(err.message || ''),
    );
  } finally {
    process.stderr.write = origWrite;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MEM-21: same-instance retry after saveSync throw re-syncs from disk', async () => {
  const root = _sandbox();
  try {
    const idx = _mockIndex();
    let throwOnce = true;
    const origSave = idx.saveSync.bind(idx);
    idx.saveSync = function (...args) {
      if (throwOnce) {
        throwOnce = false;
        throw new Error('synthetic saveSync failure');
      }
      return origSave(...args);
    };
    const memory = createMemory({ provider: _mockProvider(), indexEngine: idx, cwd: root });
    await assert.rejects(
      memory.index([{ type: 'learning', title: 'A', body: 'x' }]),
      (err) => /synthetic saveSync failure/.test(err.message || ''),
    );
    const result = await memory.index([{ type: 'learning', title: 'B', body: 'y' }]);
    assert.equal(result.added, 1);
    const lines = fs.readFileSync(
      path.join(root, '.nubos-pilot', 'memory', 'records.jsonl'),
      'utf-8',
    ).split('\n').filter(Boolean);
    assert.equal(lines.length, 1, 'only the successful record reaches jsonl');
    assert.equal(JSON.parse(lines[0]).title, 'B');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
