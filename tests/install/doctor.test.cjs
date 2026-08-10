const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function mkTmp(scope) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'np-' + scope + '-'));
}
function capture() {
  let buf = '';
  return { stub: { write: (s) => { buf += s; return true; } }, get: () => buf };
}

const REPO_ROOT = path.join(__dirname, '..', '..');

// Build a REAL install for `runtimes` by driving the installer's own asset planner
// and manifest writer (lib/install/runtime-assets.cjs + lib/install/manifest.cjs).
// Not a hand-faked directory tree: whatever install actually writes for these
// runtimes is what doctor is then pointed at. bin/install.js is deliberately not
// invoked — it is interactive — but the config shape written here mirrors the one
// it produces (`runtimes: []` + legacy scalar `runtime`).
function installRuntimes(root, runtimes) {
  const runtimeAssets = require('../../lib/install/runtime-assets.cjs');
  const manifestMod = require('../../lib/install/manifest.cjs');
  const payloadDir = path.join(root, '.claude', 'nubos-pilot');
  fs.mkdirSync(payloadDir, { recursive: true });
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.nubos-pilot', 'config.json'),
    JSON.stringify({ runtime: runtimes[0], runtimes, scope: 'local' }),
  );
  const plans = runtimeAssets.planRuntimeAssets({
    selectedRuntimes: runtimes,
    scope: 'local',
    projectRoot: root,
    workflowsDir: path.join(REPO_ROOT, 'workflows'),
    agentsDir: path.join(REPO_ROOT, 'agents'),
    skillsDir: null,
  });
  runtimeAssets.writeRuntimeAssets(plans);
  manifestMod.writeManifest(payloadDir, {
    version: require('../../package.json').version,
    timestamp: new Date().toISOString(),
    files: runtimeAssets.manifestEntriesForPlans(plans),
  });
  return { payloadDir, plans };
}

async function auditIds(root, args) {
  const doctor = require('../../bin/np-tools/doctor.cjs');
  const cap = capture();
  await doctor.run(args || [], { cwd: root, stdout: cap.stub, stderr: capture().stub });
  return JSON.parse(cap.get());
}

test('doctor: default run emits {issues: [...]} without mutating FS (INST-05, D-15)', async (t) => {
  const doctor = require('../../bin/np-tools/doctor.cjs');
  const root = mkTmp('doctor-default');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  const before = fs.readdirSync(root);
  const cap = capture();
  await doctor.run([], { cwd: root, stdout: cap.stub });
  const payload = JSON.parse(cap.get());
  assert.ok(Array.isArray(payload.issues), 'default run must emit issues array');
  assert.deepEqual(fs.readdirSync(root), before, 'FS unchanged in default run');
});

test('doctor: missing manifest produces issue {id: "missing-manifest"} (INST-05)', async (t) => {
  const doctor = require('../../bin/np-tools/doctor.cjs');
  const root = mkTmp('doctor-missing');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  const cap = capture();
  await doctor.run([], { cwd: root, stdout: cap.stub });
  const payload = JSON.parse(cap.get());
  assert.ok(payload.issues.some((i) => i.id === 'missing-manifest'),
    'must report missing-manifest when .claude/nubos-pilot/.manifest.json absent');
});

test('doctor: --fix applies auto-fixable issues without prompting (D-16)', async (t) => {
  const doctor = require('../../bin/np-tools/doctor.cjs');
  const root = mkTmp('doctor-fix');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  const cap = capture();
  let askCalled = false;
  const mockAskUser = async () => { askCalled = true; throw new Error('must not prompt for auto-fix'); };
  await doctor.run(['--fix'], { cwd: root, stdout: cap.stub, askUser: mockAskUser });
  assert.equal(askCalled, false, 'auto-fixable issues must never call askUser (D-16 whitelist)');
});

// P2.6 / P2.7: doctor claimed 12 checks while running 13 (orphan checkpoints was
// undocumented), always exited 0 even on error severity, looked for the critic
// agents in the wrong directory, and reported prompt-fixes as "applied" with no
// repair code behind them.
// The doc side is a CONDITIONAL assertion: it only bites on a number it can find.
// It previously matched English "13 checks" / "13-check" only, so "13 Prüfungen"
// next to a 14-check _audit passed vacuously — and several workflow docs here are
// German. Widening the grammar and requiring each file to state the count at all
// closes both the language gap and the drop-the-number vacuum. It still cannot
// catch a doc that describes the count in prose ("a baker's dozen of checks");
// that residue is accepted, not claimed as covered.
test('DOC-P27-1: the documented check count matches the checks _audit actually runs', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'bin', 'np-tools', 'doctor.cjs'), 'utf-8');
  const auditStart = src.indexOf('function _audit');
  const auditBody = src.slice(auditStart, src.indexOf('\n}', auditStart));
  const actual = new Set(auditBody.match(/_check[A-Za-z]+/g) || []).size;

  const COUNT_RE = /(\d+)[-\s]+(?:checks?|pr(?:ü|ue)fungen?)\b/gi;
  const surfaces = [
    'workflows/doctor.md',
    'README.md',
    'bin/np-tools/_commands.cjs',
    '../docs/v1/troubleshooting.md',
  ];
  for (const rel of surfaces) {
    const raw = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
    const claimed = [...raw.matchAll(COUNT_RE)].map((m) => Number(m[1]));
    assert.ok(claimed.length > 0,
      rel + ' states no check count at all — the count assertion would pass vacuously');
    for (const n of claimed) {
      assert.equal(n, actual, rel + ' claims ' + n + ' checks but _audit runs ' + actual);
    }
  }
});

// Executes the repair dispatch instead of grepping for the symbol. `constructor`
// and `toString` are the regression: with a `{}`-backed registry they resolved to
// inherited Object.prototype functions, reached askUser(), and were reported
// applied as `<id>-repaired` — a repair that never ran.
test('DOC-P27-2: no prompt-fixable issue is reported applied without an own handler', async () => {
  const doctor = require('../../bin/np-tools/doctor.cjs');
  const ids = ['askuser-broken', 'constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty'];
  const issues = ids.map((id) => ({ id, severity: 'warn', fixable: 'prompt' }));
  let asked = 0;
  const askUser = async () => { asked += 1; return { value: true }; };

  const { applied, skipped } = await doctor._applyFixes(
    issues, null, askUser, { write: () => true });

  assert.equal(asked, 0,
    'no handler exists for any of these ids — none may reach askUser()');
  assert.deepEqual(applied, [],
    'a phantom repair was reported applied: ' + JSON.stringify(applied));
  assert.deepEqual(
    skipped.map((s) => s.reason),
    ids.map(() => 'no-repair-implemented'),
    'every handler-less prompt issue must be skipped as no-repair-implemented');
});

test('DOC-P27-2b: the handler registry has a null prototype', () => {
  const doctor = require('../../bin/np-tools/doctor.cjs');
  assert.equal(Object.getPrototypeOf(doctor.PROMPT_FIX_HANDLERS), null,
    'a prototype-bearing registry makes constructor/toString resolve to truthy handlers');
});

// P2.6 core: "fires on a healthy install with a hint that can never fix it".
// Correcting the path alone fixed this for Claude only — the lookup hardcoded
// getRuntimeMeta('claude'), so every non-Claude install kept the false positive.
for (const runtimes of [['claude'], ['codex', 'gemini'], ['opencode'], ['codex', 'claude']]) {
  test('DOC-P27-3: healthy ' + runtimes.join('+') + ' install reports no missing agents dir (P2.6)', async (t) => {
    const root = mkTmp('doctor-rt-' + runtimes.join('-'));
    t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
    installRuntimes(root, runtimes);
    const payload = await auditIds(root, []);
    const hits = payload.issues.filter((i) => i.id === 'nubosloop-agents-dir-missing'
      || i.id === 'nubosloop-critic-missing');
    assert.deepEqual(hits, [],
      'healthy ' + runtimes.join('+') + ' install must not be told to fix a dir its runtimes never use: '
        + JSON.stringify(hits));
  });
}

test('DOC-P27-3b: a genuinely broken agents dir is still caught, per runtime', async (t) => {
  const root = mkTmp('doctor-rt-broken');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  installRuntimes(root, ['opencode']);
  // opencode writes its agents to .opencode/agent — the dir the old check never looked at.
  fs.rmSync(path.join(root, '.opencode', 'agent'), { recursive: true, force: true });
  const payload = await auditIds(root, []);
  const hit = payload.issues.find((i) => i.id === 'nubosloop-agents-dir-missing');
  assert.ok(hit, 'a removed agents dir must still be reported');
  assert.equal(hit.details.runtime, 'opencode', 'the finding must name the runtime it applies to');
  assert.ok(hit.details.expected.endsWith(path.join('.opencode', 'agent')),
    'the finding must point at the dir this runtime actually uses, got ' + hit.details.expected);
});

test('DOC-P27-3c: a single missing critic is caught for a non-Claude runtime', async (t) => {
  const root = mkTmp('doctor-rt-critic');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  installRuntimes(root, ['opencode']);
  fs.rmSync(path.join(root, '.opencode', 'agent', 'np-critic-tests.md'), { force: true });
  const payload = await auditIds(root, []);
  const hit = payload.issues.find((i) => i.id === 'nubosloop-critic-missing');
  assert.ok(hit, 'a removed critic agent must be reported');
  assert.equal(hit.details.agent, 'np-critic-tests');
  assert.equal(hit.details.runtime, 'opencode');
});

// Defect 4: doctor is a diagnostic — the default run reports, --fix repairs.
// The sweep used to delete unconditionally, contradicting INST-05/D-15.
test('DOC-P27-4: default run reports orphan tmp files but does not delete them', async (t) => {
  const root = mkTmp('doctor-tmp-readonly');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  const orphan = path.join(root, '.nubos-pilot', 'stale.tmp');
  fs.writeFileSync(orphan, 'x');
  const old = Date.now() - 2 * 60 * 60 * 1000;
  fs.utimesSync(orphan, old / 1000, old / 1000);

  const payload = await auditIds(root, []);
  assert.ok(fs.existsSync(orphan), 'a doctor run without --fix must not delete anything');
  const hit = payload.issues.find((i) => i.id === 'orphan-tmp-files');
  assert.ok(hit, 'the stale tmp file must still be REPORTED without --fix');
  assert.equal(hit.details.found, 1);
});

test('DOC-P27-4b: --fix sweeps orphan tmp files and reports them applied, not skipped', async (t) => {
  const root = mkTmp('doctor-tmp-fix');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  const orphan = path.join(root, '.nubos-pilot', 'stale.tmp');
  const fresh = path.join(root, '.nubos-pilot', 'fresh.tmp');
  fs.writeFileSync(orphan, 'x');
  fs.writeFileSync(fresh, 'x');
  const old = Date.now() - 2 * 60 * 60 * 1000;
  fs.utimesSync(orphan, old / 1000, old / 1000);

  const payload = await auditIds(root, ['--fix']);
  assert.ok(!fs.existsSync(orphan), '--fix must sweep tmp files older than 1h');
  assert.ok(fs.existsSync(fresh), '--fix must not touch a fresh tmp file — it may be in flight');
  assert.ok(payload.applied.some((a) => a.id === 'orphan-tmp-files-cleaned'),
    'a sweep that happened must be reported applied, got: ' + JSON.stringify(payload.applied));
  assert.ok(!payload.skipped.some((s) => s.id === 'orphan-tmp-files-cleaned'),
    'a completed sweep must never be reported as skipped/no-auto-handler');
});
