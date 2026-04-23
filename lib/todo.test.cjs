'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { renderTodoMd, todoPath, STATUS_CHECKBOX } = require('./todo.cjs');
const { setTaskStatus } = require('./tasks.cjs');

function _writeTask(root, mNum, sNum, tNum, status, name) {
  const mId = 'M' + String(mNum).padStart(3, '0');
  const sId = 'S' + String(sNum).padStart(3, '0');
  const tId = 'T' + String(tNum).padStart(4, '0');
  const fullId = mId + '-' + sId + '-' + tId;
  const dir = path.join(root, '.nubos-pilot', 'milestones', mId, 'slices', sId, 'tasks', tId);
  fs.mkdirSync(dir, { recursive: true });
  const fm = [
    '---',
    'id: "' + fullId + '"',
    'slice: "' + mId + '-' + sId + '"',
    'milestone: "' + mId + '"',
    'type: execute',
    'status: ' + status,
    'tier: sonnet',
    'owner: np-executor',
    'wave: 1',
    'depends_on: []',
    'files_modified: []',
    'autonomous: true',
    'must_haves: {}',
    '---',
    '',
    '# ' + fullId + ' — ' + name,
    '',
  ].join('\n');
  const file = path.join(dir, tId + '-PLAN.md');
  fs.writeFileSync(file, fm, 'utf-8');
  return { fullId, sliceFullId: mId + '-' + sId, file };
}

function _sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-todo-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  return root;
}

test('TD-1: renderTodoMd writes TODO.md under slice dir', () => {
  const root = _sandbox();
  try {
    const { sliceFullId } = _writeTask(root, 1, 1, 1, 'pending', 'First task');
    const target = renderTodoMd(sliceFullId, root);
    assert.equal(target, path.join(root, '.nubos-pilot', 'milestones', 'M001', 'slices', 'S001', 'TODO.md'));
    assert.ok(fs.existsSync(target), 'TODO.md must exist');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('TD-2: frontmatter contains correct counts', () => {
  const root = _sandbox();
  try {
    _writeTask(root, 1, 1, 1, 'pending', 'A');
    _writeTask(root, 1, 1, 2, 'in-progress', 'B');
    _writeTask(root, 1, 1, 3, 'done', 'C');
    _writeTask(root, 1, 1, 4, 'done', 'D');
    _writeTask(root, 1, 1, 5, 'skipped', 'E');
    _writeTask(root, 1, 1, 6, 'parked', 'F');
    renderTodoMd('M001-S001', root);
    const raw = fs.readFileSync(todoPath('M001-S001', root), 'utf-8');
    assert.match(raw, /total:\s*6/);
    assert.match(raw, /pending:\s*1/);
    assert.match(raw, /in_progress:\s*1/);
    assert.match(raw, /done:\s*2/);
    assert.match(raw, /skipped:\s*1/);
    assert.match(raw, /parked:\s*1/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('TD-3: each status renders its correct checkbox', () => {
  const root = _sandbox();
  try {
    _writeTask(root, 2, 1, 1, 'pending', 'P');
    _writeTask(root, 2, 1, 2, 'in-progress', 'IP');
    _writeTask(root, 2, 1, 3, 'done', 'D');
    _writeTask(root, 2, 1, 4, 'skipped', 'S');
    _writeTask(root, 2, 1, 5, 'parked', 'K');
    renderTodoMd('M002-S001', root);
    const raw = fs.readFileSync(todoPath('M002-S001', root), 'utf-8');
    assert.match(raw, /- \[ \] \*\*M002-S001-T0001\*\* — P/);
    assert.match(raw, /- \[~\] \*\*M002-S001-T0002\*\* — IP/);
    assert.match(raw, /- \[x\] \*\*M002-S001-T0003\*\* — D/);
    assert.match(raw, /- \[-\] \*\*M002-S001-T0004\*\* — S/);
    assert.match(raw, /- \[!\] \*\*M002-S001-T0005\*\* — K/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('TD-4: empty slice renders "No tasks yet." placeholder', () => {
  const root = _sandbox();
  try {
    fs.mkdirSync(path.join(root, '.nubos-pilot', 'milestones', 'M003', 'slices', 'S001', 'tasks'), { recursive: true });
    renderTodoMd('M003-S001', root);
    const raw = fs.readFileSync(todoPath('M003-S001', root), 'utf-8');
    assert.match(raw, /_No tasks yet\._/);
    assert.match(raw, /total:\s*0/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('TD-5: task name extracted from H1 after em-dash', () => {
  const root = _sandbox();
  try {
    _writeTask(root, 4, 1, 1, 'pending', 'Implement feature X');
    renderTodoMd('M004-S001', root);
    const raw = fs.readFileSync(todoPath('M004-S001', root), 'utf-8');
    assert.match(raw, /\*\*M004-S001-T0001\*\* — Implement feature X/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('TD-6: setTaskStatus triggers auto-render of TODO.md', () => {
  const root = _sandbox();
  try {
    const { fullId, sliceFullId } = _writeTask(root, 5, 1, 1, 'pending', 'Task one');
    setTaskStatus(fullId, 'in-progress', root);
    const raw = fs.readFileSync(todoPath(sliceFullId, root), 'utf-8');
    assert.match(raw, /- \[~\] \*\*M005-S001-T0001\*\* — Task one/);
    assert.match(raw, /in_progress:\s*1/);
    assert.match(raw, /pending:\s*0/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('TD-7: renderTodoMd rejects malformed slice full-id', () => {
  assert.throws(
    () => renderTodoMd('not-a-slice-id', '/tmp'),
    (err) => err.name === 'NubosPilotError' && err.code === 'layout-invalid-id',
  );
});

test('TD-8: renderTodoMd rejects missing sliceFullId', () => {
  assert.throws(
    () => renderTodoMd(null, '/tmp'),
    (err) => err.name === 'NubosPilotError' && err.code === 'todo-missing-slice-id',
  );
});

test('TD-9: STATUS_CHECKBOX covers all task status enum values', () => {
  const expected = ['pending', 'in-progress', 'done', 'skipped', 'parked'];
  for (const s of expected) {
    assert.ok(STATUS_CHECKBOX[s], 'missing checkbox mapping for status: ' + s);
  }
});

test('TD-10: re-rendering overwrites stale counts', () => {
  const root = _sandbox();
  try {
    const { fullId } = _writeTask(root, 6, 1, 1, 'pending', 'Alpha');
    renderTodoMd('M006-S001', root);
    let raw = fs.readFileSync(todoPath('M006-S001', root), 'utf-8');
    assert.match(raw, /pending:\s*1/);
    assert.match(raw, /done:\s*0/);
    setTaskStatus(fullId, 'done', root);
    raw = fs.readFileSync(todoPath('M006-S001', root), 'utf-8');
    assert.match(raw, /pending:\s*0/);
    assert.match(raw, /done:\s*1/);
    assert.match(raw, /- \[x\] \*\*M006-S001-T0001\*\* — Alpha/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
