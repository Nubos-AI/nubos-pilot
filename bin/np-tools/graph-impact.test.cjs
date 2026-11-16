const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const cli = require('./graph-impact.cjs');

const _sandboxes = [];

function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-gi-'));
  _sandboxes.push(dir);
  return dir;
}

function writeGraph(root, graph) {
  const dir = path.join(root, '.nubos-pilot', 'codebase');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.graph.json'), JSON.stringify(graph));
}

function capture() {
  let buf = '';
  return { stream: { write: (s) => { buf += s; } }, read: () => buf };
}

const SAMPLE = {
  schema_version: 1,
  module_count: 3,
  edge_count: 2,
  nodes: [
    { id: 'a', directory: 'a', primary_language: 'javascript', file_count: 1 },
    { id: 'b', directory: 'b', primary_language: 'javascript', file_count: 1 },
    { id: 'c', directory: 'c', primary_language: 'javascript', file_count: 1 },
  ],
  edges: [
    { from: 'a', to: 'b', weight: 1 },
    { from: 'b', to: 'c', weight: 1 },
  ],
  cycles: [],
  clusters: [{ id: 0, members: ['a', 'b', 'c'] }],
  metrics: { unresolved_internal_deps: 0, max_fan_in: 1, max_fan_out: 1, isolated_modules: 0 },
};

afterEach(() => {
  while (_sandboxes.length) {
    const dir = _sandboxes.pop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('GI-1: --module reports impact and dependencies', () => {
  const root = makeSandbox();
  writeGraph(root, SAMPLE);
  const out = capture();
  const rc = cli.run(['--module', 'c'], { cwd: root, stdout: out.stream });
  assert.equal(rc, 0);
  const res = JSON.parse(out.read());
  assert.equal(res.module, 'c');
  assert.deepEqual(res.direct_dependents, ['b']);
  assert.deepEqual(res.impact, ['a', 'b']);
  assert.deepEqual(res.transitive_dependencies, []);
});

test('GI-2: --path maps a file to its owning module', () => {
  const root = makeSandbox();
  writeGraph(root, SAMPLE);
  const out = capture();
  cli.run(['--path', 'a/login.js'], { cwd: root, stdout: out.stream });
  const res = JSON.parse(out.read());
  assert.equal(res.module, 'a');
  assert.deepEqual(res.direct_dependencies, ['b']);
});

test('GI-3: missing graph throws graph-not-found', () => {
  const root = makeSandbox();
  assert.throws(
    () => cli.run(['--module', 'a'], { cwd: root, stdout: capture().stream }),
    (err) => err.code === 'graph-not-found',
  );
});

test('GI-4: unknown module throws graph-unknown-module', () => {
  const root = makeSandbox();
  writeGraph(root, SAMPLE);
  assert.throws(
    () => cli.run(['--module', 'nope'], { cwd: root, stdout: capture().stream }),
    (err) => err.code === 'graph-unknown-module',
  );
});

test('GI-5: no target throws graph-missing-target', () => {
  const root = makeSandbox();
  writeGraph(root, SAMPLE);
  assert.throws(
    () => cli.run([], { cwd: root, stdout: capture().stream }),
    (err) => err.code === 'graph-missing-target',
  );
});

test('GI-6: --cycles dumps the cycle list', () => {
  const root = makeSandbox();
  writeGraph(root, Object.assign({}, SAMPLE, { cycles: [['a', 'b']] }));
  const out = capture();
  cli.run(['--cycles'], { cwd: root, stdout: out.stream });
  const res = JSON.parse(out.read());
  assert.equal(res.cycle_count, 1);
  assert.deepEqual(res.cycles[0], ['a', 'b']);
});

test('GI-7: unmappable --path throws graph-path-unmapped', () => {
  const root = makeSandbox();
  writeGraph(root, SAMPLE);
  assert.throws(
    () => cli.run(['--path', 'ghost/x.js'], { cwd: root, stdout: capture().stream }),
    (err) => err.code === 'graph-path-unmapped',
  );
});
