const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');

const statsCli = require('./stats.cjs');

const _sandboxes = [];

function makeSink() {
  const chunks = [];
  const w = new Writable({
    write(chunk, _enc, cb) { chunks.push(chunk); cb(); },
  });
  w.toString = () => Buffer.concat(chunks.map((c) => Buffer.isBuffer(c) ? c : Buffer.from(String(c)))).toString('utf-8');
  return w;
}

function makeSandbox(yaml, stateMd) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-stats-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  fs.writeFileSync(path.join(root, '.nubos-pilot', 'roadmap.yaml'), yaml);
  fs.writeFileSync(path.join(root, '.nubos-pilot', 'STATE.md'), stateMd);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: root });
  _sandboxes.push(root);
  return root;
}

test.afterEach(() => {
  while (_sandboxes.length) {
    try { fs.rmSync(_sandboxes.pop(), { recursive: true, force: true }); } catch {  }
  }
});

const DEMO_YAML = [
  'milestones:',
  '  - id: v1.0',
  '    name: v1',
  '    phases:',
  '      - number: 1',
  '        name: Foundation',
  '        slug: foundation',
  '        status: done',
  '        plans:',
  '          - id: 01-01',
  '            title: First',
  '            complete: true',
  '      - number: 2',
  '        name: Next',
  '        slug: next',
  '        status: in-progress',
  '        plans:',
  '          - id: 02-01',
  '            title: Second',
  '            complete: false',
].join('\n') + '\n';

const DEMO_STATE = [
  '---',
  'schema_version: 2',
  'milestone: v1.0',
  'milestone_name: v1',
  'last_updated: "2026-04-17T10:00:00Z"',
  'progress:',
  '  total_phases: 2',
  '  completed_phases: 1',
  '  total_plans: 2',
  '  completed_plans: 1',
  '  percent: 50',
  '---',
  '',
  '# STATE',
].join('\n') + '\n';

test('STATS-1: stats json emits schema_version + phases + git + metrics_by_phase', async () => {
  const sb = makeSandbox(DEMO_YAML, DEMO_STATE);
  const stdout = makeSink();
  const stderr = makeSink();
  const code = await statsCli.run(['json'], { cwd: sb, stdout, stderr });
  assert.equal(code, 0, 'stderr=' + stderr.toString());
  const parsed = JSON.parse(stdout.toString());
  assert.equal(parsed.schema_version, 2);
  assert.ok(parsed.milestone);
  assert.equal(parsed.phases.length, 2);
  assert.equal(parsed.plans_total, 2);
  assert.equal(parsed.plans_complete, 1);
  assert.equal(parsed.percent, 50);
  assert.ok(parsed.tasks);
  assert.equal(typeof parsed.tasks.total, 'number');
  assert.equal(typeof parsed.tasks.complete, 'number');
  assert.equal(typeof parsed.tasks.percent, 'number');
  assert.ok(parsed.slices);
  assert.equal(typeof parsed.slices.total, 'number');
  assert.equal(typeof parsed.slices.complete, 'number');
  assert.equal(typeof parsed.slices.percent, 'number');
  assert.ok(parsed.git);
  assert.ok(typeof parsed.git.commits === 'number');
  assert.ok(parsed.metrics_by_phase);
});

function writeTaskPlan(root, mNum, sNum, tNum, status) {
  const mid = 'M' + String(mNum).padStart(3, '0');
  const sid = 'S' + String(sNum).padStart(3, '0');
  const tid = 'T' + String(tNum).padStart(4, '0');
  const dir = path.join(root, '.nubos-pilot', 'milestones', mid, 'slices', sid, 'tasks', tid);
  fs.mkdirSync(dir, { recursive: true });
  const fm = [
    '---',
    `id: ${mid}-${sid}-${tid}`,
    `slice: ${mid}-${sid}`,
    `milestone: ${mid}`,
    'type: execute',
    `status: ${status}`,
    'tier: sonnet',
    'owner: executor',
    `wave: ${sNum}`,
    'depends_on: []',
    'files_modified: []',
    'autonomous: true',
    'must_haves: {}',
    '---',
    '',
    `# ${mid}-${sid}-${tid}`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, tid + '-PLAN.md'), fm);
}

test('STATS-4: tasks + slices percent reflect filesystem task status', async () => {
  const sb = makeSandbox(DEMO_YAML, DEMO_STATE);
  writeTaskPlan(sb, 1, 1, 1, 'done');
  writeTaskPlan(sb, 1, 1, 2, 'done');
  writeTaskPlan(sb, 1, 2, 1, 'done');
  writeTaskPlan(sb, 1, 2, 2, 'pending');
  writeTaskPlan(sb, 1, 3, 1, 'pending');
  const stdout = makeSink();
  const stderr = makeSink();
  const code = await statsCli.run(['json'], { cwd: sb, stdout, stderr });
  assert.equal(code, 0, 'stderr=' + stderr.toString());
  const parsed = JSON.parse(stdout.toString());
  assert.equal(parsed.tasks.total, 5);
  assert.equal(parsed.tasks.complete, 3);
  assert.equal(parsed.tasks.percent, 60);
  assert.equal(parsed.slices.total, 3);
  assert.equal(parsed.slices.complete, 1, 'only S001 has all tasks done');
  assert.equal(parsed.slices.percent, 33);
});

test('STATS-5: tasks + slices are 0 when nothing scaffolded', async () => {
  const sb = makeSandbox(DEMO_YAML, DEMO_STATE);
  const stdout = makeSink();
  const stderr = makeSink();
  await statsCli.run(['json'], { cwd: sb, stdout, stderr });
  const parsed = JSON.parse(stdout.toString());
  assert.equal(parsed.tasks.total, 0);
  assert.equal(parsed.tasks.percent, 0);
  assert.equal(parsed.slices.total, 0);
  assert.equal(parsed.slices.percent, 0);
});

test('STATS-6: stats bar renders two progress rows on stdout', async () => {
  const sb = makeSandbox(DEMO_YAML, DEMO_STATE);
  writeTaskPlan(sb, 1, 1, 1, 'done');
  writeTaskPlan(sb, 1, 1, 2, 'pending');
  const stdout = makeSink();
  const stderr = makeSink();
  const code = await statsCli.run(['bar'], { cwd: sb, stdout, stderr });
  assert.equal(code, 0, 'stderr=' + stderr.toString());
  const out = stdout.toString();
  assert.match(out, /Tasks .*\d+%/);
  assert.match(out, /Slices.*\d+%/);
  assert.match(out, /1\/2/);
});

test('STATS-2: unknown subcommand prints usage', async () => {
  const sb = makeSandbox(DEMO_YAML, DEMO_STATE);
  const stdout = makeSink();
  const stderr = makeSink();
  const code = await statsCli.run(['yolo'], { cwd: sb, stdout, stderr });
  assert.equal(code, 1);
  assert.match(stderr.toString(), /Usage:/);
});

test('STATS-MD-1: stats markdown emits English title + headers when no config', async () => {
  const sb = makeSandbox(DEMO_YAML, DEMO_STATE);
  writeTaskPlan(sb, 1, 1, 1, 'done');
  const stdout = makeSink();
  const stderr = makeSink();
  const code = await statsCli.run(['markdown'], { cwd: sb, stdout, stderr });
  assert.equal(code, 0, 'stderr=' + stderr.toString());
  const out = stdout.toString();
  assert.match(out, /^## Project Stats/m);
  assert.match(out, /^\*\*Milestone:\*\*/m);
  assert.match(out, /^\*\*Progress:\*\*/m);
  assert.match(out, /^### Phases/m);
  assert.match(out, /^### Metrics by Phase/m);
});

test('STATS-MD-2: stats markdown emits German labels when config.response_language=de', async () => {
  const sb = makeSandbox(DEMO_YAML, DEMO_STATE);
  fs.writeFileSync(
    path.join(sb, '.nubos-pilot', 'config.json'),
    JSON.stringify({ response_language: 'de' }),
  );
  writeTaskPlan(sb, 1, 1, 1, 'done');
  const stdout = makeSink();
  const stderr = makeSink();
  const code = await statsCli.run(['markdown'], { cwd: sb, stdout, stderr });
  assert.equal(code, 0, 'stderr=' + stderr.toString());
  const out = stdout.toString();
  assert.match(out, /^## Projekt-Stats/m);
  assert.match(out, /^\*\*Fortschritt:\*\*/m);
  assert.match(out, /^\*\*Letzte Aktivität:\*\*/m);
  assert.match(out, /^\*\*Projekt-Start:\*\*/m);
  assert.match(out, /^### Phasen/m);
  assert.match(out, /^### Metriken pro Phase/m);
  assert.match(out, /Pläne/);
  assert.equal(/^## Project Stats/m.test(out), false, 'no English title');
});

test('STATS-MD-3: --lang flag overrides config language', async () => {
  const sb = makeSandbox(DEMO_YAML, DEMO_STATE);
  fs.writeFileSync(
    path.join(sb, '.nubos-pilot', 'config.json'),
    JSON.stringify({ response_language: 'de' }),
  );
  writeTaskPlan(sb, 1, 1, 1, 'done');
  const stdout = makeSink();
  const stderr = makeSink();
  const code = await statsCli.run(['markdown', '--lang', 'en'], { cwd: sb, stdout, stderr });
  assert.equal(code, 0, 'stderr=' + stderr.toString());
  assert.match(stdout.toString(), /^## Project Stats/m);
});

test('STATS-MD-4: _renderMarkdown is a pure function callable without project', () => {
  const md = statsCli._renderMarkdown({
    schema_version: 2,
    milestone: { version: 'v1', name: 'Auth' },
    phases: [{ number: '1', name: 'F', plans_total: 2, plans_complete: 1, status: 'in-progress' }],
    plans_total: 2, plans_complete: 1, percent: 50,
    git: { commits: 5, first_commit_at: '2026-01-01' },
    last_activity: '2026-04-01T00:00:00Z',
    metrics_by_phase: {},
  }, 'de');
  assert.match(md, /Projekt-Stats/);
  assert.match(md, /Pläne/);
});

test('STATS-3: outside project emits NubosPilotError envelope', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'np-stats-outside-'));
  _sandboxes.push(tmp);
  const stdout = makeSink();
  const stderr = makeSink();
  const code = await statsCli.run(['json'], { cwd: tmp, stdout, stderr });
  assert.equal(code, 1);
  assert.match(stderr.toString(), /"code":\s*"not-in-project"/);
});
