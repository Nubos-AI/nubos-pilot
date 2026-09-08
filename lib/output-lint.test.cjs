'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const outputLint = require('./output-lint.cjs');
const verificationSchema = require('./schemas/verification.cjs');
const validationSchema = require('./schemas/validation.cjs');
const { getSchema, inferSchemaForFile, listSchemas } = require('./schemas/index.cjs');

const FIX_VER = path.join(__dirname, 'fixtures', 'verification');
const FIX_VAL = path.join(__dirname, 'fixtures', 'validation');

const _tmp = [];

afterEach(() => {
  while (_tmp.length) {
    try { fs.rmSync(_tmp.pop(), { recursive: true, force: true }); } catch {}
  }
});

function _tmpFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-ol-'));
  _tmp.push(dir);
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

test('OL-1: verification schema accepts canonical frontmatter file', () => {
  const result = outputLint.lintFile(
    path.join(FIX_VER, 'h3-colon-verified.md'),
    verificationSchema,
  );
  assert.equal(result.ok, true, 'expected ok; violations: ' + JSON.stringify(result.violations));
});

test('OL-2: verification schema rejects H2/em-dash file (no frontmatter)', () => {
  const result = outputLint.lintFile(
    path.join(FIX_VER, 'h2-emdash-verified.md'),
    verificationSchema,
  );
  assert.equal(result.ok, false);
  const codes = result.violations.map((v) => v.code);
  assert.ok(codes.includes('missing-required'), 'expected missing-required: ' + JSON.stringify(codes));
  assert.ok(codes.includes('invariant'), 'expected invariant violation');
  assert.ok(codes.includes('block-min'), 'expected block-min (H3 pattern not matched)');
});

test('OL-3: verification rejects [object Object] in SC heading', () => {
  const bad = [
    '---',
    'schema_version: 2',
    'milestone: "M001"',
    'milestone_status: verified',
    'sc_total: 1',
    'passed: 1',
    'failed: 0',
    'deferred: 0',
    'pending: 0',
    '---',
    '',
    '# M001 — Verification',
    '',
    '**Milestone Status:** verified',
    '',
    '### SC-1: [object Object]',
    '- **Status:** Pass',
    '- **Classified by:** np-verifier',
    '- **Evidence:** abc',
    '',
  ].join('\n');
  const p = _tmpFile('M001-VERIFICATION.md', bad);
  const result = outputLint.lintFile(p, verificationSchema);
  assert.equal(result.ok, false);
  assert.ok(
    result.violations.some((v) => v.code === 'block-heading-forbidden'),
    'expected block-heading-forbidden: ' + JSON.stringify(result.violations),
  );
});

test('OL-4: verification rejects sc_total != sum(passed+failed+deferred+pending)', () => {
  const bad = [
    '---',
    'schema_version: 2',
    'milestone: "M001"',
    'milestone_status: verified',
    'sc_total: 5',
    'passed: 2',
    'failed: 0',
    'deferred: 0',
    'pending: 0',
    '---',
    '',
    '# M001 — Verification',
    '',
    '**Milestone Status:** verified',
    '',
    '### SC-1: ok',
    '- **Status:** Pass',
    '- **Classified by:** np-verifier',
    '- **Evidence:** abc',
    '',
    '### SC-2: ok',
    '- **Status:** Pass',
    '- **Classified by:** np-verifier',
    '- **Evidence:** abc',
    '',
  ].join('\n');
  const p = _tmpFile('M001-VERIFICATION.md', bad);
  const result = outputLint.lintFile(p, verificationSchema);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.code === 'invariant'));
});

test('OL-5: verification rejects wrong milestone_status enum value', () => {
  const bad = [
    '---',
    'schema_version: 2',
    'milestone: "M001"',
    'milestone_status: maybe',
    'sc_total: 0',
    'passed: 0',
    'failed: 0',
    'deferred: 0',
    'pending: 0',
    '---',
    '',
    '**Milestone Status:** maybe',
    '',
    '### SC-1: foo',
    '- **Status:** Pass',
    '- **Classified by:** x',
    '- **Evidence:** y',
  ].join('\n');
  const p = _tmpFile('M001-VERIFICATION.md', bad);
  const result = outputLint.lintFile(p, verificationSchema);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.code === 'enum' && v.path === 'frontmatter.milestone_status'));
});

test('OL-6: verification rejects forbidden Status block-field value', () => {
  const bad = [
    '---',
    'schema_version: 2',
    'milestone: "M001"',
    'milestone_status: verified',
    'sc_total: 1',
    'passed: 1',
    'failed: 0',
    'deferred: 0',
    'pending: 0',
    '---',
    '',
    '**Milestone Status:** verified',
    '',
    '### SC-1: fine',
    '- **Status:** Maybe',
    '- **Classified by:** x',
    '- **Evidence:** y',
  ].join('\n');
  const p = _tmpFile('M001-VERIFICATION.md', bad);
  const result = outputLint.lintFile(p, verificationSchema);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.code === 'block-field-enum'));
});

test('OL-7: validation schema accepts canonical frontmatter file', () => {
  const result = outputLint.lintFile(
    path.join(FIX_VAL, 'clean-frontmatter.md'),
    validationSchema,
  );
  assert.equal(result.ok, true, 'expected ok; violations: ' + JSON.stringify(result.violations));
});

test('OL-8: validation rejects file with no frontmatter (legacy)', () => {
  const result = outputLint.lintFile(
    path.join(FIX_VAL, 'legacy-no-frontmatter.md'),
    validationSchema,
  );
  assert.equal(result.ok, false);
  const codes = result.violations.map((v) => v.code);
  assert.ok(codes.includes('missing-required'));
});

test('OL-9: validation rejects requirements_total != covered + under + uncovered', () => {
  const bad = [
    '---',
    'phase: 1',
    'audited_at: "2026-05-12T10:00:00Z"',
    'requirements_total: 10',
    'covered: 5',
    'under_sampled: 0',
    'uncovered: 0',
    'nyquist_compliant: false',
    'status: clean',
    '---',
    '',
    '## Summary',
    '',
    '## Covered',
    '',
    '## Under-Sampled',
    '',
    '## Uncovered',
  ].join('\n');
  const p = _tmpFile('M001-VALIDATION.md', bad);
  const result = outputLint.lintFile(p, validationSchema);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.code === 'invariant'));
});

test('OL-10: validation rejects missing body sections', () => {
  const bad = [
    '---',
    'phase: 1',
    'audited_at: "2026-05-12T10:00:00Z"',
    'requirements_total: 0',
    'covered: 0',
    'under_sampled: 0',
    'uncovered: 0',
    'nyquist_compliant: true',
    'status: clean',
    '---',
    '',
    '# Validation',
    '',
    'no sections present',
  ].join('\n');
  const p = _tmpFile('M001-VALIDATION.md', bad);
  const result = outputLint.lintFile(p, validationSchema);
  assert.equal(result.ok, false);
  const messages = result.violations.map((v) => v.message);
  assert.ok(messages.some((m) => /Summary section missing/.test(m)));
  assert.ok(messages.some((m) => /Covered section missing/.test(m)));
});

test('OL-11: lintFile on non-existent file returns file-missing violation', () => {
  const result = outputLint.lintFile('/tmp/np-does-not-exist-xyz123.md', verificationSchema);
  assert.equal(result.ok, false);
  assert.equal(result.violations[0].code, 'file-missing');
});

test('OL-12: enforceFile throws NubosPilotError on violation', () => {
  const p = _tmpFile('M001-VERIFICATION.md', '# nothing\n');
  assert.throws(
    () => outputLint.enforceFile(p, verificationSchema),
    (err) => err.name === 'NubosPilotError' && err.code === 'output-schema-violation',
  );
});

test('OL-13: schemaPrompt renders required keys + enums + invariants', () => {
  const md = outputLint.schemaPrompt(verificationSchema);
  assert.match(md, /# Output Schema — verification/);
  assert.match(md, /schema_version: 2/);
  assert.match(md, /milestone_status: verified \| failed \| deferred/);
  assert.match(md, /sc_total must equal passed/);
  assert.match(md, /Heading pattern:.*SC-/);
  assert.match(md, /Status.*Pass.*Fail.*Defer.*Pending/);
});

test('OL-14: schemaPrompt renders forbidden substring guard', () => {
  const md = outputLint.schemaPrompt(verificationSchema);
  assert.match(md, /\[object Object\]/);
});

test('OL-15: registry — inferSchemaForFile picks correct schema', () => {
  assert.equal(inferSchemaForFile('/x/M001-VERIFICATION.md'), 'verification');
  assert.equal(inferSchemaForFile('/x/M005-VALIDATION.md'), 'validation');
  assert.equal(inferSchemaForFile('/x/random.md'), null);
});

test('OL-16: registry — getSchema rejects unknown name', () => {
  assert.throws(
    () => getSchema('bogus'),
    (err) => err.code === 'output-schema-not-found',
  );
});

test('OL-17: listSchemas returns the registered set', () => {
  const names = listSchemas();
  assert.ok(names.includes('verification'));
  assert.ok(names.includes('validation'));
});
