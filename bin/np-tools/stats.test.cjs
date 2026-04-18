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
  assert.equal(parsed.schema_version, 1);
  assert.ok(parsed.milestone);
  assert.equal(parsed.phases.length, 2);
  assert.equal(parsed.plans_total, 2);
  assert.equal(parsed.plans_complete, 1);
  assert.equal(parsed.percent, 50);
  assert.ok(parsed.git);
  assert.ok(typeof parsed.git.commits === 'number');
  assert.ok(parsed.metrics_by_phase);
});

test('STATS-2: unknown subcommand prints usage', async () => {
  const sb = makeSandbox(DEMO_YAML, DEMO_STATE);
  const stdout = makeSink();
  const stderr = makeSink();
  const code = await statsCli.run(['yolo'], { cwd: sb, stdout, stderr });
  assert.equal(code, 1);
  assert.match(stderr.toString(), /Usage:/);
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
