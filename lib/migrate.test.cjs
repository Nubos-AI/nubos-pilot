'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { runMigrators, MAX_HOPS } = require('./migrate.cjs');
const { NubosPilotError } = require('./core.cjs');

test('MIG-1: object already at target version is returned unchanged', () => {
  const obj = { version: 2, payload: 'x' };
  const out = runMigrators(obj, { targetVersion: 2, migrators: {} });
  assert.equal(out, obj);
});

test('MIG-2: single hop runs the matching migrator', () => {
  const out = runMigrators({ version: 1, n: 1 }, {
    targetVersion: 2,
    migrators: { 1: (v) => ({ version: 2, n: v.n + 1 }) },
  });
  assert.deepEqual(out, { version: 2, n: 2 });
});

test('MIG-3: multi-hop chain runs each hop until target', () => {
  const out = runMigrators({ version: 0, steps: [] }, {
    targetVersion: 3,
    migrators: {
      0: (v) => ({ version: 1, steps: [...v.steps, 'a'] }),
      1: (v) => ({ version: 2, steps: [...v.steps, 'b'] }),
      2: (v) => ({ version: 3, steps: [...v.steps, 'c'] }),
    },
  });
  assert.deepEqual(out.steps, ['a', 'b', 'c']);
});

test('MIG-4: missing migrator for a version returns null', () => {
  const out = runMigrators({ version: 99 }, { targetVersion: 1, migrators: {} });
  assert.equal(out, null);
});

test('MIG-5: migrator returning a non-object returns null', () => {
  const out = runMigrators({ version: 0 }, { targetVersion: 1, migrators: { 0: () => null } });
  assert.equal(out, null);
});

test('MIG-6: hop cap prevents an infinite migrator cycle', () => {
  const out = runMigrators({ version: 0 }, {
    targetVersion: 999,
    migrators: { 0: () => ({ version: 0 }) },
  });
  assert.equal(out, null);
});

test('MIG-7: pure function — input object is not mutated', () => {
  const input = { version: 0, n: 1 };
  runMigrators(input, { targetVersion: 1, migrators: { 0: (v) => ({ version: 1, n: v.n + 1 }) } });
  assert.deepEqual(input, { version: 0, n: 1 });
});

test('MIG-8: migrated shape is validated against the given schema', () => {
  assert.throws(
    () => runMigrators({ version: 0, learnings: [] }, {
      targetVersion: 1,
      migrators: { 0: () => ({ version: 1, learnings: [{ fingerprint: 'NOTHEX', occurrence: 1 }] }) },
      schema: 'learnings.v1',
      code: 'learnings-store-corrupt',
      details: { path: '<test>' },
    }),
    (err) => err instanceof NubosPilotError && err.code === 'learnings-store-corrupt',
  );
});

test('MIG-9: custom versionField is honoured', () => {
  const out = runMigrators({ schema_version: 1, ok: true }, {
    versionField: 'schema_version',
    targetVersion: 1,
    migrators: {},
  });
  assert.deepEqual(out, { schema_version: 1, ok: true });
});

test('MIG-10: MAX_HOPS is a finite positive cap', () => {
  assert.ok(Number.isInteger(MAX_HOPS) && MAX_HOPS > 0);
});

test('MIG-11: a version matching an Object.prototype member returns null, not a raw throw', () => {
  for (const poison of ['valueOf', 'hasOwnProperty', 'toString', 'constructor', '__proto__']) {
    let out;
    assert.doesNotThrow(() => { out = runMigrators({ version: poison }, { targetVersion: 1, migrators: {} }); });
    assert.equal(out, null);
  }
});
