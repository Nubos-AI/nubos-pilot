const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const pd = require('./plan-diff.cjs');

const _repos = [];

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-plan-diff-'));
  execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'pipe' });
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@nubos-pilot.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'nubos-test']);
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  execFileSync('git', ['-C', root, 'commit', '--allow-empty', '-q', '-m', 'chore: init'], { stdio: 'pipe' });
  _repos.push(root);
  return root;
}

function seedPlanCommit(root, phase, phaseSlug, planId, body) {
  const padded = String(phase).padStart(2, '0');
  const phaseDir = path.join(root, '.nubos-pilot', 'phases', padded + '-' + phaseSlug);
  fs.mkdirSync(phaseDir, { recursive: true });
  const rel = path.join('.nubos-pilot', 'phases', padded + '-' + phaseSlug, planId + '-PLAN.md');
  const abs = path.join(root, rel);
  fs.writeFileSync(abs, body, 'utf-8');
  execFileSync('git', ['-C', root, 'add', '--', rel], { stdio: 'pipe' });
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'docs(' + planId + '): seed PLAN.md'], { stdio: 'pipe' });
  return { abs, rel, phaseDir };
}

function planBody(tasks) {
  const lines = ['---', 'plan: 1', 'phase: 9', 'requirements: [R-05]', '---', '', '## Tasks', ''];
  for (const t of tasks) {
    lines.push('<task type="auto" tier="' + t.tier + '" id="' + t.id + '">');
    lines.push('body');
    lines.push('</task>');
    lines.push('');
  }
  return lines.join('\n');
}

function inRepo(root, fn) {
  const prev = process.cwd();
  process.chdir(root);
  try { return fn(); } finally { process.chdir(prev); }
}

after(() => {
  while (_repos.length) {
    const r = _repos.pop();
    try { fs.rmSync(r, { recursive: true, force: true }); } catch {}
  }
});

test('PD-1: added task (new id in current, not in prior) is reported', () => {
  const prior = planBody([{ id: '09-01-T01', tier: 'opus' }]);
  const current = planBody([
    { id: '09-01-T01', tier: 'opus' },
    { id: '09-01-T04', tier: 'haiku' },
  ]);
  const diff = pd.semanticTaskDiff(prior, current);
  assert.deepEqual(diff.added, [{ id: '09-01-T04', tier: 'haiku' }]);
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(diff.changed, []);
});

test('PD-2: removed task (id in prior but not current) is reported', () => {
  const prior = planBody([
    { id: '09-01-T01', tier: 'opus' },
    { id: '09-01-T03', tier: 'haiku' },
  ]);
  const current = planBody([{ id: '09-01-T01', tier: 'opus' }]);
  const diff = pd.semanticTaskDiff(prior, current);
  assert.deepEqual(diff.added, []);
  assert.equal(diff.removed.length, 1);
  assert.equal(diff.removed[0].id, '09-01-T03');
  assert.deepEqual(diff.changed, []);
});

test('PD-3: tier change on same id is reported as changed', () => {
  const prior = planBody([{ id: '09-01-T01', tier: 'opus' }]);
  const current = planBody([{ id: '09-01-T01', tier: 'sonnet' }]);
  const diff = pd.semanticTaskDiff(prior, current);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(diff.changed, [{ id: '09-01-T01', field: 'tier', from: 'opus', to: 'sonnet' }]);
});

test('PD-4: non-canonical task-id formats are ignored (Pitfall 4)', () => {
  const prior = '<task tier="opus" id="T-09-01-04">x</task>\n<task tier="opus" id="T01">y</task>\n';
  const current = '<task tier="opus" id="T-09-01-04">x</task>\n<task tier="haiku" id="09-01-T05">z</task>\n';
  const diff = pd.semanticTaskDiff(prior, current);
  assert.deepEqual(diff.added, [{ id: '09-01-T05', tier: 'haiku' }]);
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(diff.changed, []);
});

test('PD-5: renderTwoPartDiff returns hasPrior=true with combined Semantic + Raw sections', () => {
  const root = makeRepo();
  const { abs } = seedPlanCommit(root, '09', 'feature-set', '09-01', planBody([
    { id: '09-01-T01', tier: 'opus' },
  ]));
  const modified = planBody([
    { id: '09-01-T01', tier: 'opus' },
    { id: '09-01-T02', tier: 'sonnet' },
  ]);
  fs.writeFileSync(abs, modified, 'utf-8');
  const r = pd.renderTwoPartDiff({ phase: '09', planId: '09-01', cwd: root });
  assert.equal(r.hasPrior, true);
  assert.ok(r.semantic.includes('09-01-T02'));
  assert.ok(r.raw.startsWith('diff --git'));
  assert.ok(r.combined.includes('Semantic diff'));
  assert.ok(r.combined.includes('Raw git diff'));
});

test('PD-6: renderTwoPartDiff returns {hasPrior:false} when HEAD has no prior PLAN.md', () => {
  const root = makeRepo();
  const padded = '09';
  const phaseDir = path.join(root, '.nubos-pilot', 'phases', padded + '-feature-set');
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(path.join(phaseDir, '09-01-PLAN.md'), planBody([{ id: '09-01-T01', tier: 'opus' }]), 'utf-8');
  const r = pd.renderTwoPartDiff({ phase: '09', planId: '09-01', cwd: root });
  assert.equal(r.hasPrior, false);
  assert.equal(r.semantic, undefined);
});

test('PD-7: archiveRejected writes PLAN-DIFF-{ISO}.md with frontmatter + restores HEAD', () => {
  const root = makeRepo();
  const priorBody = planBody([{ id: '09-01-T01', tier: 'opus' }]);
  const { abs, phaseDir } = seedPlanCommit(root, '09', 'feature-set', '09-01', priorBody);
  const newBody = planBody([
    { id: '09-01-T01', tier: 'opus' },
    { id: '09-01-T02', tier: 'sonnet' },
  ]);
  fs.writeFileSync(abs, newBody, 'utf-8');
  const archivePath = pd.archiveRejected({ phase: '09', planId: '09-01', reason: 'design flaw', cwd: root });
  assert.ok(fs.existsSync(archivePath));
  const name = path.basename(archivePath);
  assert.match(name, /^09-09-01-PLAN-DIFF-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.md$/);
  const archived = fs.readFileSync(archivePath, 'utf-8');
  assert.match(archived, /^---\n/);
  assert.ok(archived.includes('rejected_at:'));
  assert.ok(archived.includes('reason: "design flaw"'));
  assert.ok(archived.includes('09-01-T02'), 'archive must include rejected body');
  const restored = fs.readFileSync(abs, 'utf-8');
  assert.equal(restored, priorBody, 'working-tree PLAN.md must be reset to HEAD body');
  assert.ok(phaseDir);
});

test('PD-8: back-to-back archiveRejected produces distinct filenames (millisecond ISO, Pitfall 9)', () => {
  const root = makeRepo();
  const priorBody = planBody([{ id: '09-01-T01', tier: 'opus' }]);
  const { abs } = seedPlanCommit(root, '09', 'feature-set', '09-01', priorBody);
  fs.writeFileSync(abs, planBody([{ id: '09-01-T02', tier: 'haiku' }]), 'utf-8');
  const a1 = pd.archiveRejected({ phase: '09', planId: '09-01', reason: 'first', cwd: root });
  fs.writeFileSync(abs, planBody([{ id: '09-01-T03', tier: 'haiku' }]), 'utf-8');
  const a2 = pd.archiveRejected({ phase: '09', planId: '09-01', reason: 'second', cwd: root });
  assert.notEqual(a1, a2);
  assert.ok(fs.existsSync(a1));
  assert.ok(fs.existsSync(a2));
});

test('PD-9: archiveRejected with empty reason → frontmatter reason: ""', () => {
  const root = makeRepo();
  const priorBody = planBody([{ id: '09-01-T01', tier: 'opus' }]);
  const { abs } = seedPlanCommit(root, '09', 'feature-set', '09-01', priorBody);
  fs.writeFileSync(abs, planBody([{ id: '09-01-T02', tier: 'haiku' }]), 'utf-8');
  const archivePath = pd.archiveRejected({ phase: '09', planId: '09-01', reason: '', cwd: root });
  const body = fs.readFileSync(archivePath, 'utf-8');
  assert.ok(body.includes('reason: ""'));
});

test('PD-10: restoreFromHead is idempotent', () => {
  const root = makeRepo();
  const priorBody = planBody([{ id: '09-01-T01', tier: 'opus' }]);
  const { abs } = seedPlanCommit(root, '09', 'feature-set', '09-01', priorBody);
  fs.writeFileSync(abs, 'mutated', 'utf-8');
  pd.restoreFromHead({ phase: '09', planId: '09-01', cwd: root });
  assert.equal(fs.readFileSync(abs, 'utf-8'), priorBody);
  pd.restoreFromHead({ phase: '09', planId: '09-01', cwd: root });
  assert.equal(fs.readFileSync(abs, 'utf-8'), priorBody);
});

test('PD-11: semantic diff line format uses +/~/- prefixes with expected fields', () => {
  const root = makeRepo();
  const { abs } = seedPlanCommit(root, '09', 'feature-set', '09-01', planBody([
    { id: '09-01-T01', tier: 'opus' },
    { id: '09-01-T03', tier: 'haiku' },
  ]));
  fs.writeFileSync(abs, planBody([
    { id: '09-01-T01', tier: 'sonnet' },
    { id: '09-01-T04', tier: 'haiku' },
  ]), 'utf-8');
  const r = pd.renderTwoPartDiff({ phase: '09', planId: '09-01', cwd: root });
  assert.ok(r.combined.includes('+ 09-01-T04: tier=haiku'));
  assert.ok(r.combined.includes('~ 09-01-T01: tier=opus→sonnet'));
  assert.ok(r.combined.includes('- 09-01-T03'));
});

test('PD-12: rendered combined output contains no ANSI escape bytes (Pitfall 6)', () => {
  const root = makeRepo();
  const { abs } = seedPlanCommit(root, '09', 'feature-set', '09-01', planBody([
    { id: '09-01-T01', tier: 'opus' },
  ]));
  execFileSync('git', ['-C', root, 'config', '--local', 'color.ui', 'always'], { stdio: 'pipe' });
  fs.writeFileSync(abs, planBody([
    { id: '09-01-T01', tier: 'opus' },
    { id: '09-01-T02', tier: 'sonnet' },
  ]), 'utf-8');
  const r = pd.renderTwoPartDiff({ phase: '09', planId: '09-01', cwd: root });
  assert.equal(r.combined.indexOf('\x1b'), -1);
  inRepo(root, () => {  });
});
