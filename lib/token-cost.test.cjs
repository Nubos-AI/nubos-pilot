'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const tc = require('./token-cost.cjs');

test('TC-1: estimateTokens uses chars-per-token and defaults sanely', () => {
  assert.equal(tc.estimateTokens(4000, 4), 1000);
  assert.equal(tc.estimateTokens(4000), 1000);
  assert.equal(tc.estimateTokens(0, 4), 0);
  assert.equal(tc.estimateTokens(100, 0), 25);
});

test('TC-2: estimateCost returns null without a positive price', () => {
  assert.equal(tc.estimateCost(1_000_000, null), null);
  assert.equal(tc.estimateCost(1_000_000, 0), null);
  assert.equal(tc.estimateCost(1_000_000, 3), 3);
});

test('TC-3: summarizeSavings reports tokens only when no price is given', () => {
  const s = tc.summarizeSavings({ bytesBefore: 8000, bytesAfter: 2000, charsPerToken: 4 });
  assert.equal(s.bytes_saved, 6000);
  assert.equal(s.tokens_saved_est, 1500);
  assert.equal(s.saved_pct, 75);
  assert.equal(s.cost_saved_est, undefined, 'no cost without a price');
  assert.equal(s.currency, undefined);
});

test('TC-4: summarizeSavings adds a cost estimate + currency when priced', () => {
  const s = tc.summarizeSavings({ bytesBefore: 8000, bytesAfter: 2000, charsPerToken: 4, pricePerMTok: 3, currency: 'EUR' });
  assert.equal(s.tokens_saved_est, 1500);
  assert.equal(s.cost_saved_est, 0.0045);
  assert.equal(s.currency, 'EUR');
  assert.equal(s.price_per_mtok, 3);
});

test('TC-5: never negative when output is somehow larger than input', () => {
  const s = tc.summarizeSavings({ bytesBefore: 100, bytesAfter: 400 });
  assert.equal(s.bytes_saved, 0);
  assert.equal(s.tokens_saved_est, 0);
});
