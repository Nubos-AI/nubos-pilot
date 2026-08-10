'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const reconciler = require('./researcher-reconciler.cjs');
const outputLint = require('./output-lint.cjs');
const researcherOutputSchema = require('./schemas/researcher-output.cjs');
const researchFinalSchema = require('./schemas/research-final.cjs');

const FIX = path.join(__dirname, 'fixtures', 'researcher');

const _sandboxes = [];

function _mkResearchSandbox(spawnFiles) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-recon-'));
  _sandboxes.push(root);
  const sd = path.join(root, '.nubos-pilot');
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, 'PROJECT.md'), '# Demo\n', 'utf-8');
  const mDir = path.join(sd, 'milestones', 'M001');
  const researchDir = path.join(mDir, 'research');
  fs.mkdirSync(researchDir, { recursive: true });
  for (let i = 0; i < spawnFiles.length; i++) {
    fs.copyFileSync(path.join(FIX, spawnFiles[i]), path.join(researchDir, 'spawn-' + i + '.md'));
  }
  return root;
}

afterEach(() => {
  while (_sandboxes.length) {
    try { fs.rmSync(_sandboxes.pop(), { recursive: true, force: true }); } catch {}
  }
});

test('RR-1: parseSpawnOutput extracts decisions/risks/patterns with Reasoning trace', () => {
  const parsed = reconciler.parseSpawnOutput(path.join(FIX, 'spawn-0-good.md'));
  assert.equal(parsed.spawn_index, 0);
  assert.equal(parsed.seed_delta, -7);
  assert.equal(parsed.decisions.length, 2);
  assert.equal(parsed.decisions[0].id, 'D-1');
  assert.match(parsed.decisions[0].text, /jose@6/);
  assert.match(parsed.decisions[0].reasoning, /Compared jose vs jsonwebtoken/);
  assert.equal(parsed.risks.length, 1);
  assert.equal(parsed.patterns.length, 1);
  assert.equal(parsed.open_questions.length, 1);
  assert.equal(parsed.sources.length, 2);
});

test('RR-2: parseSpawnOutput on missing file throws researcher-spawn-missing', () => {
  assert.throws(
    () => reconciler.parseSpawnOutput('/tmp/np-not-here-xyz.md'),
    (err) => err.code === 'researcher-spawn-missing',
  );
});

test('RR-3: classifyReasoningAgreement returns orthogonal for distinct reasoning', () => {
  const entries = [
    { reasoning: 'compared library A and library B benchmarks, A wins on perf' },
    { reasoning: 'evaluated cves and maintenance status, A is the only maintained option' },
  ];
  const cls = reconciler.classifyReasoningAgreement(entries);
  assert.equal(cls, 'orthogonal');
});

test('RR-4: classifyReasoningAgreement returns identical for same reasoning', () => {
  const entries = [
    { reasoning: 'option a is best because of feature x' },
    { reasoning: 'option a is best because of feature x' },
  ];
  assert.equal(reconciler.classifyReasoningAgreement(entries), 'identical');
});

test('RR-5: classifyReasoningAgreement handles unknown when traces absent', () => {
  const entries = [{ reasoning: '' }, { reasoning: 'lone trace' }];
  assert.equal(reconciler.classifyReasoningAgreement(entries), 'unknown');
});

test('RR-6: reconcileSpawns produces consensus on shared decision + contested for split decision', () => {
  const spawns = [
    reconciler.parseSpawnOutput(path.join(FIX, 'spawn-0-good.md')),
    reconciler.parseSpawnOutput(path.join(FIX, 'spawn-1-good.md')),
    reconciler.parseSpawnOutput(path.join(FIX, 'spawn-2-disagrees.md')),
  ];
  const result = reconciler.reconcileSpawns(spawns);
  assert.equal(result.k, 3);

  const joseDecision = result.final_decisions.find((d) => /jose@6/.test(d.text));
  assert.ok(joseDecision, 'jose@6 decision should be consensus');
  assert.equal(joseDecision.agreement_count, 3);
  assert.deepEqual(joseDecision.from_spawns, [0, 1, 2]);
  assert.equal(joseDecision.reasoning_trace_agreement, 'orthogonal',
    'three different reasoning paths should classify as orthogonal');

  const cookieDecision = result.final_decisions.find((d) => /signed cookies/.test(d.text));
  assert.ok(cookieDecision, 'cookie decision should be consensus (2 of 3)');
  assert.equal(cookieDecision.agreement_count, 2);

  const redisDecision = result.contested.find((d) => /Redis/.test(d.text));
  assert.ok(redisDecision, 'Redis decision should be contested (only spawn-2)');
  assert.equal(redisDecision.agreement_count, 1);
  assert.deepEqual(redisDecision.from_spawns, [2]);
});

test('RR-7: prepareReconcilerInput reads research/ dir + builds merged shape', () => {
  const sb = _mkResearchSandbox(['spawn-0-good.md', 'spawn-1-good.md', 'spawn-2-disagrees.md']);
  const payload = reconciler.prepareReconcilerInput(1, sb);
  assert.equal(payload.milestone, 1);
  assert.equal(payload.milestone_id, 'M001');
  assert.equal(payload.spawn_count, 3);
  assert.equal(payload.merged.k, 3);
  assert.ok(payload.merged.final_decisions.length >= 1);
  assert.ok(payload.merged.contested.length >= 1, 'expected ≥1 contested for split scenario');
  assert.equal(payload.thresholds.min_agreement_score, 0.5);
  assert.equal(payload.thresholds.max_contested, 2);
});

test('RR-8: prepareReconcilerInput throws when research/ dir missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-recon-empty-'));
  _sandboxes.push(root);
  fs.mkdirSync(path.join(root, '.nubos-pilot', 'milestones', 'M001'), { recursive: true });
  fs.writeFileSync(path.join(root, '.nubos-pilot', 'PROJECT.md'), '# x\n', 'utf-8');
  assert.throws(
    () => reconciler.prepareReconcilerInput(1, root),
    (err) => err.code === 'researcher-reconcile-no-research-dir',
  );
});

test('RR-9: prepareReconcilerInput throws when research/ dir is empty', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-recon-empty-'));
  _sandboxes.push(root);
  fs.mkdirSync(path.join(root, '.nubos-pilot', 'milestones', 'M001', 'research'), { recursive: true });
  fs.writeFileSync(path.join(root, '.nubos-pilot', 'PROJECT.md'), '# x\n', 'utf-8');
  assert.throws(
    () => reconciler.prepareReconcilerInput(1, root),
    (err) => err.code === 'researcher-reconcile-no-spawn-files',
  );
});

test('RR-10: disagreementGate triggers askuser when agreement_score < 0.5', () => {
  const merged = {
    agreement: { decisions: 0.3 },
    contested: [],
  };
  const gate = reconciler.disagreementGate(merged);
  assert.equal(gate.needs_askuser, true);
  assert.ok(gate.violations.some((v) => v.code === 'agreement-score-low'));
});

test('RR-11: disagreementGate triggers askuser when contested_count > max', () => {
  const merged = {
    agreement: { decisions: 1 },
    contested: [{}, {}, {}],
  };
  const gate = reconciler.disagreementGate(merged);
  assert.equal(gate.needs_askuser, true);
  assert.ok(gate.violations.some((v) => v.code === 'too-many-contested'));
});

test('RR-12: disagreementGate passes when score above threshold + few contested', () => {
  const merged = {
    agreement: { decisions: 0.9 },
    contested: [{}],
  };
  const gate = reconciler.disagreementGate(merged);
  assert.equal(gate.needs_askuser, false);
  assert.equal(gate.violations.length, 0);
});

test('RR-13: gateFromFinalFrontmatter reads agreement_score + contested_count from MD', () => {
  const md = [
    '---',
    'schema_version: 2',
    'type: research',
    'agent: np-researcher-reconciler',
    'milestone: "M001"',
    'k: 3',
    'agreement_score: 0.33',
    'contested_count: 4',
    'reconciler_verdict: needs_re_spawn',
    'decision_count: 2',
    'risk_count: 0',
    'pattern_count: 0',
    'open_question_count: 0',
    'source_count: 0',
    '---',
    '',
    'body',
  ].join('\n');
  const gate = reconciler.gateFromFinalFrontmatter(md);
  assert.equal(gate.needs_askuser, true);
  assert.equal(gate.score, 0.33);
  assert.equal(gate.contested_count, 4);
});

test('RR-14: per-spawn schema accepts canonical fixture', () => {
  const result = outputLint.lintFile(path.join(FIX, 'spawn-0-good.md'), researcherOutputSchema);
  assert.equal(result.ok, true, 'expected ok; violations: ' + JSON.stringify(result.violations));
});

test('RR-15: per-spawn schema rejects file without Reasoning field per entry', () => {
  const bad = [
    '---',
    'schema_version: 1',
    'agent: np-researcher',
    'spawn_index: 0',
    'seed_delta: 0',
    'task_query_hash: "abc"',
    'decision_count: 1',
    'risk_count: 0',
    'pattern_count: 0',
    'open_question_count: 0',
    'source_count: 0',
    '---',
    '',
    '## Decisions',
    '',
    '### D-1: missing reasoning',
    '- **Rationale:** x',
    '- **Confidence:** med',
    '- **Evidence:** y',
    '',
    '## Risks',
    '',
    '_None._',
    '',
    '## Patterns',
    '',
    '_None._',
    '',
    '## Open Questions',
    '',
    '_None._',
    '',
    '## Sources',
    '',
    '_None._',
  ].join('\n');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'np-spawn-bad-'));
  _sandboxes.push(tmpRoot);
  const p = path.join(tmpRoot, 'spawn-0.md');
  fs.writeFileSync(p, bad, 'utf-8');
  const result = outputLint.lintFile(p, researcherOutputSchema);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.code === 'block-field-missing' && /Reasoning/.test(v.message)));
});

test('RR-16: research-final schema accepts a well-formed reconciler output', () => {
  const md = [
    '---',
    'schema_version: 2',
    'milestone: "M001"',
    'type: research',
    'agent: np-researcher-reconciler',
    'k: 3',
    'agreement_score: 0.8',
    'contested_count: 1',
    'reconciler_verdict: issues_flagged',
    'decision_count: 2',
    'risk_count: 1',
    'pattern_count: 1',
    'open_question_count: 0',
    'source_count: 2',
    '---',
    '',
    '# M001 — Research',
    '',
    '## Reconciler Summary',
    'k=3, two decisions consolidated, one contested (Redis vs cookies).',
    '',
    '## Final Decisions',
    '',
    '### D-1: Use jose@6 for JWT signing',
    '- **Reconciled-from:** spawn-0, spawn-1, spawn-2',
    '- **Confidence (reconciled):** high',
    '- **Reasoning-Trace-Agreement:** orthogonal',
    '- **Evidence:** combined refs',
    '- **Reasoning:** synthesis',
    '',
    '## Contested Decisions',
    '',
    '### CD-1: Session storage backend',
    '- **Spawn-0 says:** signed cookies',
    '- **Spawn-2 says:** Redis with sliding window',
    '- **Reconciler verdict:** Pick spawn-0',
    '- **Reason:** spec has no concurrent-session-invalidation requirement',
    '',
    '## Final Risks',
    '',
    '### R-1: Cookie size limit',
    '- **Severity:** med',
    '- **Mitigation:** Strip claims',
    '- **Reasoning:** ~200 perms hits 4KB',
    '',
    '## Final Patterns',
    '',
    '### P-1: RT rotation',
    '- **Description:** Each refresh rotates',
    '- **Source-Type:** docs',
    '- **Reasoning:** OWASP guidance',
    '',
    '## Final Open Questions',
    '',
    '_None._',
    '',
    '## Sources',
    '',
    '### S-1: https://github.com/panva/jose',
    '- **Type:** docs',
    '- **Notes:** v6 release',
    '',
    '### S-2: https://owasp.org/...',
    '- **Type:** docs',
    '- **Notes:** OWASP',
  ].join('\n');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'np-final-ok-'));
  _sandboxes.push(tmpRoot);
  const p = path.join(tmpRoot, 'M001-RESEARCH.md');
  fs.writeFileSync(p, md, 'utf-8');
  const result = outputLint.lintFile(p, researchFinalSchema);
  assert.equal(result.ok, true, 'expected ok; violations: ' + JSON.stringify(result.violations));
});

test('RR-17: research-final schema rejects missing Contested Decisions section', () => {
  const md = [
    '---',
    'schema_version: 2',
    'milestone: "M001"',
    'type: research',
    'agent: np-researcher-reconciler',
    'k: 3',
    'agreement_score: 1',
    'contested_count: 0',
    'reconciler_verdict: clean',
    'decision_count: 1',
    'risk_count: 0',
    'pattern_count: 0',
    'open_question_count: 0',
    'source_count: 0',
    '---',
    '',
    '## Reconciler Summary',
    '## Final Decisions',
    '## Final Risks',
    '## Final Patterns',
    '## Final Open Questions',
    '## Sources',
  ].join('\n');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'np-final-bad-'));
  _sandboxes.push(tmpRoot);
  const p = path.join(tmpRoot, 'M001-RESEARCH.md');
  fs.writeFileSync(p, md, 'utf-8');
  const result = outputLint.lintFile(p, researchFinalSchema);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => /Contested Decisions/.test(v.message)));
});
