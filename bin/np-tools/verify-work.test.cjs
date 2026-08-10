const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { makeSandbox, seedRoadmapYaml, seedMilestoneDir, cleanupAll } =
  require('../../tests/helpers/fixture.cjs');
const subcmd = require('./verify-work.cjs');

function _roadmapWithSCs() {
  return {
    schema_version: 2,
    milestones: [
      {
        id: 'M006',
        number: 6,
        name: 'Execution',
        goal: '',
        requirements: [],
        success_criteria: ['Tasks commit atomically', 'Verification runs'],
        status: 'pending',
        slices: [],
      },
    ],
  };
}

function _capture() {
  let b = '';
  return { stub: { write: (s) => { b += s; return true; } }, get: () => b };
}

afterEach(() => {
  cleanupAll();
  process.exitCode = 0;
});

test('VW-1: init emits payload with success_criteria + verifier_tier', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmapWithSCs());
  seedMilestoneDir(sandbox, 6, {});
  const cap = _capture();
  const p = subcmd.run(['init', '6'], { cwd: sandbox, stdout: cap.stub });
  assert.equal(p._workflow, 'verify-work');
  assert.equal(p.milestone, 6);
  assert.equal(p.milestone_id, 'M006');
  assert.equal(p.verifier_tier, 'sonnet');
  assert.deepEqual(p.success_criteria, ['Tasks commit atomically', 'Verification runs']);
  assert.ok(Array.isArray(p.draft_results));
  assert.equal(p.draft_results.length, 2);
  assert.ok(Array.isArray(p.slice_uat));
});

test('VW-2: emit-draft writes M<NNN>-VERIFICATION.md', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmapWithSCs());
  const mDir = seedMilestoneDir(sandbox, 6, {});
  const cap = _capture();
  subcmd.run(['emit-draft', '6'], { cwd: sandbox, stdout: cap.stub });
  const vp = path.join(mDir, 'M006-VERIFICATION.md');
  assert.ok(fs.existsSync(vp), 'expected ' + vp);
  const body = fs.readFileSync(vp, 'utf-8');
  assert.ok(body.includes('### SC-1:'));
  assert.ok(body.includes('### SC-2:'));
  assert.ok(body.includes('**Status:** Pending'));
  assert.match(body, /^# M006 — Execution — Verification$/m);
});

test('VW-3: record-sc updates a single SC status + sets classified_by=user', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmapWithSCs());
  const mDir = seedMilestoneDir(sandbox, 6, {});
  subcmd.run(['emit-draft', '6'], { cwd: sandbox, stdout: _capture().stub });
  subcmd.run(['record-sc', '6', 'SC-1', 'Pass'], { cwd: sandbox, stdout: _capture().stub });
  const body = fs.readFileSync(path.join(mDir, 'M006-VERIFICATION.md'), 'utf-8');
  assert.ok(body.includes('### SC-1: Tasks commit atomically\n- **Status:** Pass\n- **Classified by:** user'));
  assert.ok(body.includes('### SC-2: Verification runs\n- **Status:** Pending'));
});

test('VW-4: record-sc rejects unknown status', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmapWithSCs());
  seedMilestoneDir(sandbox, 6, {});
  subcmd.run(['emit-draft', '6'], { cwd: sandbox, stdout: _capture().stub });
  assert.throws(
    () => subcmd.run(['record-sc', '6', 'SC-1', 'Maybe'], { cwd: sandbox, stdout: _capture().stub }),
    (err) => err && err.code === 'verify-work-invalid-status',
  );
});

test('VW-5: record-sc before emit-draft → file-unreadable', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmapWithSCs());
  seedMilestoneDir(sandbox, 6, {});
  assert.throws(
    () => subcmd.run(['record-sc', '6', 'SC-1', 'Pass'], { cwd: sandbox, stdout: _capture().stub }),
    (err) => err && err.code === 'verify-work-file-unreadable',
  );
});

test('VW-6: unknown verb throws', () => {
  const sandbox = makeSandbox();
  assert.throws(
    () => subcmd.run(['bogus'], { cwd: sandbox, stdout: _capture().stub }),
    (err) => err && err.code === 'verify-work-unknown-verb',
  );
});

test('VW-7: unknown milestone number throws verify-work-not-found', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmapWithSCs());
  assert.throws(
    () => subcmd.run(['init', '99'], { cwd: sandbox, stdout: _capture().stub }),
    (err) => err && err.code === 'verify-work-not-found',
  );
});

const YAML = require('yaml');

function _readMilestoneStatus(sandbox, num) {
  const yamlPath = path.join(sandbox, '.nubos-pilot', 'roadmap.yaml');
  const doc = YAML.parse(fs.readFileSync(yamlPath, 'utf-8'));
  const want = String(num);
  for (const ms of doc.milestones) {
    if (Array.isArray(ms.slices) && String(ms.number) === want) return ms.status;
    if (Array.isArray(ms.phases)) {
      const hit = ms.phases.find((p) => String(p.number) === want);
      if (hit) return hit.status;
    }
  }
  return null;
}

test('VW-8: record-sc syncs roadmap.yaml status to in-progress when any SC remains pending', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmapWithSCs());
  seedMilestoneDir(sandbox, 6, {});
  subcmd.run(['emit-draft', '6'], { cwd: sandbox, stdout: _capture().stub });
  subcmd.run(['record-sc', '6', 'SC-1', 'Pass'], { cwd: sandbox, stdout: _capture().stub });
  assert.equal(_readMilestoneStatus(sandbox, 6), 'in-progress');
});

test('VW-9: record-sc flips roadmap status to verified when every SC passes', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmapWithSCs());
  seedMilestoneDir(sandbox, 6, {});
  subcmd.run(['emit-draft', '6'], { cwd: sandbox, stdout: _capture().stub });
  subcmd.run(['record-sc', '6', 'SC-1', 'Pass'], { cwd: sandbox, stdout: _capture().stub });
  subcmd.run(['record-sc', '6', 'SC-2', 'Pass'], { cwd: sandbox, stdout: _capture().stub });
  assert.equal(_readMilestoneStatus(sandbox, 6), 'verified');
});

test('VW-10: record-sc flips roadmap status to failed when any SC fails', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmapWithSCs());
  seedMilestoneDir(sandbox, 6, {});
  subcmd.run(['emit-draft', '6'], { cwd: sandbox, stdout: _capture().stub });
  subcmd.run(['record-sc', '6', 'SC-1', 'Fail'], { cwd: sandbox, stdout: _capture().stub });
  subcmd.run(['record-sc', '6', 'SC-2', 'Pass'], { cwd: sandbox, stdout: _capture().stub });
  assert.equal(_readMilestoneStatus(sandbox, 6), 'failed');
});

test('VW-11: sync-roadmap <n> reads VERIFICATION.md and updates roadmap.yaml', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmapWithSCs());
  seedMilestoneDir(sandbox, 6, {});
  subcmd.run(['emit-draft', '6'], { cwd: sandbox, stdout: _capture().stub });
  const vp = path.join(sandbox, '.nubos-pilot', 'milestones', 'M006', 'M006-VERIFICATION.md');
  let raw = fs.readFileSync(vp, 'utf-8');
  raw = raw.replace(/### SC-1:.*?\n- \*\*Status:\*\* Pending\n- \*\*Classified by:\*\* n\/a/s,
    '### SC-1: Tasks commit atomically\n- **Status:** Pass\n- **Classified by:** user');
  raw = raw.replace(/### SC-2:.*?\n- \*\*Status:\*\* Pending\n- \*\*Classified by:\*\* n\/a/s,
    '### SC-2: Verification runs\n- **Status:** Pass\n- **Classified by:** user');
  fs.writeFileSync(vp, raw, 'utf-8');
  const cap = _capture();
  const result = subcmd.run(['sync-roadmap', '6'], { cwd: sandbox, stdout: cap.stub });
  assert.equal(result.synced, true);
  assert.equal(result.status, 'verified');
  assert.equal(_readMilestoneStatus(sandbox, 6), 'verified');
});

test('VW-12b: record-sc also updates M{N}-META.json status', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmapWithSCs());
  const mDir = seedMilestoneDir(sandbox, 6, {
    'M006-META.json': JSON.stringify({ id: 'M006', name: 'Execution', status: 'pending', slice_count: 0, task_count: 0 }, null, 2),
  });
  subcmd.run(['emit-draft', '6'], { cwd: sandbox, stdout: _capture().stub });
  subcmd.run(['record-sc', '6', 'SC-1', 'Pass'], { cwd: sandbox, stdout: _capture().stub });
  subcmd.run(['record-sc', '6', 'SC-2', 'Pass'], { cwd: sandbox, stdout: _capture().stub });
  const meta = JSON.parse(fs.readFileSync(path.join(mDir, 'M006-META.json'), 'utf-8'));
  assert.equal(meta.status, 'verified');
  assert.equal(meta.id, 'M006', 'other meta fields untouched');
  assert.equal(meta.slice_count, 0);
});

test('VW-12d: record-sc without M{N}-META.json present does not crash', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmapWithSCs());
  seedMilestoneDir(sandbox, 6, {});
  subcmd.run(['emit-draft', '6'], { cwd: sandbox, stdout: _capture().stub });
  const cap = _capture();
  const result = subcmd.run(['record-sc', '6', 'SC-1', 'Pass'], { cwd: sandbox, stdout: cap.stub });
  assert.equal(result.ok, true);
  assert.equal(result.roadmap_sync.synced, true);
  assert.equal(result.roadmap_sync.meta.changed, false);
  assert.equal(result.roadmap_sync.meta.reason, 'meta-missing');
});

test('VW-13: record-sc sets ok:false + non-zero exit when roadmap.yaml is missing', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmapWithSCs());
  const mDir = seedMilestoneDir(sandbox, 6, {});
  subcmd.run(['emit-draft', '6'], { cwd: sandbox, stdout: _capture().stub });
  fs.rmSync(path.join(sandbox, '.nubos-pilot', 'roadmap.yaml'));
  const origWrite = process.stderr.write.bind(process.stderr);
  let warned = '';
  process.stderr.write = (chunk) => { warned += String(chunk); return true; };
  const origExitCode = process.exitCode;
  process.exitCode = 0;
  try {
    const result = subcmd.run(['record-sc', '6', 'SC-1', 'Pass'], { cwd: sandbox, stdout: _capture().stub });
    assert.equal(result.ok, false, 'sync failure must flip ok:false');
    assert.equal(result.roadmap_sync.synced, false);
    assert.match(warned, /roadmap-sync failed|sync-error|roadmap-write-read-error/);
    assert.equal(process.exitCode, 1, 'exit code must signal failure');
    const md = fs.readFileSync(path.join(mDir, 'M006-VERIFICATION.md'), 'utf-8');
    assert.match(md, /### SC-1: Tasks commit atomically\n- \*\*Status:\*\* Pass/, 'SC must still be persisted even when sync fails');
  } finally {
    process.exitCode = origExitCode;
    process.stderr.write = origWrite;
  }
});

test('VW-13b: record-sc respects context.suppressExitCode (library callers)', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmapWithSCs());
  seedMilestoneDir(sandbox, 6, {});
  subcmd.run(['emit-draft', '6'], { cwd: sandbox, stdout: _capture().stub });
  fs.rmSync(path.join(sandbox, '.nubos-pilot', 'roadmap.yaml'));
  const origExitCode = process.exitCode;
  process.exitCode = 0;
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  try {
    subcmd.run(['record-sc', '6', 'SC-1', 'Pass'], {
      cwd: sandbox,
      stdout: _capture().stub,
      suppressExitCode: true,
    });
    assert.equal(process.exitCode, 0, 'suppressExitCode keeps exit code 0');
  } finally {
    process.exitCode = origExitCode;
    process.stderr.write = origWrite;
  }
});

test('VW-14: sync-roadmap aggregate ok=false when at least one milestone sync errors', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, {
    schema_version: 2,
    milestones: [
      { id: 'M001', number: 1, name: 'A', goal: '', requirements: [], success_criteria: ['c1'], status: 'pending', slices: [] },
    ],
  });
  seedMilestoneDir(sandbox, 1, {});
  subcmd.run(['emit-draft', '1'], { cwd: sandbox, stdout: _capture().stub });
  subcmd.run(['record-sc', '1', 'SC-1', 'Pass'], { cwd: sandbox, stdout: _capture().stub });
  fs.rmSync(path.join(sandbox, '.nubos-pilot', 'roadmap.yaml'));
  const result = subcmd.run(['sync-roadmap'], { cwd: sandbox, stdout: _capture().stub });
  assert.equal(result.ok, false);
});

test('VW-14b: sync-roadmap stays ok=true when only verification-missing is reported', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmapWithSCs());
  seedMilestoneDir(sandbox, 6, {});
  const result = subcmd.run(['sync-roadmap'], { cwd: sandbox, stdout: _capture().stub });
  assert.equal(result.ok, true, 'verification-missing is expected (not a failure)');
});

test('VW-12c: sync-roadmap without arg also updates M{N}-META.json', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmapWithSCs());
  const mDir = seedMilestoneDir(sandbox, 6, {
    'M006-META.json': JSON.stringify({ id: 'M006', status: 'pending' }, null, 2),
  });
  subcmd.run(['emit-draft', '6'], { cwd: sandbox, stdout: _capture().stub });
  subcmd.run(['record-sc', '6', 'SC-1', 'Fail'], { cwd: sandbox, stdout: _capture().stub });
  subcmd.run(['record-sc', '6', 'SC-2', 'Pass'], { cwd: sandbox, stdout: _capture().stub });
  subcmd.run(['sync-roadmap'], { cwd: sandbox, stdout: _capture().stub });
  const meta = JSON.parse(fs.readFileSync(path.join(mDir, 'M006-META.json'), 'utf-8'));
  assert.equal(meta.status, 'failed');
});

test('VW-12: sync-roadmap without arg syncs every milestone with a VERIFICATION.md', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, {
    schema_version: 2,
    milestones: [
      {
        id: 'M001', number: 1, name: 'A', goal: '', requirements: [],
        success_criteria: ['c1'], status: 'pending', slices: [],
      },
      {
        id: 'M002', number: 2, name: 'B', goal: '', requirements: [],
        success_criteria: ['c1'], status: 'pending', slices: [],
      },
    ],
  });
  seedMilestoneDir(sandbox, 1, {});
  seedMilestoneDir(sandbox, 2, {});
  subcmd.run(['emit-draft', '1'], { cwd: sandbox, stdout: _capture().stub });
  subcmd.run(['emit-draft', '2'], { cwd: sandbox, stdout: _capture().stub });
  subcmd.run(['record-sc', '1', 'SC-1', 'Pass'], { cwd: sandbox, stdout: _capture().stub });
  subcmd.run(['record-sc', '2', 'SC-1', 'Fail'], { cwd: sandbox, stdout: _capture().stub });
  const cap = _capture();
  const result = subcmd.run(['sync-roadmap'], { cwd: sandbox, stdout: cap.stub });
  assert.equal(result.ok, true);
  assert.equal(result.count, 2);
  assert.equal(_readMilestoneStatus(sandbox, 1), 'verified');
  assert.equal(_readMilestoneStatus(sandbox, 2), 'failed');
});

function _captureStderr() {
  const orig = process.stderr.write;
  let buf = '';
  process.stderr.write = (s) => { buf += String(s); return true; };
  return { get: () => buf, restore: () => { process.stderr.write = orig; } };
}

test('VW-PARTIAL-1: recording only some SC reports the shortfall instead of going quiet', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmapWithSCs());
  seedMilestoneDir(sandbox, 6, {});
  subcmd.run(['emit-draft', '6'], { cwd: sandbox, stdout: _capture().stub });

  const err = _captureStderr();
  let result;
  try {
    result = subcmd.run(['record-sc', '6', 'SC-1', 'Pass'], {
      cwd: sandbox, stdout: _capture().stub, suppressExitCode: true,
    });
  } finally { err.restore(); }

  assert.equal(result.roadmap_sync.partial, true);
  assert.equal(result.roadmap_sync.classified, 1);
  assert.equal(result.roadmap_sync.total, 2);
  assert.equal(result.roadmap_sync.status, 'in-progress');
  assert.match(err.get(), /1\/2 SC classified/);
});

test('VW-PARTIAL-2: the last SC completes the set, clears partial and reaches verified', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmapWithSCs());
  seedMilestoneDir(sandbox, 6, {});
  subcmd.run(['emit-draft', '6'], { cwd: sandbox, stdout: _capture().stub });

  const err = _captureStderr();
  let result;
  try {
    subcmd.run(['record-sc', '6', 'SC-1', 'Pass'], { cwd: sandbox, stdout: _capture().stub, suppressExitCode: true });
    result = subcmd.run(['record-sc', '6', 'SC-2', 'Pass'], { cwd: sandbox, stdout: _capture().stub, suppressExitCode: true });
  } finally { err.restore(); }

  assert.equal(result.roadmap_sync.partial, false);
  assert.equal(result.roadmap_sync.status, 'verified');
  assert.equal(result.ok, true);
});

test('VW-PARTIAL-3: a stale META.json makes the sync not-ok, a missing one does not', () => {
  const mk = () => {
    const sandbox = makeSandbox();
    seedRoadmapYaml(sandbox, _roadmapWithSCs());
    seedMilestoneDir(sandbox, 6, {});
    subcmd.run(['emit-draft', '6'], { cwd: sandbox, stdout: _capture().stub });
    return sandbox;
  };

  const noMeta = mk();
  const err1 = _captureStderr();
  let r1;
  try {
    r1 = subcmd.run(['record-sc', '6', 'SC-1', 'Pass'], { cwd: noMeta, stdout: _capture().stub, suppressExitCode: true });
  } finally { err1.restore(); }
  assert.equal(r1.roadmap_sync.meta_stale, false, 'no META.json means nothing can go stale');
  assert.equal(r1.ok, true);

  const badMeta = mk();
  const metaPath = path.join(badMeta, '.nubos-pilot', 'milestones', 'M006', 'M006-META.json');
  fs.writeFileSync(metaPath, '{ not json', 'utf-8');
  const err2 = _captureStderr();
  let r2;
  try {
    r2 = subcmd.run(['record-sc', '6', 'SC-1', 'Pass'], { cwd: badMeta, stdout: _capture().stub, suppressExitCode: true });
  } finally { err2.restore(); }
  assert.equal(r2.roadmap_sync.meta_stale, true, 'an unwritable META.json keeps lying to the dashboard');
  assert.equal(r2.ok, false);
});

test('VW-OPEN-1: verifying over unfinished slices says so instead of going quiet', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmapWithSCs());
  const sd = path.join(sandbox, '.nubos-pilot');
  for (const [sid, status] of [['S001', 'done'], ['S002', 'pending']]) {
    const dir = path.join(sd, 'milestones', 'M006', 'slices', sid, 'tasks', 'T0001');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'T0001-PLAN.md'),
      '---\ntask: T0001\nslice: M006-' + sid + '\nstatus: ' + status + '\n---\n# t\n',
      'utf-8',
    );
  }
  const yamlPath = path.join(sd, 'roadmap.yaml');
  fs.writeFileSync(
    yamlPath,
    fs.readFileSync(yamlPath, 'utf-8').replace(
      'slices: []',
      'slices:\n      - id: S001\n        name: S001\n      - id: S002\n        name: S002',
    ),
    'utf-8',
  );
  seedMilestoneDir(sandbox, 6, {});
  subcmd.run(['emit-draft', '6'], { cwd: sandbox, stdout: _capture().stub });

  const orig = process.stderr.write;
  let err = '';
  process.stderr.write = (s) => { err += String(s); return true; };
  try {
    subcmd.run(['record-sc', '6', 'SC-1', 'Pass'], { cwd: sandbox, stdout: _capture().stub, suppressExitCode: true });
    subcmd.run(['record-sc', '6', 'SC-2', 'Pass'], { cwd: sandbox, stdout: _capture().stub, suppressExitCode: true });
  } finally { process.stderr.write = orig; }

  assert.match(err, /milestone set to "verified" while S002 is not done/);
});
