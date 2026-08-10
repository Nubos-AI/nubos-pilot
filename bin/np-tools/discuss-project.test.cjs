const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const newProject = require('./new-project.cjs');
const subcmd = require('./discuss-project.cjs');

const _sandboxes = [];

function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-dp-'));
  fs.mkdirSync(path.join(dir, '.nubos-pilot'), { recursive: true });
  _sandboxes.push(dir);
  return dir;
}

function scaffold(root) {
  const answersPath = path.join(root, 'ans.json');
  fs.writeFileSync(answersPath, JSON.stringify({
    project_name: 'Demo',
    core_value: 'Ship fast.',
    primary_constraints: 'Node 22',
    first_milestone_name: 'v1.0',
    first_phase_name: 'foundation',
  }));
  newProject.run(['--apply', answersPath], { cwd: root, stdout: captureStdout().stub });
}

function captureStdout() {
  const chunks = [];
  return {
    stub: { write: (s) => chunks.push(String(s)) },
    json: () => JSON.parse(chunks.join('')),
  };
}

afterEach(() => {
  while (_sandboxes.length) {
    const dir = _sandboxes.pop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('DP-1: throws when .nubos-pilot missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-dp-bare-'));
  _sandboxes.push(dir);
  assert.throws(
    () => subcmd.run([], { cwd: dir, stdout: captureStdout().stub }),
    (err) => err.code === 'discuss-project-not-initialized',
  );
});

test('DP-2: plan mode emits questions, required_fields, scan context', () => {
  const root = makeSandbox();
  scaffold(root);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'demo' }));
  fs.writeFileSync(path.join(root, 'README.md'), '# Demo\n\nFirst line.\n');

  const cap = captureStdout();
  subcmd.run([], { cwd: root, stdout: cap.stub });
  const out = cap.json();
  assert.equal(out.mode, 'plan');
  assert.ok(Array.isArray(out.questions));
  assert.ok(out.questions.length >= 5);
  assert.ok(out.required_fields.includes('project_description'));
  assert.ok(out.scan_context);
  assert.ok(out.scan_context.manifest_paths.includes('package.json'));
});

test('DP-3: plan detects bootstrap sub_mode when placeholders still in PROJECT.md', () => {
  const root = makeSandbox();
  scaffold(root);

  const cap = captureStdout();
  subcmd.run(['--bootstrap'], { cwd: root, stdout: cap.stub });
  const out = cap.json();
  assert.equal(out.sub_mode, 'bootstrap');
});

test('DP-4: apply fills in PROJECT.md sections', () => {
  const root = makeSandbox();
  scaffold(root);

  const answers = {
    project_description: 'Demo fills holes.',
    domain_text: 'Jedi-era scaffolding.',
    target_users_text: 'Engineers.',
    non_goals_text: 'Not a framework.',
    success_criteria_text: 'Phase 1 ships.',
    strategic_decisions_text: 'Node-only.',
  };
  const answersPath = path.join(root, 'pa.json');
  fs.writeFileSync(answersPath, JSON.stringify(answers));

  const cap = captureStdout();
  subcmd.run(['--apply', answersPath, '--bootstrap'], { cwd: root, stdout: cap.stub });
  const projectMd = fs.readFileSync(path.join(root, '.nubos-pilot', 'PROJECT.md'), 'utf-8');
  assert.ok(projectMd.includes('Demo fills holes.'));
  assert.ok(projectMd.includes('Jedi-era scaffolding.'));
  assert.ok(projectMd.includes('Engineers.'));
  assert.ok(projectMd.includes('Not a framework.'));
  assert.ok(projectMd.includes('Phase 1 ships.'));
  assert.ok(projectMd.includes('Node-only.'));
  assert.doesNotMatch(projectMd, /_TBD — filled by/);
});

test('DP-5: apply refresh updates a filled PROJECT.md', () => {
  const root = makeSandbox();
  scaffold(root);

  const bootstrap = {
    project_description: 'First take.',
    domain_text: 'd1',
    target_users_text: 'u1',
    non_goals_text: 'n1',
    success_criteria_text: 's1',
    strategic_decisions_text: 'st1',
  };
  const p1 = path.join(root, 'a1.json');
  fs.writeFileSync(p1, JSON.stringify(bootstrap));
  subcmd.run(['--apply', p1, '--bootstrap'], { cwd: root, stdout: captureStdout().stub });

  const refresh = {
    project_description: 'Second take.',
    domain_text: 'd2',
    target_users_text: 'u2',
    non_goals_text: 'n2',
    success_criteria_text: 's2',
    strategic_decisions_text: 'st2',
  };
  const p2 = path.join(root, 'a2.json');
  fs.writeFileSync(p2, JSON.stringify(refresh));
  subcmd.run(['--apply', p2], { cwd: root, stdout: captureStdout().stub });

  const projectMd = fs.readFileSync(path.join(root, '.nubos-pilot', 'PROJECT.md'), 'utf-8');
  assert.ok(projectMd.includes('Second take.'));
  assert.ok(!projectMd.includes('First take.'));
});

test('DP-6: apply validates required fields', () => {
  const root = makeSandbox();
  scaffold(root);
  const p = path.join(root, 'a.json');
  fs.writeFileSync(p, JSON.stringify({ project_description: 'x' }));
  assert.throws(
    () => subcmd.run(['--apply', p, '--bootstrap'], { cwd: root, stdout: captureStdout().stub }),
    (err) => err.code === 'discuss-project-missing-field',
  );
});

test('DP-7-val: validateProposedRequirements rejects non-array', () => {
  const { validateProposedRequirements } = subcmd;
  assert.throws(
    () => validateProposedRequirements({ not: 'array' }),
    (err) => err.code === 'proposed-reqs-not-array',
  );
});

test('DP-7-val2: validateProposedRequirements rejects invalid id', () => {
  const { validateProposedRequirements } = subcmd;
  assert.throws(
    () => validateProposedRequirements([{ id: 'REQ-1', text: 'ok' }]),
    (err) => err.code === 'proposed-reqs-invalid-id',
  );
  assert.throws(
    () => validateProposedRequirements([{ id: 'foo', text: 'ok' }]),
    (err) => err.code === 'proposed-reqs-invalid-id',
  );
});

test('DP-7-val3: validateProposedRequirements rejects empty text', () => {
  const { validateProposedRequirements } = subcmd;
  assert.throws(
    () => validateProposedRequirements([{ id: 'REQ-02', text: '   ' }]),
    (err) => err.code === 'proposed-reqs-empty-text',
  );
});

test('DP-7-val4: validateProposedRequirements rejects duplicates within batch', () => {
  const { validateProposedRequirements } = subcmd;
  assert.throws(
    () => validateProposedRequirements([
      { id: 'REQ-02', text: 'a' },
      { id: 'REQ-02', text: 'b' },
    ]),
    (err) => err.code === 'proposed-reqs-duplicate-id',
  );
});

test('DP-7-val5: validateProposedRequirements rejects collision with existing', () => {
  const { validateProposedRequirements } = subcmd;
  const existing = new Set(['REQ-01', 'REQ-02']);
  assert.throws(
    () => validateProposedRequirements([{ id: 'REQ-02', text: 'x' }], existing),
    (err) => err.code === 'proposed-reqs-collides-with-existing',
  );
});

test('DP-7-val6: validateProposedRequirements trims text and returns valid', () => {
  const { validateProposedRequirements } = subcmd;
  const result = validateProposedRequirements([
    { id: 'REQ-02', text: '  must persist  ' },
  ]);
  assert.deepEqual(result, [{ id: 'REQ-02', text: 'must persist' }]);
});

test('DP-7: proposed requirements are appended to REQUIREMENTS.md', () => {
  const root = makeSandbox();
  scaffold(root);
  const answers = {
    project_description: 'd',
    domain_text: 'd',
    target_users_text: 't',
    non_goals_text: 'n',
    success_criteria_text: 's',
    strategic_decisions_text: 'st',
  };
  const ap = path.join(root, 'a.json');
  fs.writeFileSync(ap, JSON.stringify(answers));

  const rp = path.join(root, 'r.json');
  fs.writeFileSync(rp, JSON.stringify([
    { id: 'REQ-02', text: 'must support offline mode' },
    { id: 'REQ-03', text: 'must persist to markdown' },
  ]));

  subcmd.run(['--apply', ap, '--bootstrap', '--proposed-requirements', rp], {
    cwd: root, stdout: captureStdout().stub,
  });

  const reqs = fs.readFileSync(path.join(root, '.nubos-pilot', 'REQUIREMENTS.md'), 'utf-8');
  assert.ok(reqs.includes('## Proposed (from np:discuss-project)'));
  assert.ok(reqs.includes('REQ-02'));
  assert.ok(reqs.includes('must support offline mode'));
  assert.ok(reqs.includes('REQ-03'));
});
