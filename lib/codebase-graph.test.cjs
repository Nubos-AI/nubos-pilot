const { test } = require('node:test');
const assert = require('node:assert/strict');

const g = require('./codebase-graph.cjs');

function fact(id, directory, files, extra) {
  const source_paths = files.map((f) => f.path);
  return Object.assign({
    id,
    name: directory || 'root',
    directory: directory || '',
    primary_language: 'javascript',
    language_distribution: { javascript: files.length },
    file_count: files.length,
    source_paths,
    symbols: [],
    internal_deps: [],
    external_deps: [],
    files,
  }, extra || {});
}

test('CG-1: buildModuleGraph creates a node per fact', () => {
  const facts = [
    fact('src-auth', 'src/auth', [{ path: 'src/auth/login.js', language: 'javascript', symbols: [], deps: [] }]),
    fact('src-db', 'src/db', [{ path: 'src/db/index.js', language: 'javascript', symbols: [], deps: [] }]),
  ];
  const graph = g.buildModuleGraph(facts);
  assert.equal(graph.module_count, 2);
  assert.deepEqual(graph.nodes.map((n) => n.id), ['src-auth', 'src-db']);
});

test('CG-2: relative import resolves to a cross-module edge', () => {
  const facts = [
    fact('src-auth', 'src/auth', [
      { path: 'src/auth/login.js', language: 'javascript', symbols: [], deps: ['../db', 'bcrypt'] },
    ]),
    fact('src-db', 'src/db', [
      { path: 'src/db/index.js', language: 'javascript', symbols: [], deps: [] },
    ]),
  ];
  const graph = g.buildModuleGraph(facts);
  assert.equal(graph.edge_count, 1);
  assert.deepEqual(graph.edges[0], { from: 'src-auth', to: 'src-db', weight: 1 });
});

test('CG-3: external (non-relative) deps never become edges', () => {
  const facts = [
    fact('src-auth', 'src/auth', [
      { path: 'src/auth/login.js', language: 'javascript', symbols: [], deps: ['bcrypt', 'node:fs'] },
    ]),
  ];
  const graph = g.buildModuleGraph(facts);
  assert.equal(graph.edge_count, 0);
});

test('CG-4: same-module relative import is not a self-edge', () => {
  const facts = [
    fact('src-auth', 'src/auth', [
      { path: 'src/auth/login.js', language: 'javascript', symbols: [], deps: ['./session'] },
      { path: 'src/auth/session.js', language: 'javascript', symbols: [], deps: [] },
    ]),
  ];
  const graph = g.buildModuleGraph(facts);
  assert.equal(graph.edge_count, 0);
});

test('CG-5: repeated imports raise edge weight', () => {
  const facts = [
    fact('a', 'a', [
      { path: 'a/one.js', language: 'javascript', symbols: [], deps: ['../b'] },
      { path: 'a/two.js', language: 'javascript', symbols: [], deps: ['../b/helper'] },
    ]),
    fact('b', 'b', [
      { path: 'b/index.js', language: 'javascript', symbols: [], deps: [] },
      { path: 'b/helper.js', language: 'javascript', symbols: [], deps: [] },
    ]),
  ];
  const graph = g.buildModuleGraph(facts);
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0].weight, 2);
});

test('CG-6: unresolved internal-looking deps are counted, not edged', () => {
  const facts = [
    fact('a', 'a', [
      { path: 'a/one.js', language: 'javascript', symbols: [], deps: ['../nonexistent'] },
    ]),
  ];
  const graph = g.buildModuleGraph(facts);
  assert.equal(graph.edge_count, 0);
  assert.equal(graph.metrics.unresolved_internal_deps, 1);
});

test('CG-7: Tarjan detects a 2-module cycle', () => {
  const facts = [
    fact('a', 'a', [{ path: 'a/x.js', language: 'javascript', symbols: [], deps: ['../b'] }]),
    fact('b', 'b', [{ path: 'b/index.js', language: 'javascript', symbols: [], deps: ['../a'] }]),
  ];
  const graph = g.buildModuleGraph(facts);
  assert.equal(graph.cycles.length, 1);
  assert.deepEqual(graph.cycles[0], ['a', 'b']);
});

test('CG-8: acyclic graph reports no cycles', () => {
  const facts = [
    fact('a', 'a', [{ path: 'a/x.js', language: 'javascript', symbols: [], deps: ['../b'] }]),
    fact('b', 'b', [{ path: 'b/index.js', language: 'javascript', symbols: [], deps: ['../c'] }]),
    fact('c', 'c', [{ path: 'c/index.js', language: 'javascript', symbols: [], deps: [] }]),
  ];
  const graph = g.buildModuleGraph(facts);
  assert.equal(graph.cycles.length, 0);
});

test('CG-9: transitive dependents (impact) walk the reverse graph', () => {
  const facts = [
    fact('a', 'a', [{ path: 'a/x.js', language: 'javascript', symbols: [], deps: ['../b'] }]),
    fact('b', 'b', [{ path: 'b/index.js', language: 'javascript', symbols: [], deps: ['../c'] }]),
    fact('c', 'c', [{ path: 'c/index.js', language: 'javascript', symbols: [], deps: [] }]),
  ];
  const graph = g.buildModuleGraph(facts);
  assert.deepEqual(g.transitiveDependents(graph, 'c'), ['a', 'b']);
  assert.deepEqual(g.directDependents(graph, 'c'), ['b']);
  assert.deepEqual(g.transitiveDependencies(graph, 'a'), ['b', 'c']);
  assert.deepEqual(g.directDependencies(graph, 'a'), ['b']);
});

test('CG-10: deterministic clustering groups a connected component together', () => {
  const facts = [
    fact('a', 'a', [{ path: 'a/x.js', language: 'javascript', symbols: [], deps: ['../b'] }]),
    fact('b', 'b', [{ path: 'b/index.js', language: 'javascript', symbols: [], deps: ['../a'] }]),
    fact('lonely', 'lonely', [{ path: 'lonely/z.js', language: 'javascript', symbols: [], deps: [] }]),
  ];
  const graph = g.buildModuleGraph(facts);
  const first = g.buildModuleGraph(facts);
  assert.deepEqual(graph.clusters, first.clusters);
  const clusterAB = graph.clusters.find((c) => c.members.includes('a'));
  assert.ok(clusterAB.members.includes('b'));
  assert.ok(!clusterAB.members.includes('lonely'));
});

test('CG-11: cycleFor and clusterOf locate a module', () => {
  const facts = [
    fact('a', 'a', [{ path: 'a/x.js', language: 'javascript', symbols: [], deps: ['../b'] }]),
    fact('b', 'b', [{ path: 'b/index.js', language: 'javascript', symbols: [], deps: ['../a'] }]),
  ];
  const graph = g.buildModuleGraph(facts);
  assert.deepEqual(g.cycleFor(graph, 'a'), ['a', 'b']);
  assert.equal(typeof g.clusterOf(graph, 'a'), 'number');
  assert.equal(g.cycleFor(graph, 'missing'), null);
  assert.equal(g.clusterOf(graph, 'missing'), null);
});

test('CG-12: root-relative (/-prefixed) deps resolve from project root', () => {
  const facts = [
    fact('src-auth', 'src/auth', [
      { path: 'src/auth/login.js', language: 'javascript', symbols: [], deps: ['/src/db'] },
    ]),
    fact('src-db', 'src/db', [
      { path: 'src/db/index.js', language: 'javascript', symbols: [], deps: [] },
    ]),
  ];
  const graph = g.buildModuleGraph(facts);
  assert.equal(graph.edge_count, 1);
  assert.deepEqual(graph.edges[0], { from: 'src-auth', to: 'src-db', weight: 1 });
});

test('CG-13: empty facts yield an empty graph', () => {
  const graph = g.buildModuleGraph([]);
  assert.equal(graph.module_count, 0);
  assert.equal(graph.edge_count, 0);
  assert.deepEqual(graph.cycles, []);
  assert.deepEqual(graph.clusters, []);
});
