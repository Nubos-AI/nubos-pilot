const { test } = require('node:test');
const assert = require('node:assert/strict');

const { MODEL_ALIAS_MAP } = require('./model-profiles.cjs');

test('MAR-1: MODEL_ALIAS_MAP snapshot — fail loud on silent alias bump (D-17)', () => {
  assert.deepEqual(
    MODEL_ALIAS_MAP,
    {
      opus:   'claude-opus-4-7',
      sonnet: 'claude-sonnet-4-6',
      haiku:  'claude-haiku-4-5',
    },
    'Regression gate: MODEL_ALIAS_MAP changed. Release checklist REQUIRES running this test on pre-bump main and confirming the failure message BEFORE updating the alias map. If this failure is expected, bump the literals in BOTH model-profiles.cjs AND this test in a single commit citing the Anthropic release URL.',
  );
});
