const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const SPEC_DOC = path.join(REPO_ROOT, 'docs', 'phase-directory-layout.md');

test('SD-1: phase-directory-layout.md exists at the documented D-25 path', () => {
  const st = fs.statSync(SPEC_DOC);
  assert.ok(st.isFile(), 'expected a regular file at ' + SPEC_DOC);
  assert.ok(st.size > 0, 'expected non-empty phase-directory-layout.md');
});

test('SD-2: phase-directory-layout.md mentions every optional phase file per D-25', () => {
  const raw = fs.readFileSync(SPEC_DOC, 'utf-8');
  const optional = [
    'CONTEXT.md',
    'RESEARCH.md',
    'VERIFICATION.md',
    'DISCUSSION-LOG.md',
    'UI-SPEC.md',
    'AI-SPEC.md',
    'REVIEW.md',
  ];
  for (const name of optional) {
    assert.ok(raw.includes(name), 'spec doc does not mention ' + name);
  }
});
