'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { FILES, parse } = require('./npm.cjs');

const PACKAGE_LOCK_V3 = JSON.stringify({
  name: 'demo',
  version: '1.0.0',
  lockfileVersion: 3,
  requires: true,
  packages: {
    '': {
      name: 'demo',
      version: '1.0.0',
      license: 'MIT',
      dependencies: { '@scope/pkg': '^1.0.0', yaml: '^2.8.0' },
      devDependencies: { typescript: '^5.4.0' },
      optionalDependencies: { fsevents: '^2.3.3' },
    },
    'node_modules/@scope/pkg': {
      version: '1.0.0',
      resolved: 'https://registry.npmjs.org/@scope/pkg/-/pkg-1.0.0.tgz',
      integrity: 'sha512-aaa==',
      license: 'Apache-2.0',
    },
    'node_modules/fsevents': {
      version: '2.3.3',
      resolved: 'https://registry.npmjs.org/fsevents/-/fsevents-2.3.3.tgz',
      integrity: 'sha512-bbb==',
      optional: true,
      os: ['darwin'],
    },
    'node_modules/lodash': {
      version: '4.17.21',
      resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
      integrity: 'sha512-ccc==',
      license: 'MIT',
    },
    'node_modules/typescript': {
      version: '5.4.5',
      resolved: 'https://registry.npmjs.org/typescript/-/typescript-5.4.5.tgz',
      integrity: 'sha512-ddd==',
      dev: true,
      license: 'Apache-2.0',
    },
    'node_modules/wrap-ansi': {
      version: '7.0.0',
      resolved: 'https://registry.npmjs.org/wrap-ansi/-/wrap-ansi-7.0.0.tgz',
      integrity: 'sha512-eee==',
      devOptional: true,
    },
    'node_modules/wrap-ansi/node_modules/yaml': {
      version: '1.10.2',
      resolved: 'https://registry.npmjs.org/yaml/-/yaml-1.10.2.tgz',
      integrity: 'sha512-fff==',
      license: 'ISC',
    },
    'node_modules/yaml': {
      version: '2.8.0',
      resolved: 'https://registry.npmjs.org/yaml/-/yaml-2.8.0.tgz',
      integrity: 'sha512-ggg==',
      license: 'ISC',
    },
    'node_modules/workspace-app': { resolved: 'packages/app', link: true },
    'packages/app': { name: 'workspace-app', version: '0.0.1' },
  },
}, null, 2);

const PACKAGE_LOCK_V1 = JSON.stringify({
  name: 'legacy',
  version: '0.1.0',
  lockfileVersion: 1,
  requires: true,
  dependencies: {
    '@scope/pkg': {
      version: '1.0.0',
      resolved: 'https://registry.npmjs.org/@scope/pkg/-/pkg-1.0.0.tgz',
      integrity: 'sha512-aaa==',
      requires: { lodash: '^4.17.20' },
      dependencies: {
        lodash: {
          version: '4.17.20',
          resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz',
          integrity: 'sha512-bbb==',
        },
      },
    },
    typescript: {
      version: '5.4.5',
      resolved: 'https://registry.npmjs.org/typescript/-/typescript-5.4.5.tgz',
      integrity: 'sha512-ccc==',
      dev: true,
    },
    yaml: {
      version: '2.8.0',
      resolved: 'https://registry.npmjs.org/yaml/-/yaml-2.8.0.tgz',
      integrity: 'sha512-ddd==',
    },
  },
}, null, 2);

const PNPM_V9 = [
  "lockfileVersion: '9.0'",
  '',
  'settings:',
  '  autoInstallPeers: true',
  '  excludeLinksFromLockfile: false',
  '',
  'importers:',
  '',
  '  .:',
  '    dependencies:',
  "      '@scope/pkg':",
  '        specifier: ^1.0.0',
  '        version: 1.0.0',
  '      yaml:',
  '        specifier: ^2.8.0',
  '        version: 2.8.0',
  '    devDependencies:',
  '      typescript:',
  '        specifier: ^5.4.0',
  '        version: 5.4.5',
  '',
  'packages:',
  '',
  "  '@scope/pkg@1.0.0':",
  '    resolution: {integrity: sha512-aaa==}',
  '',
  '  lodash@4.17.21:',
  '    resolution: {integrity: sha512-bbb==}',
  '',
  '  typescript@5.4.5:',
  '    resolution: {integrity: sha512-ccc==}',
  "    engines: {node: '>=14.17'}",
  '    hasBin: true',
  '',
  '  yaml@2.8.0:',
  '    resolution: {integrity: sha512-ddd==}',
  "    engines: {node: '>= 14'}",
  '    hasBin: true',
  '',
  'snapshots:',
  '',
  "  '@scope/pkg@1.0.0':",
  '    dependencies:',
  '      lodash: 4.17.21',
  '',
  '  lodash@4.17.21: {}',
  '',
  '  typescript@5.4.5: {}',
  '',
  '  yaml@2.8.0: {}',
  '',
].join('\n');

const PNPM_V9_SNAPSHOTS_ONLY = [
  "lockfileVersion: '9.0'",
  '',
  'importers:',
  '',
  '  .:',
  '    dependencies:',
  '      vue:',
  '        specifier: ^3.4.0',
  '        version: 3.4.0(typescript@5.4.5)',
  '',
  'snapshots:',
  '',
  '  vue@3.4.0(typescript@5.4.5):',
  '    dependencies:',
  '      typescript: 5.4.5',
  '',
  '  typescript@5.4.5: {}',
  '',
].join('\n');

const PNPM_V5 = [
  'lockfileVersion: 5.4',
  '',
  'specifiers:',
  "  '@scope/pkg': ^1.0.0",
  '  typescript: ^5.4.0',
  '  vue: ^3.4.0',
  '  yaml: ^2.8.0',
  '',
  'dependencies:',
  "  '@scope/pkg': 1.0.0",
  '  vue: 3.4.0_typescript@5.4.5',
  '  yaml: 2.8.0',
  '',
  'devDependencies:',
  '  typescript: 5.4.5',
  '',
  'packages:',
  '',
  '  /@scope/pkg/1.0.0:',
  '    resolution: {integrity: sha512-aaa==}',
  '    dev: false',
  '',
  '  /lodash/4.17.21:',
  '    resolution: {integrity: sha512-bbb==}',
  '    dev: true',
  '',
  '  /typescript/5.4.5:',
  '    resolution: {integrity: sha512-ccc==}',
  "    engines: {node: '>=14.17'}",
  '    hasBin: true',
  '    dev: true',
  '',
  '  /vue/3.4.0_typescript@5.4.5:',
  '    resolution: {integrity: sha512-ddd==}',
  '    peerDependencies:',
  "      typescript: '*'",
  '    dev: false',
  '',
  '  /yaml/2.8.0:',
  '    resolution: {integrity: sha512-eee==}',
  '    dev: false',
  '',
].join('\n');

const YARN_V1 = [
  '# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.',
  '# yarn lockfile v1',
  '',
  '',
  '"@scope/pkg@^1.0.0":',
  '  version "1.0.0"',
  '  resolved "https://registry.yarnpkg.com/@scope/pkg/-/pkg-1.0.0.tgz#abc"',
  '  integrity sha512-aaa==',
  '  dependencies:',
  '    lodash "^4.17.21"',
  '',
  'lodash@^4.17.21:',
  '  version "4.17.21"',
  '  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.21.tgz#def"',
  '  integrity sha512-bbb==',
  '',
  '"yaml@^2.7.0", "yaml@^2.8.0":',
  '  version "2.8.0"',
  '  resolved "https://registry.yarnpkg.com/yaml/-/yaml-2.8.0.tgz#ghi"',
  '  integrity sha512-ccc==',
  '',
].join('\n');

const YARN_BERRY = [
  '# This file is generated by running "yarn install" inside your project.',
  '# Manual changes might be lost - proceed with caution!',
  '',
  '__metadata:',
  '  version: 8',
  '  cacheKey: 10c0',
  '',
  '"@scope/pkg@npm:^1.0.0":',
  '  version: 1.0.0',
  '  resolution: "@scope/pkg@npm:1.0.0"',
  '  checksum: 10c0/aaa',
  '  languageName: node',
  '  linkType: hard',
  '',
  '"demo@workspace:.":',
  '  version: 0.0.0-use.local',
  '  resolution: "demo@workspace:."',
  '  dependencies:',
  '    yaml: "npm:^2.8.0"',
  '  languageName: unknown',
  '  linkType: soft',
  '',
  '"yaml@npm:^2.7.0, yaml@npm:^2.8.0":',
  '  version: 2.8.0',
  '  resolution: "yaml@npm:2.8.0"',
  '  checksum: 10c0/bbb',
  '  languageName: node',
  '  linkType: hard',
  '',
].join('\n');

function byPurl(packages) {
  return new Map(packages.map((pkg) => [pkg.purl, pkg]));
}

function purls(packages) {
  return packages.map((pkg) => pkg.purl);
}

test('NPM-1 FILES lists the three supported lockfile basenames and is frozen', () => {
  assert.deepEqual([...FILES], ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);
  assert.ok(Object.isFrozen(FILES));
});

test('NPM-2 package-lock v3 maps scope, direct and license per entry', () => {
  const { packages, warnings } = parse(PACKAGE_LOCK_V3, { file: 'package-lock.json' });
  assert.deepEqual(warnings, []);
  const index = byPurl(packages);

  const scoped = index.get('pkg:npm/%40scope/pkg@1.0.0');
  assert.ok(scoped, 'scoped package purl: ' + purls(packages).join(' '));
  assert.equal(scoped.name, '@scope/pkg');
  assert.equal(scoped.scope, 'prod');
  assert.equal(scoped.direct, true);
  assert.equal(scoped.license, 'Apache-2.0');
  assert.equal(scoped.source, 'package-lock.json');

  assert.equal(index.get('pkg:npm/typescript@5.4.5').scope, 'dev');
  assert.equal(index.get('pkg:npm/typescript@5.4.5').direct, true);
  assert.equal(index.get('pkg:npm/fsevents@2.3.3').scope, 'optional');
  assert.equal(index.get('pkg:npm/fsevents@2.3.3').direct, true);
  assert.equal(index.get('pkg:npm/wrap-ansi@7.0.0').scope, 'dev');

  assert.equal(index.get('pkg:npm/lodash@4.17.21').scope, 'prod');
  assert.equal(index.get('pkg:npm/lodash@4.17.21').direct, false);
});

test('NPM-3 package-lock v3 keeps nested duplicates apart and skips links plus the root entry', () => {
  const { packages } = parse(PACKAGE_LOCK_V3, { file: 'package-lock.json' });
  const index = byPurl(packages);

  assert.equal(index.get('pkg:npm/yaml@2.8.0').direct, true);
  assert.equal(index.get('pkg:npm/yaml@1.10.2').direct, false);
  assert.equal(index.get('pkg:npm/yaml@1.10.2').name, 'yaml');

  assert.ok(!packages.some((pkg) => pkg.name === 'demo'));
  assert.ok(!packages.some((pkg) => pkg.name === 'workspace-app'));
  assert.deepEqual(purls(packages), [
    'pkg:npm/%40scope/pkg@1.0.0',
    'pkg:npm/fsevents@2.3.3',
    'pkg:npm/lodash@4.17.21',
    'pkg:npm/typescript@5.4.5',
    'pkg:npm/wrap-ansi@7.0.0',
    'pkg:npm/yaml@1.10.2',
    'pkg:npm/yaml@2.8.0',
  ]);
});

test('NPM-4 package-lock v1 walks the nested tree and warns lockfile-v1', () => {
  const { packages, warnings } = parse(PACKAGE_LOCK_V1, { file: 'sub/package-lock.json' });
  assert.deepEqual(warnings, ['lockfile-v1']);
  assert.deepEqual(purls(packages), [
    'pkg:npm/%40scope/pkg@1.0.0',
    'pkg:npm/lodash@4.17.20',
    'pkg:npm/typescript@5.4.5',
    'pkg:npm/yaml@2.8.0',
  ]);
  const index = byPurl(packages);
  assert.equal(index.get('pkg:npm/typescript@5.4.5').scope, 'dev');
  assert.equal(index.get('pkg:npm/yaml@2.8.0').scope, 'prod');
  assert.equal(index.get('pkg:npm/lodash@4.17.20').direct, false);
  assert.equal(index.get('pkg:npm/yaml@2.8.0').source, 'sub/package-lock.json');
});

test('NPM-5 pnpm v9 reads the packages map and derives direct from importers', () => {
  const { packages, warnings } = parse(PNPM_V9, { file: 'pnpm-lock.yaml' });
  assert.deepEqual(warnings, []);
  assert.deepEqual(purls(packages), [
    'pkg:npm/%40scope/pkg@1.0.0',
    'pkg:npm/lodash@4.17.21',
    'pkg:npm/typescript@5.4.5',
    'pkg:npm/yaml@2.8.0',
  ]);
  const index = byPurl(packages);
  assert.equal(index.get('pkg:npm/%40scope/pkg@1.0.0').name, '@scope/pkg');
  assert.equal(index.get('pkg:npm/%40scope/pkg@1.0.0').direct, true);
  assert.equal(index.get('pkg:npm/%40scope/pkg@1.0.0').scope, 'prod');
  assert.equal(index.get('pkg:npm/typescript@5.4.5').scope, 'dev');
  assert.equal(index.get('pkg:npm/typescript@5.4.5').direct, true);
  assert.equal(index.get('pkg:npm/lodash@4.17.21').scope, 'unknown');
  assert.equal(index.get('pkg:npm/lodash@4.17.21').direct, false);
});

test('NPM-6 pnpm v9 falls back to snapshots and strips peer-dependency suffixes', () => {
  const { packages, warnings } = parse(PNPM_V9_SNAPSHOTS_ONLY, { file: 'pnpm-lock.yaml' });
  assert.deepEqual(warnings, []);
  assert.deepEqual(purls(packages), ['pkg:npm/typescript@5.4.5', 'pkg:npm/vue@3.4.0']);
  assert.equal(byPurl(packages).get('pkg:npm/vue@3.4.0').direct, true);
});

test('NPM-7 pnpm v5 slash keys, underscore peer suffixes and dev flags', () => {
  const { packages, warnings } = parse(PNPM_V5, { file: 'pnpm-lock.yaml' });
  assert.deepEqual(warnings, []);
  assert.deepEqual(purls(packages), [
    'pkg:npm/%40scope/pkg@1.0.0',
    'pkg:npm/lodash@4.17.21',
    'pkg:npm/typescript@5.4.5',
    'pkg:npm/vue@3.4.0',
    'pkg:npm/yaml@2.8.0',
  ]);
  const index = byPurl(packages);
  assert.equal(index.get('pkg:npm/%40scope/pkg@1.0.0').name, '@scope/pkg');
  assert.equal(index.get('pkg:npm/%40scope/pkg@1.0.0').direct, true);
  assert.equal(index.get('pkg:npm/vue@3.4.0').scope, 'prod');
  assert.equal(index.get('pkg:npm/typescript@5.4.5').scope, 'dev');
  assert.equal(index.get('pkg:npm/lodash@4.17.21').scope, 'dev');
  assert.equal(index.get('pkg:npm/lodash@4.17.21').direct, false);
});

test('NPM-8 yarn v1 handles multi-descriptor headers, scoped names and unknown scope', () => {
  const { packages, warnings } = parse(YARN_V1, { file: 'yarn.lock' });
  assert.deepEqual(warnings, []);
  assert.deepEqual(purls(packages), [
    'pkg:npm/%40scope/pkg@1.0.0',
    'pkg:npm/lodash@4.17.21',
    'pkg:npm/yaml@2.8.0',
  ]);
  for (const pkg of packages) {
    assert.equal(pkg.scope, 'unknown');
    assert.equal(pkg.direct, false);
    assert.equal(pkg.source, 'yarn.lock');
  }
  assert.equal(byPurl(packages).get('pkg:npm/%40scope/pkg@1.0.0').name, '@scope/pkg');
});

test('NPM-9 yarn Berry parses as YAML and skips workspace entries', () => {
  const { packages, warnings } = parse(YARN_BERRY, { file: 'yarn.lock' });
  assert.deepEqual(warnings, []);
  assert.deepEqual(purls(packages), ['pkg:npm/%40scope/pkg@1.0.0', 'pkg:npm/yaml@2.8.0']);
  assert.ok(!packages.some((pkg) => pkg.name === 'demo'));
  assert.equal(byPurl(packages).get('pkg:npm/yaml@2.8.0').scope, 'unknown');
});

test('NPM-10 an unsupported basename warns instead of guessing', () => {
  assert.deepEqual(parse('{}', { file: 'Gemfile.lock' }), {
    packages: [],
    warnings: ['unsupported-file'],
  });
  assert.deepEqual(parse('{}', {}), { packages: [], warnings: ['unsupported-file'] });
});

test('NPM-11 malformed lockfiles warn instead of throwing', () => {
  assert.deepEqual(parse('{ "packages": ', { file: 'package-lock.json' }), {
    packages: [],
    warnings: ['malformed-json'],
  });
  assert.deepEqual(parse('[]', { file: 'package-lock.json' }), {
    packages: [],
    warnings: ['malformed-json'],
  });
  assert.deepEqual(parse('{"lockfileVersion":3}', { file: 'package-lock.json' }), {
    packages: [],
    warnings: ['no-packages'],
  });
  assert.deepEqual(parse('packages:\n  "yaml@2.8.0: {resolution: [\n', { file: 'pnpm-lock.yaml' }), {
    packages: [],
    warnings: ['malformed-yaml'],
  });
});

test('NPM-12 partially broken entries are skipped with a warning, survivors are kept', () => {
  const content = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'demo', dependencies: { yaml: '^2.8.0' } },
      'node_modules/yaml': { version: '2.8.0' },
      'node_modules/broken': 'not-an-object',
      'node_modules/no-version': { resolved: 'https://example.invalid/x.tgz' },
      'node_modules/': { version: '9.9.9' },
    },
  });
  const { packages, warnings } = parse(content, { file: 'package-lock.json' });
  assert.deepEqual(purls(packages), ['pkg:npm/yaml@2.8.0']);
  assert.deepEqual(warnings.sort(), ['malformed-entry', 'missing-version', 'unnamed-entry']);
});

test('NPM-13 yarn v1 blocks without a version line warn but do not abort the file', () => {
  const content = [
    '# yarn lockfile v1',
    '',
    'broken@^1.0.0:',
    '  resolved "https://registry.yarnpkg.com/broken/-/broken-1.0.0.tgz#zzz"',
    '',
    'lodash@^4.17.21:',
    '  version "4.17.21"',
    '',
  ].join('\n');
  const { packages, warnings } = parse(content, { file: 'yarn.lock' });
  assert.deepEqual(purls(packages), ['pkg:npm/lodash@4.17.21']);
  assert.deepEqual(warnings, ['missing-version']);
});

test('NPM-14 non-string content is a programming error, not a lockfile warning', () => {
  assert.throws(() => parse(null, { file: 'package-lock.json' }), {
    code: 'inventory-invalid-content',
  });
});

test('NPM-15 pnpm registry-prefixed keys resolve, unusable keys warn', () => {
  const content = [
    'lockfileVersion: 5.4',
    '',
    'packages:',
    '',
    '  registry.example.com/yaml/2.8.0:',
    '    resolution: {integrity: sha512-aaa==}',
    '    dev: false',
    '',
    '  weird-key: {}',
    '',
  ].join('\n');
  const { packages, warnings } = parse(content, { file: 'pnpm-lock.yaml' });
  assert.deepEqual(purls(packages), ['pkg:npm/yaml@2.8.0']);
  assert.deepEqual(warnings, ['unparseable-package-key']);
});

test('NPM-16 pnpm non-registry versions and unparseable yarn headers are reported', () => {
  const pnpm = [
    "lockfileVersion: '9.0'",
    '',
    'packages:',
    '',
    '  local-thing@file:../local-thing:',
    '    resolution: {directory: ../local-thing, type: directory}',
    '',
  ].join('\n');
  const pnpmResult = parse(pnpm, { file: 'pnpm-lock.yaml' });
  assert.deepEqual(pnpmResult.packages, []);
  assert.deepEqual(pnpmResult.warnings, ['unresolvable-version']);

  const yarn = ['# yarn lockfile v1', '', 'this line is not a block header', ''].join('\n');
  const yarnResult = parse(yarn, { file: 'yarn.lock' });
  assert.deepEqual(yarnResult.packages, []);
  assert.deepEqual(yarnResult.warnings, ['unparseable-block-header']);
});

test('NPM-17 the YAML size cap propagates as an error', () => {
  const huge = "lockfileVersion: '9.0'\n# " + 'x'.repeat(1024 * 1024) + '\n';
  assert.throws(() => parse(huge, { file: 'pnpm-lock.yaml' }), { code: 'yaml-too-large' });
});
