'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const elision = require('./elision.cjs');

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-elision-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  return root;
}

function writeConfig(root, compression) {
  fs.writeFileSync(
    path.join(root, '.nubos-pilot', 'config.json'),
    JSON.stringify({ compression }),
  );
}

test('ELISION-1: store then retrieve is lossless', () => {
  const root = sandbox();
  try {
    const original = 'line one\nERROR boom\nline three';
    const hash = elision.store(original, { type: 'log' }, root);
    assert.match(hash, /^[a-f0-9]{12}$/);
    const got = elision.retrieve(hash, root);
    assert.equal(got.status, 'ok');
    assert.equal(got.original, original);
    assert.equal(got.type, 'log');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ELISION-2: store is idempotent for identical content', () => {
  const root = sandbox();
  try {
    const h1 = elision.store('same', { type: 'plain' }, root);
    const p = path.join(root, '.nubos-pilot', 'elision', h1 + '.json');
    const mtime1 = fs.statSync(p).mtimeMs;
    const h2 = elision.store('same', { type: 'plain' }, root);
    assert.equal(h2, h1);
    assert.equal(fs.statSync(p).mtimeMs, mtime1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ELISION-3: unknown and malformed hashes return not_found', () => {
  const root = sandbox();
  try {
    assert.equal(elision.retrieve('aaaaaaaaaaaa', root).status, 'not_found');
    assert.equal(elision.retrieve('NOT-A-HASH', root).status, 'not_found');
    assert.equal(elision.retrieve(null, root).status, 'not_found');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ELISION-4: an entry past its ttl reports expired', () => {
  const root = sandbox();
  try {
    const hash = elision.hashOf('old payload');
    const dir = path.join(root, '.nubos-pilot', 'elision');
    fs.mkdirSync(dir, { recursive: true });
    const entry = {
      version: 1,
      hash,
      original: 'old payload',
      type: 'plain',
      created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      ttl_ms: 1000,
      original_bytes: 11,
      compressed_bytes: 0,
    };
    fs.writeFileSync(path.join(dir, hash + '.json'), JSON.stringify(entry));
    assert.equal(elision.retrieve(hash, root).status, 'expired');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ELISION-5: prune removes only expired entries', () => {
  const root = sandbox();
  try {
    const fresh = elision.store('fresh', { type: 'plain' }, root);
    const staleHash = elision.hashOf('stale');
    const dir = path.join(root, '.nubos-pilot', 'elision');
    fs.writeFileSync(path.join(dir, staleHash + '.json'), JSON.stringify({
      version: 1, hash: staleHash, original: 'stale', type: 'plain',
      created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      ttl_ms: 1000, original_bytes: 5, compressed_bytes: 0,
    }));
    const res = elision.prune(root);
    assert.equal(res.removed, 1);
    assert.equal(elision.retrieve(fresh, root).status, 'ok');
    assert.equal(elision.retrieve(staleHash, root).status, 'not_found');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ELISION-6: compressionContext is disabled by default', () => {
  const root = sandbox();
  try {
    const cx = elision.compressionContext(root);
    assert.equal(cx.enabled, false);
    assert.equal(cx.store, null);
    assert.equal(cx.verifyMaxBytes, 2000);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ELISION-7: compressionContext yields a working store when enabled', () => {
  const root = sandbox();
  try {
    writeConfig(root, { enabled: true });
    const cx = elision.compressionContext(root);
    assert.equal(cx.enabled, true);
    assert.equal(typeof cx.store, 'function');
    const hash = cx.store('cached body', 'plain');
    assert.equal(elision.retrieve(hash, root).original, 'cached body');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ELISION-8: compressionContext store is null when elision is disabled', () => {
  const root = sandbox();
  try {
    writeConfig(root, { enabled: true, elision: { enabled: false } });
    const cx = elision.compressionContext(root);
    assert.equal(cx.enabled, true);
    assert.equal(cx.store, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
