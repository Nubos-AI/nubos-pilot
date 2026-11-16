'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  ECOSYSTEMS,
  SCOPES,
  isEcosystem,
  assertEcosystem,
  splitName,
  normalizeName,
  purl,
  parsePurl,
  makePackage,
  dedupe,
} = require('./pkgurl.cjs');

test('PURL-1 every ecosystem maps to a purl type and back', () => {
  for (const eco of ECOSYSTEMS) {
    const round = parsePurl(purl({ ecosystem: eco, name: 'foo', version: '1.0.0' }));
    assert.equal(round.ecosystem, eco, eco + ' must round-trip');
    assert.equal(round.name, 'foo');
    assert.equal(round.version, '1.0.0');
  }
});

test('PURL-2 npm scoped names split into namespace and name', () => {
  assert.deepEqual(splitName('npm', '@scope/pkg'), { namespace: '@scope', name: 'pkg' });
  assert.deepEqual(splitName('npm', 'plain'), { namespace: null, name: 'plain' });
  assert.deepEqual(splitName('npm', '@broken'), { namespace: null, name: '@broken' });
});

test('PURL-3 maven splits on colon and go on the last slash', () => {
  assert.deepEqual(splitName('Maven', 'org.apache:commons'), { namespace: 'org.apache', name: 'commons' });
  assert.deepEqual(splitName('Go', 'github.com/foo/bar'), { namespace: 'github.com/foo', name: 'bar' });
  assert.deepEqual(splitName('Go', 'singleton'), { namespace: null, name: 'singleton' });
});

test('PURL-4 scoped npm purl round-trips namespace and name', () => {
  const p = purl({ ecosystem: 'npm', name: '@scope/pkg', version: '1.0.0' });
  const parsed = parsePurl(p);
  assert.equal(parsed.namespace, '@scope');
  assert.equal(parsed.name, 'pkg');
  assert.equal(parsed.version, '1.0.0');
});

test('PURL-5 PyPI names normalize per PEP 503 for lookup keys', () => {
  assert.equal(normalizeName('PyPI', 'Flask_SQLAlchemy'), 'flask-sqlalchemy');
  assert.equal(normalizeName('PyPI', 'zope.interface'), 'zope-interface');
  assert.equal(normalizeName('PyPI', 'Django'), 'django');
});

test('PURL-6 crates and npm names normalize, Go and Maven stay case-sensitive', () => {
  assert.equal(normalizeName('crates.io', 'serde_json'), 'serde-json');
  assert.equal(normalizeName('npm', 'React'), 'react');
  assert.equal(normalizeName('Go', 'github.com/Foo/Bar'), 'github.com/Foo/Bar');
  assert.equal(normalizeName('Maven', 'org.Apache:Commons'), 'org.Apache:Commons');
});

test('PURL-7 a purl without a version omits the @ suffix', () => {
  assert.equal(purl({ ecosystem: 'npm', name: 'yaml' }), 'pkg:npm/yaml');
  assert.equal(parsePurl('pkg:npm/yaml').version, null);
});

test('PURL-8 unknown ecosystem is refused loudly', () => {
  assert.throws(() => assertEcosystem('cpan'), /unknown ecosystem/);
  assert.throws(() => purl({ ecosystem: 'cpan', name: 'x' }), /unknown ecosystem/);
  assert.ok(!isEcosystem('cpan'));
});

test('PURL-9 a package without a name is refused loudly', () => {
  assert.throws(() => purl({ ecosystem: 'npm', name: '' }), /needs a name/);
  assert.throws(() => makePackage({ ecosystem: 'npm' }), /needs a name/);
});

test('PURL-10 parsePurl rejects non-purl and unknown-type input', () => {
  assert.equal(parsePurl('not-a-purl'), null);
  assert.equal(parsePurl('pkg:cpan/foo@1.0'), null);
  assert.equal(parsePurl(''), null);
  assert.equal(parsePurl(null), null);
  assert.equal(parsePurl('pkg:npm'), null);
});

test('PURL-11 parsePurl drops qualifiers and subpath', () => {
  const parsed = parsePurl('pkg:npm/yaml@2.8.0?arch=x64#sub/path');
  assert.equal(parsed.name, 'yaml');
  assert.equal(parsed.version, '2.8.0');
});

test('PURL-12 makePackage fills key, purl and safe defaults', () => {
  const pkg = makePackage({ ecosystem: 'PyPI', name: 'Flask_SQLAlchemy', version: '3.1.1' });
  assert.equal(pkg.key, 'flask-sqlalchemy');
  assert.equal(pkg.purl, 'pkg:pypi/Flask_SQLAlchemy@3.1.1');
  assert.equal(pkg.scope, 'unknown');
  assert.equal(pkg.direct, false);
  assert.equal(pkg.source, null);
  assert.equal(pkg.license, null);
});

test('PURL-13 makePackage rejects an out-of-vocabulary scope', () => {
  assert.equal(makePackage({ ecosystem: 'npm', name: 'x', scope: 'bogus' }).scope, 'unknown');
  for (const scope of SCOPES) {
    assert.equal(makePackage({ ecosystem: 'npm', name: 'x', scope }).scope, scope);
  }
});

test('PURL-14 makePackage treats an empty version as absent', () => {
  assert.equal(makePackage({ ecosystem: 'npm', name: 'x', version: '' }).version, null);
  assert.equal(makePackage({ ecosystem: 'npm', name: 'x', version: null }).purl, 'pkg:npm/x');
});

test('PURL-15 dedupe collapses identical purls and keeps the strongest scope', () => {
  const merged = dedupe([
    makePackage({ ecosystem: 'npm', name: 'yaml', version: '2.8.0', scope: 'dev' }),
    makePackage({ ecosystem: 'npm', name: 'yaml', version: '2.8.0', scope: 'prod' }),
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].scope, 'prod');
});

test('PURL-16 dedupe promotes unknown scope and keeps direct and license', () => {
  const merged = dedupe([
    makePackage({ ecosystem: 'npm', name: 'a', version: '1.0.0', scope: 'unknown', direct: false }),
    makePackage({ ecosystem: 'npm', name: 'a', version: '1.0.0', scope: 'dev', direct: true, license: 'MIT' }),
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].scope, 'dev');
  assert.equal(merged[0].direct, true);
  assert.equal(merged[0].license, 'MIT');
});

test('PURL-17 dedupe keeps different versions apart and sorts deterministically', () => {
  const merged = dedupe([
    makePackage({ ecosystem: 'npm', name: 'b', version: '2.0.0' }),
    makePackage({ ecosystem: 'npm', name: 'a', version: '1.0.0' }),
    makePackage({ ecosystem: 'npm', name: 'b', version: '1.0.0' }),
  ]);
  assert.deepEqual(merged.map((p) => p.purl), [
    'pkg:npm/a@1.0.0', 'pkg:npm/b@1.0.0', 'pkg:npm/b@2.0.0',
  ]);
});

test('PURL-18 dedupe tolerates junk entries', () => {
  assert.deepEqual(dedupe([null, undefined, {}, 'x']), []);
  assert.deepEqual(dedupe(null), []);
});
