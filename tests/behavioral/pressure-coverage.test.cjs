'use strict';

// The offline half of ADR-0024: structural gates over the pressure suite.
//
// These tests cannot prove an agent obeys its mandate — only a live run can do
// that. What they prove is that the suite which measures obedience stays honest:
// every fixture targets a rule its agent actually claims, coverage never
// silently shrinks, and the debt list of untested rules cannot rot.
//
// Deliberately no model call. `pressure-eval report` is the verb that scores
// recorded responses, and it is run against a captured transcript on a model
// swap (ADR-0021) — not on every `npm test`.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const AGENTS_DIR = path.join(REPO_ROOT, 'agents');
const COMPLETENESS = path.join(REPO_ROOT, 'templates', 'COMPLETENESS.md');

const pressure = require(path.join(REPO_ROOT, 'lib', 'pressure.cjs'));
const { COMMANDS } = require(path.join(REPO_ROOT, 'bin', 'np-tools', '_commands.cjs'));
const { topLevelCommands } = require(path.join(REPO_ROOT, 'np-tools.cjs'));

// The rules with no pressure fixture yet. This is a debt list, not a
// permission slip: BHV-8 asserts it matches the real uncovered set exactly, so
// adding a fixture forces the entry out and deleting one forces an entry in.
// Neither direction can happen silently.
//
//   4  (docs)        — enforced by generate-docs --check in CI; a prose gate
//                      adds little over the mechanical one.
//   5  (impress)     — the quality bar is what every other fixture's compliant
//                      option embodies; a standalone scenario would score taste.
//   7  (loose ends)  — mechanically audited by Critic-Style on dangling imports.
//   10 (test first)  — commit-task refuses a commit without a green verify;
//                      the gate is code, not judgement.
//   11 (ship whole)  — structurally impossible to violate: execute-phase is the
//                      only workflow that closes tasks.
const KNOWN_UNCOVERED_RULES = Object.freeze([4, 5, 7, 10, 11]);

const FIXTURES = pressure.loadFixtures();

test('BHV-1: the shipped pressure suite loads and lints clean', () => {
  // loadFixtures throws on any structural defect, so reaching this line is the
  // lint passing. The count floor stops the suite being emptied to go green.
  assert.ok(FIXTURES.length >= 7, `expected at least 7 fixtures, found ${FIXTURES.length}`);
});

test('BHV-2: every fixture targets an agent that still exists', () => {
  const stale = FIXTURES
    .filter((fx) => !fs.existsSync(path.join(AGENTS_DIR, fx.agent + '.md')))
    .map((fx) => fx.id + ' -> ' + fx.agent);
  assert.deepEqual(stale, [], 'fixtures for deleted agents: ' + JSON.stringify(stale));
});

test('BHV-3: every fixture targets a rule the Completeness Mandate defines', () => {
  const body = fs.readFileSync(COMPLETENESS, 'utf-8');
  const defined = new Set([...body.matchAll(/^###\s+(\d+)\.\s+/gm)].map((m) => Number(m[1])));
  const orphans = FIXTURES.filter((fx) => !defined.has(fx.rule)).map((fx) => fx.id + ' -> Rule ' + fx.rule);
  assert.deepEqual(orphans, [], 'fixtures targeting undefined rules: ' + JSON.stringify(orphans));
});

test('BHV-4: every fixture targets a rule its agent doc actually claims to be bound by', () => {
  // The gate that found two real gaps when it was written: np-executor carried
  // no Rule 8 bullet while being the agent that ships workarounds, and
  // np-verifier carried no Rule 1 bullet even though COMPLETENESS.md names the
  // verifier in Rule 1's own mechanical check. Pressure-testing a rule the
  // agent never claimed measures nothing the agent agreed to.
  const gaps = [];
  for (const fx of FIXTURES) {
    const doc = fs.readFileSync(path.join(AGENTS_DIR, fx.agent + '.md'), 'utf-8');
    const mandate = doc.split(/^##\s+/m).find((s) => s.startsWith('Completeness Mandate'));
    assert.ok(mandate, `${fx.agent}.md has no Completeness Mandate block`);
    if (!new RegExp('Rule\\s+' + fx.rule + '\\b').test(mandate)) {
      gaps.push(fx.id + ': ' + fx.agent + ' does not list Rule ' + fx.rule + ' in its Mandate block');
    }
  }
  assert.deepEqual(gaps, [], 'fixture/mandate mismatches: ' + JSON.stringify(gaps, null, 2));
});

test('BHV-5: no rationalization merely echoes its excuse back as the counter', () => {
  // A counter that restates the excuse closes no loophole. Cheap to detect, and
  // it is the laziest way to satisfy the uncountered-rationalization gate.
  const lazy = [];
  for (const fx of FIXTURES) {
    for (const r of fx.rationalizations) {
      const norm = (s) => s.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
      if (norm(r.counter).includes(norm(r.excuse)) || norm(r.counter) === norm(r.excuse)) {
        lazy.push(fx.id + ': ' + r.excuse.slice(0, 50));
      }
      if (r.counter.trim().length < r.excuse.trim().length / 2) {
        lazy.push(fx.id + ': counter far shorter than excuse — ' + r.excuse.slice(0, 50));
      }
    }
  }
  assert.deepEqual(lazy, [], 'lazy counters: ' + JSON.stringify(lazy, null, 2));
});

test('BHV-6: pressure-eval is a registered command with a dispatch entry', () => {
  assert.ok(
    COMMANDS.some((c) => c && c.name === 'pressure-eval'),
    'pressure-eval must appear in _commands.cjs or it is invisible to np:help and the docs generator',
  );
  assert.ok(topLevelCommands['pressure-eval'], 'pressure-eval must be dispatchable from np-tools.cjs');
});

test('BHV-7: every fixture stacks at least MIN_PRESSURES distinct pressures', () => {
  // Redundant with validateFixture by construction, and kept deliberately: this
  // is the doctrine claim of ADR-0024, so it gets an assertion that names it
  // rather than relying on a loader side effect.
  for (const fx of FIXTURES) {
    assert.ok(
      new Set(fx.pressures).size >= pressure.MIN_PRESSURES,
      `${fx.id} stacks ${fx.pressures.length} pressures, floor is ${pressure.MIN_PRESSURES}`,
    );
  }
});

test('BHV-8: the uncovered-rule debt list matches reality exactly and cannot rot', () => {
  const cov = pressure.coverage(FIXTURES, []);
  assert.deepEqual(
    cov.uncovered_rules, KNOWN_UNCOVERED_RULES.slice(),
    'KNOWN_UNCOVERED_RULES has drifted from the suite. Adding a fixture must remove its rule '
    + 'from the list; deleting one must add it back. Actual uncovered: ' + JSON.stringify(cov.uncovered_rules),
  );
});

test('BHV-9: coverage never silently shrinks below the rules that are covered today', () => {
  const covered = new Set(pressure.coverage(FIXTURES, []).rules_covered);
  for (const rule of [1, 2, 3, 6, 8, 9, 12]) {
    assert.ok(covered.has(rule), `Rule ${rule} lost its pressure fixture — coverage regressed`);
  }
});
