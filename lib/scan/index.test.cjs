'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scan = require('./index.cjs');

const HOSTILE_WORKFLOW = [
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

const HOSTILE_COMPOSE = [
  'services:',
  '  db:',
  '    image: postgres:latest',
  '    privileged: true',
  '    network_mode: host',
  '    environment:',
  '      POSTGRES_PASSWORD: hunter2supersecret',
].join('\n');

function tree(spec) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-scan-'));
  for (const [rel, content] of Object.entries(spec)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

test('SCANX-1 a compose file reaches the compose checker, not just the first yaml match', () => {
  const { findings } = scan.scanFileContent('docker-compose.yml', HOSTILE_COMPOSE, {});
  const ids = findings.map((f) => f.id);
  assert.ok(ids.some((id) => id.startsWith('NPS-060')), 'compose rules (NPS-060x) must fire: got ' + ids.join(','));
});

test('SCANX-2 every checker whose matcher accepts a path is run, not only the first', () => {
  const both = scan.misconfigCheckersFor('docker-compose.yml');
  assert.ok(both.length >= 2, 'a compose file legitimately matches more than one yaml checker');
  for (const p of ['compose.yaml', 'docker-compose.yaml']) {
    assert.ok(scan.misconfigCheckersFor(p).length >= 2, p);
  }
});

test('SCANX-3 path routing sends each file type to the right family', () => {
  const cases = [
    ['.github/workflows/ci.yml', true, false],
    ['Dockerfile', true, false],
    ['infra/main.tf', true, false],
    ['package-lock.json', false, true],
    ['requirements/dev.txt', false, true],
    ['Cargo.lock', false, true],
    ['src/app.js', false, false],
  ];
  for (const [p, misconfig, manifest] of cases) {
    assert.equal(scan.misconfigCheckersFor(p).length > 0, misconfig, 'misconfig routing for ' + p);
    assert.equal(scan.isManifestPath(p), manifest, 'manifest routing for ' + p);
  }
});

test('SCANX-4 the takeover primitive surfaces as critical through the orchestrator', () => {
  const { findings } = scan.scanFileContent('.github/workflows/x.yml', HOSTILE_WORKFLOW, {});
  assert.ok(findings.some((f) => f.severity === 'critical'), findings.map((f) => f.id + ':' + f.severity).join(','));
});

test('SCANX-5 secrets and misconfig both run on one file', () => {
  const content = 'FROM node:latest\nENV API_KEY=ghp_' + 'A'.repeat(36) + '\n';
  const { findings } = scan.scanFileContent('Dockerfile', content, {});
  const scanners = new Set(findings.map((f) => f.scanner));
  assert.ok(scanners.has('secrets'), 'secret scanner must run');
  assert.ok(scanners.has('misconfig'), 'misconfig checker must run');
});

test('SCANX-6 no scanner ever echoes a credential into a finding', () => {
  const secret = 'hunter2supersecret';
  const a = scan.scanFileContent('docker-compose.yml', HOSTILE_COMPOSE, {});
  const b = scan.scanFileContent('Dockerfile', 'FROM node:20\nENV DB_PASSWORD=' + secret + '\nUSER app\n', {});
  for (const result of [a, b]) {
    assert.ok(!JSON.stringify(result.findings).includes(secret), 'a finding leaked the credential');
  }
});

test('SCANX-7 a disabled scanner produces none of its findings', () => {
  const content = 'FROM node:latest\nENV API_KEY=ghp_' + 'A'.repeat(36) + '\n';
  const noSecrets = scan.scanFileContent('Dockerfile', content, { config: { secrets: false } });
  assert.ok(!noSecrets.findings.some((f) => f.scanner === 'secrets'));
  const noMisconfig = scan.scanFileContent('Dockerfile', content, { config: { misconfig: false } });
  assert.ok(!noMisconfig.findings.some((f) => f.scanner === 'misconfig'));
});

test('SCANX-8 resolveOptions falls back to the shipped defaults per key', () => {
  const o = scan.resolveOptions({ secrets: false });
  assert.equal(o.secrets, false);
  assert.equal(o.misconfig, scan.DEFAULTS.misconfig);
  assert.equal(o.min_severity, 'high');
  assert.deepEqual(o.ignore_scopes, ['dev']);
  assert.deepEqual(scan.resolveOptions(null), scan.resolveOptions({}));
});

test('SCANX-9 an out-of-vocabulary min_severity fails safe rather than opening the gate', () => {
  assert.equal(scan.resolveOptions({ min_severity: 'bogus' }).min_severity, 'high');
  assert.equal(scan.resolveOptions({ min_severity: 'low' }).min_severity, 'low');
});

test('SCANX-10 a broken checker cannot lose the other scanners findings', () => {
  const original = scan.MISCONFIG_CHECKERS[0].check;
  scan.MISCONFIG_CHECKERS[0].check = () => { throw new Error('boom'); };
  try {
    const { findings, warnings } = scan.scanFileContent(
      '.github/workflows/x.yml',
      HOSTILE_WORKFLOW + '\n# token: ghp_' + 'B'.repeat(36) + '\n',
      {},
    );
    assert.ok(warnings.includes('misconfig-checker-failed'));
    assert.ok(findings.some((f) => f.scanner === 'secrets'), 'the secret scanner must still have run');
  } finally { scan.MISCONFIG_CHECKERS[0].check = original; }
});

test('SCANX-11 scanProject reports which scanners ran and what it walked', () => {
  const root = tree({
    'docker-compose.yml': HOSTILE_COMPOSE,
    'src/app.js': 'const x = 1;\n',
  });
  try {
    const result = scan.scanProject(root, { config: { advisory: false, malicious: false }, now: Date.now() });
    assert.ok(result.report.scanners.includes('secrets'));
    assert.ok(result.report.scanners.includes('misconfig'));
    assert.ok(result.report.stats.files_visited >= 2);
    assert.ok(result.total_findings > 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('SCANX-12 scanProject collects the dependency inventory when advisory is on', () => {
  const root = tree({
    'package-lock.json': JSON.stringify({
      lockfileVersion: 3,
      packages: { '': { name: 'demo', dependencies: { yaml: '^2.8.0' } }, 'node_modules/yaml': { version: '2.8.0' } },
    }),
  });
  try {
    const result = scan.scanProject(root, { dir: null, now: Date.now() });
    assert.equal(result.report.inventory.packages, 1);
    assert.deepEqual(result.report.inventory.ecosystems, ['npm']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('SCANX-13 an absent advisory database surfaces as a coverage finding, not as clean', () => {
  const root = tree({
    'package-lock.json': JSON.stringify({
      lockfileVersion: 3,
      packages: { '': { name: 'demo' }, 'node_modules/yaml': { version: '2.8.0' } },
    }),
  });
  try {
    const result = scan.scanProject(root, { dir: null, now: Date.now() });
    assert.ok(result.findings.some((f) => f.id === 'NPS-0301'), 'the missing-database gap must be reported');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('SCANX-14 dev dependencies are excluded from gating by default', () => {
  const root = tree({
    'package-lock.json': JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'demo', devDependencies: { tap: '^18.0.0' } },
        'node_modules/tap': { version: '18.0.0', dev: true },
      },
    }),
  });
  try {
    const withDev = scan.scanProject(root, { dir: null, now: Date.now(), config: { ignore_scopes: [] } });
    const withoutDev = scan.scanProject(root, { dir: null, now: Date.now() });
    assert.equal(withDev.report.inventory.counts.by_scope.dev, 1);
    assert.equal(withoutDev.report.inventory.counts.by_scope.dev, 1, 'the inventory still reports it');
    assert.ok(withoutDev.report.coverage.packages_total <= withDev.report.coverage.packages_total);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('SCANX-15 findings are severity-sorted and the cap is reported honestly', () => {
  const root = tree({ 'docker-compose.yml': HOSTILE_COMPOSE });
  try {
    const capped = scan.scanProject(root, {
      config: { advisory: false, malicious: false, max_findings_per_run: 1 },
      now: Date.now(),
    });
    assert.equal(capped.findings.length, 1);
    assert.equal(capped.truncated, true, 'a truncated result must say so');
    assert.ok(capped.total_findings > 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('SCANX-16 the envelope gates on min_severity and names its denials', () => {
  const root = tree({ 'docker-compose.yml': HOSTILE_COMPOSE });
  try {
    const strict = scan.scanProject(root, {
      config: { advisory: false, malicious: false, min_severity: 'critical' },
      now: Date.now(),
    });
    const loose = scan.scanProject(root, {
      config: { advisory: false, malicious: false, min_severity: 'low' },
      now: Date.now(),
    });
    assert.ok(loose.envelope.denials.length > strict.envelope.denials.length);
    for (const denial of loose.envelope.denials) {
      assert.match(denial.id, /^NP[SC]-\d{4}$/);
      assert.ok(denial.msg.length > 0);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('SCANX-17 isScannablePath is true for source files only while secrets is on', () => {
  assert.equal(scan.isScannablePath('src/app.js', {}), true);
  assert.equal(scan.isScannablePath('src/app.js', { config: { secrets: false } }), false);
  assert.equal(scan.isScannablePath('Dockerfile', { config: { secrets: false } }), true);
  assert.equal(scan.isScannablePath('package-lock.json', { config: { secrets: false } }), true);
});

test('SCANX-18 sbomFor produces a CycloneDX document from the live inventory', () => {
  const root = tree({
    'package-lock.json': JSON.stringify({
      lockfileVersion: 3,
      packages: { '': { name: 'demo' }, 'node_modules/yaml': { version: '2.8.0', license: 'ISC' } },
    }),
  });
  try {
    const { bom } = scan.sbomFor(root, {
      timestamp: '2026-08-03T00:00:00.000Z', projectName: 'demo', toolVersion: '1.5.0',
    });
    assert.equal(bom.bomFormat, 'CycloneDX');
    assert.equal(bom.components.length, 1);
    assert.equal(bom.components[0].purl, 'pkg:npm/yaml@2.8.0');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('SCANX-19 node_modules is never walked by the content scanners', () => {
  const root = tree({
    'src/app.js': 'const x = 1;\n',
    'node_modules/evil/index.js': 'const t = "ghp_' + 'C'.repeat(36) + '";\n',
  });
  try {
    const result = scan.scanProject(root, { config: { advisory: false, malicious: false }, now: Date.now() });
    assert.ok(!result.findings.some((f) => String(f.file || '').includes('node_modules')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('SCANX-20 every scanner name in SCANNERS is a real config toggle', () => {
  for (const name of scan.SCANNERS) {
    assert.ok(name in scan.DEFAULTS, name + ' has no default toggle');
  }
});

test('SCANX-21 a source file named like a buildfile is not treated as one', () => {
  for (const p of [
    'lib/scan/misconfig/containerfile.cjs',
    'lib/scan/misconfig/containerfile.test.cjs',
    'docs/dockerfile.md',
    'src/Dockerfile.ts',
  ]) {
    assert.equal(scan.misconfigCheckersFor(p).length, 0, p + ' must not match a misconfig checker');
  }
});

test('SCANX-22 real buildfile variants are still matched', () => {
  for (const p of ['Dockerfile', 'Dockerfile.prod', 'Containerfile', 'build/app.Dockerfile']) {
    assert.ok(scan.misconfigCheckersFor(p).length > 0, p + ' must match');
  }
});

test('SCANX-23 an unrelated yaml file produces no findings and no warnings', () => {
  const roadmap = 'schema_version: 3\nmilestones: []\n';
  const result = scan.scanFileContent('roadmap.yaml', roadmap, {});
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.warnings, [], 'an ordinary yaml must not produce checker warnings');
});

test('SCANX-24 a real kubernetes manifest is still checked despite the content pre-check', () => {
  const manifest = [
    'apiVersion: apps/v1',
    'kind: Deployment',
    'spec:',
    '  template:',
    '    spec:',
    '      containers:',
    '        - name: app',
    '          image: nginx:latest',
    '          securityContext:',
    '            privileged: true',
  ].join('\n');
  const { findings } = scan.scanFileContent('deploy.yaml', manifest, {});
  assert.ok(findings.some((f) => f.id === 'NPS-0550'), 'privileged must fire: ' + findings.map((f) => f.id).join(','));
});

test('SCANX-25 a real compose file is still checked despite the content pre-check', () => {
  const { findings } = scan.scanFileContent('docker-compose.yml', HOSTILE_COMPOSE, {});
  assert.ok(findings.some((f) => f.id.startsWith('NPS-060')));
});

test('SCANX-26 scanning this repository produces no checker warnings', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const result = scan.scanProject(repoRoot, {
    config: { advisory: false, malicious: false, license: false },
    now: Date.now(),
  });
  const noisy = result.warnings.filter((w) => /parse-failed|unparsable|no-from-instruction|no-pod-spec/.test(w));
  assert.deepEqual(noisy, [], 'ordinary repo content must not trip a checker: ' + result.warnings.join(','));
});

test('SCANX-27 max_severity reflects the full result, not the capped view', () => {
  const root = tree({ 'docker-compose.yml': HOSTILE_COMPOSE });
  try {
    const full = scan.scanProject(root, { config: { advisory: false, malicious: false }, now: Date.now() });
    const capped = scan.scanProject(root, {
      config: { advisory: false, malicious: false, max_findings_per_run: 1 },
      now: Date.now(),
    });
    assert.equal(capped.truncated, true);
    assert.equal(capped.max_severity, full.max_severity,
      'a cap on how many findings are shown must not change what the worst one was');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('SCANX-28 max_severity is null on a clean result', () => {
  const root = tree({ 'src/app.js': 'const x = 1;\n' });
  try {
    const result = scan.scanProject(root, { config: { advisory: false, malicious: false }, now: Date.now() });
    assert.equal(result.max_severity, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('SCANX-29 the enabled switch is honoured by the library, not only by the hook', () => {
  const off = scan.scanFileContent('Dockerfile', 'FROM node:latest\n', { config: { enabled: false } });
  assert.deepEqual(off.findings, []);
  const on = scan.scanFileContent('Dockerfile', 'FROM node:latest\n', { config: { enabled: true } });
  assert.ok(on.findings.length > 0, 'the same input must be scanned when enabled');
});

test('SCANX-30 a disabled scanProject reports that it was disabled', () => {
  const root = tree({ 'docker-compose.yml': HOSTILE_COMPOSE });
  try {
    const result = scan.scanProject(root, { config: { enabled: false }, now: Date.now() });
    assert.equal(result.total_findings, 0);
    assert.equal(result.max_severity, null);
    assert.equal(result.report.disabled, true);
    assert.equal(result.envelope.allow, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
