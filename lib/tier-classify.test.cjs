'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { classifyTier, isValidTier, SIZE_TO_TIER } = require('./tier-classify.cjs');

test('TC-1: security keyword forces large→opus regardless of file count', () => {
  const r = classifyTier({ files_modified: ['app/Auth.php'], name: 'Add password reset flow' });
  assert.strictEqual(r.size, 'large');
  assert.strictEqual(r.tier, 'opus');
  assert.strictEqual(r.signals.risk, true);
});

test('TC-2: migration path escalates to large', () => {
  const r = classifyTier({ files_modified: ['db/migrations/003_add_col.sql'], name: 'add column' });
  assert.strictEqual(r.tier, 'opus');
  assert.strictEqual(r.signals.risk, true);
});

test('TC-3: many files → large even without risk/arch keywords', () => {
  const r = classifyTier({ files_modified: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'], name: 'wire feature' });
  assert.strictEqual(r.size, 'large');
  assert.strictEqual(r.tier, 'opus');
});

test('TC-4: architectural keyword → large', () => {
  const r = classifyTier({ files_modified: ['svc.ts'], name: 'refactor the orchestration interface' });
  assert.strictEqual(r.size, 'large');
  assert.strictEqual(r.signals.arch, true);
});

test('TC-5: single-file doc/typo → trivial→haiku', () => {
  const r = classifyTier({ files_modified: ['README.md'], name: 'fix typo in readme' });
  assert.strictEqual(r.size, 'trivial');
  assert.strictEqual(r.tier, 'haiku');
  assert.strictEqual(r.signals.trivial, true);
});

test('TC-6: ordinary single-concern → standard→sonnet', () => {
  const r = classifyTier({ files_modified: ['app/Service.php', 'app/Service.test.php'], name: 'add discount calculation' });
  assert.strictEqual(r.size, 'standard');
  assert.strictEqual(r.tier, 'sonnet');
});

test('TC-7: trivial keyword but multiple files is NOT trivial', () => {
  const r = classifyTier({ files_modified: ['a.ts', 'b.ts'], name: 'rename helper' });
  assert.strictEqual(r.size, 'standard');
});

test('TC-8: empty/missing input → standard, no throw', () => {
  const r = classifyTier({});
  assert.strictEqual(r.size, 'standard');
  assert.strictEqual(r.signals.file_count, 0);
  const r2 = classifyTier(null);
  assert.strictEqual(r2.size, 'standard');
});

test('TC-9: every emitted tier is a valid tier', () => {
  for (const size of Object.keys(SIZE_TO_TIER)) {
    assert.ok(isValidTier(SIZE_TO_TIER[size]), size + ' maps to a valid tier');
  }
});

test('TC-10: deterministic — same input twice yields identical result', () => {
  const input = { files_modified: ['x.ts'], name: 'add token validation' };
  assert.deepStrictEqual(classifyTier(input), classifyTier(input));
});
