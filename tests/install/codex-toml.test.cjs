const test = require('node:test');
const assert = require('node:assert/strict');

test('codex-toml: hasTrappedFeatures returns true for non-boolean key under [features] (D-12)', () => {
  const { hasTrappedFeatures } = require('../../lib/install/codex-toml.cjs');
  const trapped = [
    '[features]',
    'model = "opus"',
    'x = true',
    '',
  ].join('\n');
  assert.equal(hasTrappedFeatures(trapped), true);

  const clean = [
    '[features]',
    'x = true',
    'y = false',
    '',
  ].join('\n');
  assert.equal(hasTrappedFeatures(clean), false);
});

test('codex-toml: repairTrappedFeatures relocates trapped keys above [features] header (D-12)', () => {
  const { repairTrappedFeatures } = require('../../lib/install/codex-toml.cjs');
  const input = [
    '[other]',
    'foo = 1',
    '',
    '[features]',
    'model = "opus"',
    'x = true',
    '',
  ].join('\n');
  const out = repairTrappedFeatures(input);
  const modelLineIdx = out.split('\n').findIndex((l) => /^model\s*=/.test(l));
  const featuresLineIdx = out.split('\n').findIndex((l) => /^\[features\]\s*$/.test(l));
  assert.ok(modelLineIdx >= 0, 'model line preserved');
  assert.ok(featuresLineIdx >= 0, '[features] header preserved');
  assert.ok(modelLineIdx < featuresLineIdx, 'trapped key relocated above [features] header');
});

test('codex-toml: CRLF line endings are preserved after repair (D-12 + Pitfall 2)', () => {
  const { repairTrappedFeatures, detectLineEnding } = require('../../lib/install/codex-toml.cjs');
  const crlf = '[features]\r\nmodel = "opus"\r\nx = true\r\n';
  assert.equal(detectLineEnding(crlf), '\r\n');
  const out = repairTrappedFeatures(crlf);
  assert.ok(out.includes('\r\n'), 'CRLF preserved');
  assert.ok(!/\n(?!\r)/.test(out.replace(/\r\n/g, '')), 'no bare LF introduced');
});
