const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cw = require('./check-workflows.cjs');

test('CW-8: SCAN_PATHS includes bin/install.js and lib/install/ (Phase 7 extension)', () => {
  const source = fs.readFileSync(path.resolve(__dirname, 'check-workflows.cjs'), 'utf8');
  assert.match(source, /bin\/install\.js/);
  assert.match(source, /lib\/install/);
  assert.deepEqual(cw.INSTALLER_SCAN_PATHS, ['bin/install.js', 'lib/install/']);
});

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cw-test-'));
}

function seed(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf-8');
  }
}

test('CW-1: absent directory returns empty violations + exitCode 0 (skip-on-absent)', () => {
  const tmp = mkTmp();
  try {
    const res = cw.checkWorkflows(path.join(tmp, 'does/not/exist'));
    assert.deepEqual(res.violations, []);
    assert.equal(res.exitCode, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CW-2: empty directory returns empty violations + exitCode 0', () => {
  const tmp = mkTmp();
  try {
    const dir = path.join(tmp, 'workflows');
    fs.mkdirSync(dir, { recursive: true });
    const res = cw.checkWorkflows(dir);
    assert.deepEqual(res.violations, []);
    assert.equal(res.exitCode, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CW-3: bare AskUserQuestion outside gateway → violation + exitCode 1', () => {
  const tmp = mkTmp();
  try {
    const dir = path.join(tmp, 'workflows');
    seed(dir, { 'bad.md': 'Please call AskUserQuestion directly here.\n' });
    const res = cw.checkWorkflows(dir);
    assert.equal(res.exitCode, 1);
    assert.equal(res.violations.length, 1);
    assert.match(res.violations[0].pattern, /AskUserQuestion/);
    assert.ok(res.violations[0].file.endsWith('bad.md'));
    assert.equal(typeof res.violations[0].line, 'number');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CW-4: direct cat .nubos-pilot read triggers violation', () => {
  const tmp = mkTmp();
  try {
    const dir = path.join(tmp, 'workflows');
    seed(dir, { 'read.md': '```bash\ncat .nubos-pilot/STATE.md\n```\n' });
    const res = cw.checkWorkflows(dir);
    assert.equal(res.exitCode, 1);
    assert.ok(res.violations.length >= 1);
    assert.ok(res.violations.some((v) => /nubos-pilot/.test(v.pattern) || /cat/.test(v.pattern)));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CW-5: single-call gateway through np-tools.cjs init does NOT violate', () => {
  const tmp = mkTmp();
  try {
    const dir = path.join(tmp, 'workflows');
    seed(dir, {
      'ok.md': '```bash\nINIT=$(node np-tools.cjs init phase-op 3)\n```\n',
    });
    const res = cw.checkWorkflows(dir);
    assert.deepEqual(res.violations, []);
    assert.equal(res.exitCode, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CW-6: CLI main reads argv[2]; violations exit 1 and write to stderr', () => {
  const { spawnSync } = require('node:child_process');
  const tmp = mkTmp();
  try {
    const dir = path.join(tmp, 'workflows');
    seed(dir, { 'bad.md': 'note: AskUserQuestion here\n' });
    const res = spawnSync(process.execPath, [path.join(__dirname, 'check-workflows.cjs'), dir], {
      encoding: 'utf-8',
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /violation/i);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CW-7: recursion detects violation in nested workflow .md file', () => {
  const tmp = mkTmp();
  try {
    const dir = path.join(tmp, 'workflows');
    seed(dir, { 'sub/deep.md': 'uses AskUserQuestion improperly\n' });
    const res = cw.checkWorkflows(dir);
    assert.equal(res.exitCode, 1);
    assert.ok(res.violations.some((v) => v.file.includes(path.join('sub', 'deep.md'))));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CW-M-1: Task spawn paired with `metrics record` inside bash block → no warning', () => {
  const tmp = mkTmp();
  try {
    const dir = path.join(tmp, 'workflows');
    seed(dir, {
      'good.md':
        '```bash\n' +
        'MODEL=$(node np-tools.cjs resolve-model planner --profile balanced)\n' +
        '# Spawn agent=np-planner tier=opus model=$MODEL\n' +
        'node np-tools.cjs metrics record --agent np-planner --phase 09 \\\n' +
        '  --tier opus --resolved-model "$MODEL" --started "$START" --ended "$END"\n' +
        '```\n',
    });
    const res = cw.checkWorkflows(dir);
    assert.equal(res.exitCode, 0);
    assert.deepEqual(res.violations, []);
    assert.deepEqual(res.warnings, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CW-M-2: Task spawn without `metrics record` → warning, exit code still 0', () => {
  const tmp = mkTmp();
  try {
    const dir = path.join(tmp, 'workflows');
    seed(dir, {
      'bad.md':
        '```bash\n' +
        'MODEL=$(node np-tools.cjs resolve-model planner)\n' +
        'Task({ subagent_type: "np-planner", model: "$MODEL" })\n' +
        'echo done\n' +
        '```\n',
    });
    const res = cw.checkWorkflows(dir);

    assert.deepEqual(res.violations, []);
    assert.equal(res.exitCode, 0);
    assert.equal(res.warnings.length, 1);
    assert.equal(res.warnings[0].pattern, 'workflow-missing-metrics');
    assert.ok(res.warnings[0].file.endsWith('bad.md'));
    assert.equal(typeof res.warnings[0].line, 'number');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CW-M-3: workflow with no Task/Spawn sites → no warning', () => {
  const tmp = mkTmp();
  try {
    const dir = path.join(tmp, 'workflows');
    seed(dir, {
      'docs-only.md':
        '# Pure documentation workflow\n\n' +
        'No bash, no Task, no Spawn. Just prose.\n',
    });
    const res = cw.checkWorkflows(dir);
    assert.equal(res.exitCode, 0);
    assert.deepEqual(res.violations, []);
    assert.deepEqual(res.warnings, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CW-M-4: Spawn agent= reference in a markdown table (prose) → NOT flagged', () => {
  const tmp = mkTmp();
  try {
    const dir = path.join(tmp, 'workflows');
    seed(dir, {
      'table.md':
        '# Naming conventions\n\n' +
        '| Legacy token | Canonical token |\n' +
        '| ------------ | --------------- |\n' +
        '| Task(…)      | Spawn agent=…   |\n',
    });
    const res = cw.checkWorkflows(dir);
    assert.deepEqual(res.warnings, []);
    assert.equal(res.exitCode, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
