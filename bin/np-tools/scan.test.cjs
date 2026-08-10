'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const subcmd = require('./scan.cjs');

function sandbox(spec) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-scancli-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  for (const [rel, content] of Object.entries(spec || {})) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

function capture() {
  let buf = '';
  return { stub: { write: (s) => { buf += s; return true; } }, get: () => buf };
}

test('SCANCLI-1 an unknown verb is refused with the valid list', async () => {
  await assert.rejects(
    () => subcmd.run(['bogus'], { cwd: process.cwd(), stdout: capture().stub }),
    /unknown scan verb/,
  );
});

test('SCANCLI-2 --help lists the verbs without running a scan', async () => {
  const cap = capture();
  const code = await subcmd.run(['--help'], { cwd: process.cwd(), stdout: cap.stub });
  assert.equal(code, 0);
  for (const verb of subcmd.VERBS) assert.ok(cap.get().includes(verb), 'help omits ' + verb);
});

test('SCANCLI-3 a home directory is never accepted as a scan root', () => {
  for (const target of [os.homedir(), path.parse(process.cwd()).root]) {
    assert.throws(
      () => subcmd._resolveRoot(process.cwd(), target),
      (err) => {
        assert.equal(err.code, 'scan-refused-root', 'wrong error code for ' + target);
        return true;
      },
      target,
    );
  }
});

test('SCANCLI-4 the auto-resolved root never escapes to an ancestor project', () => {
  const root = sandbox({});
  try {
    const nested = path.join(root, 'packages', 'app');
    fs.mkdirSync(nested, { recursive: true });
    assert.equal(subcmd._resolveRoot(root, null), root, 'a project root resolves to itself');
    assert.equal(subcmd._resolveRoot(nested, null), root, 'a subdirectory resolves to its project root');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('SCANCLI-5 fail-on gates on the worst finding even when the output is capped', () => {
  const truncated = { findings: [{ severity: 'low' }], max_severity: 'critical', truncated: true };
  assert.equal(subcmd._exitCode(truncated, 'critical'), 1);
  assert.equal(subcmd._exitCode(truncated, 'high'), 1);
  assert.equal(subcmd._exitCode(truncated, 'never'), 0);
  assert.equal(subcmd._exitCode({ findings: [], max_severity: 'medium' }, 'high'), 0);
});

test('SCANCLI-6 fail-on defaults to never so a scan cannot break a build by surprise', () => {
  assert.equal(subcmd._exitCode({ max_severity: 'critical' }, undefined), 0);
  assert.equal(subcmd._exitCode({ max_severity: 'critical' }, null), 0);
});

test('SCANCLI-7 inventory reports the packages it found', async () => {
  const root = sandbox({
    'package-lock.json': JSON.stringify({
      lockfileVersion: 3,
      packages: { '': { name: 'demo' }, 'node_modules/yaml': { version: '2.8.0' } },
    }),
  });
  try {
    const cap = capture();
    await subcmd.run(['inventory', '--json'], { cwd: root, stdout: cap.stub });
    const out = JSON.parse(cap.get());
    assert.equal(out.counts.total, 1);
    assert.deepEqual(out.ecosystems, ['npm']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('SCANCLI-8 db-status reports an absent snapshot rather than failing', async () => {
  const root = sandbox({});
  try {
    const cap = capture();
    const code = await subcmd.run(['db-status', '--json'], { cwd: root, stdout: cap.stub });
    assert.equal(code, 0);
    assert.equal(typeof JSON.parse(cap.get()).present, 'boolean');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('SCANCLI-9 sbom emits a CycloneDX document', async () => {
  const root = sandbox({
    'package-lock.json': JSON.stringify({
      lockfileVersion: 3,
      packages: { '': { name: 'demo' }, 'node_modules/yaml': { version: '2.8.0' } },
    }),
  });
  try {
    const cap = capture();
    await subcmd.run(['sbom'], { cwd: root, stdout: cap.stub });
    const out = JSON.parse(cap.get());
    assert.equal(out.bom.bomFormat, 'CycloneDX');
    assert.equal(out.bom.components.length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('SCANCLI-10 a verb restricts the run to its own scanners', () => {
  for (const [verb, expected] of Object.entries(subcmd.SCANNER_FOR_VERB)) {
    assert.ok(Array.isArray(expected) && expected.length > 0, verb);
  }
  assert.deepEqual(subcmd.SCANNER_FOR_VERB.secrets, ['secrets']);
  assert.deepEqual(subcmd.SCANNER_FOR_VERB.advisory, ['advisory', 'malicious']);
});

test('SCANCLI-11 misconfig on a hostile workflow reports it and stays exit 0 by default', async () => {
  const root = sandbox({
    '.github/workflows/evil.yml': [
      'on:',
      '  pull_request_target:',
      'jobs:',
      '  b:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '        with:',
      '          ref: ${{ github.event.pull_request.head.sha }}',
    ].join('\n'),
  });
  try {
    const cap = capture();
    const code = await subcmd.run(['misconfig', '--json'], { cwd: root, stdout: cap.stub });
    const out = JSON.parse(cap.get());
    assert.equal(code, 0, 'the default must never break a build');
    assert.equal(out.max_severity, 'critical');
    assert.ok(out.findings.some((f) => f.id === 'NPS-0500'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('SCANCLI-12 --fail-on turns the same run into a gate', async () => {
  const root = sandbox({
    '.github/workflows/evil.yml': [
      'on:',
      '  pull_request_target:',
      'jobs:',
      '  b:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '        with:',
      '          ref: ${{ github.event.pull_request.head.sha }}',
    ].join('\n'),
  });
  try {
    const code = await subcmd.run(['misconfig', '--fail-on', 'critical'], { cwd: root, stdout: capture().stub });
    assert.equal(code, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('SCANCLI-13 an out-of-vocabulary --min-severity is refused, never silently weakened', () => {
  for (const bad of ['moderate', 'nonsense', '', 'HIGH']) {
    assert.throws(
      () => subcmd._flags(['--min-severity', bad]),
      (err) => { assert.equal(err.code, 'scan-invalid-flag'); return true; },
      JSON.stringify(bad),
    );
  }
  for (const good of subcmd.VALID_MIN_SEVERITY) {
    assert.equal(subcmd._flags(['--min-severity', good]).minSeverity, good);
  }
});

test('SCANCLI-14 an out-of-vocabulary --fail-on is refused rather than collapsed to high', () => {
  for (const bad of ['medium', 'low', 'info', 'always']) {
    assert.throws(
      () => subcmd._flags(['--fail-on', bad]),
      (err) => { assert.equal(err.code, 'scan-invalid-flag'); return true; },
      bad,
    );
  }
  for (const good of subcmd.VALID_FAIL_ON) {
    assert.equal(subcmd._flags(['--fail-on', good]).failOn, good);
  }
});

test('SCANCLI-15 an invalid flag surfaces through run() instead of scanning', async () => {
  await assert.rejects(
    () => subcmd.run(['misconfig', '--fail-on', 'medium'], { cwd: process.cwd(), stdout: capture().stub }),
    (err) => { assert.equal(err.code, 'scan-invalid-flag'); return true; },
  );
});
