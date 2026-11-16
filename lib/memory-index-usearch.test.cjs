'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createUsearchIndex } = require('./memory-index-usearch.cjs');

function mkSandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'np-usearch-'));
}

const DIM = 4;
function vec(seed) {
  return new Float32Array([seed, seed + 1, seed + 2, seed + 3]);
}

test('UI-1 save/load round-trip — vectors searchable from a fresh index', () => {
  const dir = mkSandbox();
  try {
    const file = path.join(dir, 'index.usearch');
    const a = createUsearchIndex({ dim: DIM });
    a.add('rec-1', vec(1));
    a.add('rec-2', vec(50));
    a.saveSync(file);

    const b = createUsearchIndex({ dim: DIM });
    b.loadSync(file);
    assert.equal(b.size(), 2);
    const hits = b.search(vec(1), 1);
    assert.equal(hits[0].id, 'rec-1');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('UI-2 saveSync is atomic — no .tmp leftover, rolling .bak from the second save on', () => {
  const dir = mkSandbox();
  try {
    const file = path.join(dir, 'index.usearch');
    const a = createUsearchIndex({ dim: DIM });
    a.add('rec-1', vec(1));
    a.saveSync(file);
    assert.equal(fs.existsSync(file + '.tmp'), false, 'no .tmp leftover after rename');
    assert.equal(fs.existsSync(file + '.bak'), false, 'first save has no prior index to back up');

    a.add('rec-2', vec(2));
    a.saveSync(file);
    assert.equal(fs.existsSync(file + '.bak'), true, 'second save rolls a .bak of the prior index');
    assert.equal(fs.existsSync(file + '.tmp'), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('UI-3 loadSync throws memory-index-desync when the keymap is missing', () => {
  const dir = mkSandbox();
  try {
    const file = path.join(dir, 'index.usearch');
    const a = createUsearchIndex({ dim: DIM });
    a.add('rec-1', vec(1));
    a.saveSync(file);
    fs.unlinkSync(file + '.keymap.json');

    const b = createUsearchIndex({ dim: DIM });
    assert.throws(
      () => b.loadSync(file),
      (err) => err && err.name === 'NubosPilotError' && err.code === 'memory-index-desync',
    );
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('UI-4 loadSync throws memory-index-keymap-corrupt on a non-JSON keymap', () => {
  const dir = mkSandbox();
  try {
    const file = path.join(dir, 'index.usearch');
    const a = createUsearchIndex({ dim: DIM });
    a.add('rec-1', vec(1));
    a.saveSync(file);
    fs.writeFileSync(file + '.keymap.json', '{not json', 'utf-8');

    const b = createUsearchIndex({ dim: DIM });
    assert.throws(
      () => b.loadSync(file),
      (err) => err && err.code === 'memory-index-keymap-corrupt',
    );
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('UI-5 loadSync skips a malformed keymap key instead of crashing (BigInt DoS guard)', () => {
  const dir = mkSandbox();
  try {
    const file = path.join(dir, 'index.usearch');
    const a = createUsearchIndex({ dim: DIM });
    a.add('rec-1', vec(1));
    a.saveSync(file);
    // A non-numeric key would make BigInt() throw uncaught and crash every
    // memory operation; loadSync must skip it, not die.
    const map = JSON.parse(fs.readFileSync(file + '.keymap.json', 'utf-8'));
    map['not-a-number'] = 'rec-evil';
    fs.writeFileSync(file + '.keymap.json', JSON.stringify(map), 'utf-8');

    const b = createUsearchIndex({ dim: DIM });
    b.loadSync(file);
    assert.equal(b.size(), 1, 'only the well-formed key/id pair is loaded');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
