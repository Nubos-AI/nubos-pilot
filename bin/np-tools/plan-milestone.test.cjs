const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { makeSandbox, seedRoadmapYaml, seedMilestoneDir, seedSliceDir, cleanupAll } =
  require('../../tests/helpers/fixture.cjs');
const subcmd = require('./plan-milestone.cjs');

function _roadmap() {
  return {
    schema_version: 1,
    milestones: [
      {
        id: 'M001',
        number: 1,
        name: 'Auth & Basic UI',
        goal: 'Ship login + basic profile',
        status: 'pending',
        requirements: ['AUTH-01', 'AUTH-02'],
        success_criteria: ['User can log in', 'Profile visible after login'],
        slices: [
          { id: 'S001', name: 'Login Page', status: 'pending' },
          { id: 'S002', name: 'Profile Page', status: 'pending' },
        ],
      },
    ],
  };
}

function _capture() {
  let buf = '';
  const stub = { write: (s) => { buf += s; return true; } };
  return { stub, get: () => buf };
}

afterEach(cleanupAll);

test('PM-1: init emits milestone payload with slice status', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmap());
  const cap = _capture();
  const payload = subcmd.run(['init', '1'], { cwd: sandbox, stdout: cap.stub });
  const raw = cap.get().trim();
  const parsed = raw.startsWith('@file:') ? JSON.parse(fs.readFileSync(raw.slice(6), 'utf-8')) : JSON.parse(raw);
  assert.equal(parsed.milestone, 1);
  assert.equal(parsed.milestone_id, 'M001');
  assert.ok(parsed.milestone_dir.endsWith(path.join('.nubos-pilot', 'milestones', 'M001')));
  assert.equal(parsed.name, 'Auth & Basic UI');
  assert.deepEqual(parsed.requirements, ['AUTH-01', 'AUTH-02']);
  assert.equal(parsed.has_context, false);
  assert.equal(parsed.has_roadmap, false);
  assert.deepEqual(parsed.existing_slices, []);
  assert.equal(payload.milestone, 1);
});

test('PM-2: init surfaces existing_slices with task counts', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmap());
  seedMilestoneDir(sandbox, 1, { 'M001-CONTEXT.md': '# ctx', 'M001-ROADMAP.md': '# rm' });
  seedSliceDir(sandbox, 1, 1, { 'S001-PLAN.md': 'plan' });
  fs.mkdirSync(path.join(sandbox, '.nubos-pilot', 'milestones', 'M001', 'slices', 'S001', 'tasks', 'T0001'), { recursive: true });
  fs.writeFileSync(
    path.join(sandbox, '.nubos-pilot', 'milestones', 'M001', 'slices', 'S001', 'tasks', 'T0001', 'T0001-PLAN.md'),
    '---\nid: "M001-S001-T0001"\n---\n',
  );
  const cap = _capture();
  subcmd.run(['init', '1'], { cwd: sandbox, stdout: cap.stub });
  const parsed = JSON.parse(cap.get().trim());
  assert.equal(parsed.has_context, true);
  assert.equal(parsed.has_roadmap, true);
  assert.equal(parsed.existing_slices.length, 1);
  assert.equal(parsed.existing_slices[0].id, 'S001');
  assert.equal(parsed.existing_slices[0].full_id, 'M001-S001');
  assert.equal(parsed.existing_slices[0].has_plan, true);
  assert.equal(parsed.existing_slices[0].task_count, 1);
});

test('PM-3: create-milestone-dir + create-slice-dir scaffold directories', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmap());
  subcmd.run(['create-milestone-dir', '1'], { cwd: sandbox, stdout: _capture().stub });
  assert.ok(fs.existsSync(path.join(sandbox, '.nubos-pilot', 'milestones', 'M001')));
  assert.ok(fs.existsSync(path.join(sandbox, '.nubos-pilot', 'milestones', 'M001', 'slices')));
  subcmd.run(['create-slice-dir', '1', '2'], { cwd: sandbox, stdout: _capture().stub });
  assert.ok(fs.existsSync(path.join(sandbox, '.nubos-pilot', 'milestones', 'M001', 'slices', 'S002')));
  assert.ok(fs.existsSync(path.join(sandbox, '.nubos-pilot', 'milestones', 'M001', 'slices', 'S002', 'tasks')));
});

test('PM-4: scaffold-slice-tasks extracts <task> blocks and writes T<NNNN>/T<NNNN>-PLAN.md + SUMMARY.md', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmap());
  seedMilestoneDir(sandbox, 1, {});
  const slicePlan = [
    '---',
    'slice: "M001-S001"',
    'milestone: "M001"',
    '---',
    '',
    '<tasks>',
    '<task id="M001-S001-T0001" wave="1" tier="sonnet" depends_on="">',
    '  <name>Seed login form</name>',
    '  <files>src/auth/LoginForm.tsx</files>',
    '  <action>Create form component with email+password.</action>',
    '  <verify><automated>npm test -- LoginForm</automated></verify>',
    '  <done>Form renders and test passes.</done>',
    '</task>',
    '<task id="M001-S001-T0002" wave="1" tier="opus" depends_on="">',
    '  <name>Wire login handler</name>',
    '  <files>src/auth/loginHandler.ts</files>',
    '  <action>POST /api/login.</action>',
    '  <verify><automated>npm test -- loginHandler</automated></verify>',
    '  <done>Handler returns token.</done>',
    '</task>',
    '</tasks>',
  ].join('\n');
  seedSliceDir(sandbox, 1, 1, { 'S001-PLAN.md': slicePlan });
  const cap = _capture();
  subcmd.run(['scaffold-slice-tasks', '1', '1'], { cwd: sandbox, stdout: cap.stub });
  const out = JSON.parse(cap.get().trim());
  assert.equal(out.reason, 'ok');
  assert.equal(out.task_count, 2);
  const t0001Plan = path.join(sandbox, '.nubos-pilot', 'milestones', 'M001', 'slices', 'S001', 'tasks', 'T0001', 'T0001-PLAN.md');
  const t0001Summary = path.join(sandbox, '.nubos-pilot', 'milestones', 'M001', 'slices', 'S001', 'tasks', 'T0001', 'T0001-SUMMARY.md');
  const t0002Plan = path.join(sandbox, '.nubos-pilot', 'milestones', 'M001', 'slices', 'S001', 'tasks', 'T0002', 'T0002-PLAN.md');
  for (const p of [t0001Plan, t0001Summary, t0002Plan]) {
    assert.ok(fs.existsSync(p), 'expected ' + p);
  }
  const body = fs.readFileSync(t0001Plan, 'utf-8');
  assert.match(body, /id: "M001-S001-T0001"/);
  assert.match(body, /slice: "M001-S001"/);
  assert.match(body, /milestone: "M001"/);
  assert.match(body, /tier: "sonnet"/);
  assert.match(body, /- "src\/auth\/LoginForm.tsx"/);
  assert.match(body, /Seed login form/);
});

test('PM-5: scaffold-all-tasks walks every slice and returns per-slice counts', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmap());
  const plan1 = [
    '---', 'slice: "M001-S001"', 'milestone: "M001"', '---', '',
    '<task id="M001-S001-T0001" wave="1" tier="sonnet" depends_on=""><name>N</name><action>A</action><done>D</done></task>',
  ].join('\n');
  const plan2 = [
    '---', 'slice: "M001-S002"', 'milestone: "M001"', '---', '',
    '<task id="M001-S002-T0001" wave="2" tier="sonnet" depends_on=""><name>N</name><action>A</action><done>D</done></task>',
    '<task id="M001-S002-T0002" wave="2" tier="sonnet" depends_on="M001-S002-T0001"><name>N2</name><action>A</action><done>D</done></task>',
  ].join('\n');
  seedMilestoneDir(sandbox, 1, {});
  seedSliceDir(sandbox, 1, 1, { 'S001-PLAN.md': plan1 });
  seedSliceDir(sandbox, 1, 2, { 'S002-PLAN.md': plan2 });

  const cap = _capture();
  subcmd.run(['scaffold-all-tasks', '1'], { cwd: sandbox, stdout: cap.stub });
  const out = JSON.parse(cap.get().trim());
  assert.equal(out.reason, 'ok');
  assert.equal(out.total_tasks, 3);
  assert.equal(out.scaffolded.length, 2);
  const t2Plan = path.join(sandbox, '.nubos-pilot', 'milestones', 'M001', 'slices', 'S002', 'tasks', 'T0002', 'T0002-PLAN.md');
  const body = fs.readFileSync(t2Plan, 'utf-8');
  assert.match(body, /- "M001-S002-T0001"/);
});

test('PM-6: scaffold-slice-tasks is idempotent (does not overwrite existing task files)', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmap());
  const slicePlan = [
    '---', 'slice: "M001-S001"', '---', '',
    '<task id="M001-S001-T0001" wave="1" tier="sonnet" depends_on=""><name>N</name><action>A</action><done>D</done></task>',
  ].join('\n');
  seedMilestoneDir(sandbox, 1, {});
  seedSliceDir(sandbox, 1, 1, { 'S001-PLAN.md': slicePlan });
  subcmd.run(['scaffold-slice-tasks', '1', '1'], { cwd: sandbox, stdout: _capture().stub });
  const t1Plan = path.join(sandbox, '.nubos-pilot', 'milestones', 'M001', 'slices', 'S001', 'tasks', 'T0001', 'T0001-PLAN.md');
  fs.writeFileSync(t1Plan, '# user edits\n');
  subcmd.run(['scaffold-slice-tasks', '1', '1'], { cwd: sandbox, stdout: _capture().stub });
  assert.equal(fs.readFileSync(t1Plan, 'utf-8'), '# user edits\n');
});

test('PM-7: abort removes all slice dirs but preserves milestone dir', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmap());
  seedMilestoneDir(sandbox, 1, { 'M001-CONTEXT.md': '# ctx' });
  seedSliceDir(sandbox, 1, 1, { 'S001-PLAN.md': 'x' });
  seedSliceDir(sandbox, 1, 2, { 'S002-PLAN.md': 'x' });
  subcmd.run(['abort', '1'], { cwd: sandbox, stdout: _capture().stub });
  assert.ok(fs.existsSync(path.join(sandbox, '.nubos-pilot', 'milestones', 'M001', 'M001-CONTEXT.md')));
  assert.ok(!fs.existsSync(path.join(sandbox, '.nubos-pilot', 'milestones', 'M001', 'slices', 'S001')));
  assert.ok(!fs.existsSync(path.join(sandbox, '.nubos-pilot', 'milestones', 'M001', 'slices', 'S002')));
});

test('PM-8: milestone-not-found when roadmap lacks that id', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmap());
  assert.throws(
    () => subcmd.run(['init', '999'], { cwd: sandbox, stdout: _capture().stub }),
    (err) => err && err.code === 'plan-milestone-not-found',
  );
});

test('PM-9: unknown verb throws', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmap());
  assert.throws(
    () => subcmd.run(['bad', '1'], { cwd: sandbox, stdout: _capture().stub }),
    (err) => err && err.code === 'plan-milestone-unknown-verb',
  );
});

test('PM-10: scaffold-all-tasks renumbers task ids per slice when planner numbered globally', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmap());
  seedMilestoneDir(sandbox, 1, {});
  const plan1 = [
    '---', 'slice: "M001-S001"', 'milestone: "M001"', '---', '',
    '<task id="M001-S001-T0001" wave="1" tier="sonnet" depends_on=""><name>A</name><action>A</action><done>D</done></task>',
    '<task id="M001-S001-T0002" wave="1" tier="sonnet" depends_on=""><name>B</name><action>A</action><done>D</done></task>',
    '<task id="M001-S001-T0003" wave="1" tier="sonnet" depends_on=""><name>C</name><action>A</action><done>D</done></task>',
  ].join('\n');
  const plan2 = [
    '---', 'slice: "M001-S002"', 'milestone: "M001"', '---', '',
    '<task id="M001-S002-T0004" wave="2" tier="sonnet" depends_on="M001-S001-T0003"><name>D</name><action>A</action><done>D</done></task>',
    '<task id="M001-S002-T0005" wave="2" tier="sonnet" depends_on=""><name>E</name><action>A</action><done>D</done></task>',
  ].join('\n');
  const plan3 = [
    '---', 'slice: "M001-S003"', 'milestone: "M001"', '---', '',
    '<task id="M001-S003-T0006" wave="3" tier="sonnet" depends_on="M001-S002-T0004"><name>F</name><action>A</action><done>D</done></task>',
    '<task id="M001-S003-T0007" wave="3" tier="sonnet" depends_on="M001-S002-T0005,M001-S001-T0001"><name>G</name><action>A</action><done>D</done></task>',
  ].join('\n');
  seedSliceDir(sandbox, 1, 1, { 'S001-PLAN.md': plan1 });
  seedSliceDir(sandbox, 1, 2, { 'S002-PLAN.md': plan2 });
  seedSliceDir(sandbox, 1, 3, { 'S003-PLAN.md': plan3 });

  const cap = _capture();
  subcmd.run(['scaffold-all-tasks', '1'], { cwd: sandbox, stdout: cap.stub });
  const out = JSON.parse(cap.get().trim());
  assert.equal(out.reason, 'ok');
  assert.equal(out.total_tasks, 7);

  const tasksBase = path.join(sandbox, '.nubos-pilot', 'milestones', 'M001', 'slices');
  assert.ok(fs.existsSync(path.join(tasksBase, 'S001', 'tasks', 'T0001')));
  assert.ok(fs.existsSync(path.join(tasksBase, 'S001', 'tasks', 'T0002')));
  assert.ok(fs.existsSync(path.join(tasksBase, 'S001', 'tasks', 'T0003')));
  assert.ok(fs.existsSync(path.join(tasksBase, 'S002', 'tasks', 'T0001')));
  assert.ok(fs.existsSync(path.join(tasksBase, 'S002', 'tasks', 'T0002')));
  assert.ok(!fs.existsSync(path.join(tasksBase, 'S002', 'tasks', 'T0004')));
  assert.ok(fs.existsSync(path.join(tasksBase, 'S003', 'tasks', 'T0001')));
  assert.ok(fs.existsSync(path.join(tasksBase, 'S003', 'tasks', 'T0002')));
  assert.ok(!fs.existsSync(path.join(tasksBase, 'S003', 'tasks', 'T0006')));

  const s2t1 = fs.readFileSync(path.join(tasksBase, 'S002', 'tasks', 'T0001', 'T0001-PLAN.md'), 'utf-8');
  assert.match(s2t1, /id: "M001-S002-T0001"/);
  assert.match(s2t1, /- "M001-S001-T0003"/);

  const s3t1 = fs.readFileSync(path.join(tasksBase, 'S003', 'tasks', 'T0001', 'T0001-PLAN.md'), 'utf-8');
  assert.match(s3t1, /id: "M001-S003-T0001"/);
  assert.match(s3t1, /- "M001-S002-T0001"/);

  const s3t2 = fs.readFileSync(path.join(tasksBase, 'S003', 'tasks', 'T0002', 'T0002-PLAN.md'), 'utf-8');
  assert.match(s3t2, /id: "M001-S003-T0002"/);
  assert.match(s3t2, /- "M001-S002-T0002"/);
  assert.match(s3t2, /- "M001-S001-T0001"/);

  const s2PlanRaw = fs.readFileSync(path.join(tasksBase, 'S002', 'S002-PLAN.md'), 'utf-8');
  assert.match(s2PlanRaw, /id="M001-S002-T0001"/);
  assert.match(s2PlanRaw, /id="M001-S002-T0002"/);
  assert.doesNotMatch(s2PlanRaw, /T0004/);
  assert.doesNotMatch(s2PlanRaw, /T0005/);

  assert.deepEqual(out.normalized_ids['M001-S002-T0004'], 'M001-S002-T0001');
  assert.deepEqual(out.normalized_ids['M001-S002-T0005'], 'M001-S002-T0002');
  assert.deepEqual(out.normalized_ids['M001-S003-T0006'], 'M001-S003-T0001');
  assert.deepEqual(out.normalized_ids['M001-S003-T0007'], 'M001-S003-T0002');
});

test('PM-11: scaffold-all-tasks is idempotent — already-normalized ids stay unchanged', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmap());
  seedMilestoneDir(sandbox, 1, {});
  const plan1 = [
    '---', 'slice: "M001-S001"', 'milestone: "M001"', '---', '',
    '<task id="M001-S001-T0001" wave="1" tier="sonnet" depends_on=""><name>A</name><action>A</action><done>D</done></task>',
  ].join('\n');
  const plan2 = [
    '---', 'slice: "M001-S002"', 'milestone: "M001"', '---', '',
    '<task id="M001-S002-T0001" wave="2" tier="sonnet" depends_on="M001-S001-T0001"><name>B</name><action>A</action><done>D</done></task>',
  ].join('\n');
  seedSliceDir(sandbox, 1, 1, { 'S001-PLAN.md': plan1 });
  seedSliceDir(sandbox, 1, 2, { 'S002-PLAN.md': plan2 });

  subcmd.run(['scaffold-all-tasks', '1'], { cwd: sandbox, stdout: _capture().stub });
  const cap = _capture();
  subcmd.run(['scaffold-all-tasks', '1'], { cwd: sandbox, stdout: cap.stub });
  const out = JSON.parse(cap.get().trim());
  assert.deepEqual(out.normalized_ids, {});
});

test('PM-13: scaffold accepts <files_modified> tag and strips bullet prefixes', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmap());
  seedMilestoneDir(sandbox, 1, {});
  const slicePlan = [
    '---', 'slice: "M001-S001"', 'milestone: "M001"', '---', '',
    '<task id="M001-S001-T0001" wave="1" tier="sonnet" depends_on="">',
    '  <name>Multi-file task</name>',
    '  <files_modified>',
    '    - src/a.ts',
    '    - src/b.ts',
    '    - src/c.ts',
    '  </files_modified>',
    '  <action>Touch three files.</action>',
    '  <done>Done.</done>',
    '</task>',
  ].join('\n');
  seedSliceDir(sandbox, 1, 1, { 'S001-PLAN.md': slicePlan });
  subcmd.run(['scaffold-slice-tasks', '1', '1'], { cwd: sandbox, stdout: _capture().stub });
  const body = fs.readFileSync(
    path.join(sandbox, '.nubos-pilot', 'milestones', 'M001', 'slices', 'S001', 'tasks', 'T0001', 'T0001-PLAN.md'),
    'utf-8',
  );
  assert.match(body, /- "src\/a.ts"/);
  assert.match(body, /- "src\/b.ts"/);
  assert.match(body, /- "src\/c.ts"/);
  assert.doesNotMatch(body, /- "- /);
});

test('PM-12: scaffold-slice-tasks renumbers its own slice when ids do not start at T0001', () => {
  const sandbox = makeSandbox();
  seedRoadmapYaml(sandbox, _roadmap());
  seedMilestoneDir(sandbox, 1, {});
  const plan2 = [
    '---', 'slice: "M001-S002"', 'milestone: "M001"', '---', '',
    '<task id="M001-S002-T0004" wave="2" tier="sonnet" depends_on=""><name>A</name><action>A</action><done>D</done></task>',
    '<task id="M001-S002-T0005" wave="2" tier="sonnet" depends_on=""><name>B</name><action>A</action><done>D</done></task>',
  ].join('\n');
  seedSliceDir(sandbox, 1, 2, { 'S002-PLAN.md': plan2 });

  const cap = _capture();
  subcmd.run(['scaffold-slice-tasks', '1', '2'], { cwd: sandbox, stdout: cap.stub });
  const out = JSON.parse(cap.get().trim());
  assert.equal(out.task_count, 2);

  const tasksBase = path.join(sandbox, '.nubos-pilot', 'milestones', 'M001', 'slices', 'S002', 'tasks');
  assert.ok(fs.existsSync(path.join(tasksBase, 'T0001')));
  assert.ok(fs.existsSync(path.join(tasksBase, 'T0002')));
  assert.ok(!fs.existsSync(path.join(tasksBase, 'T0004')));

  const planRaw = fs.readFileSync(
    path.join(sandbox, '.nubos-pilot', 'milestones', 'M001', 'slices', 'S002', 'S002-PLAN.md'),
    'utf-8',
  );
  assert.match(planRaw, /id="M001-S002-T0001"/);
  assert.doesNotMatch(planRaw, /T0004/);
});
