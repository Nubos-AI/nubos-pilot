'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { toCycloneDx, render, SPEC_VERSION } = require('./export.cjs');
const { makePackage } = require('../inventory/pkgurl.cjs');

const TS = '2026-08-03T12:00:00.000Z';

function inv(packages) {
  return { packages: packages || [] };
}

function opts(over) {
  return Object.assign({ timestamp: TS, projectName: 'demo', toolVersion: '1.5.0' }, over || {});
}

test('SBOM-1 emits a well-formed CycloneDX envelope', () => {
  const bom = toCycloneDx(inv([]), opts());
  assert.equal(bom.bomFormat, 'CycloneDX');
  assert.equal(bom.specVersion, SPEC_VERSION);
  assert.equal(bom.version, 1);
  assert.equal(bom.metadata.timestamp, TS);
  assert.equal(bom.metadata.component.name, 'demo');
  assert.equal(bom.metadata.tools.components[0].version, '1.5.0');
  assert.deepEqual(bom.components, []);
});

test('SBOM-2 serial number is a valid v4-shaped uuid urn', () => {
  const bom = toCycloneDx(inv([makePackage({ ecosystem: 'npm', name: 'yaml', version: '2.8.0' })]), opts());
  assert.match(bom.serialNumber, /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('SBOM-3 identical inventories produce an identical serial number', () => {
  const packages = [makePackage({ ecosystem: 'npm', name: 'yaml', version: '2.8.0' })];
  const a = toCycloneDx(inv(packages), opts());
  const b = toCycloneDx(inv(packages), opts());
  assert.equal(a.serialNumber, b.serialNumber);
});

test('SBOM-4 a different package set produces a different serial number', () => {
  const a = toCycloneDx(inv([makePackage({ ecosystem: 'npm', name: 'a', version: '1.0.0' })]), opts());
  const b = toCycloneDx(inv([makePackage({ ecosystem: 'npm', name: 'b', version: '1.0.0' })]), opts());
  assert.notEqual(a.serialNumber, b.serialNumber);
});

test('SBOM-5 input order does not change the output', () => {
  const p1 = makePackage({ ecosystem: 'npm', name: 'a', version: '1.0.0' });
  const p2 = makePackage({ ecosystem: 'npm', name: 'b', version: '1.0.0' });
  assert.equal(render(inv([p1, p2]), opts()), render(inv([p2, p1]), opts()));
});

test('SBOM-6 nubos-pilot scopes map onto the CycloneDX vocabulary', () => {
  const cases = [['prod', 'required'], ['dev', 'excluded'], ['optional', 'optional'], ['unknown', 'required']];
  for (const [scope, expected] of cases) {
    const bom = toCycloneDx(inv([makePackage({ ecosystem: 'npm', name: 'x', version: '1.0.0', scope })]), opts());
    assert.equal(bom.components[0].scope, expected, scope + ' -> ' + expected);
  }
});

test('SBOM-7 the original scope survives as a property even when mapped', () => {
  const bom = toCycloneDx(inv([makePackage({ ecosystem: 'npm', name: 'x', version: '1.0.0', scope: 'dev' })]), opts());
  const props = bom.components[0].properties;
  assert.ok(props.some((p) => p.name === 'nubos-pilot:scope' && p.value === 'dev'));
  assert.ok(props.some((p) => p.name === 'nubos-pilot:ecosystem' && p.value === 'npm'));
  assert.ok(props.some((p) => p.name === 'nubos-pilot:direct' && p.value === 'false'));
});

test('SBOM-8 a single SPDX id becomes a license id', () => {
  const bom = toCycloneDx(inv([makePackage({ ecosystem: 'npm', name: 'x', version: '1.0.0', license: 'MIT' })]), opts());
  assert.deepEqual(bom.components[0].licenses, [{ license: { id: 'MIT' } }]);
});

test('SBOM-9 an OR expression splits into separate license entries', () => {
  const bom = toCycloneDx(inv([makePackage({ ecosystem: 'npm', name: 'x', version: '1.0.0', license: 'Apache-2.0 OR MIT' })]), opts());
  assert.deepEqual(bom.components[0].licenses, [
    { license: { id: 'Apache-2.0' } },
    { license: { id: 'MIT' } },
  ]);
});

test('SBOM-10 a non-SPDX license string is carried as a name, not an id', () => {
  const bom = toCycloneDx(inv([makePackage({ ecosystem: 'npm', name: 'x', version: '1.0.0', license: 'see LICENSE file' })]), opts());
  assert.deepEqual(bom.components[0].licenses, [{ license: { name: 'see LICENSE file' } }]);
});

test('SBOM-11 a package without a license omits the licenses key entirely', () => {
  const bom = toCycloneDx(inv([makePackage({ ecosystem: 'npm', name: 'x', version: '1.0.0' })]), opts());
  assert.ok(!('licenses' in bom.components[0]));
});

test('SBOM-12 a package without a version omits the version key', () => {
  const bom = toCycloneDx(inv([makePackage({ ecosystem: 'npm', name: 'x' })]), opts());
  assert.ok(!('version' in bom.components[0]));
  assert.equal(bom.components[0].purl, 'pkg:npm/x');
});

test('SBOM-13 bom-ref equals the purl so components are addressable', () => {
  const bom = toCycloneDx(inv([makePackage({ ecosystem: 'npm', name: '@scope/pkg', version: '1.0.0' })]), opts());
  assert.equal(bom.components[0]['bom-ref'], bom.components[0].purl);
  assert.equal(bom.components[0].name, '@scope/pkg');
});

test('SBOM-14 a missing timestamp is refused so exports stay reproducible', () => {
  assert.throws(() => toCycloneDx(inv([]), { projectName: 'x' }), /explicit ISO timestamp/);
  assert.throws(() => toCycloneDx(inv([]), { timestamp: '' }), /explicit ISO timestamp/);
});

test('SBOM-15 a malformed inventory is refused loudly', () => {
  assert.throws(() => toCycloneDx(null, opts()), /packages array/);
  assert.throws(() => toCycloneDx({}, opts()), /packages array/);
  assert.throws(() => toCycloneDx({ packages: 'x' }, opts()), /packages array/);
});

test('SBOM-16 entries without a purl are skipped rather than emitted broken', () => {
  const bom = toCycloneDx({ packages: [null, {}, makePackage({ ecosystem: 'npm', name: 'x', version: '1.0.0' })] }, opts());
  assert.equal(bom.components.length, 1);
});

test('SBOM-17 render produces parseable JSON ending in a newline', () => {
  const text = render(inv([makePackage({ ecosystem: 'npm', name: 'x', version: '1.0.0' })]), opts());
  assert.ok(text.endsWith('\n'));
  assert.equal(JSON.parse(text).components.length, 1);
});

test('SBOM-18 project version is optional and omitted when absent', () => {
  assert.ok(!('version' in toCycloneDx(inv([]), opts()).metadata.component));
  assert.equal(toCycloneDx(inv([]), opts({ projectVersion: '2.1.0' })).metadata.component.version, '2.1.0');
});
