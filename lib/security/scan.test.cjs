'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { scanContent, loadCustomRules, _globToRegExp, _looksCatastrophic } = require('./scan.cjs');

function cats(findings) {
  return new Set(findings.map((f) => f.category));
}

test('SCAN-1 each built-in category triggers on representative content', () => {
  const samples = {
    'dynamic-exec': 'const r = eval(userInput);',
    'unsafe-deserialization': 'data = pickle.loads(blob)',
    'dom-injection': 'el.innerHTML = userInput;',
    'hardcoded-secret': 'const key = "-----BEGIN PRIVATE KEY-----";',
  };
  for (const [category, content] of Object.entries(samples)) {
    const { findings } = scanContent({ filePath: 'src/x.js', content });
    assert.ok(cats(findings).has(category), category + ' should trigger; got ' + [...cats(findings)].join(','));
  }
});

test('SCAN-2 the blanket workflow-file reminder is retired in favour of real checks', () => {
  const { findings } = scanContent({ filePath: '.github/workflows/deploy.yml', content: 'name: ci' });
  assert.ok(
    !findings.some((f) => f.category === 'workflow-file'),
    'a harmless workflow must no longer produce a "review this file" finding',
  );

  const { BUILTIN_PATTERNS } = require('./patterns.cjs');
  assert.ok(!BUILTIN_PATTERNS.some((r) => r.id === 'NPS-0012'), 'NPS-0012 is retired');
  assert.ok(!BUILTIN_PATTERNS.some((r) => r.path_only), 'no path-only rule remains in the write scan');

  const ciWorkflow = require('../scan/misconfig/ci-workflow.cjs');
  const hostile = [
    'on:',
    '  pull_request_target:',
    'jobs:',
    '  b:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '        with:',
    '          ref: ${{ github.event.pull_request.head.sha }}',
  ].join('\n');
  const real = ciWorkflow.check(hostile, { file: '.github/workflows/deploy.yml' });
  assert.ok(
    real.findings.some((f) => f.severity === 'critical'),
    'the replacement must catch what the blanket rule only hinted at',
  );
});

test('SCAN-3 clean code produces no findings (no false positives)', () => {
  const content = [
    'function add(a, b) {',
    '  return a + b;',
    '}',
    'const greeting = "hello world";',
    'el.textContent = greeting;',
  ].join('\n');
  const { findings } = scanContent({ filePath: 'src/util.js', content });
  assert.deepEqual(findings, []);
});

test('SCAN-4 finding carries the first matching line number', () => {
  const content = 'line one\nline two\nconst r = eval(x);\n';
  const { findings } = scanContent({ filePath: 'a.js', content });
  const evalFinding = findings.find((f) => f.rule_name === 'eval_call');
  assert.equal(evalFinding.line, 3);
});

test('SCAN-5 custom rules augment built-ins (both present)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-scan-'));
  const rulesFile = path.join(dir, 'rules.json');
  fs.writeFileSync(rulesFile, JSON.stringify({
    patterns: [{
      rule_name: 'tenant_unfiltered_query',
      category: 'multi-tenant',
      severity: 'risk',
      regex: '\\.objects\\.all\\(\\)',
      reminder: 'Filter by org_id.',
    }],
  }));
  try {
    const content = 'q = Model.objects.all()\nr = eval(z)';
    const { findings } = scanContent({ filePath: 'src/tenants/x.py', content, customRulesPath: rulesFile });
    assert.ok(findings.some((f) => f.rule_name === 'tenant_unfiltered_query'), 'custom rule fires');
    assert.ok(findings.some((f) => f.rule_name === 'eval_call'), 'built-in still fires');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SCAN-6 custom rule paths scope limits where it applies', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-scan-'));
  const rulesFile = path.join(dir, 'rules.json');
  fs.writeFileSync(rulesFile, JSON.stringify({
    patterns: [{
      rule_name: 'tenant_unfiltered_query',
      regex: '\\.objects\\.all\\(\\)',
      paths: ['**/src/tenants/**'],
      reminder: 'scoped',
    }],
  }));
  try {
    const content = 'q = Model.objects.all()';
    const inScope = scanContent({ filePath: 'src/tenants/a.py', content, customRulesPath: rulesFile });
    const outScope = scanContent({ filePath: 'src/public/a.py', content, customRulesPath: rulesFile });
    assert.ok(inScope.findings.some((f) => f.rule_name === 'tenant_unfiltered_query'));
    assert.ok(!outScope.findings.some((f) => f.rule_name === 'tenant_unfiltered_query'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SCAN-7 catastrophic regex in custom rule is skipped, not loaded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-scan-'));
  const rulesFile = path.join(dir, 'rules.json');
  fs.writeFileSync(rulesFile, JSON.stringify({
    patterns: [{ rule_name: 'evil', regex: '(a+)+$', reminder: 'x' }],
  }));
  try {
    const { rules, skipped } = loadCustomRules(rulesFile);
    assert.equal(rules.length, 0);
    assert.ok(skipped.some((s) => s.reason === 'catastrophic-regex'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SCAN-8 custom rule cap at 50 enforced with diagnostic', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-scan-'));
  const rulesFile = path.join(dir, 'rules.json');
  const many = [];
  for (let i = 0; i < 60; i++) many.push({ rule_name: 'r' + i, substrings: ['ZZZ' + i], reminder: 'x' });
  fs.writeFileSync(rulesFile, JSON.stringify({ patterns: many }));
  try {
    const { rules, skipped } = loadCustomRules(rulesFile);
    assert.equal(rules.length, 50);
    assert.ok(skipped.some((s) => s.reason === 'rule-cap-exceeded'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SCAN-9 missing custom rules path is a no-op (additive, resilient)', () => {
  const { rules, skipped } = loadCustomRules(null);
  assert.deepEqual(rules, []);
  assert.deepEqual(skipped, []);
});

test('SCAN-10 glob and catastrophic helpers behave', () => {
  assert.ok(_globToRegExp('**/src/tenants/**').test('app/src/tenants/x.py'));
  assert.ok(!_globToRegExp('**/src/tenants/**').test('app/src/public/x.py'));
  assert.ok(_looksCatastrophic('(.*)*'));
  assert.ok(!_looksCatastrophic('\\beval\\s*\\('));
});

test('SCAN-11 every built-in carries a unique NPS id in the patterns range', () => {
  const finding = require('../scan/finding.cjs');
  const { BUILTIN_PATTERNS } = require('./patterns.cjs');
  const seen = new Set();
  for (const rule of BUILTIN_PATTERNS) {
    assert.ok(finding.isValidRuleId(rule.id), rule.rule_name + ' needs an NPS id');
    assert.ok(finding.idInRange(rule.id, 'patterns'), rule.id + ' outside the patterns range');
    assert.ok(!seen.has(rule.id), 'duplicate id ' + rule.id);
    seen.add(rule.id);
  }
});

test('SCAN-12 every built-in carries a graded severity and at least one CWE', () => {
  const { SEVERITY_RANK } = require('../scan/finding.cjs');
  const { BUILTIN_PATTERNS } = require('./patterns.cjs');
  for (const rule of BUILTIN_PATTERNS) {
    assert.ok(SEVERITY_RANK[rule.severity] !== undefined, rule.rule_name + ' severity: ' + rule.severity);
    assert.ok(Array.isArray(rule.cwe) && rule.cwe.length > 0, rule.rule_name + ' needs a CWE');
  }
});

test('SCAN-13 findings expose id, cwe and graded severity', () => {
  const { findings } = scanContent({ filePath: 'src/x.js', content: 'const r = eval(q);' });
  const f = findings.find((x) => x.rule_name === 'eval_call');
  assert.equal(f.id, 'NPS-0001');
  assert.deepEqual(f.cwe, ['CWE-95']);
  assert.equal(f.severity, 'high');
  assert.equal(f.scanner, 'patterns');
});

test('SCAN-14 custom rules get an NPC id that cannot collide with a built-in', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-scan-id-'));
  const p = path.join(dir, 'rules.json');
  fs.writeFileSync(p, JSON.stringify([{ rule_name: 'house_rule', substrings: ['FORBIDDEN'] }]));
  try {
    const { rules } = loadCustomRules(p);
    assert.equal(rules.length, 1);
    assert.match(rules[0].id, /^NPC-\d{4}$/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('SCAN-15 a custom rule without severity stays advisory, not escalated to high', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-scan-sev-'));
  const p = path.join(dir, 'rules.json');
  fs.writeFileSync(p, JSON.stringify([{ rule_name: 'house_rule', substrings: ['FORBIDDEN'] }]));
  try {
    const { rules } = loadCustomRules(p);
    assert.equal(rules[0].severity, 'medium');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
