'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const cc = require('./check-completeness.cjs');

function _mkRoot() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-'));
  fs.mkdirSync(path.join(r, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(r, 'workflows'), { recursive: true });
  fs.mkdirSync(path.join(r, 'templates'), { recursive: true });
  return r;
}

function _seedDoctrine(root, opts) {
  const { count } = Object.assign({ count: 12 }, opts || {});
  const headings = [];
  for (let i = 1; i <= count; i += 1) headings.push('### ' + i + '. Rule ' + i + '\n\nText.');
  fs.writeFileSync(
    path.join(root, 'templates', 'COMPLETENESS.md'),
    '# Doctrine\n\n' + headings.join('\n\n') + '\n',
    'utf-8',
  );
}

function _seedAgent(root, name, body) {
  const fm = '---\nname: ' + name + '\ndescription: x\ntier: sonnet\ntools: Read\n---\n';
  fs.writeFileSync(path.join(root, 'agents', name + '.md'), fm + (body || ''), 'utf-8');
}

function _seedWorkflow(root, name, body) {
  fs.writeFileSync(path.join(root, 'workflows', name + '.md'), body || '# ' + name + '\n', 'utf-8');
}

test('CC-1: complete root → no violations', () => {
  const r = _mkRoot();
  try {
    _seedDoctrine(r);
    _seedAgent(r, 'np-foo', '## Completeness Mandate\n\nSee templates/COMPLETENESS.md.\n');
    _seedWorkflow(r, 'foo', '# foo\n\n## Definition of Done\n\nSee templates/COMPLETENESS.md.\n');
    const res = cc.checkAll(r);
    assert.deepEqual(res.violations, []);
    assert.equal(res.exitCode, 0);
  } finally {
    fs.rmSync(r, { recursive: true, force: true });
  }
});

test('CC-2: agent missing Completeness Mandate heading → violation', () => {
  const r = _mkRoot();
  try {
    _seedDoctrine(r);
    _seedAgent(r, 'np-foo', 'No mandate here.\n');
    const v = cc.checkAgents(r);
    assert.equal(v.length, 1);
    assert.equal(v[0].code, 'missing-completeness-mandate');
    assert.ok(v[0].file.endsWith('np-foo.md'));
  } finally {
    fs.rmSync(r, { recursive: true, force: true });
  }
});

test('CC-3: agent has heading but no COMPLETENESS.md link → violation', () => {
  const r = _mkRoot();
  try {
    _seedDoctrine(r);
    _seedAgent(r, 'np-foo', '## Completeness Mandate\n\nThis lacks the link.\n');
    const v = cc.checkAgents(r);
    assert.equal(v.length, 1);
    assert.equal(v[0].code, 'missing-completeness-link');
  } finally {
    fs.rmSync(r, { recursive: true, force: true });
  }
});

test('CC-4: workflow missing Definition of Done heading → violation', () => {
  const r = _mkRoot();
  try {
    _seedDoctrine(r);
    _seedWorkflow(r, 'foo', '# foo\n\nNo DoD.\n');
    const v = cc.checkWorkflows(r);
    assert.equal(v.length, 1);
    assert.equal(v[0].code, 'missing-definition-of-done');
  } finally {
    fs.rmSync(r, { recursive: true, force: true });
  }
});

test('CC-5: workflow has heading but no COMPLETENESS.md link → violation', () => {
  const r = _mkRoot();
  try {
    _seedDoctrine(r);
    _seedWorkflow(r, 'foo', '# foo\n\n## Definition of Done\n\nText only.\n');
    const v = cc.checkWorkflows(r);
    assert.equal(v.length, 1);
    assert.equal(v[0].code, 'missing-completeness-link');
  } finally {
    fs.rmSync(r, { recursive: true, force: true });
  }
});

test('CC-6: doctrine file missing → violation', () => {
  const r = _mkRoot();
  try {
    const v = cc.checkCompletenessFile(r);
    assert.equal(v.length, 1);
    assert.equal(v[0].code, 'missing-completeness-file');
  } finally {
    fs.rmSync(r, { recursive: true, force: true });
  }
});

test('CC-7: doctrine has only 11 rules → drift violation', () => {
  const r = _mkRoot();
  try {
    _seedDoctrine(r, { count: 11 });
    const v = cc.checkCompletenessFile(r);
    assert.equal(v.length, 1);
    assert.equal(v[0].code, 'doctrine-drift');
  } finally {
    fs.rmSync(r, { recursive: true, force: true });
  }
});

test('CC-8: doctrine with skipped numbering (1,2,4,…) → drift', () => {
  const r = _mkRoot();
  try {
    fs.writeFileSync(
      path.join(r, 'templates', 'COMPLETENESS.md'),
      '### 1. A\n\n### 2. B\n\n### 4. C\n\n### 5. D\n\n### 6. E\n\n### 7. F\n\n### 8. G\n\n### 9. H\n\n### 10. I\n\n### 11. J\n\n### 12. K\n\n### 13. L\n',
      'utf-8',
    );
    const v = cc.checkCompletenessFile(r);
    assert.equal(v.length, 1);
    assert.equal(v[0].code, 'doctrine-drift');
  } finally {
    fs.rmSync(r, { recursive: true, force: true });
  }
});

test('CC-9: real nubos-pilot repo passes — every agent + workflow + doctrine compliant', () => {
  const res = cc.checkAll();
  if (res.violations.length) {
    const lines = res.violations
      .map((v) => '  ' + v.file + ' [' + v.code + '] ' + v.message)
      .join('\n');
    assert.fail('Real-tree completeness violations:\n' + lines);
  }
  assert.equal(res.exitCode, 0);
});

test('CC-10: CLI exits 1 on a sandbox missing the doctrine', () => {
  const { spawnSync } = require('node:child_process');
  const r = _mkRoot();
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'check-completeness.cjs'), r], {
      encoding: 'utf-8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /violation/i);
  } finally {
    fs.rmSync(r, { recursive: true, force: true });
  }
});
