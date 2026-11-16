'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { safeYamlParse, DEFAULT_MAX_BYTES, DEFAULT_MAX_ALIASES } = require('./yaml.cjs');

test('YAML-1 happy-path parse returns expected document', () => {
  const doc = safeYamlParse('name: foo\nversion: 1\n', { kind: 'test' });
  assert.deepEqual(doc, { name: 'foo', version: 1 });
});

test('YAML-2 oversize input is rejected with yaml-too-large', () => {
  const huge = 'a: ' + 'x'.repeat(DEFAULT_MAX_BYTES + 10);
  let thrown;
  try { safeYamlParse(huge, { kind: 'test' }); } catch (e) { thrown = e; }
  assert.ok(thrown);
  assert.equal(thrown.code, 'yaml-too-large');
  assert.ok(thrown.details.bytes > DEFAULT_MAX_BYTES);
});

test('YAML-3 anchor-bomb (billion-laughs variant) is rejected by maxAliases', () => {
  // Crafted nested-alias expansion exceeding 100 aliases.
  const bomb = [
    'a: &a [1,2,3,4,5,6,7,8,9,10]',
    'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]',
    'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]',
    'd: [*c,*c,*c,*c,*c,*c,*c,*c,*c,*c]',
  ].join('\n');
  let thrown;
  try { safeYamlParse(bomb, { kind: 'test', maxAliases: 10 }); } catch (e) { thrown = e; }
  assert.ok(thrown, 'expected throw for alias bomb');
  assert.equal(thrown.code, 'yaml-parse-failed');
});

test('YAML-4 unresolved alias throws yaml-parse-failed with kind in details', () => {
  let thrown;
  try { safeYamlParse('a: *missing_anchor\n', { kind: 'roadmap' }); } catch (e) { thrown = e; }
  assert.ok(thrown);
  assert.equal(thrown.code, 'yaml-parse-failed');
  assert.equal(thrown.details.kind, 'roadmap');
});

test('YAML-5 non-string input throws yaml-invalid-input', () => {
  for (const bad of [null, undefined, 42, {}, []]) {
    let thrown;
    try { safeYamlParse(bad, { kind: 'test' }); } catch (e) { thrown = e; }
    assert.ok(thrown);
    assert.equal(thrown.code, 'yaml-invalid-input');
  }
});

test('YAML-6 custom maxBytes override is honoured', () => {
  const small = 'a: 1\n';
  // 5 chars + newline = 6 bytes; cap below should fail.
  let thrown;
  try { safeYamlParse(small, { maxBytes: 4 }); } catch (e) { thrown = e; }
  assert.ok(thrown);
  assert.equal(thrown.code, 'yaml-too-large');
});

test('YAML-7 defaults are sane (1 MiB, 100 aliases)', () => {
  assert.equal(DEFAULT_MAX_BYTES, 1024 * 1024);
  assert.equal(DEFAULT_MAX_ALIASES, 100);
});
