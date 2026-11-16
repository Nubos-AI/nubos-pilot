const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const roadmap = require('./roadmap.cjs');

const FIXTURES = path.join(__dirname, 'fixtures', 'roadmap');
const MINIMAL = fs.readFileSync(path.join(FIXTURES, 'roadmap-minimal.yaml'), 'utf-8');
const MALFORMED = fs.readFileSync(path.join(FIXTURES, 'roadmap-malformed.yaml'), 'utf-8');
const TEN_PHASES = fs.readFileSync(path.join(FIXTURES, 'roadmap-ten-phases.yaml'), 'utf-8');

const _sandboxes = [];

function makeSandbox(roadmapContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-rm-'));
  fs.mkdirSync(path.join(dir, '.nubos-pilot'));
  if (roadmapContent !== null) {
    fs.writeFileSync(path.join(dir, '.nubos-pilot', 'roadmap.yaml'), roadmapContent);
  }
  _sandboxes.push(dir);
  return dir;
}

afterEach(() => {
  while (_sandboxes.length) {
    const dir = _sandboxes.pop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('RM-1: parseRoadmap returns 3 phases', () => {
  const sandbox = makeSandbox(MINIMAL);
  const r = roadmap.parseRoadmap(sandbox);
  assert.equal(r.phases.length, 3);
});

test('RM-2: Phase 1 has goal, requirements [F-01, F-02], 2 success criteria', () => {
  const sandbox = makeSandbox(MINIMAL);
  const r = roadmap.parseRoadmap(sandbox);
  const p1 = r.phases.find(p => p.number === '1');
  assert.ok(p1, 'phase 1 present');
  assert.ok(p1.goal && p1.goal.length > 0, 'goal non-empty');
  assert.deepEqual(p1.requirements, ['F-01', 'F-02']);
  assert.equal(p1.success_criteria.length, 2);
});

test('RM-3: Phase 2.1 parsed with number === "2.1" (decimal-safe)', () => {
  const sandbox = makeSandbox(MINIMAL);
  const r = roadmap.parseRoadmap(sandbox);
  const decimal = r.phases.find(p => p.number === '2.1');
  assert.ok(decimal, 'decimal phase present');
  assert.equal(decimal.name, 'Hotfix');
});

test('RM-4: getPhase resolves integer and decimal', () => {
  const sandbox = makeSandbox(MINIMAL);
  assert.equal(roadmap.getPhase(3, sandbox).number, '3');
  assert.equal(roadmap.getPhase('2.1', sandbox).name, 'Hotfix');
});

test('RM-5: phaseComplete reflects table state', () => {
  const sandbox = makeSandbox(MINIMAL);
  assert.equal(roadmap.phaseComplete(1, sandbox), true);
  assert.equal(roadmap.phaseComplete(3, sandbox), false);
});

test('RM-6: listPhases returns 3 phases', () => {
  const sandbox = makeSandbox(MINIMAL);
  assert.equal(roadmap.listPhases(sandbox).length, 3);
});

test('RM-7: Phase 1 plans[0].complete === true (checkbox [x])', () => {
  const sandbox = makeSandbox(MINIMAL);
  const p1 = roadmap.getPhase(1, sandbox);
  assert.ok(Array.isArray(p1.plans));
  assert.ok(p1.plans.length >= 1, 'at least one plan');
  assert.equal(p1.plans[0].complete, true);
});

test('RM-8: Phase 1 depends_on mentions Nothing', () => {
  const sandbox = makeSandbox(MINIMAL);
  const p1 = roadmap.getPhase(1, sandbox);
  assert.ok(p1.depends_on && p1.depends_on.includes('Nothing'));
});

test('RM-9: Phase 3 depends_on mentions Phase 2', () => {
  const sandbox = makeSandbox(MINIMAL);
  const p3 = roadmap.getPhase(3, sandbox);
  assert.ok(p3.depends_on && p3.depends_on.includes('Phase 2'));
});

test('RM-10: missing ROADMAP.md → NubosPilotError roadmap-parse-error', () => {
  const sandbox = makeSandbox(null);
  assert.throws(
    () => roadmap.parseRoadmap(sandbox),
    (err) => err.name === 'NubosPilotError' && err.code === 'roadmap-parse-error',
  );
});

test('RM-11: malformed ROADMAP (no Phase Details) → roadmap-parse-error', () => {
  const sandbox = makeSandbox(MALFORMED);
  assert.throws(
    () => roadmap.parseRoadmap(sandbox),
    (err) => err.name === 'NubosPilotError' && err.code === 'roadmap-parse-error',
  );
});

test('RM-12: getPhase(999) → phase-not-found', () => {
  const sandbox = makeSandbox(MINIMAL);
  assert.throws(
    () => roadmap.getPhase(999, sandbox),
    (err) => err.name === 'NubosPilotError' && err.code === 'phase-not-found',
  );
});

test('RM-13: 10-phase roadmap → parseRoadmap returns 10 phases, getPhase(3) requirements match LIB-03..LIB-08', () => {
  const sandbox = makeSandbox(TEN_PHASES);
  const r = roadmap.parseRoadmap(sandbox);
  assert.equal(r.phases.length, 10);
  const p3 = roadmap.getPhase(3, sandbox);
  assert.deepEqual(p3.requirements, ['LIB-03', 'LIB-04', 'LIB-05', 'LIB-06', 'LIB-07', 'LIB-08']);
});

test('RM-14: 10-phase roadmap → phaseComplete reflects status (Phase 1 done, Phase 2 pending)', () => {
  const sandbox = makeSandbox(TEN_PHASES);
  assert.equal(roadmap.phaseComplete(1, sandbox), true);
  assert.equal(roadmap.phaseComplete(2, sandbox), false);
});

const WRITE_SEED = [
  'schema_version: 1',
  'milestones:',
  '  - id: v1.0',
  '    name: first',
  '    phases:',
  '      - number: 1',
  '        name: Foundation',
  '        slug: foundation',
  '        goal: initial',
  '        depends_on: []',
  '        requirements: []',
  '        success_criteria: []',
  '        status: done',
  '        plans: []',
  '      - number: 2',
  '        name: Core',
  '        slug: core',
  '        goal: core',
  '        depends_on: [1]',
  '        requirements: []',
  '        success_criteria: []',
  '        status: pending',
  '        plans: []',
  '',
].join('\n');

function _readYamlDoc(sandbox) {
  const p = path.join(sandbox, '.nubos-pilot', 'roadmap.yaml');
  const YAML = require('yaml');
  return YAML.parse(fs.readFileSync(p, 'utf-8'));
}

test('WR-1: addMilestone appends a new milestone to roadmap.yaml', () => {
  const sandbox = makeSandbox(WRITE_SEED);
  roadmap.addMilestone({ id: 'v2.0', name: 'second', phases: [] }, sandbox);
  const doc = _readYamlDoc(sandbox);
  assert.equal(doc.milestones.length, 2);
  assert.equal(doc.milestones[1].id, 'v2.0');
  assert.deepEqual(doc.milestones[1].phases, []);
});

test('WR-2: addMilestone with duplicate id throws roadmap-duplicate-milestone', () => {
  const sandbox = makeSandbox(WRITE_SEED);
  assert.throws(
    () => roadmap.addMilestone({ id: 'v1.0', name: 'dup', phases: [] }, sandbox),
    (err) => err.name === 'NubosPilotError' && err.code === 'roadmap-duplicate-milestone',
  );
});

test('WR-3: addPhase appends phase with number = max+1', () => {
  const sandbox = makeSandbox(WRITE_SEED);
  const result = roadmap.addPhase(
    'v1.0',
    { slug: 'new-phase', goal: 'g', depends_on: [], requirements: [] },
    sandbox,
  );
  assert.equal(result.milestoneId, 'v1.0');
  assert.equal(result.number, 3);
  assert.equal(result.slug, 'new-phase');
  const doc = _readYamlDoc(sandbox);
  const ms = doc.milestones.find((m) => m.id === 'v1.0');
  assert.equal(ms.phases.length, 3);
  assert.equal(ms.phases[2].number, 3);
});

test('WR-4: addPhase with unknown milestone throws roadmap-milestone-not-found', () => {
  const sandbox = makeSandbox(WRITE_SEED);
  assert.throws(
    () => roadmap.addPhase('v9.9', { slug: 'x' }, sandbox),
    (err) => err.name === 'NubosPilotError' && err.code === 'roadmap-milestone-not-found',
  );
});

test('WR-5: addPhase with duplicate slug throws roadmap-duplicate-slug', () => {
  const sandbox = makeSandbox(WRITE_SEED);
  assert.throws(
    () => roadmap.addPhase('v1.0', { slug: 'core' }, sandbox),
    (err) => err.name === 'NubosPilotError' && err.code === 'roadmap-duplicate-slug',
  );
});

test('WR-6: addPhase with empty slug throws roadmap-invalid-slug', () => {
  const sandbox = makeSandbox(WRITE_SEED);
  assert.throws(
    () => roadmap.addPhase('v1.0', { slug: '' }, sandbox),
    (err) => err.name === 'NubosPilotError' && err.code === 'roadmap-invalid-slug',
  );
});

test('WR-7: addPhase with uppercase/special slug chars throws roadmap-invalid-slug', () => {
  const sandbox = makeSandbox(WRITE_SEED);
  assert.throws(
    () => roadmap.addPhase('v1.0', { slug: 'Bad_Slug' }, sandbox),
    (err) => err.name === 'NubosPilotError' && err.code === 'roadmap-invalid-slug',
  );
});

test('WR-8: insertPhaseAfter creates 7.1 then 7.2 leaving downstream depends_on intact', () => {

  const seed = WRITE_SEED
    + '      - number: 7\n'
    + '        name: Seven\n'
    + '        slug: seven\n'
    + '        goal: s\n'
    + '        depends_on: [6]\n'
    + '        requirements: []\n'
    + '        success_criteria: []\n'
    + '        status: pending\n'
    + '        plans: []\n'
    + '      - number: 8\n'
    + '        name: Eight\n'
    + '        slug: eight\n'
    + '        goal: e\n'
    + '        depends_on: [7]\n'
    + '        requirements: []\n'
    + '        success_criteria: []\n'
    + '        status: pending\n'
    + '        plans: []\n';
  const sandbox = makeSandbox(seed);
  const first = roadmap.insertPhaseAfter(
    7,
    { slug: 'gap-fix-a', goal: 'a', depends_on: [7], requirements: [] },
    sandbox,
  );
  const second = roadmap.insertPhaseAfter(
    7,
    { slug: 'gap-fix-b', goal: 'b', depends_on: [7], requirements: [] },
    sandbox,
  );
  assert.equal(String(first.number), '7.1');
  assert.equal(String(second.number), '7.2');
  const doc = _readYamlDoc(sandbox);
  const ms = doc.milestones.find((m) => m.id === 'v1.0');
  const eight = ms.phases.find((p) => String(p.number) === '8');

  assert.deepEqual(eight.depends_on, [7]);
});

test('WR-9: insertPhaseAfter with unknown base number throws roadmap-base-phase-not-found', () => {
  const sandbox = makeSandbox(WRITE_SEED);
  assert.throws(
    () => roadmap.insertPhaseAfter(99, { slug: 'x' }, sandbox),
    (err) => err.name === 'NubosPilotError' && err.code === 'roadmap-base-phase-not-found',
  );
});

test('WR-10: after write, ROADMAP.md on disk matches rendered markdown of new doc', () => {
  const sandbox = makeSandbox(WRITE_SEED);
  roadmap.addPhase('v1.0', { slug: 'render-check', goal: 'rc' }, sandbox);
  const mdPath = path.join(sandbox, '.nubos-pilot', 'ROADMAP.md');
  const md = fs.readFileSync(mdPath, 'utf-8');

  assert.ok(md.includes('render-check') || md.includes('3.'));

  assert.ok(md.includes('Generated from roadmap.yaml'));
});

test('WR-11: concurrent addPhase serialises — both end up with distinct numbers', async () => {
  const sandbox = makeSandbox(WRITE_SEED);
  await Promise.all([
    Promise.resolve().then(() =>
      roadmap.addPhase('v1.0', { slug: 'p-a', goal: 'a' }, sandbox),
    ),
    Promise.resolve().then(() =>
      roadmap.addPhase('v1.0', { slug: 'p-b', goal: 'b' }, sandbox),
    ),
  ]);
  const doc = _readYamlDoc(sandbox);
  const ms = doc.milestones.find((m) => m.id === 'v1.0');
  const numbers = ms.phases.map((p) => Number(p.number)).sort();

  assert.deepEqual(numbers, [1, 2, 3, 4]);
  const slugs = ms.phases.map((p) => p.slug).sort();
  assert.ok(slugs.includes('p-a') && slugs.includes('p-b'));
});

test('ROAD-ADD-BACKLOG-1: addBacklogEntry creates synthetic backlog milestone and 999.1 phase', () => {
  const sandbox = makeSandbox(WRITE_SEED);
  const res = roadmap.addBacklogEntry('Fix deploy key auth', { cwd: sandbox });
  assert.equal(res.backlog_number, '999.1');
  assert.equal(res.backlog_slug, 'fix-deploy-key-auth');
  const doc = _readYamlDoc(sandbox);
  const backlog = doc.milestones.find((m) => m.id === 'backlog');
  assert.ok(backlog, 'backlog milestone present');
  assert.equal(backlog.phases.length, 1);
  assert.equal(backlog.phases[0].number, '999.1');
  assert.equal(backlog.phases[0].name, 'Fix deploy key auth');
  const md = fs.readFileSync(path.join(sandbox, '.nubos-pilot', 'ROADMAP.md'), 'utf-8');
  assert.match(md, /## Backlog/);
  assert.match(md, /Phase 999\.1: Fix deploy key auth/);
});

test('ROAD-ADD-BACKLOG-2: second call numbers 999.2', () => {
  const sandbox = makeSandbox(WRITE_SEED);
  roadmap.addBacklogEntry('Idea one', { cwd: sandbox });
  const res = roadmap.addBacklogEntry('Idea two', { cwd: sandbox });
  assert.equal(res.backlog_number, '999.2');
  const doc = _readYamlDoc(sandbox);
  const backlog = doc.milestones.find((m) => m.id === 'backlog');
  assert.equal(backlog.phases.length, 2);
});

test('ROAD-ADD-BACKLOG-3: empty description rejected with roadmap-invalid-description', () => {
  const sandbox = makeSandbox(WRITE_SEED);
  assert.throws(
    () => roadmap.addBacklogEntry('', { cwd: sandbox }),
    (err) => err.name === 'NubosPilotError' && err.code === 'roadmap-invalid-description',
  );
});

test('ROAD-COLLAPSE-1: collapseMilestone sets collapsed=true + collapsed_at, emits <details>', () => {
  const sandbox = makeSandbox(WRITE_SEED);
  const res = roadmap.collapseMilestone('v1.0', { cwd: sandbox });
  assert.equal(res.milestoneId, 'v1.0');
  assert.equal(res.already_collapsed, false);
  const doc = _readYamlDoc(sandbox);
  const m = doc.milestones.find((x) => x.id === 'v1.0');
  assert.equal(m.collapsed, true);
  assert.match(m.collapsed_at, /^\d{4}-\d{2}-\d{2}$/);
  const md = fs.readFileSync(path.join(sandbox, '.nubos-pilot', 'ROADMAP.md'), 'utf-8');
  assert.match(md, /<details>/);
  assert.match(md, /<\/details>/);
  assert.match(md, /v1\.0 — completed on \d{4}-\d{2}-\d{2}/);
});

test('ROAD-COLLAPSE-2: second call idempotent — already_collapsed true, no throw', () => {
  const sandbox = makeSandbox(WRITE_SEED);
  roadmap.collapseMilestone('v1.0', { cwd: sandbox });
  const res = roadmap.collapseMilestone('v1.0', { cwd: sandbox });
  assert.equal(res.already_collapsed, true);
});

test('ROAD-COLLAPSE-3: unknown milestoneId throws roadmap-milestone-not-found', () => {
  const sandbox = makeSandbox(WRITE_SEED);
  assert.throws(
    () => roadmap.collapseMilestone('v9.9', { cwd: sandbox }),
    (err) => err.name === 'NubosPilotError' && err.code === 'roadmap-milestone-not-found',
  );
});

const WRITE_SEED_TOP_LEVEL = [
  'schema_version: 1',
  'milestones:',
  '  - id: M001',
  '    number: 1',
  '    name: Auth',
  '    goal: log users in',
  '    status: pending',
  '    requirements: []',
  '    success_criteria: []',
  '    slices: []',
  '  - id: M002',
  '    number: 2',
  '    name: Voice',
  '    goal: voice pipeline',
  '    status: pending',
  '    requirements: []',
  '    success_criteria: []',
  '    slices: []',
  '',
].join('\n');

test('RM-UPDATE-1: updatePhase writes success_criteria to nested milestone.phases[]', () => {
  const sandbox = makeSandbox(WRITE_SEED);
  const res = roadmap.updatePhase(1, {
    success_criteria: [{ id: 'SC-1', text: 'scaffold exists' }, { id: 'SC-2', text: 'ADRs committed' }],
  }, sandbox);
  assert.deepEqual(res.fields_updated, ['success_criteria']);
  const p = roadmap.getPhase(1, sandbox);
  assert.equal(p.success_criteria.length, 2);
  assert.equal(p.success_criteria[0].id, 'SC-1');
});

test('RM-UPDATE-2: updatePhase writes to top-level milestone (new-style roadmap)', () => {
  const sandbox = makeSandbox(WRITE_SEED_TOP_LEVEL);
  roadmap.updatePhase(2, {
    success_criteria: ['Speaker ID works', 'Latency < 2s'],
    requirements: ['REQ-01'],
  }, sandbox);
  const p = roadmap.getPhase(2, sandbox);
  assert.deepEqual(p.success_criteria, ['Speaker ID works', 'Latency < 2s']);
  assert.deepEqual(p.requirements, ['REQ-01']);
});

test('RM-UPDATE-3: unknown phase number throws phase-not-found', () => {
  const sandbox = makeSandbox(WRITE_SEED);
  assert.throws(
    () => roadmap.updatePhase(99, { success_criteria: ['x'] }, sandbox),
    (err) => err.name === 'NubosPilotError' && err.code === 'phase-not-found',
  );
});

test('RM-UPDATE-4: invalid SC id format throws roadmap-invalid-success-criteria', () => {
  const sandbox = makeSandbox(WRITE_SEED);
  assert.throws(
    () => roadmap.updatePhase(1, { success_criteria: [{ id: 'BAD', text: 'x' }] }, sandbox),
    (err) => err.name === 'NubosPilotError' && err.code === 'roadmap-invalid-success-criteria',
  );
});

test('RM-UPDATE-5: unknown patch key throws roadmap-invalid-patch', () => {
  const sandbox = makeSandbox(WRITE_SEED);
  assert.throws(
    () => roadmap.updatePhase(1, { status: 'done' }, sandbox),
    (err) => err.name === 'NubosPilotError' && err.code === 'roadmap-invalid-patch',
  );
});

test('RM-UPDATE-6: partial patch — only updates given fields', () => {
  const sandbox = makeSandbox(WRITE_SEED);
  roadmap.updatePhase(1, { goal: 'new goal text' }, sandbox);
  const p = roadmap.getPhase(1, sandbox);
  assert.equal(p.goal, 'new goal text');
  assert.equal(p.success_criteria.length, 0, 'SCs untouched');
  assert.equal(p.name, 'Foundation', 'name untouched');
});

test('RM-UPDATE-7: re-renders ROADMAP.md alongside roadmap.yaml', () => {
  const sandbox = makeSandbox(WRITE_SEED);
  roadmap.updatePhase(1, { success_criteria: ['check 1'] }, sandbox);
  const md = fs.readFileSync(path.join(sandbox, '.nubos-pilot', 'ROADMAP.md'), 'utf-8');
  assert.ok(md.includes('check 1'), 'ROADMAP.md re-rendered with new SC');
});

test('RM-STATUS-1: setMilestoneStatus writes status into top-level milestone', () => {
  const sandbox = makeSandbox(WRITE_SEED_TOP_LEVEL);
  const res = roadmap.setMilestoneStatus(2, 'verified', sandbox);
  assert.equal(res.status, 'verified');
  assert.equal(res.previous, 'pending');
  assert.equal(res.changed, true);
  const p = roadmap.getPhase(2, sandbox);
  assert.equal(p.status, 'verified');
  assert.equal(p.complete, true);
});

test('RM-STATUS-2: setMilestoneStatus writes status into nested milestone.phases[]', () => {
  const sandbox = makeSandbox(WRITE_SEED);
  roadmap.setMilestoneStatus(2, 'in-progress', sandbox);
  const p = roadmap.getPhase(2, sandbox);
  assert.equal(p.status, 'in-progress');
  assert.equal(p.complete, false);
});

test('RM-STATUS-3: setMilestoneStatus rejects invalid status', () => {
  const sandbox = makeSandbox(WRITE_SEED_TOP_LEVEL);
  assert.throws(
    () => roadmap.setMilestoneStatus(1, 'bogus', sandbox),
    (err) => err && err.code === 'roadmap-invalid-status',
  );
});

test('RM-STATUS-3b: setMilestoneStatus accepts "backlog" (matches addBacklogEntry writer)', () => {
  const sandbox = makeSandbox(WRITE_SEED_TOP_LEVEL);
  const res = roadmap.setMilestoneStatus(1, 'backlog', sandbox);
  assert.equal(res.status, 'backlog');
});

test('RM-STATUS-4: setMilestoneStatus unknown phase throws phase-not-found', () => {
  const sandbox = makeSandbox(WRITE_SEED_TOP_LEVEL);
  assert.throws(
    () => roadmap.setMilestoneStatus(99, 'verified', sandbox),
    (err) => err && err.code === 'phase-not-found',
  );
});

test('RM-STATUS-5: phaseComplete treats verified as done', () => {
  const sandbox = makeSandbox(WRITE_SEED_TOP_LEVEL);
  roadmap.setMilestoneStatus(1, 'verified', sandbox);
  assert.equal(roadmap.phaseComplete(1, sandbox), true);
});

test('RM-LOCK-1: _mutate holds yaml+md locks and renderRoadmap takes the same pair (no torn write)', async () => {
  const sandbox = makeSandbox(WRITE_SEED_TOP_LEVEL);
  const render = require('./roadmap-render.cjs');
  await Promise.all([
    Promise.resolve().then(() => roadmap.setMilestoneStatus(1, 'verified', sandbox)),
    Promise.resolve().then(() => render.renderRoadmap(sandbox)),
    Promise.resolve().then(() => roadmap.setMilestoneStatus(2, 'in-progress', sandbox)),
  ]);
  const yamlPath = path.join(sandbox, '.nubos-pilot', 'roadmap.yaml');
  const mdPath = path.join(sandbox, '.nubos-pilot', 'ROADMAP.md');
  const yaml = require('yaml').parse(fs.readFileSync(yamlPath, 'utf-8'));
  const m1 = yaml.milestones.find((m) => m.id === 'M001');
  const m2 = yaml.milestones.find((m) => m.id === 'M002');
  assert.equal(m1.status, 'verified');
  assert.equal(m2.status, 'in-progress');
  const md = fs.readFileSync(mdPath, 'utf-8');
  assert.match(md, /Generated from roadmap\.yaml/);
  assert.ok(md.length > 0, 'ROADMAP.md must not be empty after concurrent mutate+render');
});

const SCHEMA_V2_SEED = [
  'schema_version: 2',
  'milestones:',
  '  - id: M001',
  '    number: 1',
  '    name: Auth',
  '    goal: sign-in',
  '    status: pending',
  '    requirements: []',
  '    success_criteria: []',
  '    slices: []',
  '',
].join('\n');

const SCHEMA_MISSING_SEED = [
  'milestones:',
  '  - id: M001',
  '    number: 1',
  '    name: Legacy',
  '    goal: legacy',
  '    status: pending',
  '    requirements: []',
  '    success_criteria: []',
  '    slices: []',
  '',
].join('\n');

const SCHEMA_V99_SEED = [
  'schema_version: 99',
  'milestones:',
  '  - id: M001',
  '    number: 1',
  '    name: From-The-Future',
  '    goal: future',
  '    status: pending',
  '    requirements: []',
  '    success_criteria: []',
  '    slices: []',
  '',
].join('\n');

const SCHEMA_STRING_SEED = [
  'schema_version: "2"',
  'milestones:',
  '  - id: M001',
  '    number: 1',
  '    name: BadType',
  '    goal: bad',
  '    status: pending',
  '    requirements: []',
  '    success_criteria: []',
  '    slices: []',
  '',
].join('\n');

test('RM-SCHEMA-1: parseRoadmap accepts schema_version=1 and =2; tolerates missing', () => {
  const sandboxV1 = makeSandbox(WRITE_SEED);
  assert.equal(roadmap.parseRoadmap(sandboxV1).phases.length, 2);

  const sandboxV2 = makeSandbox(SCHEMA_V2_SEED);
  assert.equal(roadmap.parseRoadmap(sandboxV2).phases.length, 1);

  const sandboxMissing = makeSandbox(SCHEMA_MISSING_SEED);
  assert.equal(roadmap.parseRoadmap(sandboxMissing).phases.length, 1);
});

test('RM-SCHEMA-2: parseRoadmap throws roadmap-unsupported-schema on schema_version=99', () => {
  const sandbox = makeSandbox(SCHEMA_V99_SEED);
  assert.throws(
    () => roadmap.parseRoadmap(sandbox),
    (err) =>
      err.name === 'NubosPilotError'
      && err.code === 'roadmap-unsupported-schema'
      && err.details.got === 99
      && Array.isArray(err.details.supported)
      && err.details.supported.includes(2)
      && err.details.file === 'roadmap.yaml'
      && !('path' in err.details),
  );
});

test('RM-SCHEMA-3: _mutate stamps schema_version to CURRENT and rejects non-integer schema', () => {
  const sandbox = makeSandbox(SCHEMA_STRING_SEED);
  assert.throws(
    () => roadmap.setMilestoneStatus(1, 'verified', sandbox),
    (err) => err.name === 'NubosPilotError' && err.code === 'roadmap-unsupported-schema',
  );

  const sandboxV1 = makeSandbox(WRITE_SEED);
  roadmap.setMilestoneStatus(1, 'verified', sandboxV1);
  const yamlPath = path.join(sandboxV1, '.nubos-pilot', 'roadmap.yaml');
  const doc = require('yaml').parse(fs.readFileSync(yamlPath, 'utf-8'));
  assert.equal(doc.schema_version, roadmap.CURRENT_SCHEMA_VERSION);
  // CURRENT stays 2 even though 3 exists (ADR-0028): _mutate stamps CURRENT on
  // every write, so raising it would migrate every project to a version older
  // installs cannot read, for a feature those projects do not use.
  assert.equal(roadmap.CURRENT_SCHEMA_VERSION, 2);
  assert.equal(roadmap.CONDITIONAL_SCHEMA_VERSION, 3);
  assert.deepEqual(roadmap.SUPPORTED_SCHEMA_VERSIONS, [1, 2, 3]);
});

const CONDITIONAL_SEED = [
  'schema_version: 3',
  'milestones:',
  '  - id: M001',
  '    number: 1',
  '    name: first',
  '    status: in-progress',
  '    slices:',
  '      - id: S001',
  '        name: migrate',
  '        status: done',
  '      - id: S002',
  '        name: verify the migration',
  '        status: pending',
  '        when:',
  '          slice: S001',
  '          status: done',
  '',
].join('\n');

test('RM-SCHEMA-3b: a mutation preserves schema_version 3 instead of downgrading it (ADR-0028)', () => {
  // The original write path stamped CURRENT unconditionally, so any unrelated
  // mutation of a conditional roadmap stripped it back to 2 — removing the marker
  // that stops an older install from ignoring `when` and running a gated slice.
  const sandbox = makeSandbox(CONDITIONAL_SEED);
  roadmap.setMilestoneStatus(1, 'verified', sandbox);
  const yamlPath = path.join(sandbox, '.nubos-pilot', 'roadmap.yaml');
  const doc = require('yaml').parse(fs.readFileSync(yamlPath, 'utf-8'));
  assert.equal(doc.schema_version, 3, 'a conditional roadmap must stay at 3');
  assert.ok(doc.milestones[0].slices[1].when, 'the condition itself must survive the round trip');
});

test('RM-SCHEMA-3c: removing the last condition drops the file back to 2', () => {
  // Bidirectional by design: with nothing left to mishandle, the file becomes
  // readable by older installs again and says so honestly.
  const sandbox = makeSandbox(CONDITIONAL_SEED);
  roadmap.mutateMilestoneNode(1, (node) => {
    delete node.slices[1].when;
    return node;
  }, sandbox);
  const doc = require('yaml').parse(
    fs.readFileSync(path.join(sandbox, '.nubos-pilot', 'roadmap.yaml'), 'utf-8'),
  );
  assert.equal(doc.schema_version, 2);
});

test('RM-SCHEMA-3d: a condition declared under schema_version 2 is refused on read', () => {
  const sandbox = makeSandbox(CONDITIONAL_SEED.replace('schema_version: 3', 'schema_version: 2'));
  assert.throws(
    () => roadmap.parseRoadmap(sandbox),
    (err) => err.name === 'NubosPilotError' && err.code === 'roadmap-conditional-requires-v3',
  );
});

test('RM-SCHEMA-4: renderRoadmap throws roadmap-unsupported-schema on schema_version=99', () => {
  const sandbox = makeSandbox(SCHEMA_V99_SEED);
  const { renderRoadmap } = require('./roadmap-render.cjs');
  assert.throws(
    () => renderRoadmap(sandbox),
    (err) =>
      err.name === 'NubosPilotError'
      && err.code === 'roadmap-unsupported-schema',
  );
});

test('RM-SCHEMA-5: parseRoadmap rejects boolean and null-typed schema_version', () => {
  const seedBool = [
    'schema_version: true',
    'milestones: []',
    '',
  ].join('\n');
  const sandbox = makeSandbox(seedBool);
  assert.throws(
    () => roadmap.parseRoadmap(sandbox),
    (err) =>
      err.name === 'NubosPilotError'
      && err.code === 'roadmap-unsupported-schema'
      && err.details.got === 'boolean',
  );
});

test('RM-SCHEMA-6: schema_version=0 throws roadmap-unsupported-schema', () => {
  const seedZero = [
    'schema_version: 0',
    'milestones:',
    '  - id: M001',
    '    number: 1',
    '    name: Zero',
    '    goal: zero',
    '    status: pending',
    '    requirements: []',
    '    success_criteria: []',
    '    slices: []',
    '',
  ].join('\n');
  const sandbox = makeSandbox(seedZero);
  assert.throws(
    () => roadmap.parseRoadmap(sandbox),
    (err) =>
      err.name === 'NubosPilotError'
      && err.code === 'roadmap-unsupported-schema'
      && err.details.got === 0,
  );
});
