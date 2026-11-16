'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const rg = require('./roadmap-graph.cjs');

function _code(code) {
  return (err) => err && err.name === 'NubosPilotError' && err.code === code;
}

function _milestones(over) {
  return over || [{
    id: 'M001',
    name: 'Password reset',
    status: 'in-progress',
    slices: [
      {
        id: 'S001',
        name: 'Token plumbing',
        status: 'done',
        tasks: [
          { id: 'T0001', name: 'generate tokens', status: 'done' },
          { id: 'T0002', name: 'consume tokens', status: 'done', depends_on: ['T0001'] },
        ],
      },
      { id: 'S002', name: 'Mail transport', status: 'pending', tasks: [{ id: 'T0003', status: 'pending' }] },
    ],
  }];
}

// -------------------------------------------------------------- depends_on

test('RG-1: parseDependsOn accepts the comma-joined string parseRoadmap produces', () => {
  // roadmap.cjs normalises depends_on to a joined string, not an array. Reading
  // only the array form would drop every edge and render a graph with no
  // dependencies that still looked correct.
  assert.deepEqual(rg.parseDependsOn('M001, M002'), ['M001', 'M002']);
  assert.deepEqual(rg.parseDependsOn(['M001', 'M002']), ['M001', 'M002']);
  assert.deepEqual(rg.parseDependsOn('M001'), ['M001']);
});

test('RG-2: parseDependsOn treats null, empty and placeholder values as no dependency', () => {
  assert.deepEqual(rg.parseDependsOn(null), []);
  assert.deepEqual(rg.parseDependsOn(undefined), []);
  assert.deepEqual(rg.parseDependsOn(''), []);
  assert.deepEqual(rg.parseDependsOn([]), []);
  assert.deepEqual(rg.parseDependsOn('none'), []);
  assert.deepEqual(rg.parseDependsOn('-'), []);
});

// ------------------------------------------------------------------ escaping

test('RG-3: Mermaid-breaking characters in a name are escaped, not passed through', () => {
  // `Auth [phase 2]` would emit a parse error rather than a diagram, and the
  // failure would surface in the docs build far from the roadmap.
  const out = rg.escapeMermaid('Auth [phase 2] "quoted" (paren) {brace} a|b <tag>');
  for (const ch of ['[', ']', '"', '(', ')', '{', '}', '|', '<', '>']) {
    assert.ok(!out.includes(ch), `raw ${ch} survived escaping: ${out}`);
  }
});

test('RG-4: newlines collapse to spaces so a node label cannot break the syntax', () => {
  assert.equal(rg.escapeMermaid('line one\nline two'), 'line one line two');
  assert.equal(rg.escapeDot('line one\nline two'), 'line one line two');
});

test('RG-5: DOT escaping handles quotes and backslashes', () => {
  assert.equal(rg.escapeDot('say "hi"'), 'say \\"hi\\"');
  assert.equal(rg.escapeDot('a\\b'), 'a\\\\b');
});

test('RG-6: node ids are normalised to identifier-safe text', () => {
  assert.equal(rg.nodeId('T', 'M001-S001-T0001'), 'T_M001_S001_T0001');
  assert.ok(/^[A-Za-z0-9_]+$/.test(rg.nodeId('M', 'M001/weird id')));
});

// -------------------------------------------------------------- status class

test('RG-7: statuses collapse into the four legend buckets', () => {
  assert.equal(rg.statusClass('done'), 'done');
  assert.equal(rg.statusClass('verified'), 'done');
  assert.equal(rg.statusClass('complete'), 'done');
  assert.equal(rg.statusClass('in-progress'), 'active');
  assert.equal(rg.statusClass('failed'), 'failed');
  assert.equal(rg.statusClass('deferred'), 'skipped');
  assert.equal(rg.statusClass('skipped'), 'skipped');
  assert.equal(rg.statusClass('backlog'), 'pending');
});

test('RG-8: an unknown or absent status falls back to pending rather than throwing', () => {
  assert.equal(rg.statusClass('who-knows'), 'pending');
  assert.equal(rg.statusClass(undefined), 'pending');
  assert.equal(rg.statusClass(null), 'pending');
});

// ------------------------------------------------------------------- graph

test('RG-9: buildGraph emits a node per unit at task level', () => {
  const g = rg.buildGraph(_milestones());
  assert.equal(g.stats.milestones, 1);
  assert.equal(g.stats.slices, 2);
  assert.equal(g.stats.tasks, 3);
});

test('RG-10: the level option truncates the tree', () => {
  assert.equal(rg.buildGraph(_milestones(), { level: 'milestone' }).stats.slices, 0);
  const sliceLevel = rg.buildGraph(_milestones(), { level: 'slice' });
  assert.equal(sliceLevel.stats.slices, 2);
  assert.equal(sliceLevel.stats.tasks, 0);
});

test('RG-11: an unknown level or format is refused', () => {
  assert.throws(() => rg.buildGraph(_milestones(), { level: 'epic' }), _code('roadmap-graph-bad-level'));
  assert.throws(() => rg.render(_milestones(), { format: 'svg' }), _code('roadmap-graph-bad-format'));
});

test('RG-12: serial slice order becomes an explicit wave edge', () => {
  // The executor enforces S001 → S002, but roadmap.yaml only implies it through
  // list order. Making it an edge is the point of the diagram.
  const g = rg.buildGraph(_milestones());
  const wave = g.edges.filter((e) => e.kind === 'wave');
  assert.equal(wave.length, 1);
  assert.equal(wave[0].from, rg.nodeId('S', 'M001_S001'));
  assert.equal(wave[0].to, rg.nodeId('S', 'M001_S002'));
});

test('RG-13: intra-slice task dependencies become edges', () => {
  const g = rg.buildGraph(_milestones());
  const dep = g.edges.filter((e) => e.kind === 'task-depends');
  assert.equal(dep.length, 1);
  assert.equal(dep[0].from, rg.nodeId('T', 'M001_S001_T0001'));
  assert.equal(dep[0].to, rg.nodeId('T', 'M001_S001_T0002'));
});

test('RG-14: milestone dependencies resolve in both directions of declaration order', () => {
  const g = rg.buildGraph([
    { id: 'M002', name: 'Second', status: 'pending', depends_on: 'M001', slices: [] },
    { id: 'M001', name: 'First', status: 'done', slices: [] },
  ]);
  const dep = g.edges.filter((e) => e.kind === 'milestone-depends');
  assert.equal(dep.length, 1, 'a forward reference must still resolve');
  assert.equal(dep[0].from, rg.nodeId('M', 'M001'));
  assert.equal(dep[0].to, rg.nodeId('M', 'M002'));
});

test('RG-15: a dependency on a milestone that does not exist is reported, not silently dropped', () => {
  const g = rg.buildGraph([{ id: 'M002', status: 'pending', depends_on: 'M099', slices: [] }]);
  assert.equal(g.stats.dangling, 1);
  assert.deepEqual(g.dangling_dependencies, [{ from: 'M099', to: 'M002', kind: 'milestone-depends' }]);
  assert.equal(g.edges.filter((e) => e.kind === 'milestone-depends').length, 0);
});

test('RG-16: tasks given as bare id strings are accepted', () => {
  const g = rg.buildGraph([{
    id: 'M001', status: 'pending',
    slices: [{ id: 'S001', status: 'pending', tasks: ['T0001', 'T0002'] }],
  }]);
  assert.equal(g.stats.tasks, 2);
});

test('RG-17: malformed entries are skipped rather than throwing', () => {
  assert.doesNotThrow(() => rg.buildGraph([
    null, {}, { id: '' },
    { id: 'M001', slices: [null, {}, { id: 'S001', tasks: [null, {}, ''] }] },
  ]));
  assert.doesNotThrow(() => rg.buildGraph(null));
  assert.equal(rg.buildGraph(null).stats.milestones, 0);
});

test('RG-18: long names are truncated so a node stays readable', () => {
  const g = rg.buildGraph([{ id: 'M001', name: 'x'.repeat(200), slices: [] }], { maxLabel: 20 });
  const node = g.nodes.find((n) => n.level === 'milestone');
  assert.ok(node.label.length < 40, 'got: ' + node.label);
  assert.ok(node.label.endsWith('…'));
});

// ------------------------------------------------------------------ mermaid

test('RG-19: Mermaid output declares every node an edge references', () => {
  const { text, graph } = rg.render(_milestones(), { format: 'mermaid' });
  // Substring matching is not enough here: `S_M001_S001` also occurs inside
  // `subgraph cluster_S_M001_S001`, so an `includes` check passed while the node
  // itself was never declared and every wave edge pointed at a phantom box.
  // Match the declaration form — id immediately followed by its shape opener.
  const declared = new Set(
    [...text.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)(?:\(\[|\[|\()"/gm)].map((m) => m[1]),
  );
  assert.ok(declared.size > 0, 'sanity: the declaration regex must match something');
  for (const e of graph.edges) {
    assert.ok(declared.has(e.from), 'edge source ' + e.from + ' is not declared');
    assert.ok(declared.has(e.to), 'edge target ' + e.to + ' is not declared');
  }
});

test('RG-20: the subgraph id differs from the slice node id', () => {
  // Reusing the node id as the subgraph id makes Mermaid merge the two and the
  // wave edges disappear.
  const { text } = rg.render(_milestones(), { format: 'mermaid' });
  const slKey = rg.nodeId('S', 'M001_S001');
  assert.ok(text.includes('subgraph cluster_' + slKey), 'got:\n' + text);
  assert.ok(!text.includes('subgraph ' + slKey + '['), 'subgraph id must not collide with the node id');
});

test('RG-21: a classDef is never emitted with an empty member list', () => {
  // `class  done` with no members is a Mermaid parse error.
  const { text } = rg.render([{ id: 'M001', status: 'done', slices: [] }], { format: 'mermaid' });
  for (const line of text.split('\n')) {
    if (/^\s*class\s/.test(line) && !/^\s*classDef/.test(line)) {
      assert.match(line, /^\s*class\s+\S+\s+\w+$/, 'malformed class line: ' + line);
    }
  }
});

test('RG-22: the generated block carries a do-not-edit header in both formats', () => {
  assert.ok(rg.render(_milestones(), { format: 'mermaid' }).text.includes(rg.GENERATED_HEADER));
  assert.ok(rg.render(_milestones(), { format: 'dot' }).text.includes(rg.GENERATED_HEADER));
});

test('RG-23: direction is honoured and defaults conservatively', () => {
  assert.match(rg.render(_milestones(), { format: 'mermaid' }).text, /flowchart TD/);
  assert.match(rg.render(_milestones(), { format: 'mermaid', direction: 'LR' }).text, /flowchart LR/);
  assert.match(rg.render(_milestones(), { format: 'dot' }).text, /rankdir=TB;/);
  assert.match(rg.render(_milestones(), { format: 'dot', direction: 'LR' }).text, /rankdir=LR;/);
});

test('RG-24: a slice with no tasks is emitted as a plain node, not an empty subgraph', () => {
  const { text } = rg.render([{
    id: 'M001', status: 'pending', slices: [{ id: 'S001', name: 'Empty', status: 'pending', tasks: [] }],
  }], { format: 'mermaid' });
  assert.ok(!text.includes('subgraph'), 'an empty subgraph renders as a stray box');
  assert.ok(text.includes(rg.nodeId('S', 'M001_S001')));
});

// ---------------------------------------------------------------------- dot

test('RG-25: DOT output is a well-formed digraph with balanced braces', () => {
  const { text } = rg.render(_milestones(), { format: 'dot' });
  assert.match(text, /^\/\/ .*\ndigraph roadmap \{/);
  const opens = (text.match(/\{/g) || []).length;
  const closes = (text.match(/\}/g) || []).length;
  assert.equal(opens, closes, 'unbalanced braces would make the file unrenderable');
  assert.ok(text.trimEnd().endsWith('}'));
});

test('RG-26: DOT emits a real cluster per slice that has tasks', () => {
  const { text } = rg.render(_milestones(), { format: 'dot' });
  assert.ok(text.includes('subgraph cluster_' + rg.nodeId('S', 'M001_S001')));
});

test('RG-27: every DOT node is declared before edges reference it', () => {
  const { text, graph } = rg.render(_milestones(), { format: 'dot' });
  const declared = new Set([...text.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s+\[label=/gm)].map((m) => m[1]));
  for (const e of graph.edges) {
    assert.ok(declared.has(e.from), 'undeclared DOT node: ' + e.from);
    assert.ok(declared.has(e.to), 'undeclared DOT node: ' + e.to);
  }
});

// ----------------------------------------------------------------- markdown

test('RG-28: Mermaid wraps in the fence VitePress renders natively', () => {
  const md = rg.toMarkdown(rg.render(_milestones(), { format: 'mermaid' }), 'Roadmap');
  assert.match(md, /^## Roadmap\n\n```mermaid\n/);
  assert.ok(md.trimEnd().endsWith('```'));
});

test('RG-29: DOT is fenced as dot rather than pretending it will draw', () => {
  const md = rg.toMarkdown(rg.render(_milestones(), { format: 'dot' }));
  assert.match(md, /^```dot\n/);
  assert.ok(!md.includes('```mermaid'));
});

// ------------------------------------------------------- conditional edges

function _conditional() {
  return [{
    id: 'M001', name: 'Migration', status: 'in-progress',
    slices: [
      { id: 'S001', name: 'migrate', status: 'done' },
      { id: 'S002', name: 'verify', status: 'pending', when: { slice: 'S001', status: 'done' } },
      { id: 'S003', name: 'rollback', status: 'pending', when: { slice: 'S001', status_not: 'done' } },
    ],
  }];
}

test('RG-31: a gated slice gets a condition edge from the slice it depends on', () => {
  const g = rg.buildGraph(_conditional(), { level: 'slice' });
  const cond = g.edges.filter((e) => e.kind === 'condition');
  assert.equal(cond.length, 2);
  assert.equal(cond[0].from, rg.nodeId('S', 'M001_S001'));
  assert.equal(cond[0].to, rg.nodeId('S', 'M001_S002'));
  assert.equal(cond[0].label, 'if done');
  assert.equal(cond[1].label, 'unless done');
});

test('RG-32: Mermaid draws a condition as a dotted labelled edge', () => {
  // A gated slice is the one place where reading the slice list top to bottom
  // gives the wrong answer about what will run, so it must not look like an
  // ordinary edge.
  const { text } = rg.render(_conditional(), { format: 'mermaid', level: 'slice' });
  assert.match(text, /S_M001_S001 -\. "if done" \.-> S_M001_S002/);
  assert.match(text, /-\. "unless done" \.-> S_M001_S003/);
});

test('RG-33: DOT draws a condition as a dashed labelled edge', () => {
  const { text } = rg.render(_conditional(), { format: 'dot', level: 'slice' });
  assert.match(text, /S_M001_S001 -> S_M001_S002 \[style=dashed[^\]]*label="if done"\]/);
});

test('RG-34: a malformed condition is skipped by the renderer, not thrown', () => {
  // slice-plan lint owns reporting it, and it refuses the milestone outright, so
  // no drawing of it can mislead.
  const broken = [{
    id: 'M001', slices: [{ id: 'S001' }, { id: 'S002', when: { slice: 'S001' } }],
  }];
  assert.doesNotThrow(() => rg.render(broken, { format: 'mermaid', level: 'slice' }));
  const g = rg.buildGraph(broken, { level: 'slice' });
  assert.equal(g.edges.filter((e) => e.kind === 'condition').length, 0);
});

test('RG-35: a condition never produces a self-edge', () => {
  const g = rg.buildGraph([{
    id: 'M001', slices: [{ id: 'S001', when: { slice: 'S001', status: 'done' } }],
  }], { level: 'slice' });
  assert.equal(g.edges.filter((e) => e.kind === 'condition').length, 0);
});

test('RG-36: condition edges reference declared nodes in both formats', () => {
  for (const format of ['mermaid', 'dot']) {
    const { text, graph } = rg.render(_conditional(), { format, level: 'slice' });
    const declared = format === 'mermaid'
      ? new Set([...text.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)(?:\(\[|\[|\()"/gm)].map((m) => m[1]))
      : new Set([...text.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s+\[label=/gm)].map((m) => m[1]));
    for (const e of graph.edges.filter((x) => x.kind === 'condition')) {
      assert.ok(declared.has(e.from), format + ': undeclared condition source ' + e.from);
      assert.ok(declared.has(e.to), format + ': undeclared condition target ' + e.to);
    }
  }
});

test('RG-30: render reports stats alongside the text', () => {
  const out = rg.render(_milestones(), { format: 'mermaid' });
  assert.equal(out.format, 'mermaid');
  assert.equal(out.stats.tasks, 3);
  assert.equal(out.stats.edges, out.graph.edges.length);
});

test('RG-37: a milestone is connected to its slice chain', () => {
  const g = rg.buildGraph([{
    id: 'M001', slices: [{ id: 'S001' }, { id: 'S002' }],
  }], { level: 'slice' });
  const contains = g.edges.filter((e) => e.kind === 'contains');
  assert.equal(contains.length, 1, 'only the first slice is attached; wave edges chain the rest');
  assert.equal(contains[0].from, rg.nodeId('M', 'M001'));
  assert.equal(contains[0].to, rg.nodeId('S', 'M001_S001'));
});

test('RG-38: a single-slice milestone still renders a connected graph', () => {
  for (const format of ['mermaid', 'dot']) {
    const { text } = rg.render([{ id: 'M001', name: 'auth', slices: [{ id: 'S001', name: 'login' }] }],
      { format, level: 'slice' });
    const arrow = format === 'mermaid' ? '---' : '->';
    assert.ok(
      text.includes(rg.nodeId('M', 'M001') + ' ' + arrow + ' ' + rg.nodeId('S', 'M001_S001')),
      format + ': milestone and slice must not be drawn as unrelated boxes:\n' + text,
    );
  }
});

test('RG-39: a condition on a slice the milestone does not declare is reported, not drawn', () => {
  const g = rg.buildGraph([{
    id: 'M001',
    slices: [{ id: 'S001' }, { id: 'S002', when: { slice: 'S099', status: 'done' } }],
  }], { level: 'slice' });
  assert.equal(g.edges.filter((e) => e.kind === 'condition').length, 0);
  assert.deepEqual(g.dangling_dependencies, [{
    from: 'S099', to: 'S002', kind: 'slice-condition', milestone: 'M001',
  }]);
});

test('RG-40: every rendered edge endpoint is a declared node in both formats', () => {
  const milestones = [{
    id: 'M001', name: 'auth', status: 'in-progress',
    slices: [
      { id: 'S001', name: 'migrate', status: 'done', tasks: [{ id: 'T0001', name: 'x' }] },
      { id: 'S002', name: 'verify', status: 'pending', when: { slice: 'S001', status: 'done' } },
      { id: 'S003', name: 'ghost', status: 'pending', when: { slice: 'S099', status: 'done' } },
    ],
  }];
  for (const format of ['mermaid', 'dot']) {
    const { text, graph } = rg.render(milestones, { format });
    const declared = format === 'mermaid'
      ? new Set([...text.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)(?:\(\[|\[|\()"/gm)].map((m) => m[1]))
      : new Set([...text.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s+\[label=/gm)].map((m) => m[1]));
    for (const e of graph.edges) {
      assert.ok(declared.has(e.from), format + ': undeclared edge source ' + e.from);
      assert.ok(declared.has(e.to), format + ': undeclared edge target ' + e.to);
    }
  }
});

test('RG-41: a slice inside a cluster is not labelled twice', () => {
  const { text } = rg.render([{
    id: 'M001',
    slices: [{ id: 'S001', name: 'Token plumbing', tasks: [{ id: 'T0001', name: 'x' }] }],
  }], { format: 'mermaid' });
  assert.equal((text.match(/Token plumbing/g) || []).length, 1,
    'the cluster title carries the name; the anchor node carries the id:\n' + text);
});
