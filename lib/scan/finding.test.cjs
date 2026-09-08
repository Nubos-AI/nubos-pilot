'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  SEVERITIES,
  SEVERITY_RANK,
  isValidRuleId,
  normalizeSeverity,
  toLegacySeverity,
  atLeast,
  make,
  fingerprint,
  sortFindings,
  envelope,
} = require('./finding.cjs');

function base(over) {
  return Object.assign({ id: 'NPS-0001', scanner: 'patterns', severity: 'high' }, over || {});
}

test('FND-1 rule ids must match NPS-####', () => {
  assert.ok(isValidRuleId('NPS-0001'));
  assert.ok(isValidRuleId('NPS-9999'));
  assert.ok(!isValidRuleId('NPS-1'));
  assert.ok(!isValidRuleId('NPS-00011'));
  assert.ok(!isValidRuleId('nps-0001'));
  assert.ok(!isValidRuleId(''));
  assert.ok(!isValidRuleId(null));
});

test('FND-2 graded severities pass through unchanged', () => {
  for (const s of SEVERITIES) assert.equal(normalizeSeverity(s), s);
});

test('FND-3 legacy severities map onto the graded scale', () => {
  assert.equal(normalizeSeverity('nit'), 'low');
  assert.equal(normalizeSeverity('warn'), 'medium');
  assert.equal(normalizeSeverity('risk'), 'high');
  assert.equal(normalizeSeverity('fail'), 'high');
});

test('FND-4 unknown severity fails safe to high, never to info', () => {
  for (const raw of ['bogus', '', null, undefined, 42, {}]) {
    assert.equal(normalizeSeverity(raw), 'high', 'input: ' + String(raw));
  }
});

test('FND-5 toLegacySeverity reproduces the pre-existing risk/warn split', () => {
  assert.equal(toLegacySeverity('critical'), 'risk');
  assert.equal(toLegacySeverity('high'), 'risk');
  assert.equal(toLegacySeverity('medium'), 'warn');
  assert.equal(toLegacySeverity('low'), 'warn');
  assert.equal(toLegacySeverity('info'), 'warn');
  assert.equal(toLegacySeverity('risk'), 'risk');
  assert.equal(toLegacySeverity('warn'), 'warn');
  assert.equal(toLegacySeverity('bogus'), 'risk');
});

test('FND-6 atLeast gates on the graded rank in both directions', () => {
  assert.ok(atLeast('critical', 'high'));
  assert.ok(atLeast('high', 'high'));
  assert.ok(!atLeast('medium', 'high'));
  assert.ok(atLeast('info', 'info'));
  assert.ok(atLeast('high', 'warn'));
});

test('FND-7 make rejects a missing or malformed rule id', () => {
  assert.throws(() => make({ scanner: 'patterns' }), /NPS-####/);
  assert.throws(() => make({ id: 'X-1', scanner: 'patterns' }), /NPS-####/);
});

test('FND-8 make rejects an unknown scanner', () => {
  assert.throws(() => make({ id: 'NPS-0001', scanner: 'nope' }), /scanner must be one of/);
  assert.throws(() => make({ id: 'NPS-0001' }), /scanner must be one of/);
});

test('FND-9 make normalizes cwe ids and drops malformed entries', () => {
  const f = make(base({ cwe: ['cwe-79', 'CWE-89', 'CWE-79', 'nope', '', null, 'CWE-123456'] }));
  assert.deepEqual(f.cwe, ['CWE-79', 'CWE-89']);
  assert.deepEqual(make(base({})).cwe, []);
  assert.deepEqual(make(base({ cwe: 'CWE-22' })).cwe, ['CWE-22']);
});

test('FND-10 make keeps a package only when it has a name', () => {
  const withPkg = make(base({ package: { name: 'yaml', version: '2.8.0', ecosystem: 'npm' } }));
  assert.deepEqual(withPkg.package, { name: 'yaml', version: '2.8.0', ecosystem: 'npm' });
  assert.equal(make(base({ package: { version: '1.0.0' } })).package, null);
  assert.equal(make(base({ package: 'yaml' })).package, null);
  assert.equal(make(base({})).package, null);
});

test('FND-11 make rejects non-positive and non-integer lines', () => {
  assert.equal(make(base({ line: 12 })).line, 12);
  assert.equal(make(base({ line: 0 })).line, null);
  assert.equal(make(base({ line: -3 })).line, null);
  assert.equal(make(base({ line: 1.5 })).line, null);
  assert.equal(make(base({ line: '12' })).line, null);
});

test('FND-12 make caps title and reminder at their byte limits', () => {
  const f = make(base({ title: 'x'.repeat(500), reminder: 'y'.repeat(4000) }));
  assert.equal(Buffer.byteLength(f.title, 'utf-8'), 200);
  assert.equal(Buffer.byteLength(f.reminder, 'utf-8'), 1024);
});

test('FND-13 make defaults rule_name to the id and source to builtin', () => {
  const f = make(base({}));
  assert.equal(f.rule_name, 'NPS-0001');
  assert.equal(f.source, 'builtin');
  assert.equal(f.category, 'unspecified');
  assert.equal(make(base({ source: 'bogus' })).source, 'builtin');
  assert.equal(make(base({ source: 'advisory' })).source, 'advisory');
});

test('FND-14 fingerprint separates two advisories on the same file', () => {
  const a = { file: 'package-lock.json', line: 1, category: 'vulnerability', id: 'NPS-0100', package: { name: 'foo', version: '1.0.0' } };
  const b = { ...a, id: 'NPS-0101' };
  assert.notEqual(fingerprint(a), fingerprint(b));
});

test('FND-15 fingerprint separates two versions of the same package', () => {
  const a = { file: 'package-lock.json', category: 'vulnerability', id: 'NPS-0100', package: { name: 'foo', version: '1.0.0' } };
  const b = { ...a, package: { name: 'foo', version: '2.0.0' } };
  assert.notEqual(fingerprint(a), fingerprint(b));
});

test('FND-16 fingerprint is stable for findings without id or package', () => {
  const legacy = { file: 'x.js', line: 10, category: 'injection', rule_name: 'eval_call' };
  assert.equal(fingerprint(legacy), fingerprint({ ...legacy }));
  assert.notEqual(fingerprint(legacy), fingerprint({ ...legacy, file: 'y.js' }));
});

test('FND-17 sortFindings orders by severity, then file, line, id', () => {
  const sorted = sortFindings([
    { id: 'NPS-0003', severity: 'low', file: 'a.js', line: 1 },
    { id: 'NPS-0001', severity: 'critical', file: 'z.js', line: 9 },
    { id: 'NPS-0002', severity: 'high', file: 'b.js', line: 2 },
    { id: 'NPS-0004', severity: 'high', file: 'a.js', line: 5 },
  ]);
  assert.deepEqual(sorted.map((f) => f.id), ['NPS-0001', 'NPS-0004', 'NPS-0002', 'NPS-0003']);
});

test('FND-18 sortFindings does not mutate its input', () => {
  const input = [{ id: 'NPS-0002', severity: 'low' }, { id: 'NPS-0001', severity: 'high' }];
  sortFindings(input);
  assert.equal(input[0].id, 'NPS-0002');
});

test('FND-19 envelope allows when nothing meets the minimum severity', () => {
  const findings = [{ id: 'NPS-0001', severity: 'low', title: 'nit', file: 'a.js' }];
  assert.equal(envelope(findings, { minSeverity: 'high' }).allow, true);
  assert.equal(envelope([]).allow, true);
});

test('FND-20 envelope denies with a reason per gating finding', () => {
  const result = envelope([
    { id: 'NPS-0001', severity: 'critical', title: 'hardcoded key', file: 'a.js', line: 7 },
    { id: 'NPS-0002', severity: 'low', title: 'nit', file: 'b.js' },
  ], { minSeverity: 'high' });
  assert.equal(result.allow, false);
  assert.equal(result.denials.length, 1);
  assert.equal(result.denials[0].id, 'NPS-0001');
  assert.match(result.denials[0].msg, /hardcoded key \(a\.js:7\)/);
});

test('FND-21 envelope defaults to gating on everything', () => {
  const result = envelope([{ id: 'NPS-0001', severity: 'info', title: 'note' }]);
  assert.equal(result.allow, false);
  assert.equal(result.denials[0].msg, 'note');
});

test('FND-22 severity rank is strictly ordered', () => {
  for (let i = 1; i < SEVERITIES.length; i++) {
    assert.ok(SEVERITY_RANK[SEVERITIES[i]] > SEVERITY_RANK[SEVERITIES[i - 1]]);
  }
});
