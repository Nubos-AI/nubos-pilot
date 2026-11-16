'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { RULES_COUNT, scanContent, extractor, compileRules, SUPPRESSION_MARKER } = require('./scan.cjs');
const { SECRET_RULES } = require('./rules.cjs');
const { walk } = require('../walk.cjs');
const finding = require('../finding.cjs');

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function chars(n, seed, alphabet) {
  let out = '';
  let round = 0;
  while (out.length < n) {
    const digest = crypto.createHash('sha256').update(seed + ':' + round).digest();
    round++;
    for (const byte of digest) {
      out += alphabet[byte % alphabet.length];
      if (out.length >= n) break;
    }
  }
  return out;
}

const alnum = (n, seed) => chars(n, seed, ALNUM);

const GITHUB_TOKEN = 'ghp_' + alnum(36, 'scan-gh');
const ENTROPIC = alnum(40, 'scan-entropy');
const DEFAULT_PATH = 'src/config.js';

function ruleById(id) {
  const rule = SECRET_RULES.find((r) => r.id === id);
  assert.ok(rule, 'rule ' + id + ' must exist');
  return rule;
}

function withTree(files, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-secrets-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('SECSCAN-1 RULES_COUNT matches the shipped table and everything compiles once', () => {
  assert.equal(RULES_COUNT, SECRET_RULES.length);
  assert.equal(compileRules(SECRET_RULES).length, RULES_COUNT);
});

test('SECSCAN-2 clean source produces no findings', () => {
  const content = [
    'function add(a, b) {',
    '  return a + b;',
    '}',
    'const greeting = "hello world";',
    'const timeoutMs = 30000;',
  ].join('\n');
  const { findings, stats } = scanContent({ filePath: 'src/util.js', content });
  assert.deepEqual(findings, []);
  assert.equal(stats.linesScanned, 5);
  assert.equal(stats.filesScanned, 1);
  assert.equal(stats.findings, 0);
});

test('SECSCAN-3 a rule reports once per file and records the first matching line', () => {
  const content = [
    'const a = 1;',
    'const first = "' + GITHUB_TOKEN + '";',
    'const b = 2;',
    'const second = "' + GITHUB_TOKEN + '";',
  ].join('\n');
  const { findings } = scanContent({ filePath: DEFAULT_PATH, content });
  const hits = findings.filter((f) => f.id === 'NPS-0110');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 2);
  assert.equal(hits[0].file, DEFAULT_PATH);
});

test('SECSCAN-4 findings never echo the matched secret', () => {
  const content = 'const token = "' + GITHUB_TOKEN + '";';
  const { findings } = scanContent({ filePath: DEFAULT_PATH, content });
  assert.ok(findings.length > 0, 'the fixture must trigger something to redact');
  const serialized = JSON.stringify(findings);
  assert.ok(!serialized.includes(GITHUB_TOKEN), 'the findings ledger leaked the credential');
  assert.ok(!serialized.includes(GITHUB_TOKEN.slice(4)), 'the findings ledger leaked the credential body');
  for (const f of findings) {
    assert.ok(f.title && !f.title.includes(GITHUB_TOKEN));
    assert.ok(f.reminder && !f.reminder.includes(GITHUB_TOKEN));
  }
});

test('SECSCAN-5 findings satisfy the shared finding contract', () => {
  const { findings } = scanContent({ filePath: DEFAULT_PATH, content: 'token = "' + GITHUB_TOKEN + '"' });
  const f = findings.find((x) => x.id === 'NPS-0110');
  assert.equal(f.scanner, 'secrets');
  assert.equal(f.source, 'builtin');
  assert.equal(f.severity, 'critical');
  assert.deepEqual(f.cwe, ['CWE-798']);
  assert.ok(finding.idInRange(f.id, 'secrets'));
  assert.equal(f.rule_name, 'github_pat_classic');
});

test('SECSCAN-6 a bare high-entropy string produces no finding', () => {
  const content = [
    'const blob = "' + ENTROPIC + '";',
    'const payload = ["' + ENTROPIC + '"];',
  ].join('\n');
  const { findings } = scanContent({ filePath: DEFAULT_PATH, content });
  assert.deepEqual(findings, [], 'entropy alone must never be a trigger');
});

test('SECSCAN-7 entropy only promotes a rule that already matched a keyword context', () => {
  const rule = ruleById('NPS-0194');
  const promoted = scanContent({
    filePath: DEFAULT_PATH,
    content: 'const apiKey = "' + ENTROPIC + '";',
    rules: [rule],
  });
  assert.equal(promoted.findings.length, 1);
  assert.equal(promoted.stats.entropyPromoted, 1);
  assert.equal(promoted.stats.entropyRejected, 0);

  const rejected = scanContent({
    filePath: DEFAULT_PATH,
    content: 'const apiKey = "' + 'a'.repeat(40) + '";',
    rules: [rule],
  });
  assert.equal(rejected.findings.length, 0);
  assert.equal(rejected.stats.entropyRejected, 1);
  assert.equal(rejected.stats.entropyPromoted, 0);

  const noKeyword = scanContent({
    filePath: DEFAULT_PATH,
    content: 'const label = "' + ENTROPIC + '";',
    rules: [rule],
  });
  assert.equal(noKeyword.findings.length, 0);
  assert.equal(noKeyword.stats.entropyRejected, 0);
});

test('SECSCAN-8 a suppression comment on the matching line silences it and is counted', () => {
  const content = 'const token = "' + GITHUB_TOKEN + '"; // ' + SUPPRESSION_MARKER;
  const { findings, stats } = scanContent({ filePath: DEFAULT_PATH, content });
  assert.equal(findings.filter((f) => f.id === 'NPS-0110').length, 0);
  assert.ok(stats.suppressed >= 1, 'suppressions must be counted');
});

test('SECSCAN-9 a suppression comment on the line above silences the next line', () => {
  const content = [
    '// ' + SUPPRESSION_MARKER + ' rotated fixture token',
    'const token = "' + GITHUB_TOKEN + '";',
  ].join('\n');
  const { findings, stats } = scanContent({ filePath: DEFAULT_PATH, content });
  assert.equal(findings.filter((f) => f.id === 'NPS-0110').length, 0);
  assert.ok(stats.suppressed >= 1);
});

test('SECSCAN-10 a suppression two lines above does not reach the credential', () => {
  const content = [
    '// ' + SUPPRESSION_MARKER,
    'const unrelated = 1;',
    'const token = "' + GITHUB_TOKEN + '";',
  ].join('\n');
  const { findings } = scanContent({ filePath: DEFAULT_PATH, content });
  const hits = findings.filter((f) => f.id === 'NPS-0110');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 3);
});

test('SECSCAN-11 a suppressed occurrence does not hide a later unsuppressed one', () => {
  const content = [
    'const a = "' + GITHUB_TOKEN + '"; // ' + SUPPRESSION_MARKER,
    'const b = 2;',
    'const c = "' + GITHUB_TOKEN + '";',
  ].join('\n');
  const { findings, stats } = scanContent({ filePath: DEFAULT_PATH, content });
  const hits = findings.filter((f) => f.id === 'NPS-0110');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 3);
  assert.equal(stats.suppressed, 1);
});

test('SECSCAN-12 a generic rule is silent inside fixture directories', () => {
  const rule = ruleById('NPS-0194');
  const content = 'const apiKey = "' + ENTROPIC + '";';
  assert.equal(scanContent({ filePath: 'src/app.js', content, rules: [rule] }).findings.length, 1);
  for (const quiet of ['tests/fixtures/keys.js', 'tests/__fixtures__/keys.js', 'src/keys.test.js', 'docs/guide.md', 'config.example']) {
    assert.equal(
      scanContent({ filePath: quiet, content, rules: [rule] }).findings.length,
      0,
      'generic rule must stay silent in ' + quiet,
    );
  }
});

test('SECSCAN-13 a live credential rule still fires in a markdown file', () => {
  const rule = ruleById('NPS-0110');
  const content = 'Paste your token: `' + GITHUB_TOKEN + '`';
  assert.equal(scanContent({ filePath: 'README.md', content, rules: [rule] }).findings.length, 1);
  assert.equal(scanContent({ filePath: 'docs/setup.md', content, rules: [rule] }).findings.length, 1);
  assert.equal(scanContent({ filePath: 'docs/setup.example', content, rules: [rule] }).findings.length, 0);
});

test('SECSCAN-14 minSeverity gates the returned findings', () => {
  const content = [
    'const live = "' + GITHUB_TOKEN + '";',
    'const test = "sk_test_' + alnum(24, 'skt') + '";',
  ].join('\n');
  const all = scanContent({ filePath: DEFAULT_PATH, content });
  assert.ok(all.findings.some((f) => f.severity === 'low'));
  const gated = scanContent({ filePath: DEFAULT_PATH, content, minSeverity: 'high' });
  assert.ok(gated.findings.length > 0);
  for (const f of gated.findings) assert.ok(finding.atLeast(f.severity, 'high'));
  assert.ok(gated.findings.length < all.findings.length);
});

test('SECSCAN-15 stats report evaluated rules, lines and path scoping', () => {
  const scoped = scanContent({ filePath: 'src/app.js', content: 'x\ny\n' });
  assert.equal(scoped.stats.linesScanned, 2);
  assert.ok(scoped.stats.rulesEvaluated > 0);
  assert.ok(scoped.stats.rulesEvaluated < RULES_COUNT, 'path-scoped rules must be skipped for a .js file');
});

test('SECSCAN-16 compileRules rejects malformed, out-of-range and ReDoS-prone rules', () => {
  const base = {
    id: 'NPS-0100',
    rule_name: 'x',
    category: 'c',
    severity: 'high',
    cwe: ['CWE-798'],
    regex: 'abc',
    reminder: 'r',
  };
  const cases = [
    [{ ...base, id: 'nope' }, 'secrets-rule-invalid-id'],
    [{ ...base, id: 'NPS-0001' }, 'secrets-rule-id-out-of-range'],
    [{ ...base, id: 'NPS-0500' }, 'secrets-rule-id-out-of-range'],
    [{ ...base, rule_name: '' }, 'secrets-rule-without-name'],
    [{ ...base, regex: '(a+)+$' }, 'secrets-rule-catastrophic-regex'],
    [{ ...base, regex: '[' }, 'secrets-rule-invalid-regex'],
    [{ ...base, regex: undefined }, 'secrets-rule-without-matcher'],
    [{ ...base, regex: 'abc', entropy: { minLength: 20 } }, 'secrets-rule-entropy-without-capture'],
    [{ ...base, regex: undefined, substrings: ['a'], entropy: { minLength: 20 } }, 'secrets-rule-entropy-without-regex'],
    [{ ...base, paths: [''] }, 'secrets-rule-invalid-glob'],
  ];
  for (const [rule, code] of cases) {
    assert.throws(() => compileRules([rule]), (err) => err.code === code, code + ' expected for ' + JSON.stringify(rule.id));
  }
  assert.throws(() => compileRules([base, { ...base }]), (err) => err.code === 'secrets-rule-duplicate-id');
  assert.throws(() => compileRules('nope'), (err) => err.code === 'secrets-rules-not-an-array');
});

test('SECSCAN-17 the extractor is shaped for walk.cjs', () => {
  const e = extractor();
  assert.equal(e.name, 'secrets');
  assert.equal(typeof e.onFile, 'function');
  assert.equal(typeof e.onLine, 'function');
  assert.equal(typeof e.onFileEnd, 'function');
  assert.equal(extractor({ name: 'secrets-strict' }).name, 'secrets-strict');
});

test('SECSCAN-18 the extractor finds credentials through a real walk.cjs traversal', () => {
  const tree = {
    'src/app.js': 'const client = init();\nconst token = "' + GITHUB_TOKEN + '";\n',
    'docs/setup.md': 'Export the token: `' + GITHUB_TOKEN + '`\n',
    'tests/fixtures/sample.js': 'const apiKey = "' + ENTROPIC + '";\n',
    'src/clean.js': 'module.exports = { add: (a, b) => a + b };\n',
    '.env': 'DATABASE_PASSWORD=' + alnum(16, 'walk-env') + '\n',
  };
  withTree(tree, (root) => {
    const secrets = extractor();
    const { results, stats, warnings } = walk(root, [secrets]);
    const findings = results.get('secrets');

    assert.deepEqual(warnings, []);
    assert.equal(stats.filesVisited, 5);
    assert.ok(stats.linesScanned > 0);

    const byFile = new Map(findings.map((f) => [f.file, f]));
    assert.ok(byFile.has('src/app.js'), 'the .js credential must be reported');
    assert.ok(byFile.has('docs/setup.md'), 'a live credential in prose must still be reported');
    assert.equal(byFile.get('src/app.js').id, 'NPS-0110');
    assert.equal(byFile.get('src/app.js').line, 2);
    assert.equal(byFile.get('docs/setup.md').id, 'NPS-0110');

    assert.ok(!findings.some((f) => f.file === 'src/clean.js'));
    assert.ok(!findings.some((f) => f.file === 'tests/fixtures/sample.js'), 'fixture directories are excluded');
    assert.ok(findings.some((f) => f.file === '.env' && f.id === 'NPS-0192'), 'the dotenv rule is path scoped to .env');

    assert.equal(secrets.stats.filesScanned, 5);
    assert.equal(secrets.stats.findings, findings.length);
    const serialized = JSON.stringify(findings);
    assert.ok(!serialized.includes(GITHUB_TOKEN));
  });
});

test('SECSCAN-19 suppression comments work through the walker too', () => {
  const tree = {
    'src/app.js': '// ' + SUPPRESSION_MARKER + '\nconst token = "' + GITHUB_TOKEN + '";\n',
  };
  withTree(tree, (root) => {
    const secrets = extractor();
    const { results } = walk(root, [secrets]);
    assert.deepEqual(results.get('secrets'), []);
    assert.ok(secrets.stats.suppressed >= 1);
  });
});

test('SECSCAN-20 the extractor honours minSeverity across files', () => {
  const tree = {
    'src/live.js': 'const t = "' + GITHUB_TOKEN + '";\n',
    'src/test.js': 'const t = "sk_test_' + alnum(24, 'walk-skt') + '";\n',
  };
  withTree(tree, (root) => {
    const all = walk(root, [extractor({ name: 'all' })]).results.get('all');
    const gated = walk(root, [extractor({ name: 'gated', minSeverity: 'high' })]).results.get('gated');
    assert.ok(all.some((f) => f.severity === 'low'));
    assert.ok(gated.length > 0);
    for (const f of gated) assert.ok(finding.atLeast(f.severity, 'high'));
    assert.ok(gated.length < all.length);
  });
});
