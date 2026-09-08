'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { shannon, isHighEntropy, classifyCharset, DEFAULTS } = require('./entropy.cjs');

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function chars(n, seed, alphabet) {
  let out = '';
  let round = 0;
  while (out.length < n) {
    const digest = crypto.createHash('sha256').update(seed + ':' + round).digest();
    round++;
    for (const byte of digest) {
      out += alphabet[byte % alphabet.length];
      if (out.length >= n) break;
    }
  }
  return out;
}

const alnum = (n, seed) => chars(n, seed, ALNUM);
const hex = (n, seed) => chars(n, seed, '0123456789abcdef');
const b64 = (n, seed) => chars(n, seed, ALNUM + '+/');
const b64url = (n, seed) => chars(n, seed, ALNUM + '-_');

test('ENT-1 shannon returns bits per character and bottoms out on a single symbol', () => {
  assert.equal(shannon(''), 0);
  assert.equal(shannon('aaaaaaaa'), 0);
  assert.equal(shannon('ab'), 1);
  assert.equal(shannon('abcd'), 2);
  assert.ok(shannon(alnum(64, 'e1')) > 5);
});

test('ENT-2 shannon is scale free: repeating a string does not change bits per char', () => {
  const one = shannon('abcdefgh');
  const four = shannon('abcdefgh'.repeat(4));
  assert.ok(Math.abs(one - four) < 1e-9, one + ' vs ' + four);
});

test('ENT-3 shannon and classifyCharset reject non-string input loudly', () => {
  assert.throws(() => shannon(null), (err) => err.code === 'entropy-shannon-invalid-input');
  assert.throws(() => shannon(42), (err) => err.code === 'entropy-shannon-invalid-input');
  assert.throws(() => classifyCharset(undefined), (err) => err.code === 'entropy-charset-invalid-input');
});

test('ENT-4 classifyCharset separates hex, alnum, base64url and base64', () => {
  assert.equal(classifyCharset(hex(40, 'c1')), 'hex');
  assert.equal(classifyCharset('deadbeefDEADBEEF'), 'hex');
  assert.equal(classifyCharset('abcdefghij0123456789'), 'alnum');
  assert.equal(classifyCharset('abcXYZ012-_abcXYZ012'), 'base64url');
  assert.equal(classifyCharset('abcXYZ012+/abcXYZ012=='), 'base64');
  assert.equal(classifyCharset('has spaces and !punct'), 'other');
  assert.equal(classifyCharset(''), 'other');
});

test('ENT-5 hex clears a lower bar than base64 because hex tops out at 4 bits per char', () => {
  assert.ok(DEFAULTS.thresholds.hex < DEFAULTS.thresholds.base64);
  assert.ok(DEFAULTS.thresholds.hex < 4);
  const hexSecret = hex(40, 'c2');
  assert.ok(shannon(hexSecret) < DEFAULTS.thresholds.base64, 'random hex cannot reach the base64 bar');
  assert.ok(isHighEntropy(hexSecret, { context: 'source' }), 'random hex must still register as high entropy');
});

test('ENT-6 realistic random secrets across charsets are high entropy', () => {
  assert.ok(isHighEntropy(alnum(40, 'r1')));
  assert.ok(isHighEntropy(b64(44, 'r2')));
  assert.ok(isHighEntropy(b64url(40, 'r3')));
  assert.ok(isHighEntropy(hex(32, 'r4')));
});

test('ENT-7 a minimum length is required no matter how random the string looks', () => {
  const secret = alnum(24, 'r5');
  assert.equal(isHighEntropy(secret), true);
  assert.equal(isHighEntropy(secret, { minLength: 32 }), false);
  assert.equal(isHighEntropy(alnum(12, 'r6')), false);
  assert.equal(DEFAULTS.minLength, 20);
});

test('ENT-8 single character runs and near-constant strings are rejected', () => {
  assert.equal(isHighEntropy('a'.repeat(64)), false);
  assert.equal(isHighEntropy('0'.repeat(40)), false);
  assert.equal(isHighEntropy('abab'.repeat(16)), false);
});

test('ENT-9 UUIDs are rejected even though their entropy clears the hex bar', () => {
  const id = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
  assert.ok(shannon(id) > DEFAULTS.thresholds.hex);
  assert.equal(isHighEntropy(id), false);
  assert.equal(isHighEntropy('{3f2504e0-4f89-11d3-9a0c-0305e82c3301}'), false);
});

test('ENT-10 a git SHA is rejected in a lockfile context and judged on merit elsewhere', () => {
  const sha = hex(40, 'sha');
  assert.equal(isHighEntropy(sha, { context: 'lockfile' }), false);
  assert.equal(isHighEntropy(sha, { filePath: 'app/package-lock.json' }), false);
  assert.equal(isHighEntropy(sha, { filePath: 'app/go.sum' }), false);
  assert.equal(isHighEntropy(sha, { filePath: 'src/config.js' }), true);
});

test('ENT-11 subresource integrity hashes are never secrets', () => {
  assert.equal(isHighEntropy('sha512-' + b64(64, 'int')), false);
  assert.equal(isHighEntropy('sha256-' + b64(43, 'int2')), false);
});

test('ENT-12 long English word runs are rejected', () => {
  assert.equal(isHighEntropy('theQuickBrownFoxJumpsOverTheLazyDogAgain'), false);
  assert.equal(isHighEntropy('passwordSecretTokenValueStringNumber'), false);
  assert.equal(isHighEntropy('loremIpsumDolorSitAmetConsectetur'), false);
});

test('ENT-13 data URIs and base64 encoded images are rejected', () => {
  assert.equal(isHighEntropy('data:image/png;base64,' + b64(64, 'img')), false);
  assert.equal(isHighEntropy('iVBORw0KGgo' + b64(80, 'png')), false);
  assert.equal(isHighEntropy('/9j/' + b64(80, 'jpg')), false);
  assert.equal(isHighEntropy('JVBERi0' + b64(80, 'pdf')), false);
});

test('ENT-14 thresholds can be tightened per call without touching the defaults', () => {
  const secret = hex(32, 'thr');
  assert.equal(isHighEntropy(secret), true);
  assert.equal(isHighEntropy(secret, { thresholds: { hex: 3.99 } }), false);
  assert.equal(DEFAULTS.thresholds.hex, 3);
  assert.ok(Object.isFrozen(DEFAULTS));
  assert.ok(Object.isFrozen(DEFAULTS.thresholds));
});

test('ENT-15 non-string input to isHighEntropy is simply not a secret', () => {
  assert.equal(isHighEntropy(null), false);
  assert.equal(isHighEntropy(undefined), false);
  assert.equal(isHighEntropy(12345678901234567890), false);
});
