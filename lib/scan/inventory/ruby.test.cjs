'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { FILES, parse } = require('./ruby.cjs');

const LOCKFILE = [
  'GEM',
  '  remote: https://rubygems.org/',
  '  specs:',
  '    concurrent-ruby (1.2.2)',
  '    rack (3.0.8)',
  '    rails (7.1.0)',
  '      actionpack (= 7.1.0)',
  '      activesupport (= 7.1.0)',
  '',
  'PATH',
  '  remote: engines/billing',
  '  specs:',
  '    billing (0.1.0)',
  '      rails (>= 7.0)',
  '',
  'GIT',
  '  remote: https://github.com/example/example-gem.git',
  '  revision: 8f3a1c2',
  '  specs:',
  '    example-gem (2.0.0)',
  '',
  'PLATFORMS',
  '  ruby',
  '  x86_64-darwin-22',
  '',
  'DEPENDENCIES',
  '  billing!',
  '  rack (~> 3.0)',
  '  rails (= 7.1.0)',
  '',
  'BUNDLED WITH',
  '   2.4.10',
  '',
].join('\n');

function byName(packages, name) {
  return packages.find((p) => p.name === name);
}

test('RUBY-1 GEM, PATH and GIT specs all become packages', () => {
  const { packages, warnings } = parse(LOCKFILE, { file: 'Gemfile.lock' });

  assert.deepEqual(warnings, []);
  assert.deepEqual(packages.map((p) => p.purl), [
    'pkg:gem/concurrent-ruby@1.2.2',
    'pkg:gem/rack@3.0.8',
    'pkg:gem/rails@7.1.0',
    'pkg:gem/billing@0.1.0',
    'pkg:gem/example-gem@2.0.0',
  ]);
  assert.equal(packages.every((p) => p.scope === 'unknown'), true);
  assert.equal(packages.every((p) => p.ecosystem === 'RubyGems'), true);
  assert.equal(packages.every((p) => p.source === 'Gemfile.lock'), true);
});

test('RUBY-2 six-space constraint lines are not emitted as packages', () => {
  const { packages } = parse(LOCKFILE, { file: 'Gemfile.lock' });

  assert.equal(byName(packages, 'actionpack'), undefined);
  assert.equal(byName(packages, 'activesupport'), undefined);
  assert.equal(packages.length, 5);
});

test('RUBY-3 the DEPENDENCIES section drives the direct flag', () => {
  const { packages } = parse(LOCKFILE, { file: 'Gemfile.lock' });

  assert.equal(byName(packages, 'rack').direct, true);
  assert.equal(byName(packages, 'rails').direct, true);
  assert.equal(byName(packages, 'billing').direct, true);
  assert.equal(byName(packages, 'concurrent-ruby').direct, false);
  assert.equal(byName(packages, 'example-gem').direct, false);
});

test('RUBY-4 platform-qualified versions are kept verbatim', () => {
  const content = [
    'GEM',
    '  remote: https://rubygems.org/',
    '  specs:',
    '    nokogiri (1.16.0-x86_64-darwin)',
    '',
    'DEPENDENCIES',
    '  nokogiri',
    '',
  ].join('\n');

  const { packages, warnings } = parse(content, { file: 'sub/Gemfile.lock' });

  assert.deepEqual(warnings, []);
  assert.equal(packages.length, 1);
  assert.equal(packages[0].version, '1.16.0-x86_64-darwin');
  assert.equal(packages[0].purl, 'pkg:gem/nokogiri@1.16.0-x86_64-darwin');
  assert.equal(packages[0].source, 'sub/Gemfile.lock');
});

test('RUBY-5 unknown basename reports unsupported-file', () => {
  assert.deepEqual(parse(LOCKFILE, { file: 'Gemfile' }), { packages: [], warnings: ['unsupported-file'] });
});

test('RUBY-6 a malformed spec line warns instead of throwing', () => {
  const content = [
    'GEM',
    '  remote: https://rubygems.org/',
    '  specs:',
    '    rack (3.0.8)',
    '    broken-gem 1.0.0',
    '',
    'DEPENDENCIES',
    '  rack',
    '',
  ].join('\n');

  const { packages, warnings } = parse(content, { file: 'Gemfile.lock' });

  assert.deepEqual(packages.map((p) => p.purl), ['pkg:gem/rack@3.0.8']);
  assert.deepEqual(warnings, ['malformed-spec-line']);
});

test('RUBY-7 FILES is a frozen list of the handled basenames', () => {
  assert.deepEqual([...FILES], ['Gemfile.lock']);
  assert.equal(Object.isFrozen(FILES), true);
});
