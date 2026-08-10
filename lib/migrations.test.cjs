'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { MigrationRegistry } = require('./migrations.cjs');

test('MIG-1 register + run a single step transforms the doc', () => {
  const reg = new MigrationRegistry();
  reg.register('roadmap', 1, 2, (doc) => ({ ...doc, schema_version: 2 }));
  const out = reg.run('roadmap', { schema_version: 1, projects: [] }, 1, 2);
  assert.equal(out.schema_version, 2);
  assert.deepEqual(out.projects, []);
});

test('MIG-2 chained steps run in order (v1→v2→v3)', () => {
  const reg = new MigrationRegistry();
  const trace = [];
  reg.register('checkpoint', 1, 2, (doc) => { trace.push('1->2'); return { ...doc, v: 2 }; });
  reg.register('checkpoint', 2, 3, (doc) => { trace.push('2->3'); return { ...doc, v: 3 }; });
  const out = reg.run('checkpoint', { v: 1 }, 1, 3);
  assert.deepEqual(trace, ['1->2', '2->3']);
  assert.equal(out.v, 3);
});

test('MIG-3 same version is a no-op', () => {
  const reg = new MigrationRegistry();
  const doc = { schema_version: 2 };
  assert.equal(reg.run('roadmap', doc, 2, 2), doc);
});

test('MIG-4 downgrade is rejected', () => {
  const reg = new MigrationRegistry();
  assert.throws(
    () => reg.run('roadmap', {}, 2, 1),
    (err) => err.code === 'migration-downgrade-unsupported',
  );
});

test('MIG-5 missing intermediate step is rejected with the missing step in details', () => {
  const reg = new MigrationRegistry();
  reg.register('roadmap', 1, 2, (d) => d);
  // v2→v3 not registered
  let thrown;
  try { reg.run('roadmap', {}, 1, 3); } catch (e) { thrown = e; }
  assert.ok(thrown);
  assert.equal(thrown.code, 'migration-missing-step');
  assert.equal(thrown.details.missingStep, '2->3');
});

test('MIG-6 register rejects non-single-step migrations (1→3)', () => {
  const reg = new MigrationRegistry();
  assert.throws(
    () => reg.register('roadmap', 1, 3, (d) => d),
    (err) => err.code === 'migration-invalid-step',
  );
});

test('MIG-7 register rejects duplicate registration', () => {
  const reg = new MigrationRegistry();
  reg.register('roadmap', 1, 2, (d) => d);
  assert.throws(
    () => reg.register('roadmap', 1, 2, (d) => d),
    (err) => err.code === 'migration-duplicate',
  );
});

test('MIG-8 unknown kind without any migration registered throws migration-no-path', () => {
  const reg = new MigrationRegistry();
  assert.throws(
    () => reg.run('roadmap', {}, 1, 2),
    (err) => err.code === 'migration-no-path',
  );
});

test('MIG-9 has() reports whether a step is registered', () => {
  const reg = new MigrationRegistry();
  reg.register('state', 1, 2, (d) => d);
  assert.equal(reg.has('state', 1, 2), true);
  assert.equal(reg.has('state', 2, 3), false);
  assert.equal(reg.has('roadmap', 1, 2), false);
});
