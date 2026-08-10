'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.resolve(__dirname, 'researcher-merge.cjs');

function _mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'np-merge-'));
}

function _spawn(args, opts) {
  return spawnSync('node', [CLI, ...args], Object.assign({ encoding: 'utf-8' }, opts || {}));
}

function _writeJson(dir, name, obj) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(obj), 'utf-8');
  return p;
}

const SAME_INPUT_OUTPUT = (extra) => Object.assign({
  decisions: [{ claim: 'use jose for JWT', confidence: 'HIGH', provenance: '[VERIFIED]' }],
  risks: [],
  patterns: [{ name: 'verifyJwt', description: 'verifyJwt(token, jwks)' }],
  open_questions: [],
  sources: [],
}, extra || {});

test('RM-1: file-args produce consensus markdown with high agreement_score', () => {
  const r = _mkTmp();
  try {
    const a = _writeJson(r, 'a.json', SAME_INPUT_OUTPUT());
    const b = _writeJson(r, 'b.json', SAME_INPUT_OUTPUT());
    const c = _writeJson(r, 'c.json', SAME_INPUT_OUTPUT({ risks: [{ description: 'key rotation', severity: 'MEDIUM' }] }));
    const res = _spawn([a, b, c]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /<consensus_meta>/);
    assert.match(res.stdout, /agreement_score: 1\.000/);
    assert.match(res.stdout, /use jose for JWT.*agreement=3/);
    assert.match(res.stdout, /verifyJwt.*agreement=3/);
    assert.match(res.stdout, /\[MEDIUM\] key rotation/);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('RM-2: --stdin reads JSON array', () => {
  const inputs = [SAME_INPUT_OUTPUT(), SAME_INPUT_OUTPUT(), SAME_INPUT_OUTPUT()];
  const res = _spawn(['--stdin'], { input: JSON.stringify(inputs) });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /agreement_score: 1\.000/);
});

test('RM-3: --json emits structured consensus', () => {
  const r = _mkTmp();
  try {
    const a = _writeJson(r, 'a.json', SAME_INPUT_OUTPUT());
    const res = _spawn([a, '--json']);
    assert.equal(res.status, 0, res.stderr);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.meta.k, 1);
    assert.ok(Array.isArray(parsed.decisions));
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('RM-4: topic-split spawns produce ZERO majority decisions and EMPTY pattern intersection (the canonical bug we guard against)', () => {
  const r = _mkTmp();
  try {
    const a = _writeJson(r, 'a.json', {
      decisions: [{ claim: 'install Cashier 16 via composer require laravel/cashier', confidence: 'HIGH', provenance: '[CITED: cashier docs]' }],
      risks: [], patterns: [{ name: 'composerInstall' }], open_questions: [], sources: [],
    });
    const b = _writeJson(r, 'b.json', {
      decisions: [{ claim: 'use Pest for feature tests', confidence: 'HIGH', provenance: '[CITED: pest docs]' }],
      risks: [], patterns: [{ name: 'pestFeatureTest' }], open_questions: [], sources: [],
    });
    const c = _writeJson(r, 'c.json', {
      decisions: [{ claim: 'set CASHIER_CURRENCY in .env', confidence: 'HIGH', provenance: '[CITED: env docs]' }],
      risks: [], patterns: [{ name: 'envConfig' }], open_questions: [], sources: [],
    });
    const res = _spawn([a, b, c, '--json']);
    assert.equal(res.status, 0, res.stderr);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.decisions.length, 0, 'no claim reaches majority — every decision is seen by exactly one spawn');
    assert.equal(parsed.flagged_decisions.length, 3, 'every decision lands in flagged because none crossed the majority threshold');
    assert.equal(parsed.patterns.length, 0, 'no pattern reaches the k≥2 intersection threshold');
    assert.equal(parsed.meta.flagged_count, 3);
    assert.ok(
      parsed.meta.agreement_score < 0.5,
      'topic-split surfaces as low agreement_score (each decision seen by 1/3 spawns ≈ 0.333), unambiguously distinguishable from full consensus (1.0)',
    );
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('RM-5: --out writes consensus to file and prints the path', () => {
  const r = _mkTmp();
  try {
    const a = _writeJson(r, 'a.json', SAME_INPUT_OUTPUT());
    const out = path.join(r, 'consensus.md');
    const res = _spawn([a, '--out', out]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), out);
    const written = fs.readFileSync(out, 'utf-8');
    assert.match(written, /Researcher-Schwarm Consensus/);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('RM-6: invalid JSON in spawn output exits 4', () => {
  const r = _mkTmp();
  try {
    const bad = path.join(r, 'bad.json');
    fs.writeFileSync(bad, 'NOT JSON', 'utf-8');
    const res = _spawn([bad]);
    assert.equal(res.status, 4);
    assert.match(res.stderr, /invalid JSON/);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('RM-7: no args exits 2 with usage', () => {
  const res = _spawn([]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /Usage:/);
});

test('RM-8: --stdin with non-array exits 4', () => {
  const res = _spawn(['--stdin'], { input: '{"not":"an array"}' });
  assert.equal(res.status, 4);
  assert.match(res.stderr, /must be a JSON array/);
});

test('RM-9: --heading overrides default consensus heading', () => {
  const r = _mkTmp();
  try {
    const a = _writeJson(r, 'a.json', SAME_INPUT_OUTPUT());
    const res = _spawn([a, '--heading', 'Cashier 16 Consensus']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /^# Cashier 16 Consensus/m);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('RM-10: --out write is atomic (no .tmp residue, never torn JSON)', () => {
  const r = _mkTmp();
  try {
    const a = _writeJson(r, 'a.json', SAME_INPUT_OUTPUT());
    const out = path.join(r, 'consensus.json');
    const res = _spawn([a, '--out', out, '--json']);
    assert.equal(res.status, 0, res.stderr);
    const parsed = JSON.parse(fs.readFileSync(out, 'utf-8'));
    assert.ok(Array.isArray(parsed.decisions));
    const residue = fs.readdirSync(r).filter((n) => /\.\d+\.[0-9a-f]{12}\.tmp$/.test(n));
    assert.deepEqual(residue, [], 'atomicWriteFileSync must not leave .tmp behind');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});
