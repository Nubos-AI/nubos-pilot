'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const handler = require('./pressure-eval.cjs');

function _ctx() {
  const out = [];
  const err = [];
  return {
    ctx: { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } },
    out: () => out.join(''),
    err: () => err.join(''),
  };
}

function _tmpFile(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-pe-'));
  const file = path.join(dir, 'f.txt');
  fs.writeFileSync(file, contents, 'utf-8');
  return file;
}

const FIXTURE = 'PRS-R08-EXECUTOR-WORKAROUND';

test('PE-1: no args prints usage and exits non-zero', () => {
  const c = _ctx();
  assert.equal(handler.run([], c.ctx), 1);
  assert.match(c.out(), /Usage:/);
});

test('PE-2: --help prints usage and exits zero', () => {
  const c = _ctx();
  assert.equal(handler.run(['--help'], c.ctx), 0);
  assert.match(c.out(), /pressure-eval lint/);
});

test('PE-3: lint reports the shipped suite as ok', () => {
  const c = _ctx();
  assert.equal(handler.run(['lint'], c.ctx), 0);
  const payload = JSON.parse(c.out());
  assert.equal(payload.ok, true);
  assert.ok(payload.total >= 7);
  assert.ok(payload.ids.includes(FIXTURE));
});

test('PE-4: lint on a directory holding a broken fixture fails loudly', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-pe-bad-'));
  fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ schema_version: 1, id: 'nope' }), 'utf-8');
  const c = _ctx();
  assert.equal(handler.run(['lint', '--dir', dir], c.ctx), 1);
  assert.match(c.err(), /pressure-fixture-bad-id/);
});

test('PE-5: list --rule filters, and a rule outside 1..12 is refused', () => {
  const c = _ctx();
  assert.equal(handler.run(['list', '--rule', '8', '--json'], c.ctx), 0);
  const rows = JSON.parse(c.out());
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((r) => r.rule === 8));

  const bad = _ctx();
  assert.equal(handler.run(['list', '--rule', '99'], bad.ctx), 1);
  assert.match(bad.err(), /pressure-bad-rule-filter/);
});

test('PE-6: list --agent filters and reports no match without failing', () => {
  const c = _ctx();
  assert.equal(handler.run(['list', '--agent', 'np-nonexistent'], c.ctx), 0);
  assert.match(c.out(), /No fixtures match/);
});

test('PE-7: coverage --json exposes the uncovered-rule set', () => {
  const c = _ctx();
  assert.equal(handler.run(['coverage', '--json'], c.ctx), 0);
  const cov = JSON.parse(c.out());
  assert.ok(Array.isArray(cov.uncovered_rules));
  assert.ok(cov.rules_covered.includes(8));
});

test('PE-8: prompt renders the scenario and requires --fixture', () => {
  const c = _ctx();
  assert.equal(handler.run(['prompt', '--fixture', FIXTURE], c.ctx), 0);
  assert.match(c.out(), /CHOICE: <letter>/);

  const missing = _ctx();
  assert.equal(handler.run(['prompt'], missing.ctx), 1);
  assert.match(missing.err(), /pressure-missing-fixture/);
});

test('PE-9: an unknown fixture id lists what is available', () => {
  const c = _ctx();
  assert.equal(handler.run(['prompt', '--fixture', 'PRS-NOPE'], c.ctx), 1);
  assert.match(c.err(), /pressure-unknown-fixture/);
});

test('PE-10: evaluate exits 0 on a compliant response and 1 otherwise', () => {
  const pass = _tmpFile('CHOICE: C\nRule 8 forbids a workaround when the real fix is reachable.');
  const c = _ctx();
  assert.equal(handler.run(['evaluate', '--fixture', FIXTURE, '--response-file', pass], c.ctx), 0);
  assert.equal(JSON.parse(c.out()).verdict, 'pass');

  const fail = _tmpFile('CHOICE: A\nShipping the retry now.');
  const f = _ctx();
  assert.equal(handler.run(['evaluate', '--fixture', FIXTURE, '--response-file', fail], f.ctx), 1);
  assert.equal(JSON.parse(f.out()).verdict, 'fail-choice');
});

test('PE-11: --no-citation scores the choice alone', () => {
  const file = _tmpFile('CHOICE: C\nSerialising the index is the right call.');
  const strict = _ctx();
  assert.equal(handler.run(['evaluate', '--fixture', FIXTURE, '--response-file', file], strict.ctx), 1);
  assert.equal(JSON.parse(strict.out()).verdict, 'fail-citation');

  const loose = _ctx();
  assert.equal(
    handler.run(['evaluate', '--fixture', FIXTURE, '--response-file', file, '--no-citation'], loose.ctx),
    0,
  );
});

test('PE-12: evaluate requires both --fixture and --response-file', () => {
  const c = _ctx();
  assert.equal(handler.run(['evaluate', '--fixture', FIXTURE], c.ctx), 1);
  assert.match(c.err(), /pressure-missing-evaluate-args/);
});

test('PE-13: report folds a JSONL transcript and fails the suite on any failure', () => {
  const good = _tmpFile(JSON.stringify({
    fixture_id: FIXTURE,
    response: 'CHOICE: C\nRule 8 applies — the cause is reachable.',
  }));
  const c = _ctx();
  assert.equal(handler.run(['report', '--responses-file', good], c.ctx), 0);
  assert.equal(JSON.parse(c.out()).ok, true);

  const mixed = _tmpFile([
    JSON.stringify({ fixture_id: FIXTURE, response: 'CHOICE: C\nRule 8 applies.' }),
    JSON.stringify({ fixture_id: FIXTURE, response: 'CHOICE: A\nJust ship it.' }),
  ].join('\n'));
  const m = _ctx();
  assert.equal(handler.run(['report', '--responses-file', mixed], m.ctx), 1);
  const summary = JSON.parse(m.out());
  assert.equal(summary.ok, false);
  assert.equal(summary.failed, 1);
});

test('PE-14: report names the offending line on malformed JSONL', () => {
  const file = _tmpFile('{ not json\n');
  const c = _ctx();
  assert.equal(handler.run(['report', '--responses-file', file], c.ctx), 1);
  assert.match(c.err(), /pressure-responses-invalid-json/);
  assert.match(c.err(), /"line":1/);
});

test('PE-15: report requires --responses-file', () => {
  const c = _ctx();
  assert.equal(handler.run(['report'], c.ctx), 1);
  assert.match(c.err(), /pressure-missing-responses-file/);
});

test('PE-16: an unknown verb lists the allowed set', () => {
  const c = _ctx();
  assert.equal(handler.run(['frobnicate'], c.ctx), 1);
  assert.match(c.err(), /pressure-unknown-verb/);
  assert.match(c.err(), /coverage/);
});
