'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { RULES, FILES, matches, check } = require('./ci-workflow.cjs');
const { idInRange, SEVERITIES } = require('../finding.cjs');

const FILE = '.github/workflows/ci.yml';

function run(yaml, file) {
  return check(yaml, { file: file || FILE });
}

function ids(findings) {
  return findings.map((f) => f.id);
}

function names(findings) {
  return findings.map((f) => f.rule_name);
}

const PINNED_SHA = '11bd71901bbe5b1630ceea73d27597364c9af683';

test('CIW-1 every rule id is unique, in the misconfig range and inside NPS-0500..0549', () => {
  const entries = Object.values(RULES);
  assert.ok(entries.length > 0);
  const seen = new Set();
  for (const rule of entries) {
    assert.ok(idInRange(rule.id, 'misconfig'), rule.id + ' must be a misconfig id');
    const n = Number(rule.id.slice(4));
    assert.ok(n >= 500 && n <= 549, rule.id + ' must fall in the ci-workflow sub-block');
    assert.ok(!seen.has(rule.id), rule.id + ' is duplicated');
    seen.add(rule.id);
    assert.ok(SEVERITIES.includes(rule.severity), rule.id + ' severity ' + rule.severity);
    assert.match(rule.rule_name, /^workflow_[a-z_]+$/);
    assert.ok(rule.reminder.length > 40, rule.id + ' needs an actionable reminder');
  }
});

test('CIW-2 matches accepts workflow files and rejects everything else', () => {
  assert.equal(matches('.github/workflows/ci.yml'), true);
  assert.equal(matches('.github/workflows/release.yaml'), true);
  assert.equal(matches('sub/project/.github/workflows/test.yml'), true);
  assert.equal(matches('./.github/workflows/test.yml'), true);
  assert.equal(matches('.github/workflows/nested/ci.yml'), false);
  assert.equal(matches('.github/actions/build/action.yml'), false);
  assert.equal(matches('deploy/k8s/workflows/ci.yml'), false);
  assert.equal(matches('.github/workflows/ci.json'), false);
  assert.equal(matches(''), false);
  assert.equal(matches(null), false);
  assert.ok(FILES.every((glob) => glob.startsWith('**/.github/workflows/')));
});

test('CIW-3 pull_request_target with a checkout of the PR head is critical', () => {
  const yaml = [
    'name: pwn',
    'on: pull_request_target',
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@' + PINNED_SHA,
    '        with:',
    '          ref: ${{ github.event.pull_request.head.sha }}',
    '      - run: npm ci && npm run build',
  ].join('\n');
  const { findings } = run(yaml);
  const hit = findings.find((f) => f.id === RULES.untrustedCheckout.id);
  assert.ok(hit, 'expected untrusted checkout; got ' + names(findings).join(','));
  assert.equal(hit.severity, 'critical');
  assert.equal(hit.scanner, 'misconfig');
  assert.equal(hit.file, FILE);
  assert.equal(hit.line, 9);
});

test('CIW-4 workflow_run head_branch checkout fires, and a plain pull_request checkout does not', () => {
  const workflowRun = [
    'on:',
    '  workflow_run:',
    '    workflows: [ci]',
    '    types: [completed]',
    'jobs:',
    '  deploy:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@' + PINNED_SHA,
    '        with:',
    '          ref: ${{ github.event.workflow_run.head_branch }}',
  ].join('\n');
  assert.ok(ids(run(workflowRun).findings).includes(RULES.untrustedCheckout.id));

  const nearMiss = [
    'on: pull_request',
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@' + PINNED_SHA,
    '        with:',
    '          ref: ${{ github.event.pull_request.head.sha }}',
  ].join('\n');
  assert.ok(!ids(run(nearMiss).findings).includes(RULES.untrustedCheckout.id));

  const noRef = [
    'on: pull_request_target',
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@' + PINNED_SHA,
  ].join('\n');
  assert.ok(!ids(run(noRef).findings).includes(RULES.untrustedCheckout.id));
});

test('CIW-5 an attacker-controlled expression inside run is a script injection with a line', () => {
  const yaml = [
    'on: issues',
    'permissions: {}',
    'jobs:',
    '  triage:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@' + PINNED_SHA,
    '      - run: |',
    '          echo "title: ${{ github.event.issue.title }}"',
  ].join('\n');
  const { findings } = run(yaml);
  const hit = findings.find((f) => f.id === RULES.scriptInjection.id);
  assert.ok(hit, 'expected script injection; got ' + names(findings).join(','));
  assert.equal(hit.severity, 'high');
  assert.equal(hit.line, 9);
  assert.match(hit.title, /github\.event\.issue\.title/);
});

test('CIW-6 safe expressions in run produce no injection finding', () => {
  const yaml = [
    'on:',
    '  workflow_dispatch:',
    '    inputs:',
    '      target:',
    '        required: true',
    'permissions:',
    '  contents: read',
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: echo "sha ${{ github.sha }} repo ${{ github.repository }}"',
    '      - run: ./deploy.sh --token ${{ secrets.DEPLOY_TOKEN }}',
    '      - run: echo "target ${{ inputs.target }} / ${{ github.event.inputs.target }}"',
    '      - run: git checkout ${{ github.event.pull_request.head.sha }}',
    '      - run: echo "run ${{ github.run_id }} by ${{ github.actor }}"',
  ].join('\n');
  const { findings } = run(yaml);
  assert.deepEqual(
    findings.filter((f) => f.id === RULES.scriptInjection.id),
    [],
    'safe contexts must not be flagged; got ' + JSON.stringify(findings.map((f) => f.title)),
  );
});

test('CIW-7 github.head_ref is attacker controlled but github.ref_name on push is not', () => {
  const headRef = [
    'on: pull_request_target',
    'jobs:',
    '  b:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: echo "branch ${{ github.head_ref }}"',
  ].join('\n');
  assert.ok(ids(run(headRef).findings).includes(RULES.scriptInjection.id));

  const pushRefName = [
    'on: push',
    'permissions: {}',
    'jobs:',
    '  b:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: echo "ref ${{ github.ref_name }}"',
  ].join('\n');
  assert.ok(!ids(run(pushRefName).findings).includes(RULES.scriptInjection.id));

  const prRefName = [
    'on: pull_request',
    'permissions: {}',
    'jobs:',
    '  b:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: echo "ref ${{ github.ref_name }}"',
  ].join('\n');
  assert.ok(ids(run(prRefName).findings).includes(RULES.scriptInjection.id));
});

test('CIW-8 permissions write-all is medium, explicit scopes are clean', () => {
  const writeAll = [
    'on: push',
    'permissions: write-all',
    'jobs:',
    '  b:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: gh release create --repo ${{ github.repository }} v1',
    '        env:',
    '          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}',
  ].join('\n');
  const { findings } = run(writeAll);
  const hit = findings.find((f) => f.id === RULES.permissionsWriteAll.id);
  assert.ok(hit);
  assert.equal(hit.severity, 'medium');
  assert.equal(hit.line, 2);
  assert.ok(!ids(findings).includes(RULES.permissionsAbsent.id), 'write-all is not also reported as absent');

  const scoped = writeAll.replace('permissions: write-all', 'permissions:\n  contents: write');
  assert.deepEqual(
    ids(run(scoped).findings).filter((id) => id === RULES.permissionsWriteAll.id
      || id === RULES.permissionsAbsent.id),
    [],
  );

  const jobLevel = [
    'on: push',
    'permissions:',
    '  contents: read',
    'jobs:',
    '  b:',
    '    runs-on: ubuntu-latest',
    '    permissions: write-all',
    '    steps:',
    '      - run: gh pr list',
    '        env:',
    '          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}',
  ].join('\n');
  const jobHit = run(jobLevel).findings.find((f) => f.id === RULES.permissionsWriteAll.id);
  assert.ok(jobHit, 'job-level write-all is reported too');
  assert.match(jobHit.title, /job "b"/);
  assert.equal(jobHit.line, 7);
});

test('CIW-9 an absent permissions block plus token use is a low advisory only when a token is used', () => {
  const tokenUse = [
    'on: push',
    'jobs:',
    '  b:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: gh pr list',
    '        env:',
    '          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}',
  ].join('\n');
  const hit = run(tokenUse).findings.find((f) => f.id === RULES.permissionsAbsent.id);
  assert.ok(hit, 'expected the advisory');
  assert.equal(hit.severity, 'low');

  const noToken = [
    'on: push',
    'jobs:',
    '  b:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: npm test',
  ].join('\n');
  assert.ok(!ids(run(noToken).findings).includes(RULES.permissionsAbsent.id));

  const jobScoped = [
    'on: push',
    'jobs:',
    '  b:',
    '    runs-on: ubuntu-latest',
    '    permissions:',
    '      contents: read',
    '    steps:',
    '      - run: gh pr list',
    '        env:',
    '          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}',
  ].join('\n');
  assert.ok(!ids(run(jobScoped).findings).includes(RULES.permissionsAbsent.id));
});

test('CIW-10 third-party actions at a mutable ref are medium, first-party low, SHA pins clean', () => {
  const yaml = [
    'on: push',
    'permissions: {}',
    'jobs:',
    '  b:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - uses: some-vendor/deploy-action@main',
    '      - uses: another/pinned@' + PINNED_SHA,
    '      - uses: ./.github/actions/local',
    '      - uses: docker://alpine:3.20',
  ].join('\n');
  const { findings } = run(yaml);
  const third = findings.filter((f) => f.id === RULES.unpinnedThirdPartyAction.id);
  const first = findings.filter((f) => f.id === RULES.unpinnedFirstPartyAction.id);
  assert.equal(third.length, 1);
  assert.equal(third[0].severity, 'medium');
  assert.match(third[0].title, /some-vendor\/deploy-action/);
  assert.equal(third[0].line, 8);
  assert.equal(first.length, 1);
  assert.equal(first[0].severity, 'low');
  assert.match(first[0].title, /actions\/checkout/);
});

test('CIW-11 secrets in a pull_request_target env is high, the same env on pull_request is not', () => {
  const exposed = [
    'on: pull_request_target',
    'jobs:',
    '  b:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@' + PINNED_SHA,
    '      - run: ./publish.sh',
    '        env:',
    '          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}',
  ].join('\n');
  const hit = run(exposed).findings.find((f) => f.id === RULES.secretsInUntrustedTrigger.id);
  assert.ok(hit, 'expected secret exposure');
  assert.equal(hit.severity, 'high');
  assert.match(hit.title, /NPM_TOKEN/);
  assert.equal(hit.line, 9);

  const safe = exposed.replace('on: pull_request_target', 'on: pull_request');
  assert.ok(!ids(run(safe).findings).includes(RULES.secretsInUntrustedTrigger.id));
});

test('CIW-12 a self-hosted runner on a fork-triggerable workflow is high', () => {
  const yaml = [
    'on: [pull_request]',
    'permissions: {}',
    'jobs:',
    '  b:',
    '    runs-on: [self-hosted, linux]',
    '    steps:',
    '      - run: make build',
  ].join('\n');
  const hit = run(yaml).findings.find((f) => f.id === RULES.selfHostedPublicTrigger.id);
  assert.ok(hit);
  assert.equal(hit.severity, 'high');
  assert.equal(hit.line, 5);

  const dispatchOnly = yaml.replace('on: [pull_request]', 'on: workflow_dispatch');
  assert.ok(!ids(run(dispatchOnly).findings).includes(RULES.selfHostedPublicTrigger.id));

  const hosted = yaml.replace('runs-on: [self-hosted, linux]', 'runs-on: ubuntu-latest');
  assert.ok(!ids(run(hosted).findings).includes(RULES.selfHostedPublicTrigger.id));

  const groupForm = yaml.replace(
    'runs-on: [self-hosted, linux]',
    'runs-on:\n      group: builders\n      labels: [self-hosted]',
  );
  assert.ok(ids(run(groupForm).findings).includes(RULES.selfHostedPublicTrigger.id));

  const runnerGroupOnly = yaml.replace(
    'runs-on: [self-hosted, linux]',
    'runs-on:\n      group: builders\n      labels: ubuntu-latest',
  );
  assert.ok(!ids(run(runnerGroupOnly).findings).includes(RULES.selfHostedPublicTrigger.id));
});

test('CIW-13 malformed YAML warns instead of throwing', () => {
  const { findings, warnings } = run('on: push\n\tjobs: broken');
  assert.deepEqual(findings, []);
  assert.deepEqual(warnings, ['yaml-parse-failed']);
  for (const warning of warnings) assert.match(warning, /^[a-z0-9]+(-[a-z0-9]+)*$/);
});

test('CIW-14 non-mapping and empty documents warn without findings', () => {
  assert.deepEqual(run('').warnings, ['empty-document']);
  assert.deepEqual(run('- a\n- b').warnings, ['unexpected-document-shape']);
  assert.deepEqual(check(null, { file: FILE }).warnings, ['invalid-input']);
  assert.deepEqual(run('on: push\n').warnings, ['no-jobs-declared']);
});

test('CIW-15 the safeYamlParse alias cap propagates instead of degrading to a warning', () => {
  let bomb = 'on: push\nanchor: &a [1, 2, 3]\njobs:\n  b:\n    steps:\n';
  for (let i = 0; i < 200; i += 1) bomb += '      - *a\n';
  assert.throws(() => run(bomb), (err) => /alias/i.test(err.message));
});

test('CIW-16 a hardened workflow produces no findings and continue-on-error is not judged', () => {
  const yaml = [
    'name: ci',
    'on:',
    '  push:',
    '    branches: [main]',
    'permissions:',
    '  contents: read',
    'jobs:',
    '  test:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@' + PINNED_SHA,
    '      - uses: actions/setup-node@' + PINNED_SHA,
    '        with:',
    '          node-version: 22',
    '      - run: npm audit --audit-level=high',
    '        continue-on-error: true',
    '      - run: npm test -- --sha ${{ github.sha }}',
  ].join('\n');
  const { findings, warnings } = run(yaml);
  assert.deepEqual(findings, [], 'unexpected: ' + JSON.stringify(findings.map((f) => f.title)));
  assert.deepEqual(warnings, []);
});
