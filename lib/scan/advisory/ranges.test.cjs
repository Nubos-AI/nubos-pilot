'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { SUPPORTED, compare, isSupported, inRange, firstFixed } = require('./ranges.cjs');
const { ECOSYSTEMS } = require('../inventory/pkgurl.cjs');

function assertOrdered(ecosystem, chain) {
  for (let i = 0; i < chain.length; i += 1) {
    const a = chain[i];
    assert.equal(compare(ecosystem, a, a), 0, ecosystem + ': ' + a + ' == ' + a);
    for (let j = i + 1; j < chain.length; j += 1) {
      const b = chain[j];
      assert.equal(compare(ecosystem, a, b), -1, ecosystem + ': ' + a + ' < ' + b);
      assert.equal(compare(ecosystem, b, a), 1, ecosystem + ': ' + b + ' > ' + a);
    }
  }
}

function assertSame(ecosystem, group) {
  for (const a of group) {
    for (const b of group) {
      assert.equal(compare(ecosystem, a, b), 0, ecosystem + ': ' + a + ' == ' + b);
    }
  }
}

function range(...events) {
  return { events };
}

test('RANGE-1 SUPPORTED uses the inventory ecosystem vocabulary and nothing else', () => {
  for (const ecosystem of SUPPORTED) {
    assert.ok(ECOSYSTEMS.includes(ecosystem), ecosystem + ' must be a pkgurl ecosystem');
  }
  assert.equal(new Set(SUPPORTED).size, SUPPORTED.length);
  assert.ok(Object.isFrozen(SUPPORTED));
});

test('RANGE-2 isSupported answers only for ecosystems with a real comparator', () => {
  for (const ecosystem of SUPPORTED) assert.equal(isSupported(ecosystem), true, ecosystem);
  for (const bogus of ['Hex', 'Pub', 'npm ', 'NPM', '', null, undefined, 0, {}]) {
    assert.equal(isSupported(bogus), false, String(bogus));
  }
});

test('RANGE-3 npm follows the SemVer 2.0.0 precedence example verbatim', () => {
  assertOrdered('npm', [
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-alpha.beta',
    '1.0.0-beta',
    '1.0.0-beta.2',
    '1.0.0-beta.11',
    '1.0.0-rc.1',
    '1.0.0',
    '1.0.1',
    '1.1.0',
    '1.9.0',
    '1.10.0',
    '2.0.0',
  ]);
});

test('RANGE-4 npm ignores build metadata and tolerates a leading v and missing parts', () => {
  assertSame('npm', ['1.0.0', 'v1.0.0', '1.0.0+a', '1.0.0+b', '1.0.0+build.7']);
  assertSame('npm', ['1.2', '1.2.0', 'v1.2', '1.2.0+sha.abc']);
  assertSame('npm', ['1', '1.0', '1.0.0']);
  assertSame('npm', ['1.0.0-beta+exp.sha.1', '1.0.0-beta+exp.sha.2', '1.0.0-beta']);
  assert.equal(compare('npm', '1.0.0-beta+z', '1.0.0'), -1);
});

test('RANGE-5 crates.io follows SemVer 2.0.0 with numeric (not lexical) release parts', () => {
  assertOrdered('crates.io', [
    '0.1.0-alpha.1',
    '0.1.0-alpha.2',
    '0.1.0',
    '0.1.9',
    '0.1.12',
    '0.2.0',
    '1.0.0',
    '1.2.3',
  ]);
  assertSame('crates.io', ['1.2.3', 'v1.2.3', '1.2.3+meta']);
});

test('RANGE-6 NuGet orders a four-part release and folds prerelease label case', () => {
  assertOrdered('NuGet', [
    '1.0.0-alpha',
    '1.0.0-beta',
    '1.0.0-beta.2',
    '1.0.0-beta.11',
    '1.0.0-rc.1',
    '1.0.0',
    '1.0.0.1',
    '1.0.1',
    '1.1.0',
    '2.0.0',
  ]);
  assertSame('NuGet', ['1.0.0', '1.0.0.0', '1.0', '1.0.0+build']);
  assertSame('NuGet', ['1.0.0-Beta', '1.0.0-beta', '1.0.0-BETA']);
  assert.equal(compare('NuGet', '1.0.0-beta10', '1.0.0-beta9'), -1);
});

test('RANGE-7 Packagist orders the Composer stability ladder with numeric suffixes', () => {
  assertOrdered('Packagist', [
    '1.0.0-dev',
    '1.0.0-alpha1',
    '1.0.0-alpha2',
    '1.0.0-beta1',
    '1.0.0-beta9',
    '1.0.0-beta10',
    '1.0.0-RC1',
    '1.0.0-rc2',
    '1.0.0',
    '1.0.0-pl1',
    '1.0.1',
    '1.1.0',
    '2.0.0',
  ]);
  assertSame('Packagist', ['1.0.0', '1.0.0.0', 'v1.0.0', '1.0.0-stable', '1.0.0-stable1', '1.0.0+build']);
  assertSame('Packagist', ['1.0.0-a1', '1.0.0-alpha1']);
  assertSame('Packagist', ['1.0.0-b1', '1.0.0-beta1']);
  assertSame('Packagist', ['1.0.0-p1', '1.0.0-pl1', '1.0.0-patch1']);
  assertOrdered('Packagist', ['1.0.0-zzz', '1.0.0-dev', '1.0.0-alpha1', '1.0.0']);
});

test('RANGE-8 Go orders pseudo-versions by their embedded timestamp', () => {
  assertOrdered('Go', [
    'v0.0.0-20191109021931-daa7c04131f5',
    'v0.0.0-20200101000000-000000000000',
    'v0.0.0-20201231235959-ffffffffffff',
    'v0.0.1-0.20210101000000-abcdefabcdef',
    'v0.0.1',
    'v1.0.0-rc.1',
    'v1.0.0',
    'v1.9.0',
    'v1.10.0',
    'v2.0.0',
  ]);
  assert.equal(compare('Go', 'v0.0.0-20191109021931-daa7c04131f5', 'v0.0.0'), -1);
});

test('RANGE-9 Go treats +incompatible as build metadata and tolerates a missing v', () => {
  assertSame('Go', ['v2.0.0', 'v2.0.0+incompatible', '2.0.0']);
  assertSame('Go', ['v1.2.3', '1.2.3']);
  assert.equal(compare('Go', 'v2.0.0+incompatible', 'v2.0.1'), -1);
});

test('RANGE-10 PyPI follows PEP 440 ordering across epoch, pre, post, dev and local', () => {
  assertOrdered('PyPI', [
    '1.0.dev0',
    '1.0.dev1',
    '1.0a1.dev1',
    '1.0a1',
    '1.0a2',
    '1.0b1',
    '1.0rc1.dev1',
    '1.0rc1',
    '1.0',
    '1.0+local',
    '1.0.post1.dev1',
    '1.0.post1',
    '1.0.post2',
    '1.0.1',
    '1.0.1.1',
    '1.1',
    '2.0',
    '1!0.1',
    '1!1.0',
  ]);
});

test('RANGE-11 PyPI normalizes separators, pre-release spellings and trailing zeros', () => {
  assertSame('PyPI', ['1.0', '1.0.0', '1.0.0.0', 'v1.0', '1.0.0.0.0']);
  assertSame('PyPI', ['1.0a1', '1.0-a1', '1.0_a1', '1.0.a1', '1.0alpha1', '1.0-alpha-1', '1.0.ALPHA.1']);
  assertSame('PyPI', ['1.0b1', '1.0beta1', '1.0-b-1']);
  assertSame('PyPI', ['1.0rc1', '1.0c1', '1.0pre1', '1.0preview1', '1.0-rc-1']);
  assertSame('PyPI', ['1.0.post1', '1.0-1', '1.0rev1', '1.0r1', '1.0-post-1']);
  assertSame('PyPI', ['1.0a1', '1.0a01']);
  assertSame('PyPI', ['1.0.dev0', '1.0.dev', '1.0dev']);
  assertSame('PyPI', ['1.0.post0', '1.0.post']);
  assert.equal(compare('PyPI', '1.0.0.1', '1.0.0'), 1);
  assert.equal(compare('PyPI', '1!1.0', '2.0'), 1);
});

test('RANGE-12 PyPI local versions sort after their public version, numbers above letters', () => {
  assertOrdered('PyPI', ['1.0', '1.0+abc', '1.0+abc.1', '1.0+abd', '1.0+1', '1.0+1.1', '1.0+2']);
  assertSame('PyPI', ['1.0+abc.1', '1.0+abc-1', '1.0+abc_1', '1.0+ABC.1']);
});

test('RANGE-13 Maven orders its qualifier ladder with release above snapshot but below sp', () => {
  assertOrdered('Maven', [
    '1.0-alpha',
    '1.0-alpha1',
    '1.0-alpha2',
    '1.0-beta',
    '1.0-beta1',
    '1.0-milestone1',
    '1.0-rc1',
    '1.0-SNAPSHOT',
    '1.0',
    '1.0-sp1',
    '1.0-zzz',
    '1.0.1',
    '1.1',
    '1.9',
    '1.10',
    '2.0',
  ]);
});

test('RANGE-14 Maven treats a dotted qualifier like a hyphenated one and normalizes trailing zeros', () => {
  const facts = [
    ['1', '1.0-final-1', -1],
    ['1.0', '1.0-final-1', -1],
    ['1.0-alpha', '1.0.0-alpha', 0],
    ['1.0-alpha1', '1.0.0-alpha', 1],
    ['1.0-alpha', '1.0.alpha.1', -1],
    ['1.0-alpha', '1-1.foo-bar1baz-.1', -1],
    ['5.2.25.RELEASE', '5.2.25', 0],
    ['4.1.0.Final', '4.1.0', 0],
    ['1.0.0.GA', '1.0.0', 0],
    ['1.0-x1', '1.0-x', 1],
    ['1.0.1a', '1.0.1', 1],
    ['1.0.0.M1', '1.0.0-M1', 0],
    ['2.4.0.b1', '2.4.0-beta1', 0],
    ['1.0-alpha9', '1.0-alpha10', -1],
    ['1-sp', '1', 1],
    ['1-1', '1.0.x', 1],
    ['1.0.alpha.1', '1.0.1', -1],
    ['1.0.ga.1', '1.0.1', -1],
    ['1.0-zzz', '1.0.1', -1],
    ['1.1.alpha.1', '1.1-1', -1],
    ['1.1.ga.1', '1.1-1', -1],
  ];
  for (const [a, b, want] of facts) {
    assert.equal(compare('Maven', a, b), want, 'Maven: ' + a + ' vs ' + b);
    assert.equal(compare('Maven', b, a), want === 0 ? 0 : -want, 'Maven: ' + b + ' vs ' + a);
  }
});

test('RANGE-15 Maven qualifier aliases are case-insensitive and release-equivalent', () => {
  assertSame('Maven', ['1', '1.0', '1.0.0', '1.0-ga', '1.0-final', '1.0-GA']);
  assertSame('Maven', ['1.0-rc1', '1.0-cr1', '1.0-RC1']);
  assertSame('Maven', ['1.0-alpha1', '1.0-a1', '1.0-A1']);
  assertSame('Maven', ['1.0-beta1', '1.0-b1']);
  assertSame('Maven', ['1.0-milestone1', '1.0-m1']);
  assertSame('Maven', ['1.0-SNAPSHOT', '1.0-snapshot']);
});

test('RANGE-16 RubyGems treats a letter segment as a prerelease below the release', () => {
  assertOrdered('RubyGems', [
    '1.0.0.pre',
    '1.0.0.pre1',
    '1.0.0.pre2',
    '1.0.0.rc1',
    '1.0.0.rc2',
    '1.0.0',
    '1.0.1',
    '1.1',
    '1.9',
    '1.10',
    '2.0',
  ]);
  assert.equal(compare('RubyGems', '1.0.0-rc1', '1.0.0'), -1);
  assert.equal(compare('RubyGems', '1.0.0.beta', '1.0.0.rc'), -1);
});

test('RANGE-17 RubyGems trailing zeros are insignificant', () => {
  assertSame('RubyGems', ['1', '1.0', '1.0.0', '1.0.0.0']);
  assertSame('RubyGems', ['1.0.0.pre', '1.0.pre']);
  assert.equal(compare('RubyGems', '1.0.0.1', '1.0.0'), 1);
});

test('RANGE-18 introduced "0" with a fixed covers everything below the fix', () => {
  const ranges = [range({ introduced: '0' }, { fixed: '1.2.3' })];
  assert.equal(inRange('npm', '0.0.1', ranges), true);
  assert.equal(inRange('npm', '1.2.2', ranges), true);
  assert.equal(inRange('npm', '1.2.3', ranges), false);
  assert.equal(inRange('npm', '1.2.4', ranges), false);
  assert.equal(inRange('npm', '2.0.0', ranges), false);
});

test('RANGE-19 an introduced with no terminator affects everything from that point on', () => {
  const ranges = [range({ introduced: '1.0.0' })];
  assert.equal(inRange('npm', '0.9.9', ranges), false);
  assert.equal(inRange('npm', '1.0.0', ranges), true);
  assert.equal(inRange('npm', '99.0.0', ranges), true);
});

test('RANGE-20 last_affected is inclusive at its own boundary', () => {
  const ranges = [range({ introduced: '1.0.0' }, { last_affected: '1.2.3' })];
  assert.equal(inRange('npm', '0.9.9', ranges), false);
  assert.equal(inRange('npm', '1.0.0', ranges), true);
  assert.equal(inRange('npm', '1.2.3', ranges), true);
  assert.equal(inRange('npm', '1.2.4', ranges), false);
});

test('RANGE-21 multiple ranges are OR-ed and multiple event pairs inside one range work', () => {
  const twoRanges = [
    range({ introduced: '1.0.0' }, { fixed: '1.1.0' }),
    range({ introduced: '2.0.0' }, { fixed: '2.1.0' }),
  ];
  assert.equal(inRange('npm', '1.0.5', twoRanges), true);
  assert.equal(inRange('npm', '1.1.0', twoRanges), false);
  assert.equal(inRange('npm', '1.5.0', twoRanges), false);
  assert.equal(inRange('npm', '2.0.5', twoRanges), true);
  assert.equal(inRange('npm', '2.1.0', twoRanges), false);

  const oneRange = [range(
    { introduced: '1.0.0' },
    { fixed: '1.1.0' },
    { introduced: '2.0.0' },
    { fixed: '2.1.0' },
  )];
  assert.equal(inRange('npm', '1.0.5', oneRange), true);
  assert.equal(inRange('npm', '1.5.0', oneRange), false);
  assert.equal(inRange('npm', '2.0.5', oneRange), true);
  assert.equal(inRange('npm', '2.1.0', oneRange), false);
});

test('RANGE-22 the introduced boundary is affected and the fixed boundary is not, per ecosystem', () => {
  const cases = [
    { ecosystem: 'npm', below: '1.1.9', introduced: '1.2.0', inside: '1.2.1', fixed: '1.2.3', above: '1.2.4' },
    { ecosystem: 'crates.io', below: '1.1.9', introduced: '1.2.0', inside: '1.2.1', fixed: '1.2.3', above: '1.2.4' },
    { ecosystem: 'Go', below: 'v1.1.9', introduced: 'v1.2.0', inside: 'v1.2.1', fixed: 'v1.2.3', above: 'v1.2.4' },
    { ecosystem: 'NuGet', below: '1.1.9', introduced: '1.2.0', inside: '1.2.1', fixed: '1.2.3', above: '1.2.4' },
    { ecosystem: 'Packagist', below: '1.1.9', introduced: '1.2.0', inside: '1.2.1', fixed: '1.2.3', above: '1.2.4' },
    { ecosystem: 'PyPI', below: '1.1.9', introduced: '1.2', inside: '1.2.1', fixed: '1.2.3', above: '1.2.4' },
    { ecosystem: 'Maven', below: '1.1.9', introduced: '1.2', inside: '1.2.1', fixed: '1.2.3', above: '1.2.4' },
    { ecosystem: 'RubyGems', below: '1.1.9', introduced: '1.2', inside: '1.2.1', fixed: '1.2.3', above: '1.2.4' },
  ];
  assert.deepEqual([...SUPPORTED].sort(), cases.map((c) => c.ecosystem).sort());
  for (const c of cases) {
    const ranges = [range({ introduced: c.introduced }, { fixed: c.fixed })];
    assert.equal(inRange(c.ecosystem, c.below, ranges), false, c.ecosystem + ' below introduced');
    assert.equal(inRange(c.ecosystem, c.introduced, ranges), true, c.ecosystem + ' at introduced');
    assert.equal(inRange(c.ecosystem, c.inside, ranges), true, c.ecosystem + ' inside');
    assert.equal(inRange(c.ecosystem, c.fixed, ranges), false, c.ecosystem + ' at fixed');
    assert.equal(inRange(c.ecosystem, c.above, ranges), false, c.ecosystem + ' above fixed');

    const lastAffected = [range({ introduced: c.introduced }, { last_affected: c.fixed })];
    assert.equal(inRange(c.ecosystem, c.fixed, lastAffected), true, c.ecosystem + ' at last_affected');
    assert.equal(inRange(c.ecosystem, c.above, lastAffected), false, c.ecosystem + ' above last_affected');
  }
});

test('RANGE-23 a prerelease sits below its own release boundary in every ecosystem', () => {
  const cases = [
    { ecosystem: 'npm', pre: '2.0.0-rc.1', release: '2.0.0' },
    { ecosystem: 'crates.io', pre: '2.0.0-rc.1', release: '2.0.0' },
    { ecosystem: 'Go', pre: 'v2.0.0-rc.1', release: 'v2.0.0' },
    { ecosystem: 'NuGet', pre: '2.0.0-rc1', release: '2.0.0' },
    { ecosystem: 'Packagist', pre: '2.0.0-RC1', release: '2.0.0' },
    { ecosystem: 'PyPI', pre: '2.0rc1', release: '2.0' },
    { ecosystem: 'Maven', pre: '2.0-rc1', release: '2.0' },
    { ecosystem: 'RubyGems', pre: '2.0.0.rc1', release: '2.0.0' },
  ];
  for (const c of cases) {
    const beforeTheFix = [range({ introduced: '0' }, { fixed: c.release })];
    assert.equal(inRange(c.ecosystem, c.pre, beforeTheFix), true, c.ecosystem + ' prerelease of the fix is affected');
    assert.equal(inRange(c.ecosystem, c.release, beforeTheFix), false, c.ecosystem + ' the fix itself is not');

    const introducedAtRelease = [range({ introduced: c.release })];
    assert.equal(inRange(c.ecosystem, c.pre, introducedAtRelease), false, c.ecosystem + ' prerelease precedes introduced');
    assert.equal(inRange(c.ecosystem, c.release, introducedAtRelease), true, c.ecosystem + ' release is introduced');
  }
});

test('RANGE-24 firstFixed returns the escaping boundary or null when there is none', () => {
  const closed = [range({ introduced: '1.0.0' }, { fixed: '1.2.3' })];
  assert.equal(firstFixed('npm', '1.0.0', closed), '1.2.3');
  assert.equal(firstFixed('npm', '1.2.2', closed), '1.2.3');
  assert.equal(firstFixed('npm', '1.2.3', closed), null);
  assert.equal(firstFixed('npm', '0.9.0', closed), null);

  const open = [range({ introduced: '1.0.0' })];
  assert.equal(firstFixed('npm', '1.5.0', open), null);

  const lastAffected = [range({ introduced: '1.0.0' }, { last_affected: '1.5.0' })];
  assert.equal(firstFixed('npm', '1.2.0', lastAffected), null);

  const branches = [
    range({ introduced: '0' }, { fixed: '1.1.0' }),
    range({ introduced: '2.0.0' }, { fixed: '2.1.0' }),
  ];
  assert.equal(firstFixed('npm', '1.0.0', branches), '1.1.0');
  assert.equal(firstFixed('npm', '2.0.5', branches), '2.1.0');
  assert.equal(firstFixed('npm', '1.5.0', branches), null);
});

test('RANGE-25 firstFixed across overlapping ranges reports the boundary that escapes all of them', () => {
  const overlapping = [
    range({ introduced: '0' }, { fixed: '1.5.0' }),
    range({ introduced: '1.0.0' }, { fixed: '2.0.0' }),
  ];
  assert.equal(inRange('npm', '1.2.0', overlapping), true);
  assert.equal(firstFixed('npm', '1.2.0', overlapping), '2.0.0');
  assert.equal(firstFixed('npm', '0.5.0', overlapping), '1.5.0');
  assert.equal(firstFixed('npm', '1.7.0', overlapping), '2.0.0');

  const overlappingOpen = [
    range({ introduced: '0' }, { fixed: '1.5.0' }),
    range({ introduced: '1.0.0' }),
  ];
  assert.equal(firstFixed('npm', '1.2.0', overlappingOpen), null);
});

test('RANGE-26 an unsupported ecosystem throws instead of guessing', () => {
  const ranges = [range({ introduced: '0' }, { fixed: '1.0.0' })];
  for (const bogus of ['Hex', 'Pub', 'NPM', 'pypi', '', null, undefined, 42]) {
    for (const call of [
      () => compare(bogus, '1.0.0', '1.0.1'),
      () => inRange(bogus, '1.0.0', ranges),
      () => firstFixed(bogus, '1.0.0', ranges),
    ]) {
      assert.throws(call, (err) => {
        assert.equal(err.name, 'NubosPilotError');
        assert.equal(err.code, 'ranges-unsupported-ecosystem');
        return true;
      }, 'ecosystem ' + String(bogus));
    }
  }
});

test('RANGE-27 compare throws on an unparseable version rather than reporting equal', () => {
  const cases = [
    { ecosystem: 'npm', bad: 'not-a-version' },
    { ecosystem: 'npm', bad: '1.2.3.beta' },
    { ecosystem: 'npm', bad: '' },
    { ecosystem: 'npm', bad: '1.0.0-' },
    { ecosystem: 'crates.io', bad: '*' },
    { ecosystem: 'Go', bad: 'latest' },
    { ecosystem: 'NuGet', bad: 'not-a-version' },
    { ecosystem: 'Packagist', bad: 'dev-master' },
    { ecosystem: 'PyPI', bad: 'not a version' },
    { ecosystem: 'Maven', bad: 'RELEASE' },
    { ecosystem: 'Maven', bad: '' },
    { ecosystem: 'RubyGems', bad: 'abc' },
    { ecosystem: 'RubyGems', bad: '1.0..0' },
  ];
  for (const c of cases) {
    const good = c.ecosystem === 'Go' ? 'v1.0.0' : '1.0.0';
    assert.throws(() => compare(c.ecosystem, c.bad, good), (err) => {
      assert.equal(err.name, 'NubosPilotError');
      assert.equal(err.code, 'ranges-unparseable-version');
      return true;
    }, c.ecosystem + ' ' + JSON.stringify(c.bad) + ' as left operand');
    assert.throws(() => compare(c.ecosystem, good, c.bad), (err) => {
      assert.equal(err.code, 'ranges-unparseable-version');
      return true;
    }, c.ecosystem + ' ' + JSON.stringify(c.bad) + ' as right operand');
  }
  for (const bad of [null, undefined, {}, [], true, NaN]) {
    assert.throws(() => compare('npm', bad, '1.0.0'), (err) => {
      assert.equal(err.code, 'ranges-unparseable-version');
      return true;
    }, String(bad));
  }
});

test('RANGE-28 an unparseable installed version is not affected and never crashes the scan', () => {
  const ranges = [range({ introduced: '0' }, { fixed: '9.9.9' })];
  for (const bad of ['not-a-version', '', '   ', null, undefined, {}, [], true]) {
    assert.equal(inRange('npm', bad, ranges), false, String(bad));
    assert.equal(firstFixed('npm', bad, ranges), null, String(bad));
  }
  assert.equal(inRange('npm', '1.0.0', ranges), true);
});

test('RANGE-29 an unparseable advisory boundary throws so the gap is visible', () => {
  const broken = [
    [range({ introduced: 'garbage' })],
    [range({ introduced: '0' }, { fixed: 'garbage' })],
    [range({ introduced: '0' }, { last_affected: 'garbage' })],
    [range({ introduced: '1.0.0' }, { fixed: 'garbage' })],
    [range({ introduced: '0' }, { fixed: '1.0.0' }), range({ introduced: 'garbage' })],
  ];
  for (const ranges of broken) {
    assert.throws(() => inRange('npm', '2.0.0', ranges), (err) => {
      assert.equal(err.name, 'NubosPilotError');
      assert.equal(err.code, 'ranges-unparseable-version');
      return true;
    }, JSON.stringify(ranges));
    assert.throws(() => firstFixed('npm', '2.0.0', ranges), (err) => {
      assert.equal(err.code, 'ranges-unparseable-version');
      return true;
    }, JSON.stringify(ranges));
  }
});

test('RANGE-30 malformed or missing range containers are tolerated as "not affected"', () => {
  for (const ranges of [undefined, null, [], 'nope', {}, [null], [{}], [range()], [{ events: 'nope' }], [range({})]]) {
    assert.equal(inRange('npm', '1.0.0', ranges), false, JSON.stringify(ranges) || String(ranges));
    assert.equal(firstFixed('npm', '1.0.0', ranges), null, JSON.stringify(ranges) || String(ranges));
  }
  const danglingFixed = [range({}, { fixed: '2.0.0' })];
  assert.equal(inRange('npm', '1.0.0', danglingFixed), true);
  assert.equal(inRange('npm', '2.0.0', danglingFixed), false);
  assert.equal(firstFixed('npm', '1.0.0', danglingFixed), '2.0.0');
});

test('RANGE-31 compare is antisymmetric and reflexive over a mixed corpus', () => {
  const corpus = {
    npm: ['0.0.1', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0', '1.0.1', '1.10.0', '2.0.0+b'],
    'crates.io': ['0.1.0', '0.1.12', '1.0.0-rc.1', '1.0.0'],
    Go: ['v0.0.0-20191109021931-daa7c04131f5', 'v1.0.0', 'v2.0.0+incompatible'],
    NuGet: ['1.0.0-beta', '1.0.0', '1.0.0.1', '2.0.0'],
    Packagist: ['1.0.0-dev', '1.0.0-beta2', '1.0.0', '1.0.0-pl1'],
    PyPI: ['1.0.dev1', '1.0a1', '1.0', '1.0.post1', '1!1.0'],
    Maven: ['1.0-alpha', '1.0-SNAPSHOT', '1.0', '1.0-sp1', '1.1'],
    RubyGems: ['1.0.0.pre', '1.0.0', '1.0.1', '1.10.0'],
  };
  for (const [ecosystem, versions] of Object.entries(corpus)) {
    for (const a of versions) {
      assert.equal(compare(ecosystem, a, a), 0, ecosystem + ' ' + a);
      for (const b of versions) {
        const forward = compare(ecosystem, a, b);
        const backward = compare(ecosystem, b, a);
        assert.ok(forward === -1 || forward === 0 || forward === 1, ecosystem + ' returns a sign');
        assert.equal(Object.is(forward, -0), false, ecosystem + ': ' + a + ' vs ' + b + ' is not -0');
        assert.equal(forward, backward === 0 ? 0 : -backward, ecosystem + ': ' + a + ' vs ' + b + ' is antisymmetric');
      }
    }
  }
});

test('RANGE-32 range evaluation works end to end for a realistic advisory per ecosystem', () => {
  const advisories = [
    { ecosystem: 'npm', ranges: [range({ introduced: '0' }, { fixed: '4.17.21' })], vulnerable: '4.17.20', safe: '4.17.21' },
    { ecosystem: 'PyPI', ranges: [range({ introduced: '0' }, { fixed: '2.31.0' })], vulnerable: '2.30.0', safe: '2.31.0' },
    { ecosystem: 'Go', ranges: [range({ introduced: '0' }, { fixed: '0.17.0' })], vulnerable: 'v0.0.0-20191109021931-daa7c04131f5', safe: 'v0.17.0' },
    { ecosystem: 'crates.io', ranges: [range({ introduced: '0.1.0' }, { fixed: '0.8.5' })], vulnerable: '0.8.4', safe: '0.8.5' },
    { ecosystem: 'Maven', ranges: [range({ introduced: '2.0' }, { fixed: '2.17.1' })], vulnerable: '2.14.1', safe: '2.17.1' },
    { ecosystem: 'Packagist', ranges: [range({ introduced: '0' }, { fixed: '8.5.19' })], vulnerable: '8.5.18', safe: '8.5.19' },
    { ecosystem: 'RubyGems', ranges: [range({ introduced: '0' }, { fixed: '6.0.3.2' })], vulnerable: '6.0.3.1', safe: '6.0.3.2' },
    { ecosystem: 'NuGet', ranges: [range({ introduced: '0' }, { fixed: '13.0.1' })], vulnerable: '12.0.3', safe: '13.0.1' },
  ];
  for (const a of advisories) {
    assert.equal(inRange(a.ecosystem, a.vulnerable, a.ranges), true, a.ecosystem + ' ' + a.vulnerable);
    assert.equal(inRange(a.ecosystem, a.safe, a.ranges), false, a.ecosystem + ' ' + a.safe);
    assert.equal(firstFixed(a.ecosystem, a.vulnerable, a.ranges), a.ranges[0].events[1].fixed, a.ecosystem + ' fix');
    assert.equal(firstFixed(a.ecosystem, a.safe, a.ranges), null, a.ecosystem + ' no fix needed');
  }
});

test('RANGE-33 RubyGems canonical segments decide equality and prerelease depth', () => {
  const facts = [
    ['1.0.pre', '1.0.0.beta', 1],
    ['1.0.pre', '1.0.0.pre', 0],
    ['1.0.0.pre.0', '1.0.0.pre', 0],
    ['1.0.0-rc1', '1.0.0.pre', -1],
    ['1.0.0.20', '1.0.0.3', 1],
    ['2.0.0.rc.1', '2.0.0', -1],
    ['1.0.0.a', '1.0.0.b1', -1],
    ['1.0.0.dev', '1.0.0.alpha', 1],
  ];
  for (const [a, b, want] of facts) {
    assert.equal(compare('RubyGems', a, b), want, 'RubyGems: ' + a + ' vs ' + b);
    assert.equal(compare('RubyGems', b, a), want === 0 ? 0 : -want, 'RubyGems: ' + b + ' vs ' + a);
  }
});

test('RANGE-34 numeric identifiers beyond Number.MAX_SAFE_INTEGER still compare exactly', () => {
  const low = '99999999999999999999998.1.1';
  const high = '99999999999999999999999.1.1';
  assert.equal(compare('npm', low, high), -1);
  assert.equal(compare('npm', high, low), 1);
  assert.equal(compare('npm', high, high), 0);
  assert.equal(compare('PyPI', '9007199254740993', '9007199254740992'), 1);
  assert.equal(compare('Maven', '9007199254740993', '9007199254740992'), 1);
  assert.equal(compare('RubyGems', '9007199254740993', '9007199254740992'), 1);
  assert.equal(compare('npm', '1.0.0-beta.9007199254740993', '1.0.0-beta.9007199254740992'), 1);
  assertSame('npm', ['1.0.0-beta.007', '1.0.0-beta.7']);
});
