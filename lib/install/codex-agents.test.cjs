'use strict';

const test = require('node:test');
const assert = require('node:assert');

const codexAgents = require('./codex-agents.cjs');

// Codex parses these with a real TOML parser, so the tests do too. Node has no
// TOML built-in and nubos-pilot takes no new dependency for one file format, so
// this covers the subset the renderer emits: bare `key = "basic"` scalars and
// `key = '''literal block'''`. It is deliberately strict — an unescaped quote or
// a stray delimiter must fail here, not in the user's Codex session.
function parseToml(src) {
  const out = {};
  let rest = src;
  while (rest.trim() !== '') {
    const m = rest.match(/^(\w+)\s*=\s*/);
    assert.ok(m, 'expected `key = value`, got: ' + rest.slice(0, 40));
    const key = m[1];
    rest = rest.slice(m[0].length);
    if (rest.startsWith("'''")) {
      const end = rest.indexOf("'''", 3);
      assert.notEqual(end, -1, 'unterminated literal block for ' + key);
      // Literal strings process no escapes: the value is the raw bytes.
      out[key] = rest.slice(3, end).replace(/^\n/, '');
      rest = rest.slice(end + 3);
    } else {
      assert.ok(rest.startsWith('"'), key + ' must be a basic string');
      let i = 1;
      let val = '';
      for (; i < rest.length; i++) {
        const ch = rest[i];
        if (ch === '\\') {
          const next = rest[i + 1];
          const map = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' };
          assert.ok(next in map, 'invalid TOML escape \\' + next + ' in ' + key);
          val += map[next];
          i++;
          continue;
        }
        if (ch === '"') break;
        assert.notEqual(ch, '\n', key + ' basic string may not contain a raw newline');
        val += ch;
      }
      assert.equal(rest[i], '"', 'unterminated basic string for ' + key);
      out[key] = val;
      rest = rest.slice(i + 1);
    }
    rest = rest.replace(/^\s*/, '');
  }
  return out;
}

const AGENT = [
  '---',
  'name: np-critic',
  'description: Adversarial per-task review.',
  'tier: sonnet',
  'tools: Read, Write, Bash',
  '---',
  '',
  '## Role',
  '',
  'You are a critic.',
  '',
].join('\n');

test('renderAgentToml: emits the three fields Codex requires', () => {
  const out = codexAgents.renderAgentToml({ sourceFile: '/src/agents/np-critic.md', content: AGENT });

  assert.equal(out.name, 'np-critic');
  const toml = parseToml(out.content);
  assert.equal(toml.name, 'np-critic');
  assert.equal(toml.description, 'Adversarial per-task review.');
  assert.match(toml.developer_instructions, /You are a critic\./);
  assert.match(toml.developer_instructions, /Reference tier: `sonnet`/);
});

test('renderAgentToml: a body full of regex backslashes stays valid TOML', () => {
  // The reason the body is a literal block: TOML basic strings process escapes,
  // and `\d` is not one — it would be a parse error in the user's session.
  const src = [
    '---',
    'name: np-sc-extractor',
    'description: Extracts success criteria.',
    '---',
    '',
    'Match `^SC-\\d+$` and `C:\\path\\to`, never "quoted" text.',
    '',
  ].join('\n');

  const out = codexAgents.renderAgentToml({ sourceFile: '/src/agents/np-sc-extractor.md', content: src });
  const toml = parseToml(out.content);
  assert.match(toml.developer_instructions, /\^SC-\\d\+\$/);
  assert.match(toml.developer_instructions, /C:\\path\\to/);
  assert.match(toml.developer_instructions, /"quoted"/);
});

test('renderAgentToml: quotes and backslashes in the description are escaped, not emitted raw', () => {
  const src = '---\nname: np-x\ndescription: Says "hi" and C:\\tmp — matches ^SC-\\d+$.\n---\n\nbody\n';
  const out = codexAgents.renderAgentToml({ sourceFile: '/src/agents/np-x.md', content: src });

  const descLine = out.content.split('\n').find((l) => l.startsWith('description ='));
  assert.ok(descLine.includes('\\"hi\\"'), 'inner quotes must be escaped: ' + descLine);
  // A raw `\t` inside a basic string is a TAB escape, not the two characters —
  // so the backslash has to be doubled or the description silently mutates.
  const toml = parseToml(out.content);
  assert.equal(toml.description, 'Says "hi" and C:\\tmp — matches ^SC-\\d+$.');
  assert.equal(out.content.split('\n').filter((l) => l.startsWith('description =')).length, 1);
});

test('renderAgentToml: a body containing the literal delimiter is refused', () => {
  // Silently mangling it would produce a TOML file that parses into the wrong
  // instructions — worse than not installing the agent.
  const src = "---\nname: np-x\ndescription: d\n---\n\nSee ''' here.\n";
  assert.throws(
    () => codexAgents.renderAgentToml({ sourceFile: '/src/agents/np-x.md', content: src }),
    (err) => err.code === 'codex-agent-undelimitable-body',
  );
});

test('renderAgentToml: a role without a description is refused', () => {
  // Codex matches on description when choosing which agent to spawn; an empty
  // one installs a role that delegation can never reach.
  assert.throws(
    () => codexAgents.renderAgentToml({ sourceFile: '/src/agents/np-x.md', content: '# no frontmatter\n' }),
    (err) => err.code === 'codex-agent-missing-description',
  );
});

test('renderAgentToml: every shipped agent renders to parseable TOML', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', '..', 'agents');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  assert.ok(files.length > 0, 'no agents found to check');

  for (const file of files) {
    const sourceFile = path.join(dir, file);
    const out = codexAgents.renderAgentToml({ sourceFile, content: fs.readFileSync(sourceFile, 'utf8') });
    const toml = parseToml(out.content);
    assert.equal(toml.name, out.name, file);
    assert.ok(toml.description.length > 0, file + ' has an empty description');
    assert.ok(toml.developer_instructions.length > 0, file + ' has empty instructions');
  }
});
