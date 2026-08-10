'use strict';

const test = require('node:test');
const assert = require('node:assert');

const YAML = require('yaml');

const codexSkills = require('./codex-skills.cjs');

// Codex parses the installed SKILL.md with a real YAML parser, so the assertions
// go through one too — round-tripping via lib/frontmatter.cjs would only prove
// the file survives nubos-pilot's own reader, which is not who consumes it.
function _readSkill(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  assert.ok(m, 'rendered skill must open with a frontmatter block');
  return { frontmatter: YAML.parse(m[1]), body: content.slice(m[0].length) };
}

const WORKFLOW = [
  '---',
  'command: np:plan-phase',
  'description: Plans a milestone — "slices" and tasks.',
  'argument-hint: <milestone-number> [--research]',
  '---',
  '',
  '# np:plan-phase',
  '',
  'Body stays.',
  '',
].join('\n');

test('renderWorkflowSkill: prefixes the name and emits parseable SKILL.md frontmatter', () => {
  const out = codexSkills.renderWorkflowSkill({
    sourceFile: '/src/workflows/plan-phase.md',
    content: WORKFLOW,
    prefix: 'np-',
  });

  assert.equal(out.name, 'np-plan-phase');
  const { frontmatter, body } = _readSkill(out.content);
  assert.equal(frontmatter.name, 'np-plan-phase');
  assert.equal(frontmatter['user-invocable'], true);
  // The quote inside the source description must survive as data, not break YAML.
  assert.match(frontmatter.description, /"slices" and tasks/);
  assert.match(body, /Body stays\./);
});

test('renderWorkflowSkill: header states the $-invocation and the Claude equivalent', () => {
  const out = codexSkills.renderWorkflowSkill({
    sourceFile: '/src/workflows/plan-phase.md',
    content: WORKFLOW,
    prefix: 'np-',
  });

  // `/np-plan-phase` is not a thing in Codex; saying so is the whole point of #3.
  assert.match(out.content, /\$np-plan-phase <milestone-number> \[--research\]/);
  assert.match(out.content, /\/np:plan-phase/);
  assert.doesNotMatch(out.content, /invoked with `\/`/);
});

test('skillNameFor: an already-prefixed source is not double-prefixed', () => {
  assert.equal(codexSkills.skillNameFor('np-', '/a/np-critic.md'), 'np-critic');
  assert.equal(codexSkills.skillNameFor('np-', '/a/plan-phase.md'), 'np-plan-phase');
});

test('render: a source without a description is refused, not shipped blind', () => {
  // Codex loads only name+description at startup, so a description-less skill is
  // invisible to discovery — installing it would look fine and do nothing.
  assert.throws(
    () => codexSkills.renderWorkflowSkill({
      sourceFile: '/src/workflows/state.md',
      content: '# np:state\n\nNo frontmatter.\n',
      prefix: 'np-',
    }),
    (err) => err.code === 'codex-skill-missing-description',
  );
});

test('render: description stays one YAML line and survives quotes and colons', () => {
  // A description is what /skills shows and what implicit invocation matches on;
  // a folded block or a broken escape there costs discovery, not just tidiness.
  const src = [
    '---',
    'description: Uses "quotes", a: colon, a \\backslash and #hash.',
    '---',
    '',
    'body',
    '',
  ].join('\n');
  const out = codexSkills.renderWorkflowSkill({
    sourceFile: '/src/workflows/x.md',
    content: src,
    prefix: 'np-',
  });

  const { frontmatter } = _readSkill(out.content);
  assert.equal(frontmatter.description, 'Uses "quotes", a: colon, a \\backslash and #hash.');
  const descLines = out.content.split('\n').filter((l) => l.startsWith('description:'));
  assert.equal(descLines.length, 1);
});
