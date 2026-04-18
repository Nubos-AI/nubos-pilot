const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const subcmd = require('./plan-diff.cjs');

const _repos = [];

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-plan-diff-cli-'));
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
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'seed'], { stdio: 'pipe' });
  return { abs, rel, phaseDir };
}

function planBody(tasks) {
  const lines = ['---', 'plan: 1', 'phase: 9', '---', ''];
  for (const t of tasks) {
    lines.push('<task tier="' + t.tier + '" id="' + t.id + '">body</task>');
  }
  return lines.join('\n');
}

function captureIO() {
  let sout = '';
  let serr = '';
  return {
    stdoutWrite: (s) => { sout += s; return true; },
    stderrWrite: (s) => { serr += s; return true; },
    stdout: () => sout,
    stderr: () => serr,
  };
}

function runInRepo(root, argv) {
  const prev = process.cwd();
  const po = process.stdout.write;
  const pe = process.stderr.write;
  const cap = captureIO();
  process.stdout.write = cap.stdoutWrite;
  process.stderr.write = cap.stderrWrite;
  process.chdir(root);
  let exit;
  try {
    exit = subcmd.run(argv);
  } finally {
    process.stdout.write = po;
    process.stderr.write = pe;
    process.chdir(prev);
  }
  return { exit, stdout: cap.stdout(), stderr: cap.stderr() };
}

after(() => {
  while (_repos.length) {
    const r = _repos.pop();
    try { fs.rmSync(r, { recursive: true, force: true }); } catch {}
  }
});

test('PDCLI-1: run([phase, planId]) prints combined diff when prior exists; exits 0', () => {
  const root = makeRepo();
  const { abs } = seedPlanCommit(root, '09', 'feature-set', '09-01', planBody([
    { id: '09-01-T01', tier: 'opus' },
  ]));
  fs.writeFileSync(abs, planBody([
    { id: '09-01-T01', tier: 'opus' },
    { id: '09-01-T02', tier: 'sonnet' },
  ]), 'utf-8');
  const result = runInRepo(root, ['09', '09-01']);
  assert.equal(result.exit, 0);
  assert.ok(result.stdout.includes('Semantic diff'));
  assert.ok(result.stdout.includes('Raw git diff'));
});

test('PDCLI-2: run([phase, planId]) prints empty stdout and exits 0 when no prior in HEAD', () => {
  const root = makeRepo();
  const padded = '09';
  const phaseDir = path.join(root, '.nubos-pilot', 'phases', padded + '-feature-set');
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(path.join(phaseDir, '09-01-PLAN.md'), planBody([{ id: '09-01-T01', tier: 'opus' }]), 'utf-8');
  const result = runInRepo(root, ['09', '09-01']);
  assert.equal(result.exit, 0);
  assert.equal(result.stdout, '');
});

test('PDCLI-3: run([--archive-rejected, phase, planId, --reason, text]) archives + restores, exits 0', () => {
  const root = makeRepo();
  const priorBody = planBody([{ id: '09-01-T01', tier: 'opus' }]);
  const { abs } = seedPlanCommit(root, '09', 'feature-set', '09-01', priorBody);
  fs.writeFileSync(abs, planBody([{ id: '09-01-T02', tier: 'haiku' }]), 'utf-8');
  const result = runInRepo(root, ['--archive-rejected', '09', '09-01', '--reason', 'design flaw']);
  assert.equal(result.exit, 0);
  const archivePath = result.stdout.trim();
  assert.ok(fs.existsSync(archivePath));
  const restored = fs.readFileSync(abs, 'utf-8');
  assert.equal(restored, priorBody);
});

test('PDCLI-4: run([--archive-rejected]) with missing args exits 1 with usage on stderr', () => {
  const root = makeRepo();
  const result = runInRepo(root, ['--archive-rejected']);
  assert.equal(result.exit, 1);
  assert.ok(result.stderr.includes('Usage'));
});

test('PDCLI-5: run([]) prints usage on stderr and exits 1', () => {
  const root = makeRepo();
  const r1 = runInRepo(root, []);
  assert.equal(r1.exit, 1);
  assert.ok(r1.stderr.includes('Usage'));
  const r2 = runInRepo(root, ['--help']);
  assert.equal(r2.exit, 1);
  assert.ok(r2.stderr.includes('Usage'));
});
