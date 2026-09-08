'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  VALID_ECONOMY_MODES,
  DEFAULT_ECONOMY_MODE,
  resolveEconomyMode,
  preventionOn,
  criticOn,
  isUltra,
  economyFlags,
} = require('./economy-mode.cjs');

test('default is lite (prevention-first) when nothing is set', () => {
  assert.equal(DEFAULT_ECONOMY_MODE, 'lite');
  assert.equal(resolveEconomyMode({}), 'lite');
  assert.equal(resolveEconomyMode({ agents: {} }), 'lite');
  assert.equal(resolveEconomyMode(null), 'lite');
  assert.equal(resolveEconomyMode(undefined), 'lite');
});

test('explicit agents.economy wins for every valid mode', () => {
  for (const mode of VALID_ECONOMY_MODES) {
    assert.equal(resolveEconomyMode({ agents: { economy: mode } }), mode);
  }
});

test('legacy agents.economy_critic maps true→full, false→lite', () => {
  assert.equal(resolveEconomyMode({ agents: { economy_critic: true } }), 'full');
  assert.equal(resolveEconomyMode({ agents: { economy_critic: false } }), 'lite');
});

test('non-boolean legacy economy_critic falls back to the lite default (schema warns separately)', () => {
  assert.equal(resolveEconomyMode({ agents: { economy_critic: 'true' } }), 'lite');
  assert.equal(resolveEconomyMode({ agents: { economy_critic: 1 } }), 'lite');
  assert.equal(resolveEconomyMode({ agents: { economy_critic: null } }), 'lite');
});

test('explicit economy overrides the legacy bool', () => {
  assert.equal(resolveEconomyMode({ agents: { economy: 'off', economy_critic: true } }), 'off');
  assert.equal(resolveEconomyMode({ agents: { economy: 'ultra', economy_critic: false } }), 'ultra');
});

test('invalid explicit economy throws loud (no silent default)', () => {
  assert.throws(
    () => resolveEconomyMode({ agents: { economy: 'banana' } }),
    (err) => err.code === 'config-invalid-economy-mode',
  );
  assert.throws(
    () => resolveEconomyMode({ agents: { economy: 42 } }),
    (err) => err.code === 'config-invalid-economy-mode',
  );
});

test('flag helpers gate prevention/critic/ultra correctly', () => {
  assert.equal(preventionOn('off'), false);
  assert.equal(preventionOn('lite'), true);
  assert.equal(preventionOn('full'), true);
  assert.equal(preventionOn('ultra'), true);

  assert.equal(criticOn('off'), false);
  assert.equal(criticOn('lite'), false);
  assert.equal(criticOn('full'), true);
  assert.equal(criticOn('ultra'), true);

  assert.equal(isUltra('ultra'), true);
  assert.equal(isUltra('full'), false);
});

test('economyFlags bundles the resolved mode with its gates', () => {
  assert.deepEqual(economyFlags({ agents: { economy: 'off' } }), {
    mode: 'off', prevention: false, critic: false, ultra: false,
  });
  assert.deepEqual(economyFlags({}), {
    mode: 'lite', prevention: true, critic: false, ultra: false,
  });
  assert.deepEqual(economyFlags({ agents: { economy: 'full' } }), {
    mode: 'full', prevention: true, critic: true, ultra: false,
  });
  assert.deepEqual(economyFlags({ agents: { economy: 'ultra' } }), {
    mode: 'ultra', prevention: true, critic: true, ultra: true,
  });
});
