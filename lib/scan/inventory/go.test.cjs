'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { FILES, parse } = require('./go.cjs');

function byName(packages, name) {
  return packages.find((p) => p.name === name);
}

test('GO-1 go.mod block form yields packages and marks // indirect entries', () => {
  const content = [
    'module github.com/example/app',
    '',
    'go 1.22',
    '',
    'require (',
    '\tgithub.com/gin-gonic/gin v1.9.1',
    '\tgolang.org/x/sys v0.15.0 // indirect',
    '\tgithub.com/bytedance/sonic v1.10.2 // indirect; pinned',
    ')',
  ].join('\n');

  const { packages, warnings } = parse(content, { file: 'go.mod' });

  assert.deepEqual(warnings, []);
  assert.deepEqual(packages.map((p) => p.purl), [
    'pkg:golang/github.com/gin-gonic/gin@v1.9.1',
    'pkg:golang/golang.org/x/sys@v0.15.0',
    'pkg:golang/github.com/bytedance/sonic@v1.10.2',
  ]);
  assert.equal(byName(packages, 'github.com/gin-gonic/gin').direct, true);
  assert.equal(byName(packages, 'golang.org/x/sys').direct, false);
  assert.equal(byName(packages, 'github.com/bytedance/sonic').direct, false);
  for (const pkg of packages) {
    assert.equal(pkg.scope, 'prod');
    assert.equal(pkg.ecosystem, 'Go');
    assert.equal(pkg.source, 'go.mod');
  }
});

test('GO-2 single-line require, replace version wins, exclude is skipped', () => {
  const content = [
    'module github.com/example/app',
    '',
    'require github.com/spf13/cobra v1.8.0',
    '',
    'require github.com/gin-gonic/gin v1.9.1',
    '',
    'replace github.com/gin-gonic/gin => github.com/forked/gin v1.9.2',
    '',
    'exclude github.com/broken/pkg v0.1.0',
  ].join('\n');

  const { packages, warnings } = parse(content, { file: 'go.mod' });

  assert.deepEqual(warnings, []);
  assert.deepEqual(packages.map((p) => p.purl), [
    'pkg:golang/github.com/spf13/cobra@v1.8.0',
    'pkg:golang/github.com/gin-gonic/gin@v1.9.2',
  ]);
  assert.equal(packages.every((p) => p.direct === true), true);
});

test('GO-3 +incompatible stays part of the version', () => {
  const content = 'require github.com/docker/docker v20.10.7+incompatible\n';

  const { packages } = parse(content, { file: 'go.mod' });

  assert.equal(packages.length, 1);
  assert.equal(packages[0].version, 'v20.10.7+incompatible');
  assert.equal(packages[0].purl, 'pkg:golang/github.com/docker/docker@v20.10.7%2Bincompatible');
});

test('GO-4 replace block form records the replacement version', () => {
  const content = [
    'require (',
    '\tgithub.com/pkg/errors v0.9.0',
    '\tgithub.com/local/lib v1.0.0',
    ')',
    '',
    'replace (',
    '\tgithub.com/pkg/errors v0.9.0 => github.com/pkg/errors v0.9.1',
    '\tgithub.com/local/lib => ../local/lib',
    ')',
  ].join('\n');

  const { packages, warnings } = parse(content, { file: 'go.mod' });

  assert.deepEqual(warnings, ['replaced-by-local-path']);
  assert.equal(byName(packages, 'github.com/pkg/errors').version, 'v0.9.1');
  assert.equal(byName(packages, 'github.com/local/lib').version, null);
});

test('GO-5 go.sum collapses the /go.mod hash line into one package', () => {
  const content = [
    'github.com/gin-gonic/gin v1.9.1 h1:4idEAncQnU5cB7BeOkPtxjfCSye0AAm1R0RVIqJ+Jmg=',
    'github.com/gin-gonic/gin v1.9.1/go.mod h1:hPrL7YrpYKXt5YId3A/Tnip5kqbEAP+KLuI3SUcPTeU=',
    'golang.org/x/sys v0.15.0/go.mod h1:/VUhepiaJMQUp4+oa/7Zr1D23ma6VTLIYjOOTFZPUcA=',
    '',
  ].join('\n');

  const { packages, warnings } = parse(content, { file: 'vendor/go.sum' });

  assert.deepEqual(warnings, []);
  assert.deepEqual(packages.map((p) => p.purl), [
    'pkg:golang/github.com/gin-gonic/gin@v1.9.1',
    'pkg:golang/golang.org/x/sys@v0.15.0',
  ]);
  assert.equal(packages.every((p) => p.direct === false), true);
  assert.equal(packages.every((p) => p.scope === 'prod'), true);
  assert.equal(packages[0].source, 'vendor/go.sum');
});

test('GO-6 unknown basename reports unsupported-file', () => {
  assert.deepEqual(parse('anything', { file: 'go.work' }), { packages: [], warnings: ['unsupported-file'] });
  assert.deepEqual(parse('anything', {}), { packages: [], warnings: ['unsupported-file'] });
});

test('GO-7 malformed lines warn instead of throwing', () => {
  const mod = parse([
    'require (',
    '\tgithub.com/ok/one v1.0.0',
    '\tgithub.com/missing/version',
    ')',
    'replace github.com/no/arrow v1.0.0',
  ].join('\n'), { file: 'go.mod' });

  assert.deepEqual(mod.packages.map((p) => p.purl), ['pkg:golang/github.com/ok/one@v1.0.0']);
  assert.ok(mod.warnings.includes('malformed-require'));
  assert.ok(mod.warnings.includes('malformed-replace'));

  const sum = parse('github.com/ok/one v1.0.0 h1:aaa=\ngarbage-line\n', { file: 'go.sum' });
  assert.equal(sum.packages.length, 1);
  assert.deepEqual(sum.warnings, ['malformed-sum-line']);
});

test('GO-8 FILES is a frozen list of the handled basenames', () => {
  assert.deepEqual([...FILES], ['go.mod', 'go.sum']);
  assert.equal(Object.isFrozen(FILES), true);
});

test('GO-9 a module replaced by a local path loses its version and warns', () => {
  const mod = [
    'module x',
    'require github.com/a/b v1.0.0',
    'replace github.com/a/b => ../local/b',
  ].join('\n');
  const { packages, warnings } = parse(mod, { file: 'go.mod' });
  const replaced = packages.find((p) => p.name === 'github.com/a/b');
  assert.equal(replaced.version, null, 'upstream version must not be claimed for local code');
  assert.equal(replaced.purl, 'pkg:golang/github.com/a/b');
  assert.ok(warnings.includes('replaced-by-local-path'));
});

test('GO-10 a module replaced by a versioned module keeps the replacement version', () => {
  const mod = [
    'module x',
    'require github.com/a/b v1.0.0',
    'replace github.com/a/b => github.com/fork/b v9.9.9',
  ].join('\n');
  const { packages, warnings } = parse(mod, { file: 'go.mod' });
  assert.equal(packages.find((p) => p.name === 'github.com/a/b').version, 'v9.9.9');
  assert.ok(!warnings.includes('replaced-by-local-path'));
});
