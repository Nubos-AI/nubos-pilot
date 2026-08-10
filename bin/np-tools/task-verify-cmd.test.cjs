'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const subcmd = require('./task-verify-cmd.cjs');

const _roots = [];

function _mkProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-tvc-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  fs.writeFileSync(path.join(root, '.nubos-pilot', 'STATE.md'), '---\nschema_version: 2\n---\n', 'utf-8');
  _roots.push(root);
  return root;
}

function _seedTask(root, taskId, body) {
  const m = taskId.match(/^(M\d{3,})-(S\d{3,})-(T\d{4,})$/);
  const [, mId, sId, tId] = m;
  const dir = path.join(root, '.nubos-pilot', 'milestones', mId, 'slices', sId, 'tasks', tId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, tId + '-PLAN.md'),
    ['---', `id: ${taskId}`, `milestone: ${mId}`, `slice: ${mId}-${sId}`,
      'type: execute', 'status: pending', 'files_modified: []', '---', '', body].join('\n'),
    'utf-8');
}

function _cap() { let b = ''; return { stub: { write: (s) => { b += s; } }, get: () => b }; }

after(() => {
  while (_roots.length) {
    const r = _roots.pop();
    try { fs.rmSync(r, { recursive: true, force: true }); } catch {}
  }
});

test('TVC-1: prints the executable verify lines, dropping comments and blanks', () => {
  const root = _mkProject();
  _seedTask(root, 'M001-S001-T0001', [
    '<verify>',
    '# this is a comment',
    'npm test',
    '',
    'npx tsc --noEmit',
    '</verify>',
  ].join('\n'));
  const cap = _cap();
  subcmd.run(['M001-S001-T0001'], { cwd: root, stdout: cap.stub });
  assert.equal(cap.get(), 'npm test\nnpx tsc --noEmit\n');
});

test('TVC-2: --json emits the lines as a structured payload', () => {
  const root = _mkProject();
  _seedTask(root, 'M001-S001-T0001', '<verify>\nnpm test\n</verify>');
  const cap = _cap();
  subcmd.run(['M001-S001-T0001', '--json'], { cwd: root, stdout: cap.stub });
  assert.deepEqual(JSON.parse(cap.get()), { task_id: 'M001-S001-T0001', lines: ['npm test'] });
});

test('TVC-3: a task with no verify block fails closed, never emits an empty command (P1.1)', () => {
  const root = _mkProject();
  _seedTask(root, 'M001-S001-T0001', '# no verify block here');
  assert.throws(
    () => subcmd.run(['M001-S001-T0001'], { cwd: root, stdout: _cap().stub }),
    (err) => err.code === 'task-verify-cmd-no-verify-block',
  );
});

test('TVC-4: an empty verify block fails closed — `bash -c ""` would exit 0 and read as green (P1.1)', () => {
  const root = _mkProject();
  _seedTask(root, 'M001-S001-T0001', '<verify>\n\n# only a comment\n</verify>');
  assert.throws(
    () => subcmd.run(['M001-S001-T0001'], { cwd: root, stdout: _cap().stub }),
    (err) => err.code === 'task-verify-cmd-no-verify-block',
  );
});

test('TVC-5: invalid task id is rejected', () => {
  const root = _mkProject();
  assert.throws(
    () => subcmd.run(['nope'], { cwd: root, stdout: _cap().stub }),
    (err) => err.code === 'task-verify-cmd-invalid-task-id',
  );
});

test('TVC-6: missing task plan is reported, not silently empty', () => {
  const root = _mkProject();
  assert.throws(
    () => subcmd.run(['M009-S009-T0009'], { cwd: root, stdout: _cap().stub }),
    (err) => err.code === 'task-verify-cmd-plan-not-found',
  );
});

test('TVC-7: multiple verify blocks are concatenated in order', () => {
  const root = _mkProject();
  _seedTask(root, 'M001-S001-T0001', '<verify>\na\n</verify>\ntext\n<verify>\nb\n</verify>');
  const cap = _cap();
  subcmd.run(['M001-S001-T0001'], { cwd: root, stdout: cap.stub });
  assert.equal(cap.get(), 'a\nb\n');
});

// D1: <automated> is the canonical container the planner is REQUIRED to emit
// (agents/np-planner.md answer_validation #5/#7, np-plan-checker.md Dimension 7).
// Every one of the 409 <automated> tags in the nubos-context corpus used to be
// handed to `bash -c` verbatim — `<automated>npm test</automated>` is a bash
// syntax error (rc=2), so verify was permanently RED on every real plan.
// The old fixture form (`<verify>\nnpm test\n</verify>`) hid this: it is the
// only shape TVC-1..7 exercised, and it is the shape no planner emits.
function _runCmd(root, taskId) {
  const cap = _cap();
  subcmd.run([taskId], { cwd: root, stdout: cap.stub });
  return cap.get().replace(/\n$/, '');
}

test('TVC-8: the canonical <automated> container is stripped — the emitted line is runnable bash (D1)', () => {
  const root = _mkProject();
  _seedTask(root, 'M001-S001-T0001', '<verify>\n<automated>npm test</automated>\n</verify>');
  assert.equal(_runCmd(root, 'M001-S001-T0001'), 'npm test');
});

test('TVC-9: the single-line corpus form <verify><automated>…</automated></verify> is runnable (D1)', () => {
  const root = _mkProject();
  _seedTask(root, 'M001-S001-T0001',
    '  <verify>\n    <automated>docker exec c php artisan test --filter="A|B"</automated>\n  </verify>');
  assert.equal(_runCmd(root, 'M001-S001-T0001'),
    'docker exec c php artisan test --filter="A|B"');
});

test('TVC-10: emitted command actually parses and runs under bash -c (D1 end-to-end)', () => {
  const root = _mkProject();
  _seedTask(root, 'M001-S001-T0001', '<verify>\n<automated>true</automated>\n</verify>');
  const cmd = _runCmd(root, 'M001-S001-T0001');
  const res = spawnSync('bash', ['-c', cmd], { encoding: 'utf-8' });
  assert.equal(res.status, 0,
    'the verify command must be executable bash — got rc=' + res.status + ': ' + res.stderr);
});

test('TVC-11: HTML entities are decoded — real plans carry &amp;&amp; and &lt; (D1)', () => {
  const root = _mkProject();
  _seedTask(root, 'M001-S001-T0001',
    '<verify>\n<automated>grep -q &quot;x&quot; f.json &amp;&amp; ! grep -q &#39;y&#39; f.json</automated>\n</verify>');
  assert.equal(_runCmd(root, 'M001-S001-T0001'),
    'grep -q "x" f.json && ! grep -q \'y\' f.json');
});

test('TVC-12: &amp;amp; decodes to &amp;, not to && — entity decoding is single-pass (D1)', () => {
  const root = _mkProject();
  _seedTask(root, 'M001-S001-T0001', '<verify>\n<automated>echo &amp;amp;lt;</automated>\n</verify>');
  assert.equal(_runCmd(root, 'M001-S001-T0001'), 'echo &amp;lt;');
});

test('TVC-13: a <manual> step never reaches bash — automated wins, manual is dropped (D1)', () => {
  const root = _mkProject();
  _seedTask(root, 'M001-S001-T0001', [
    '<verify>',
    '<automated>npm test</automated>',
    '<manual>rm -rf / # a human procedure, never a command</manual>',
    '</verify>',
  ].join('\n'));
  const out = _runCmd(root, 'M001-S001-T0001');
  assert.equal(out, 'npm test');
  assert.ok(!/rm -rf/.test(out), '<manual> content must never enter the bash string');
});

test('TVC-14: a verify block with ONLY a <manual> step fails closed — no empty command (D1)', () => {
  const root = _mkProject();
  _seedTask(root, 'M001-S001-T0001',
    '<verify>\n<manual>Open the app and click around.</manual>\n</verify>');
  assert.throws(
    () => subcmd.run(['M001-S001-T0001'], { cwd: root, stdout: _cap().stub }),
    (err) => err.code === 'task-verify-cmd-no-verify-block',
    'bash -c "" exits 0 and would read as a passing verify',
  );
});

test('TVC-15: an unclosed <manual> does not leak its body into bash (D1 fail-closed)', () => {
  const root = _mkProject();
  _seedTask(root, 'M001-S001-T0001',
    '<verify>\n<automated>npm test</automated>\n<manual>click around\n</verify>');
  assert.equal(_runCmd(root, 'M001-S001-T0001'), 'npm test');
});

test('TVC-16: an empty <automated> container fails closed (D1)', () => {
  const root = _mkProject();
  _seedTask(root, 'M001-S001-T0001', '<verify>\n<automated>   </automated>\n</verify>');
  assert.throws(
    () => subcmd.run(['M001-S001-T0001'], { cwd: root, stdout: _cap().stub }),
    (err) => err.code === 'task-verify-cmd-no-verify-block',
  );
});

test('TVC-17: multiple <automated> containers across blocks keep plan order (D1)', () => {
  const root = _mkProject();
  _seedTask(root, 'M001-S001-T0001', [
    '<verify><automated>a</automated></verify>',
    'prose between the blocks',
    '<verify>',
    '  <automated>b</automated>',
    '  <automated>c</automated>',
    '</verify>',
  ].join('\n'));
  assert.equal(_runCmd(root, 'M001-S001-T0001'), 'a\nb\nc');
});
