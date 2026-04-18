const test = require('node:test');
const assert = require('node:assert/strict');

test('managed-block: rewriteBlock inserts block when markers are absent (D-11)', () => {
  const { rewriteBlock } = require('../../lib/install/managed-block.cjs');
  const user = '# My Project\n\nSome content.\n';
  const out = rewriteBlock(user, 'managed content here');
  assert.ok(out.includes('<!-- nubos-pilot:begin'));
  assert.ok(out.includes('<!-- nubos-pilot:end -->'));
  assert.ok(out.includes('managed content here'));
  assert.ok(out.includes('# My Project'), 'user content preserved');
});

test('managed-block: rewriteBlock replaces existing block idempotently (D-11)', () => {
  const { rewriteBlock } = require('../../lib/install/managed-block.cjs');
  const user = '# My Project\n\nSome content.\n';
  const once = rewriteBlock(user, 'v1 content');
  const twice = rewriteBlock(once, 'v1 content');
  assert.equal(twice, once, 'two consecutive rewrites must be identical');
  const updated = rewriteBlock(once, 'v2 content');
  assert.ok(updated.includes('v2 content'));
  assert.ok(!updated.includes('v1 content'), 'old managed content replaced');
});

test('managed-block: stripBlock removes block and trims trailing blank lines (D-20)', () => {
  const { rewriteBlock, stripBlock } = require('../../lib/install/managed-block.cjs');
  const withBlock = rewriteBlock('# Project\n\n', 'managed');
  const stripped = stripBlock(withBlock);
  assert.ok(!stripped.includes('nubos-pilot:begin'));
  assert.ok(!stripped.includes('nubos-pilot:end'));
  assert.ok(!stripped.endsWith('\n\n\n'), 'no 3+ trailing blank lines');
  assert.ok(stripped.includes('# Project'), 'user content preserved');
});
