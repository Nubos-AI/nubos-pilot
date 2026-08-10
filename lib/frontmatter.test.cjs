const { extractFrontmatter } = require('./frontmatter.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('FM-A1: unquoted string + boolean scalars', () => {
  const raw = '---\nphase: 03\nautonomous: true\n---\nbody';
  const { frontmatter, body } = extractFrontmatter(raw);
  assert.equal(frontmatter.phase, '03');
  assert.equal(frontmatter.autonomous, true);
  assert.equal(body, 'body');
});

test('FM-A2: unquoted numeric scalar → number', () => {
  const raw = '---\nwave: 1\n---\n';
  const { frontmatter } = extractFrontmatter(raw);
  assert.equal(frontmatter.wave, 1);
  assert.equal(typeof frontmatter.wave, 'number');
});

test('FM-A3: empty and tilde → null', () => {
  const raw = '---\nnullable:\nanother: ~\n---\n';
  const { frontmatter } = extractFrontmatter(raw);
  assert.equal(frontmatter.nullable, null);
  assert.equal(frontmatter.another, null);
});

test('FM-A4: missing frontmatter block → empty object, body === raw', () => {
  const raw = 'no frontmatter here\njust body\n';
  const { frontmatter, body } = extractFrontmatter(raw);
  assert.deepEqual(frontmatter, {});
  assert.equal(body, raw);
});

test('FM-B1: double-quoted value with embedded colon', () => {
  const raw = '---\nkey: "value: with colon"\n---\n';
  const { frontmatter } = extractFrontmatter(raw);
  assert.equal(frontmatter.key, 'value: with colon');
});

test('FM-B2: single-quoted value', () => {
  const raw = "---\nkey: 'single-quoted'\n---\n";
  const { frontmatter } = extractFrontmatter(raw);
  assert.equal(frontmatter.key, 'single-quoted');
});

test('FM-C1: inline array parses to JS array, not literal string (RESEARCH Pitfall 2)', () => {
  const raw = '---\ndepends_on: [T-02, T-03]\n---\n';
  const { frontmatter } = extractFrontmatter(raw);
  assert.ok(Array.isArray(frontmatter.depends_on));
  assert.equal(frontmatter.depends_on.length, 2);
  assert.deepEqual(frontmatter.depends_on, ['T-02', 'T-03']);
});

test('FM-C2: empty inline array', () => {
  const raw = '---\nempty: []\n---\n';
  const { frontmatter } = extractFrontmatter(raw);
  assert.ok(Array.isArray(frontmatter.empty));
  assert.equal(frontmatter.empty.length, 0);
});

test('FM-C3: quote-aware comma split inside inline array', () => {
  const raw = '---\nquoted: ["a, b", "c"]\n---\n';
  const { frontmatter } = extractFrontmatter(raw);
  assert.deepEqual(frontmatter.quoted, ['a, b', 'c']);
});

test('FM-D1: nested must_haves with truths + artifacts round-trips to structured JS', () => {
  const raw = [
    '---',
    'must_haves:',
    '  truths:',
    '    - "first truth"',
    '    - "second truth"',
    '  artifacts:',
    '    - path: lib/plan.cjs',
    '      provides: "parser"',
    '      exports: ["parsePlan", "listPlans"]',
    '---',
    'body',
  ].join('\n');
  const { frontmatter } = extractFrontmatter(raw);
  assert.ok(frontmatter.must_haves, 'must_haves key present');
  assert.deepEqual(frontmatter.must_haves.truths, ['first truth', 'second truth']);
  assert.ok(Array.isArray(frontmatter.must_haves.artifacts));
  assert.equal(frontmatter.must_haves.artifacts.length, 1);
  assert.equal(frontmatter.must_haves.artifacts[0].path, 'lib/plan.cjs');
  assert.equal(frontmatter.must_haves.artifacts[0].provides, 'parser');
  assert.deepEqual(frontmatter.must_haves.artifacts[0].exports, ['parsePlan', 'listPlans']);
});

test('FM-E1: bullet list under key → array of strings', () => {
  const raw = '---\nfiles_modified:\n  - lib/a.cjs\n  - lib/b.cjs\n---\n';
  const { frontmatter } = extractFrontmatter(raw);
  assert.deepEqual(frontmatter.files_modified, ['lib/a.cjs', 'lib/b.cjs']);
});

test('FM-F1: unclosed quoted string → NubosPilotError frontmatter-parse-error', () => {
  const raw = '---\nkey: "unclosed\n---\n';
  let thrown = null;
  try {
    extractFrontmatter(raw);
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, 'expected throw on unclosed quote');
  assert.equal(thrown.name, 'NubosPilotError');
  assert.equal(thrown.code, 'frontmatter-parse-error');
  assert.ok(thrown.details, 'details object present');
  assert.equal(typeof thrown.details.line, 'number');
  assert.equal(typeof thrown.details.snippet, 'string');
});

test('FM-F2: tab indent in nested block → NubosPilotError frontmatter-parse-error', () => {
  const raw = '---\nmust_haves:\n\ttruths:\n\t\t- "bad tabs"\n---\n';
  let thrown = null;
  try {
    extractFrontmatter(raw);
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, 'expected throw on tab-indented nested block');
  assert.equal(thrown.name, 'NubosPilotError');
  assert.equal(thrown.code, 'frontmatter-parse-error');
});

test('FM-G1: nested must_haves (truths/artifacts/key_links) from a real plan parses cleanly', () => {

  
  const raw = [
    '---',
    'phase: 03',
    'plan: 01',
    'type: execute',
    'wave: 0',
    'depends_on: []',
    'files_modified:',
    '  - lib/frontmatter.cjs',
    '  - lib/frontmatter.test.cjs',
    'autonomous: true',
    'requirements: [LIB-06, LIB-07]',
    'must_haves:',
    '  truths:',
    '    - "lib/frontmatter.cjs exists and exports extractFrontmatter"',
    '    - "Nested frontmatter round-trips as a structured JS object"',
    '    - "Inline arrays parse as JS arrays"',
    '    - "Quoted scalars containing colon parse correctly"',
    '  artifacts:',
    '    - path: lib/frontmatter.cjs',
    '      provides: "hand-rolled YAML frontmatter parser"',
    '      exports: ["extractFrontmatter"]',
    '    - path: lib/frontmatter.test.cjs',
    '      provides: "node:test suite"',
    '      contains: "node:test"',
    '  key_links:',
    '    - from: "lib/frontmatter.cjs"',
    '      to: "Node builtins only"',
    '      via: "require(node:fs) / no other requires"',
    '      pattern: "require"',
    '---',
    '<objective>body</objective>',
  ].join('\n');
  const { frontmatter } = extractFrontmatter(raw);
  assert.equal(frontmatter.phase, '03');
  assert.ok(Array.isArray(frontmatter.depends_on));
  assert.equal(frontmatter.depends_on.length, 0);
  assert.ok(Array.isArray(frontmatter.files_modified));
  assert.equal(frontmatter.files_modified.length, 2);
  assert.ok(Array.isArray(frontmatter.requirements));
  assert.deepEqual(frontmatter.requirements, ['LIB-06', 'LIB-07']);
  assert.ok(frontmatter.must_haves, 'must_haves present');
  assert.ok(Array.isArray(frontmatter.must_haves.truths));
  assert.ok(frontmatter.must_haves.truths.length >= 4, 'truths has ≥4 entries');
  assert.ok(Array.isArray(frontmatter.must_haves.artifacts));
  assert.equal(frontmatter.must_haves.artifacts[0].path, 'lib/frontmatter.cjs');
  assert.ok(Array.isArray(frontmatter.must_haves.key_links));
  assert.equal(frontmatter.must_haves.key_links[0].from, 'lib/frontmatter.cjs');
});
