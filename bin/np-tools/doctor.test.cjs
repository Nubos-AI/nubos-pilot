const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const doctor = require('./doctor.cjs');
const scanCodebase = require('./scan-codebase.cjs');

const _sandboxes = [];

function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-doc-'));
  fs.mkdirSync(path.join(dir, '.nubos-pilot'), { recursive: true });
  _sandboxes.push(dir);
  return dir;
}

function captureStdout() {
  const chunks = [];
  return {
    stub: { write: (s) => chunks.push(String(s)), end: () => {} },
    json: () => JSON.parse(chunks.join('')),
  };
}

afterEach(() => {
  while (_sandboxes.length) {
    const dir = _sandboxes.pop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('DOC-1: flags codebase-not-scanned when INDEX.md missing', async () => {
  const root = makeSandbox();
  fs.writeFileSync(path.join(root, 'src.js'), 'export {};');
  const cap = captureStdout();
  await doctor.run([], { cwd: root, stdout: cap.stub, stderr: cap.stub, askUser: async () => ({ value: false }) });
  const out = cap.json();
  const ids = out.issues.map((i) => i.id);
  assert.ok(ids.includes('codebase-not-scanned'));
});

test('DOC-2: no codebase issue when scanned and source unchanged', async () => {
  const root = makeSandbox();
  fs.writeFileSync(path.join(root, 'src.js'), 'export function a(){}');
  scanCodebase.run([], { cwd: root, stdout: captureStdout().stub });

  const cap = captureStdout();
  await doctor.run([], { cwd: root, stdout: cap.stub, stderr: cap.stub, askUser: async () => ({ value: false }) });
  const out = cap.json();
  const ids = out.issues.map((i) => i.id);
  assert.ok(!ids.includes('codebase-not-scanned'));
  assert.ok(!ids.includes('codebase-manifest-stale'));
});

test('DOC-3: flags codebase-manifest-stale after source changes', async () => {
  const root = makeSandbox();
  fs.writeFileSync(path.join(root, 'src.js'), 'export function a(){}');
  scanCodebase.run([], { cwd: root, stdout: captureStdout().stub });

  fs.writeFileSync(path.join(root, 'src.js'), 'export function a(){ /* v2 */ }');
  fs.writeFileSync(path.join(root, 'new.js'), 'export function b(){}');

  const cap = captureStdout();
  await doctor.run([], { cwd: root, stdout: cap.stub, stderr: cap.stub, askUser: async () => ({ value: false }) });
  const out = cap.json();
  const stale = out.issues.find((i) => i.id === 'codebase-manifest-stale');
  assert.ok(stale, 'expected codebase-manifest-stale');
  assert.ok(stale.details.changed >= 1);
  assert.ok(stale.details.added >= 1);
});

test('DOC-4: flags codebase-tbd-docs for modules with _TBD Purpose', async () => {
  const root = makeSandbox();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'export function a(){}');
  scanCodebase.run([], { cwd: root, stdout: captureStdout().stub });

  const cap = captureStdout();
  await doctor.run([], { cwd: root, stdout: cap.stub, stderr: cap.stub, askUser: async () => ({ value: false }) });
  const out = cap.json();
  const tbd = out.issues.find((i) => i.id === 'codebase-tbd-docs');
  assert.ok(tbd, 'expected codebase-tbd-docs');
  assert.ok(tbd.details.count >= 1);
});

test('DOC-6: asset manifest keys resolve to project root, not payloadDir', async () => {
  const root = makeSandbox();

  const payloadDir = path.join(root, '.claude', 'nubos-pilot');
  fs.mkdirSync(payloadDir, { recursive: true });
  fs.writeFileSync(path.join(payloadDir, '.manifest.json'), JSON.stringify({
    version: '0.0.0',
    timestamp: new Date().toISOString(),
    files: {
      '.claude/commands/np/foo.md': 'deadbeef',
      '.claude/agents/np-bar.md': 'deadbeef',
    },
  }));
  const cmdDir = path.join(root, '.claude', 'commands', 'np');
  const agentsDir = path.join(root, '.claude', 'agents');
  fs.mkdirSync(cmdDir, { recursive: true });
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(cmdDir, 'foo.md'), 'x');
  fs.writeFileSync(path.join(agentsDir, 'np-bar.md'), 'y');

  const cap = captureStdout();
  await doctor.run([], { cwd: root, stdout: cap.stub, stderr: cap.stub, askUser: async () => ({ value: false }) });
  const out = cap.json();
  const missing = out.issues.filter((i) => i.id === 'payload-missing');
  assert.equal(missing.length, 0,
    'asset keys must resolve to project-root paths (found ' +
    missing.map((m) => m.file).join(', ') + ')');
});

test('DOC-5: no tbd flag after prose applied', async () => {
  const root = makeSandbox();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'export function a(){}');
  scanCodebase.run([], { cwd: root, stdout: captureStdout().stub });

  const proseFile = path.join(root, 'p.json');
  fs.writeFileSync(proseFile, JSON.stringify({
    description: 'A module',
    purpose: 'Provides function a.',
    key_concepts: ['just one thing'],
    public_api: '`a()`',
    invariants: [],
    gotchas: [],
  }));
  scanCodebase.run(['--apply-prose', '--module', 'src', '--prose-file', proseFile], {
    cwd: root, stdout: captureStdout().stub,
  });

  const cap = captureStdout();
  await doctor.run([], { cwd: root, stdout: cap.stub, stderr: cap.stub, askUser: async () => ({ value: false }) });
  const out = cap.json();
  const tbd = out.issues.find((i) => i.id === 'codebase-tbd-docs');
  assert.ok(!tbd, 'expected no codebase-tbd-docs');
});

test('DOC-7: flags nubosloop-knowledge-store-corrupt when JSON is malformed', async () => {
  const root = makeSandbox();
  fs.writeFileSync(path.join(root, 'src.js'), 'export function a(){}');
  scanCodebase.run([], { cwd: root, stdout: captureStdout().stub });
  fs.mkdirSync(path.join(root, '.nubos-pilot', 'knowledge'), { recursive: true });
  fs.writeFileSync(path.join(root, '.nubos-pilot', 'knowledge', 'learnings.json'), 'NOT JSON');

  const cap = captureStdout();
  await doctor.run([], { cwd: root, stdout: cap.stub, stderr: cap.stub, askUser: async () => ({ value: false }) });
  const out = cap.json();
  const ids = out.issues.map((i) => i.id);
  assert.ok(ids.includes('nubosloop-knowledge-store-corrupt'));
});

test('DOC-8: flags nubosloop-knowledge-adapter-invalid for unsupported adapter', async () => {
  const root = makeSandbox();
  fs.writeFileSync(path.join(root, 'src.js'), 'export function a(){}');
  scanCodebase.run([], { cwd: root, stdout: captureStdout().stub });
  fs.writeFileSync(
    path.join(root, '.nubos-pilot', 'config.json'),
    JSON.stringify({ swarm: { knowledge_adapter: 'pinecone' } }),
  );
  const cap = captureStdout();
  await doctor.run([], { cwd: root, stdout: cap.stub, stderr: cap.stub, askUser: async () => ({ value: false }) });
  const out = cap.json();
  const ids = out.issues.map((i) => i.id);
  assert.ok(ids.includes('nubosloop-knowledge-adapter-invalid'));
});

test('DOC-9b: flags config-json-corrupt when config.json is unparseable', async () => {
  const root = makeSandbox();
  fs.writeFileSync(path.join(root, 'src.js'), 'export function a(){}');
  scanCodebase.run([], { cwd: root, stdout: captureStdout().stub });
  fs.writeFileSync(path.join(root, '.nubos-pilot', 'config.json'), '{ not json');
  const cap = captureStdout();
  await doctor.run([], { cwd: root, stdout: cap.stub, stderr: cap.stub, askUser: async () => ({ value: false }) });
  const out = cap.json();
  const issue = out.issues.find((i) => i.id === 'config-json-corrupt');
  assert.ok(issue, 'expected config-json-corrupt issue');
  assert.equal(issue.severity, 'error');
  assert.match(issue.details.hint, /Repair or delete/);
});

test('DOC-9: flags nubosloop-maxRounds-out-of-range when value > 10', async () => {
  const root = makeSandbox();
  fs.writeFileSync(path.join(root, 'src.js'), 'export function a(){}');
  scanCodebase.run([], { cwd: root, stdout: captureStdout().stub });
  fs.writeFileSync(
    path.join(root, '.nubos-pilot', 'config.json'),
    JSON.stringify({ loop: { maxRounds: 99 } }),
  );
  const cap = captureStdout();
  await doctor.run([], { cwd: root, stdout: cap.stub, stderr: cap.stub, askUser: async () => ({ value: false }) });
  const out = cap.json();
  const ids = out.issues.map((i) => i.id);
  assert.ok(ids.includes('nubosloop-maxRounds-out-of-range'));
});

test('DOC-10: clean config produces no nubosloop issues', async () => {
  const root = makeSandbox();
  fs.writeFileSync(path.join(root, 'src.js'), 'export function a(){}');
  scanCodebase.run([], { cwd: root, stdout: captureStdout().stub });
  fs.mkdirSync(path.join(root, '.nubos-pilot', 'knowledge'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.nubos-pilot', 'knowledge', 'learnings.json'),
    JSON.stringify({ version: 1, learnings: [] }),
  );
  fs.writeFileSync(
    path.join(root, '.nubos-pilot', 'config.json'),
    JSON.stringify({ loop: { maxRounds: 3 }, swarm: { knowledge_adapter: 'local' } }),
  );
  const cap = captureStdout();
  await doctor.run([], { cwd: root, stdout: cap.stub, stderr: cap.stub, askUser: async () => ({ value: false }) });
  const out = cap.json();
  const ids = out.issues.map((i) => i.id);
  assert.ok(!ids.some((id) => id.startsWith('nubosloop-knowledge-store-corrupt')));
  assert.ok(!ids.some((id) => id.startsWith('nubosloop-knowledge-adapter-invalid')));
  assert.ok(!ids.some((id) => id.startsWith('nubosloop-maxRounds')));
});

function _driftSandbox(roadmapStatus, metaStatus, scStatus) {
  const root = makeSandbox();
  const mDir = path.join(root, '.nubos-pilot', 'milestones', 'M001');
  fs.mkdirSync(mDir, { recursive: true });
  fs.writeFileSync(
    path.join(root, '.nubos-pilot', 'roadmap.yaml'),
    'schema_version: 2\nmilestones:\n  - id: M001\n    number: 1\n    name: drift\n'
      + '    status: ' + roadmapStatus + '\n    slices: []\n',
    'utf-8',
  );
  if (scStatus) {
    fs.writeFileSync(
      path.join(mDir, 'M001-VERIFICATION.md'),
      '# M001\n\n**Milestone Status:** x\n\n## Success Criteria\n\n### SC-1: works\n'
        + '- **Status:** ' + scStatus + '\n- **Classified by:** np-verifier\n- **Evidence:** abc\n',
      'utf-8',
    );
  }
  if (metaStatus) {
    fs.writeFileSync(
      path.join(mDir, 'M001-META.json'),
      JSON.stringify({ status: metaStatus }),
      'utf-8',
    );
  }
  return root;
}

async function _driftIssues(root) {
  const cap = captureStdout();
  await doctor.run([], { cwd: root, stdout: cap.stub, stderr: cap.stub, askUser: async () => ({ value: false }) });
  return cap.json().issues.filter((i) => i.id === 'milestone-status-drift');
}

test('DOC-DRIFT-1: a verified milestone still sitting on pending is reported from both sources', async () => {
  const drift = await _driftIssues(_driftSandbox('pending', 'verified', 'Pass'));
  const sources = drift.map((i) => i.details.source).sort();
  assert.deepEqual(sources, ['meta', 'verification']);
  for (const i of drift) assert.equal(i.details.roadmap_status, 'pending');
});

test('DOC-DRIFT-2: agreeing sources produce no finding', async () => {
  assert.deepEqual(await _driftIssues(_driftSandbox('verified', 'verified', 'Pass')), []);
});

test('DOC-DRIFT-3: a half-classified milestone on in-progress is not drift', async () => {
  assert.deepEqual(await _driftIssues(_driftSandbox('in-progress', 'in-progress', 'Pending')), []);
});

test('DOC-DRIFT-4: a missing META.json is not treated as drift', async () => {
  assert.deepEqual(await _driftIssues(_driftSandbox('verified', null, 'Pass')), []);
});

function _rollupSandbox(taskStatuses, persistedSliceStatus, withVerification) {
  const root = makeSandbox();
  const sd = path.join(root, '.nubos-pilot');
  const mDir = path.join(sd, 'milestones', 'M001');
  fs.mkdirSync(mDir, { recursive: true });
  const slice = { id: 'S001', name: 'S001', goal: 'g' };
  if (persistedSliceStatus) slice.status = persistedSliceStatus;
  fs.writeFileSync(
    path.join(sd, 'roadmap.yaml'),
    'schema_version: 2\nmilestones:\n  - id: M001\n    number: 1\n    name: r\n'
      + '    status: in-progress\n    slices:\n      - id: S001\n        name: S001\n'
      + (persistedSliceStatus ? '        status: ' + persistedSliceStatus + '\n' : ''),
    'utf-8',
  );
  taskStatuses.forEach((status, i) => {
    const tid = 'T' + String(i + 1).padStart(4, '0');
    const dir = path.join(mDir, 'slices', 'S001', 'tasks', tid);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, tid + '-PLAN.md'),
      '---\ntask: ' + tid + '\nslice: M001-S001\nstatus: ' + status + '\n---\n# ' + tid + '\n',
      'utf-8',
    );
  });
  if (withVerification) {
    fs.writeFileSync(
      path.join(mDir, 'M001-VERIFICATION.md'),
      '# M001\n\n## Success Criteria\n\n### SC-1: x\n- **Status:** Pass\n'
        + '- **Classified by:** np-verifier\n- **Evidence:** e\n',
      'utf-8',
    );
  }
  return root;
}

async function _idsFor(root) {
  const cap = captureStdout();
  await doctor.run([], { cwd: root, stdout: cap.stub, stderr: cap.stub, askUser: async () => ({ value: false }) });
  return cap.json().issues;
}

test('DOC-ROLLUP-1: a slice status behind its tasks is reported as drift', async () => {
  const issues = await _idsFor(_rollupSandbox(['done', 'done'], 'pending', false));
  const drift = issues.filter((i) => i.id === 'slice-status-drift');
  assert.equal(drift.length, 1);
  assert.equal(drift[0].details.persisted_status, 'pending');
  assert.equal(drift[0].details.derived_status, 'done');
});

test('DOC-ROLLUP-2: an up-to-date slice status is not drift', async () => {
  const issues = await _idsFor(_rollupSandbox(['done', 'done'], 'done', true));
  assert.deepEqual(issues.filter((i) => i.id === 'slice-status-drift'), []);
});

test('DOC-ROLLUP-3: all slices done without VERIFICATION.md flags readiness', async () => {
  const issues = await _idsFor(_rollupSandbox(['done', 'done'], 'done', false));
  const ready = issues.filter((i) => i.id === 'milestone-ready-for-verification');
  assert.equal(ready.length, 1);
  assert.equal(ready[0].details.milestone, 'M001');
});

test('DOC-ROLLUP-4: readiness clears once VERIFICATION.md exists', async () => {
  const issues = await _idsFor(_rollupSandbox(['done', 'done'], 'done', true));
  assert.deepEqual(issues.filter((i) => i.id === 'milestone-ready-for-verification'), []);
});

test('DOC-ROLLUP-5: unfinished work is neither drift nor ready', async () => {
  const issues = await _idsFor(_rollupSandbox(['done', 'pending'], 'in-progress', false));
  assert.deepEqual(issues.filter((i) => i.id === 'slice-status-drift'), []);
  assert.deepEqual(issues.filter((i) => i.id === 'milestone-ready-for-verification'), []);
});

test('DOC-ROLLUP-6: a fully parked slice is surfaced', async () => {
  const issues = await _idsFor(_rollupSandbox(['parked', 'parked'], 'in-progress', false));
  const parked = issues.filter((i) => i.id === 'slice-fully-parked');
  assert.equal(parked.length, 1);
  assert.equal(parked[0].details.slice, 'S001');
});

test('DOC-ROLLUP-7: an unreadable task plan is surfaced and blocks readiness', async () => {
  const root = _rollupSandbox(['done', 'done'], 'done', false);
  fs.rmSync(path.join(
    root, '.nubos-pilot', 'milestones', 'M001', 'slices', 'S001', 'tasks', 'T0002', 'T0002-PLAN.md',
  ));
  const issues = await _idsFor(root);
  assert.equal(issues.filter((i) => i.id === 'task-plan-unreadable').length, 1);
  assert.deepEqual(
    issues.filter((i) => i.id === 'milestone-ready-for-verification'),
    [],
    'a slice with an unreadable plan must not report as verification-ready',
  );
});

test('DOC-ROLLUP-8: a terminal milestone with reopened work is surfaced', async () => {
  const root = _rollupSandbox(['done', 'pending'], 'in-progress', true);
  const yamlPath = path.join(root, '.nubos-pilot', 'roadmap.yaml');
  fs.writeFileSync(yamlPath, fs.readFileSync(yamlPath, 'utf-8').replace('status: in-progress', 'status: verified'), 'utf-8');

  const issues = await _idsFor(root);
  const stale = issues.filter((i) => i.id === 'milestone-terminal-with-open-work');
  assert.equal(stale.length, 1);
  assert.equal(stale[0].details.milestone_status, 'verified');
});

test('DOC-ROLLUP-9: meta drift on reopened work points at rollup, not sync-roadmap', async () => {
  const root = _rollupSandbox(['done', 'pending'], 'in-progress', true);
  fs.writeFileSync(
    path.join(root, '.nubos-pilot', 'milestones', 'M001', 'M001-META.json'),
    JSON.stringify({ status: 'verified' }),
    'utf-8',
  );
  const drift = (await _idsFor(root)).filter((i) => i.id === 'milestone-status-drift' && i.details.source === 'meta');
  assert.equal(drift.length, 1);
  assert.match(drift[0].details.hint, /np-tools rollup/);
  assert.match(drift[0].details.hint, /Do NOT run `verify-work sync-roadmap`/);
});

test('DOC-ROLLUP-10: ordinary meta drift still points at sync-roadmap', async () => {
  const root = _rollupSandbox(['done', 'done'], 'done', true);
  fs.writeFileSync(
    path.join(root, '.nubos-pilot', 'milestones', 'M001', 'M001-META.json'),
    JSON.stringify({ status: 'pending' }),
    'utf-8',
  );
  const drift = (await _idsFor(root)).filter((i) => i.id === 'milestone-status-drift' && i.details.source === 'meta');
  assert.equal(drift.length, 1);
  assert.match(drift[0].details.hint, /verify-work sync-roadmap/);
});

function seedRoadmap(root, milestones) {
  fs.writeFileSync(
    path.join(root, '.nubos-pilot', 'roadmap.yaml'),
    'schema_version: 3\nmilestones:\n' + milestones.map((m) => [
      '  - id: ' + m.id,
      '    number: ' + m.number,
      '    name: ' + (m.name || m.id),
      '    goal: ships things',
      '    status: ' + (m.status || 'pending'),
      '    requirements: [' + (m.requirements || []).join(', ') + ']',
      '    success_criteria: []',
      '    slices: []',
    ].join('\n')).join('\n') + '\n',
  );
}

function seedRequirements(root, ids) {
  fs.writeFileSync(
    path.join(root, '.nubos-pilot', 'REQUIREMENTS.md'),
    '# Requirements\n\n## Active\n\n' + ids.map((id) => '- [ ] **' + id + '**: does a thing').join('\n') + '\n',
  );
}

async function auditIds(root) {
  const cap = captureStdout();
  await doctor.run([], { cwd: root, stdout: cap.stub, stderr: cap.stub, askUser: async () => ({ value: false }) });
  const out = cap.json();
  return { ids: out.issues.map((i) => i.id), issues: out.issues, ok: out.ok };
}

test('DOC-REQ-1 a milestone with no requirement ids is flagged', async () => {
  const root = makeSandbox();
  seedRequirements(root, ['REQ-01', 'REQ-02']);
  seedRoadmap(root, [{ id: 'M001', number: 1, requirements: [] }]);
  const { ids, issues } = await auditIds(root);
  assert.ok(ids.includes('milestone-without-requirements'));
  const issue = issues.find((i) => i.id === 'milestone-without-requirements');
  assert.equal(issue.details.milestone, 'M001');
  assert.match(issue.details.reason, /audit zero requirements/);
  assert.ok(issue.details.known_ids.includes('REQ-01'), 'the hint must name the ids that exist');
});

test('DOC-REQ-2 a milestone with resolvable ids is not flagged', async () => {
  const root = makeSandbox();
  seedRequirements(root, ['REQ-01', 'REQ-02']);
  seedRoadmap(root, [{ id: 'M001', number: 1, requirements: ['REQ-01', 'REQ-02'] }]);
  const { ids } = await auditIds(root);
  assert.ok(!ids.includes('milestone-without-requirements'));
  assert.ok(!ids.includes('milestone-requirements-unresolved'));
  assert.ok(!ids.includes('requirements-unassigned'));
});

test('DOC-REQ-3 an id that does not exist in REQUIREMENTS.md is reported', async () => {
  const root = makeSandbox();
  seedRequirements(root, ['REQ-01']);
  seedRoadmap(root, [{ id: 'M001', number: 1, requirements: ['REQ-01', 'GHOST-99'] }]);
  const { ids, issues } = await auditIds(root);
  assert.ok(ids.includes('milestone-requirements-unresolved'));
  assert.deepEqual(issues.find((i) => i.id === 'milestone-requirements-unresolved').details.unknown, ['GHOST-99']);
});

test('DOC-REQ-4 a requirement no milestone claims is reported as info', async () => {
  const root = makeSandbox();
  seedRequirements(root, ['REQ-01', 'REQ-02', 'REQ-03']);
  seedRoadmap(root, [{ id: 'M001', number: 1, requirements: ['REQ-01'] }]);
  const { ids, issues } = await auditIds(root);
  const issue = issues.find((i) => i.id === 'requirements-unassigned');
  assert.ok(issue);
  assert.equal(issue.severity, 'info');
  assert.deepEqual(issue.details.ids, ['REQ-02', 'REQ-03']);
});

test('DOC-REQ-5 a done milestone is not nagged about missing requirements', async () => {
  const root = makeSandbox();
  seedRequirements(root, ['REQ-01']);
  seedRoadmap(root, [
    { id: 'M001', number: 1, status: 'done', requirements: [] },
    { id: 'M002', number: 2, requirements: ['REQ-01'] },
  ]);
  const { ids } = await auditIds(root);
  assert.ok(!ids.includes('milestone-without-requirements'));
});

test('DOC-REQ-6 the requirement checks never gate the exit code', async () => {
  const root = makeSandbox();
  seedRequirements(root, ['REQ-01']);
  seedRoadmap(root, [{ id: 'M001', number: 1, requirements: [] }]);
  const { issues } = await auditIds(root);
  for (const issue of issues.filter((i) => /requirement/.test(i.id))) {
    assert.notEqual(issue.severity, 'error', issue.id + ' must not be error-severity');
  }
});

test('DOC-REQ-7 a project without REQUIREMENTS.md is not nagged', async () => {
  const root = makeSandbox();
  seedRoadmap(root, [{ id: 'M001', number: 1, requirements: [] }]);
  const { ids } = await auditIds(root);
  assert.ok(!ids.includes('milestone-without-requirements'));
  assert.ok(!ids.includes('requirements-unassigned'));
});

const advisoryDb = require('../../lib/scan/advisory/db.cjs');
const advisoryCompact = require('../../scripts/advisory-compact.cjs');
const advisoryBuilder = require('../../scripts/build-advisory-db.cjs');

const ADB_GENERATED_AT = '2026-02-01T00:00:00.000Z';
const ADB_NOW = Date.parse('2026-03-01T00:00:00.000Z');
const ADB_PACKAGE_DIR = path.join(__dirname, '..', '..', 'lib', 'scan', 'data');

function advisoryStore(generatedAt) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-doc-adb-'));
  _sandboxes.push(dir);
  const built = advisoryCompact.buildShards([
    {
      id: 'GHSA-doc-0001',
      summary: 'prototype pollution',
      aliases: ['CVE-2026-0001'],
      affected: [{
        package: { ecosystem: 'npm', name: 'lodash' },
        ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.17.21' }] }],
      }],
    },
    {
      id: 'MAL-2026-0001',
      summary: 'malicious code execution',
      affected: [{ package: { ecosystem: 'npm', name: 'evil-pkg' }, versions: ['1.0.0'] }],
    },
  ]);
  advisoryBuilder.writeShards(dir, built, {
    generatedAt: generatedAt || ADB_GENERATED_AT,
    toolVersion: '1.5.0',
    feeds: [{ eco: 'npm', license: 'CC-BY-4.0' }],
  });
  advisoryDb._clearCache();
  return dir;
}

function healthySandbox() {
  const root = makeSandbox();
  const manifestMod = require('../../lib/install/manifest.cjs');
  manifestMod.writeManifest(path.join(root, '.claude', 'nubos-pilot'), {
    version: require('../../package.json').version,
    timestamp: new Date().toISOString(),
    files: {},
  });
  return root;
}

function withoutAdvisoryEnv(fn) {
  const saved = process.env[advisoryDb.ENV_DB_DIR];
  delete process.env[advisoryDb.ENV_DB_DIR];
  try { return fn(); }
  finally {
    if (saved === undefined) delete process.env[advisoryDb.ENV_DB_DIR];
    else process.env[advisoryDb.ENV_DB_DIR] = saved;
  }
}

async function advisoryAudit(root, advisory, now) {
  const cap = captureStdout();
  await doctor.run([], {
    cwd: root,
    stdout: cap.stub,
    stderr: cap.stub,
    askUser: async () => ({ value: false }),
    now: now === undefined ? ADB_NOW : now,
    advisoryDb: advisory,
  });
  const out = cap.json();
  return { ids: out.issues.map((i) => i.id), issues: out.issues, ok: out.ok };
}

test('DOC-ADB-1 an intact advisory snapshot produces no finding and keeps ok true', async () => {
  const root = healthySandbox();
  const dir = advisoryStore();
  const { ids, ok } = await advisoryAudit(root, { dir });
  assert.deepEqual(ids.filter((id) => id.startsWith('advisory-db-')), []);
  assert.equal(ok, true, 'an intact store must not gate the exit code');
});

test('DOC-ADB-2 a flipped byte in a shard is an error-severity advisory-db-tampered', async () => {
  const root = healthySandbox();
  const dir = advisoryStore();
  const shard = path.join(dir, 'vuln-npm.json.gz');
  const bytes = fs.readFileSync(shard);
  bytes[bytes.length - 1] ^= 0xff;
  fs.writeFileSync(shard, bytes);

  const { issues, ok } = await advisoryAudit(root, { dir });
  const hit = issues.find((i) => i.id === 'advisory-db-tampered');
  assert.ok(hit, 'a modified shard must be reported');
  assert.equal(hit.severity, 'error');
  assert.deepEqual(hit.details.shards, ['vuln-npm.json.gz']);
  assert.equal(ok, false, 'a tampered store must gate the exit code');
});

test('DOC-ADB-3 a shard listed in the manifest but absent from disk is advisory-db-incomplete', async () => {
  const root = healthySandbox();
  const dir = advisoryStore();
  fs.rmSync(path.join(dir, 'malicious-npm.txt.gz'));

  const { issues, ok } = await advisoryAudit(root, { dir });
  const hit = issues.find((i) => i.id === 'advisory-db-incomplete');
  assert.ok(hit, 'a missing shard must be reported');
  assert.equal(hit.severity, 'warn');
  assert.deepEqual(hit.details.shards, ['malicious-npm.txt.gz']);
  assert.equal(ok, true, 'an incomplete store is advisory, not fatal');
});

test('DOC-ADB-4 an absent snapshot is advisory-db-missing at info and keeps ok true', async (t) => {
  if (fs.existsSync(ADB_PACKAGE_DIR)) {
    t.skip('this checkout carries a built lib/scan/data snapshot, so nothing is absent');
    return;
  }
  const root = healthySandbox();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'np-doc-adb-home-'));
  _sandboxes.push(home);
  const { issues, ok } = await withoutAdvisoryEnv(
    () => advisoryAudit(root, { dir: path.join(home, 'absent'), homedir: home }),
  );
  const hit = issues.find((i) => i.id === 'advisory-db-missing');
  assert.ok(hit, 'an absent snapshot must be reported as a capability gap');
  assert.equal(hit.severity, 'info');
  assert.ok(hit.details.expected.includes('advisory-db'),
    'the finding must name the shared cache path, got ' + hit.details.expected);
  assert.equal(ok, true, 'a missing snapshot must never gate the exit code');
});

test('DOC-ADB-5 an unreadable manifest is advisory-db-unreadable at warn', async () => {
  const root = healthySandbox();
  const dir = advisoryStore();
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'));
  manifest.schema_version = 99;
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));

  const { issues, ok } = await advisoryAudit(root, { dir });
  const hit = issues.find((i) => i.id === 'advisory-db-unreadable');
  assert.ok(hit, 'a schema mismatch must be reported');
  assert.equal(hit.severity, 'warn');
  assert.equal(hit.details.cause, 'advisory-schema-mismatch');
  assert.equal(ok, true);
});

test('DOC-ADB-6 a snapshot older than 90 days is advisory-db-stale with its age', async () => {
  const root = healthySandbox();
  const dir = advisoryStore();
  const now = Date.parse(ADB_GENERATED_AT) + (200 * 24 * 60 * 60 * 1000);
  const { issues } = await advisoryAudit(root, { dir }, now);
  const hit = issues.find((i) => i.id === 'advisory-db-stale');
  assert.ok(hit, 'a 200-day-old snapshot must be flagged');
  assert.equal(hit.severity, 'info');
  assert.equal(hit.details.age_days, 200);
  assert.equal(hit.details.generated_at, ADB_GENERATED_AT);
});

test('DOC-ADB-7 a snapshot inside the freshness window is not flagged stale', async () => {
  const root = healthySandbox();
  const dir = advisoryStore();
  const now = Date.parse(ADB_GENERATED_AT) + (89 * 24 * 60 * 60 * 1000);
  const { ids } = await advisoryAudit(root, { dir }, now);
  assert.ok(!ids.includes('advisory-db-stale'));
});
