'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { FILES, parse } = require('./composer.cjs');

function lock(extra) {
  return JSON.stringify(Object.assign({
    _readme: ['This file locks the dependencies of your project to a known state'],
    'content-hash': 'a1b2c3',
    packages: [
      { name: 'monolog/monolog', version: '3.5.0', license: ['MIT'] },
      { name: 'psr/log', version: 'v3.0.0', license: ['MIT'] },
    ],
    'packages-dev': [
      { name: 'phpunit/phpunit', version: '10.5.2', license: ['BSD-3-Clause'] },
    ],
  }, extra || {}));
}

test('COMPOSER-1 packages and packages-dev become prod and dev entries', () => {
  const { packages, warnings } = parse(lock(), { file: 'composer.lock' });

  assert.deepEqual(warnings, []);
  assert.deepEqual(packages.map((p) => p.purl), [
    'pkg:composer/monolog/monolog@3.5.0',
    'pkg:composer/psr/log@v3.0.0',
    'pkg:composer/phpunit/phpunit@10.5.2',
  ]);
  assert.deepEqual(packages.map((p) => p.scope), ['prod', 'prod', 'dev']);
  assert.equal(packages.every((p) => p.direct === false), true);
  assert.equal(packages.every((p) => p.ecosystem === 'Packagist'), true);
  assert.equal(packages.every((p) => p.source === 'composer.lock'), true);
});

test('COMPOSER-2 a license array of several SPDX ids joins with OR', () => {
  const content = lock({
    packages: [
      { name: 'vendor/dual', version: '1.0.0', license: ['MIT', 'GPL-2.0-or-later'] },
      { name: 'vendor/single', version: '1.0.0', license: ['Apache-2.0'] },
      { name: 'vendor/string', version: '1.0.0', license: 'MIT' },
      { name: 'vendor/none', version: '1.0.0' },
    ],
    'packages-dev': [],
  });

  const { packages, warnings } = parse(content, { file: 'composer.lock' });

  assert.deepEqual(warnings, []);
  assert.deepEqual(packages.map((p) => p.license), [
    'MIT OR GPL-2.0-or-later',
    'Apache-2.0',
    'MIT',
    null,
  ]);
});

test('COMPOSER-3 versions are kept verbatim including a v prefix', () => {
  const content = lock({
    packages: [{ name: 'symfony/console', version: 'v6.4.1' }],
    'packages-dev': [],
  });

  const { packages } = parse(content, { file: 'composer.lock' });

  assert.equal(packages[0].version, 'v6.4.1');
  assert.equal(packages[0].purl, 'pkg:composer/symfony/console@v6.4.1');
});

test('COMPOSER-4 unknown basename reports unsupported-file', () => {
  assert.deepEqual(parse(lock(), { file: 'composer.json' }), { packages: [], warnings: ['unsupported-file'] });
});

test('COMPOSER-5 invalid JSON warns instead of throwing', () => {
  const result = parse('{ "packages": [ ', { file: 'app/composer.lock' });

  assert.deepEqual(result, { packages: [], warnings: ['invalid-json'] });
});

test('COMPOSER-6 unusable entries are skipped with a warning', () => {
  const content = lock({
    packages: [
      { name: 'good/one', version: '1.0.0' },
      { version: '2.0.0' },
      null,
      { name: 'no/version' },
    ],
    'packages-dev': { not: 'an array' },
  });

  const { packages, warnings } = parse(content, { file: 'composer.lock' });

  assert.deepEqual(packages.map((p) => p.purl), ['pkg:composer/good/one@1.0.0', 'pkg:composer/no/version']);
  assert.equal(packages[1].version, null);
  assert.ok(warnings.includes('malformed-package'));
  assert.ok(warnings.includes('missing-version'));
  assert.ok(warnings.includes('malformed-packages-section'));
});

test('COMPOSER-7 FILES is a frozen list of the handled basenames', () => {
  assert.deepEqual([...FILES], ['composer.lock']);
  assert.equal(Object.isFrozen(FILES), true);
});
