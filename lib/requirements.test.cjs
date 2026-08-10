'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const reqs = require('./requirements.cjs');

const SAMPLE = [
  '# Requirements',
  '',
  '## Auth Requirements',
  '',
  '- [ ] **AUTH-01**: users can log in with email and password',
  '- [x] **AUTH-02**: sessions expire after 24h',
  '',
  '## Utility Requirements',
  '',
  '* **UTIL-01**: paths are validated against traversal',
  '',
  '## Out of Scope',
  '',
  '- SSO',
].join('\n');

function project(markdown) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-reqs-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  if (markdown != null) fs.writeFileSync(reqs.requirementsPath(root), markdown);
  return root;
}

test('REQS-1 entries are parsed with id, text, section and checkbox state', () => {
  const { entries, byId } = reqs.parseRequirements(SAMPLE);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((e) => e.id), ['AUTH-01', 'AUTH-02', 'UTIL-01']);
  assert.equal(byId.get('AUTH-01').section, 'Auth Requirements');
  assert.equal(byId.get('AUTH-01').checked, false);
  assert.equal(byId.get('AUTH-02').checked, true);
  assert.equal(byId.get('UTIL-01').section, 'Utility Requirements');
  assert.match(byId.get('UTIL-01').text, /traversal/);
});

test('REQS-2 both dash and asterisk bullets are recognized', () => {
  const { entries } = reqs.parseRequirements('- **A-1**: x\n* **B-2**: y\n');
  assert.deepEqual(entries.map((e) => e.id), ['A-1', 'B-2']);
});

test('REQS-3 requirement ids inside a fenced block are ignored', () => {
  const md = ['- **REAL-01**: yes', '', '```md', '- **FAKE-01**: no', '```', '- **REAL-02**: yes'].join('\n');
  assert.deepEqual(reqs.parseRequirements(md).entries.map((e) => e.id), ['REAL-01', 'REAL-02']);
});

test('REQS-4 a tilde fence is honoured too', () => {
  const md = ['~~~', '- **FAKE-01**: no', '~~~', '- **REAL-01**: yes'].join('\n');
  assert.deepEqual(reqs.parseRequirements(md).entries.map((e) => e.id), ['REAL-01']);
});

test('REQS-5 duplicate ids are reported and the first wins', () => {
  const { byId, duplicates } = reqs.parseRequirements('- **A-1**: first\n- **A-1**: second\n');
  assert.deepEqual(duplicates, ['A-1']);
  assert.equal(byId.get('A-1').text, 'first');
});

test('REQS-6 the placeholder id from new-milestone is marked as such', () => {
  const { byId } = reqs.parseRequirements('- [ ] **REQ-TBD**: TBD\n');
  assert.equal(byId.get('REQ-TBD').placeholder, true);
  assert.ok(reqs.isPlaceholder('REQ-TBD'));
  assert.ok(!reqs.isPlaceholder('REQ-01'));
});

test('REQS-7 id shape is enforced', () => {
  for (const good of ['REQ-01', 'AUTH-02', 'UTIL-1', 'A1-2', 'PLAN-05.1']) {
    assert.ok(reqs.isRequirementId(good), good);
  }
  for (const bad of ['req-01', 'REQ', 'REQ-', '-01', '1-REQ', '', null, 'REQ 01', 'REQ--01']) {
    assert.ok(!reqs.isRequirementId(bad), String(bad));
  }
});

test('REQS-8 a missing REQUIREMENTS.md reads as absent rather than throwing', () => {
  const root = project(null);
  try {
    const store = reqs.readRequirements(root);
    assert.equal(store.present, false);
    assert.deepEqual(store.entries, []);
    assert.deepEqual(reqs.knownIds(root), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('REQS-9 knownIds returns every declared id', () => {
  const root = project(SAMPLE);
  try {
    assert.deepEqual(reqs.knownIds(root), ['AUTH-01', 'AUTH-02', 'UTIL-01']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('REQS-10 sections group entries by their heading', () => {
  const root = project(SAMPLE);
  try {
    const grouped = reqs.sections(root);
    assert.deepEqual(grouped.get('Auth Requirements').map((e) => e.id), ['AUTH-01', 'AUTH-02']);
    assert.deepEqual(grouped.get('Utility Requirements').map((e) => e.id), ['UTIL-01']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('REQS-11 normalizeIdList accepts a comma or space separated string', () => {
  assert.deepEqual(reqs.normalizeIdList('AUTH-01, AUTH-02'), ['AUTH-01', 'AUTH-02']);
  assert.deepEqual(reqs.normalizeIdList('auth-01 util-01'), ['AUTH-01', 'UTIL-01']);
  assert.deepEqual(reqs.normalizeIdList(['AUTH-01', 'AUTH-01']), ['AUTH-01']);
  assert.deepEqual(reqs.normalizeIdList(''), []);
  assert.deepEqual(reqs.normalizeIdList(null), []);
});

test('REQS-12 validateIds separates malformed, unknown and placeholder ids', () => {
  const root = project(SAMPLE);
  try {
    const ok = reqs.validateIds('AUTH-01,UTIL-01', root);
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.ids, ['AUTH-01', 'UTIL-01']);

    const bad = reqs.validateIds('AUTH-01, nope, MISSING-99, REQ-TBD', root);
    assert.equal(bad.ok, false);
    assert.deepEqual(bad.malformed, ['NOPE']);
    assert.deepEqual(bad.unknown, ['MISSING-99']);
    assert.deepEqual(bad.placeholders, ['REQ-TBD']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('REQS-13 assertIds returns the ids when every one resolves', () => {
  const root = project(SAMPLE);
  try {
    assert.deepEqual(reqs.assertIds('AUTH-02', root), ['AUTH-02']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('REQS-14 assertIds refuses an unknown id loudly', () => {
  const root = project(SAMPLE);
  try {
    assert.throws(() => reqs.assertIds('MISSING-99', root), /no such requirement/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('REQS-15 assertIds refuses the TBD placeholder with a fix hint', () => {
  const root = project('- [ ] **REQ-TBD**: TBD\n');
  try {
    assert.throws(() => reqs.assertIds('REQ-TBD', root), /replace it in REQUIREMENTS\.md/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('REQS-16 assertIds refuses a malformed id with an example', () => {
  const root = project(SAMPLE);
  try {
    assert.throws(() => reqs.assertIds('banana', root), /expected e\.g\. REQ-01/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('REQS-17 unassignedIds reports requirements no milestone claims', () => {
  const root = project(SAMPLE);
  try {
    const doc = { milestones: [{ id: 'M001', requirements: ['AUTH-01'] }] };
    assert.deepEqual(reqs.unassignedIds(root, doc), ['AUTH-02', 'UTIL-01']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('REQS-18 unassignedIds ignores the placeholder and is case-insensitive', () => {
  const root = project(SAMPLE + '\n- [ ] **REQ-TBD**: TBD\n');
  try {
    const doc = { milestones: [{ id: 'M001', requirements: ['auth-01', 'auth-02', 'util-01'] }] };
    assert.deepEqual(reqs.unassignedIds(root, doc), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('REQS-19 unassignedIds tolerates a missing or empty roadmap doc', () => {
  const root = project(SAMPLE);
  try {
    assert.deepEqual(reqs.unassignedIds(root, null), ['AUTH-01', 'AUTH-02', 'UTIL-01']);
    assert.deepEqual(reqs.unassignedIds(root, {}), ['AUTH-01', 'AUTH-02', 'UTIL-01']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('REQS-20 an oversized REQUIREMENTS.md is refused rather than parsed', () => {
  const root = project('x'.repeat(reqs.MAX_BYTES + 1));
  try {
    assert.throws(() => reqs.readRequirements(root), /exceeds the/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
