const { test } = require('node:test');
const assert = require('node:assert/strict');

const mp = require('./model-profiles.cjs');
const { TIER_PROFILE_MATRIX, MODEL_ALIAS_MAP, VALID_TIERS, VALID_PROFILES, resolve } = mp;

test('MP-1: TIER_PROFILE_MATRIX matches D-01 3x4 shape', () => {
  assert.deepEqual(TIER_PROFILE_MATRIX, {
    opus:   { quality: 'opus',   balanced: 'opus',   budget: 'sonnet', inherit: '' },
    sonnet: { quality: 'sonnet', balanced: 'sonnet', budget: 'haiku',  inherit: '' },
    haiku:  { quality: 'sonnet', balanced: 'haiku',  budget: 'haiku',  inherit: '' },
  });
});

test('MP-2: MODEL_ALIAS_MAP matches D-04 literals', () => {
  assert.deepEqual(MODEL_ALIAS_MAP, {
    opus:   'claude-opus-4-7',
    sonnet: 'claude-sonnet-4-6',
    haiku:  'claude-haiku-4-5',
  });
});

test('MP-3: VALID_TIERS deepEquals [haiku, sonnet, opus]', () => {
  assert.deepEqual(VALID_TIERS, ['haiku', 'sonnet', 'opus']);
});

test('MP-4: VALID_PROFILES deepEquals [quality, balanced, budget, inherit]', () => {
  assert.deepEqual(VALID_PROFILES, ['quality', 'balanced', 'budget', 'inherit']);
});

test('MP-5: resolve() returns correct alias per matrix cell', () => {
  assert.equal(resolve('opus', 'balanced'), 'opus');
  assert.equal(resolve('haiku', 'budget'),  'haiku');
  assert.equal(resolve('sonnet', 'budget'), 'haiku');
  assert.equal(resolve('opus', 'budget'),   'sonnet');
  assert.equal(resolve('haiku', 'quality'), 'sonnet');
});

test('MP-6: resolve() returns empty string for inherit profile (D-03)', () => {
  assert.equal(resolve('opus', 'inherit'),   '');
  assert.equal(resolve('haiku', 'inherit'),  '');
  assert.equal(resolve('sonnet', 'inherit'), '');
});

test('MP-7: resolve() throws NubosPilotError(invalid-tier) on unknown tier', () => {
  let thrown = null;
  try { resolve('gpt-4', 'balanced'); } catch (e) { thrown = e; }
  assert.ok(thrown);
  assert.equal(thrown.name, 'NubosPilotError');
  assert.equal(thrown.code, 'invalid-tier');
  assert.equal(thrown.details.got, 'gpt-4');
});

test('MP-8: resolve() throws NubosPilotError(invalid-profile) on unknown profile', () => {
  let thrown = null;
  try { resolve('opus', 'eco'); } catch (e) { thrown = e; }
  assert.ok(thrown);
  assert.equal(thrown.name, 'NubosPilotError');
  assert.equal(thrown.code, 'invalid-profile');
  assert.equal(thrown.details.got, 'eco');
});
