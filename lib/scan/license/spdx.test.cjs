'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { NubosPilotError } = require('../../core.cjs');
const {
  CATEGORIES, normalizeId, classify, parseExpression, isDeprecated,
} = require('./spdx.cjs');

const REQUIRED_IDS = [
  'MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'Unlicense',
  'CC0-1.0', 'Python-2.0', 'PSF-2.0', 'Zlib', 'MPL-2.0', 'LGPL-2.1-only',
  'LGPL-2.1-or-later', 'LGPL-3.0-only', 'LGPL-3.0-or-later', 'GPL-2.0-only',
  'GPL-2.0-or-later', 'GPL-3.0-only', 'GPL-3.0-or-later', 'AGPL-3.0-only',
  'AGPL-3.0-or-later', 'EPL-2.0', 'CDDL-1.1', 'MS-PL', 'WTFPL', 'BSL-1.0',
  'Artistic-2.0', 'CC-BY-4.0', 'CC-BY-SA-4.0',
];

test('SPDX-1 every category is reachable through classify', () => {
  const samples = {
    permissive: 'MIT',
    'weak-copyleft': 'MPL-2.0',
    'strong-copyleft': 'GPL-3.0-only',
    'network-copyleft': 'AGPL-3.0-or-later',
    'public-domain': 'CC0-1.0',
    proprietary: 'UNLICENSED',
    unknown: 'Frobnicate-1.0',
  };
  assert.deepEqual(Object.keys(samples).sort(), [...CATEGORIES].sort());
  for (const [category, id] of Object.entries(samples)) {
    assert.equal(classify(id), category, id + ' should classify as ' + category);
  }
});

test('SPDX-2 the required license set is fully covered and self-normalizing', () => {
  for (const id of REQUIRED_IDS) {
    assert.equal(normalizeId(id), id, id + ' should normalize to itself');
    const category = classify(id);
    assert.ok(CATEGORIES.includes(category), id + ' -> ' + category);
    assert.notEqual(category, 'unknown', id + ' must be classified');
    assert.equal(isDeprecated(id), false, id + ' is not deprecated');
  }
});

test('SPDX-3 normalizeId is case and separator insensitive', () => {
  assert.equal(normalizeId('mit'), 'MIT');
  assert.equal(normalizeId('MIT'), 'MIT');
  assert.equal(normalizeId('  apache-2.0  '), 'Apache-2.0');
  assert.equal(normalizeId('APACHE-2.0'), 'Apache-2.0');
  assert.equal(normalizeId('bsd-3-clause'), 'BSD-3-Clause');
  assert.equal(normalizeId('agpl-3.0-or-later'), 'AGPL-3.0-or-later');
});

test('SPDX-4 normalizeId resolves common non-SPDX manifest aliases', () => {
  const aliases = {
    'Apache 2.0': 'Apache-2.0',
    'Apache License 2.0': 'Apache-2.0',
    'Apache License, Version 2.0': 'Apache-2.0',
    BSD: 'BSD-3-Clause',
    'New BSD': 'BSD-3-Clause',
    'MIT License': 'MIT',
    'The MIT License': 'MIT',
    Expat: 'MIT',
    'Simplified BSD': 'BSD-2-Clause',
    'zlib license': 'Zlib',
    'The Unlicense': 'Unlicense',
    CC0: 'CC0-1.0',
  };
  for (const [raw, expected] of Object.entries(aliases)) {
    assert.equal(normalizeId(raw), expected, JSON.stringify(raw));
  }
});

test('SPDX-5 deprecated bare forms map to the -only variant', () => {
  const deprecated = {
    'GPL-2.0': 'GPL-2.0-only',
    'GPL-3.0': 'GPL-3.0-only',
    'LGPL-2.1': 'LGPL-2.1-only',
    'LGPL-3.0': 'LGPL-3.0-only',
    'AGPL-3.0': 'AGPL-3.0-only',
  };
  for (const [raw, expected] of Object.entries(deprecated)) {
    assert.equal(normalizeId(raw), expected, raw);
    assert.equal(isDeprecated(raw), true, raw + ' is deprecated');
    assert.equal(isDeprecated(expected), false, expected + ' is current');
    assert.equal(classify(raw), classify(expected), raw + ' classifies like ' + expected);
  }
  assert.equal(isDeprecated('gpl-3.0'), true);
});

test('SPDX-6 the deprecated + suffix maps to -or-later', () => {
  assert.equal(normalizeId('GPL-2.0+'), 'GPL-2.0-or-later');
  assert.equal(normalizeId('LGPL-2.1+'), 'LGPL-2.1-or-later');
  assert.equal(isDeprecated('GPL-2.0+'), true);
  assert.equal(classify('GPL-2.0+'), 'strong-copyleft');
});

test('SPDX-7 unknown input keeps the trimmed original and classifies as unknown', () => {
  assert.equal(normalizeId('  Frobnicate-1.0 '), 'Frobnicate-1.0');
  assert.equal(classify('Frobnicate-1.0'), 'unknown');
  assert.equal(normalizeId(null), null);
  assert.equal(normalizeId(''), null);
  assert.equal(normalizeId('   '), null);
  assert.equal(isDeprecated(null), false);
});

test('SPDX-8 UNLICENSED, SEE LICENSE IN and empty licenses are handled', () => {
  assert.equal(classify('UNLICENSED'), 'proprietary');
  assert.equal(classify('unlicensed'), 'proprietary');
  assert.equal(classify('Unlicense'), 'public-domain');
  assert.equal(classify('SEE LICENSE IN LICENSE.md'), 'unknown');
  assert.equal(classify('see licence in ./legal/terms.txt'), 'unknown');
  assert.equal(classify(null), 'unknown');
  assert.equal(classify(''), 'unknown');
  assert.equal(classify('   '), 'unknown');
  assert.deepEqual(parseExpression('SEE LICENSE IN LICENSE.md').ids, []);
});

test('SPDX-9 parseExpression extracts ids and operators across parens', () => {
  const parsed = parseExpression('(MIT OR Apache-2.0) AND ISC');
  assert.deepEqual(parsed.ids, ['MIT', 'Apache-2.0', 'ISC']);
  assert.deepEqual(parsed.operators.sort(), ['AND', 'OR']);
  assert.deepEqual(parsed.exceptions, []);

  const single = parseExpression('MIT');
  assert.deepEqual(single.ids, ['MIT']);
  assert.deepEqual(single.operators, []);

  const nested = parseExpression('MIT OR (Apache-2.0 AND (ISC OR Zlib))');
  assert.deepEqual(nested.ids, ['MIT', 'Apache-2.0', 'ISC', 'Zlib']);

  const lenient = parseExpression('mit or apache-2.0');
  assert.deepEqual(lenient.ids, ['MIT', 'Apache-2.0']);
  assert.deepEqual(lenient.operators, ['OR']);
});

test('SPDX-10 parseExpression keeps the base id and records WITH exceptions', () => {
  const parsed = parseExpression('GPL-2.0-only WITH Classpath-exception-2.0');
  assert.deepEqual(parsed.ids, ['GPL-2.0-only']);
  assert.deepEqual(parsed.operators, ['WITH']);
  assert.deepEqual(parsed.exceptions, ['Classpath-exception-2.0']);
  assert.equal(classify('GPL-2.0-only WITH Classpath-exception-2.0'), 'strong-copyleft');

  const mixed = parseExpression('Apache-2.0 WITH LLVM-exception OR MIT');
  assert.deepEqual(mixed.ids, ['Apache-2.0', 'MIT']);
  assert.deepEqual(mixed.exceptions, ['LLVM-exception']);
});

test('SPDX-11 parseExpression reports deprecated tokens in their raw form', () => {
  const parsed = parseExpression('GPL-3.0 OR MIT');
  assert.deepEqual(parsed.deprecated, ['GPL-3.0']);
  assert.deepEqual(parsed.ids, ['GPL-3.0-only', 'MIT']);
  assert.deepEqual(parseExpression('MIT OR ISC').deprecated, []);
});

test('SPDX-12 OR takes the least restrictive branch, AND the most restrictive', () => {
  assert.equal(classify('MIT OR GPL-3.0-only'), 'permissive');
  assert.equal(classify('AGPL-3.0-only OR Apache-2.0'), 'permissive');
  assert.equal(classify('MIT AND GPL-3.0-only'), 'strong-copyleft');
  assert.equal(classify('MIT AND AGPL-3.0-only'), 'network-copyleft');
  assert.equal(classify('MIT AND Frobnicate-1.0'), 'unknown');
  assert.equal(classify('MIT OR Frobnicate-1.0'), 'permissive');
});

test('SPDX-13 unbalanced parentheses raise a NubosPilotError', () => {
  assert.throws(() => parseExpression('(MIT OR ISC'), (err) => {
    assert.ok(err instanceof NubosPilotError);
    assert.equal(err.code, 'license-unbalanced-expression');
    return true;
  });
  assert.throws(() => parseExpression('MIT OR ISC)'), NubosPilotError);
});

test('SPDX-14 CATEGORIES is a frozen, exhaustive vocabulary', () => {
  assert.ok(Object.isFrozen(CATEGORIES));
  assert.equal(new Set(CATEGORIES).size, CATEGORIES.length);
  assert.ok(CATEGORIES.includes('unknown'));
});
