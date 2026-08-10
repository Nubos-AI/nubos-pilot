const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { loadAgent, FORBIDDEN } = require('./agents.cjs');

const AGENT_PATH = path.join(__dirname, '..', 'agents', 'np-plan-checker.md');
const BODY = fs.readFileSync(AGENT_PATH, 'utf-8');

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-pc-contract-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(root, 'agents', 'np-plan-checker.md'), BODY, 'utf-8');
  return root;
}

const CATEGORIES = [
  'missing-success-criterion',
  'non-atomic-task',
  'unbounded-scope',
  'broken-dependency',
  'cyclic-dependency',
  'fake-promotion-trigger',
  'missing-coverage-annotation',
  'bare-askuser-call',
  'hook-field-present',
  'forbidden-agent-field',
  'unverified-assumption',
  'contradictory-requirements',
  'pattern-claim-unverified',
];

const REQUIRED_H2 = [
  '## Role',
  '## Inputs',
  '## Review Dimensions',
  '## Verdict Format',
  '## Severity Rubric',
  '## Forbidden Outputs',
  '## Semantic Blocks',
];

test('PC-1: loadAgent(plan-checker) returns tier=opus and name=plan-checker', () => {
  const sb = makeSandbox();
  try {
    const fm = loadAgent('np-plan-checker', sb);
    assert.equal(fm.tier, 'opus');
    assert.equal(fm.name, 'np-plan-checker');
  } finally {
    fs.rmSync(sb, { recursive: true, force: true });
  }
});

test('PC-2: body contains every canonical finding-category identifier', () => {
  for (const c of CATEGORIES) {
    assert.ok(BODY.includes(c), 'missing canonical category: ' + c);
  }
});

test('PC-6: Dimension 13 audits internal consistency and reads the cited pattern code (ADR-0032)', () => {
  assert.match(BODY, /###\s+Dimension 13: Internal Consistency & Pattern Fidelity/,
    'Dimension 13 heading missing — nothing checks whether the plan can be true at once');
  assert.match(BODY, /<pattern_ref>/,
    'Dimension 13 must reference the <pattern_ref> block it verifies');
  assert.match(BODY, /M<NNN>-RESEARCH\.md/,
    'the checker must be told that RESEARCH.md is milestone-level evidence it reads');
});

test('PC-4: body contains all 7 required H2 section headers verbatim', () => {
  for (const h of REQUIRED_H2) {
    assert.ok(BODY.includes(h), 'missing required H2 header: ' + h);
  }
});

test('PC-5: frontmatter contains no FORBIDDEN key (model/model_profile/hooks)', () => {
  const fmBlock = BODY.split(/^---$/m)[1] || '';
  for (const f of FORBIDDEN) {
    const re = new RegExp('^' + f + ':', 'm');
    assert.equal(re.test(fmBlock), false, 'frontmatter contains forbidden field: ' + f);
  }
});
