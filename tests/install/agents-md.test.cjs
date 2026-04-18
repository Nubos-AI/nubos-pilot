const test = require('node:test');
const assert = require('node:assert/strict');

test('agents-md: generateAgentsMd returns content with permissionMode frontmatter key removed (D-10)', () => {
  const { generateAgentsMd } = require('../../lib/install/agents-md.cjs');
  const claudeMd = [
    '---',
    'name: project',
    'permissionMode: acceptAll',
    'description: demo',
    '---',
    '',
    '# Project',
    '',
    'Body.',
    '',
  ].join('\n');
  const out = generateAgentsMd(claudeMd);
  assert.ok(!/permissionMode\s*:/.test(out), 'permissionMode frontmatter key stripped');
  assert.ok(/name\s*:\s*project/.test(out), 'other frontmatter keys preserved');
  assert.ok(out.includes('# Project'), 'body preserved');
});

test('agents-md: generator adds readline-prompts note (D-10)', () => {
  const { generateAgentsMd } = require('../../lib/install/agents-md.cjs');
  const claudeMd = '# Project\n\nBody.\n';
  const out = generateAgentsMd(claudeMd);
  assert.match(out, /readline|prompt/i, 'must hint about readline-prompts fallback for non-Claude runtimes');
});

test('agents-md: generateAgentsMd(runtime=gemini) emits Gemini notice (D-09)', () => {
  const { generateAgentsMd } = require('../../lib/install/agents-md.cjs');
  const out = generateAgentsMd('# Test\n', 'gemini');
  assert.match(out, /GEMINI\.md/);
  assert.match(out, /readline/i);
});

test('agents-md: generateAgentsMd(runtime=opencode) emits OpenCode notice (D-09, 8.1 D-02)', () => {
  const { generateAgentsMd } = require('../../lib/install/agents-md.cjs');
  const out = generateAgentsMd('# Test\n', 'opencode');
  assert.match(out, /\.opencode\/nubos-pilot\/AGENTS\.md/);
  assert.match(out, /\/model inherit/);
});

test('agents-md: generateAgentsMd(runtime=claude) emits Claude notice (D-09)', () => {
  const { generateAgentsMd } = require('../../lib/install/agents-md.cjs');
  const out = generateAgentsMd('# Test\n', 'claude');
  assert.match(out, /Claude Code/);
});

test('agents-md: default runtime (no arg) equals runtime=codex (back-compat guarantee)', () => {
  const { generateAgentsMd } = require('../../lib/install/agents-md.cjs');
  const a = generateAgentsMd('# Test\n');
  const b = generateAgentsMd('# Test\n', 'codex');
  assert.equal(a, b);
});

test('agents-md: unknown runtime throws NubosPilotError with code runtime-unknown', () => {
  const { generateAgentsMd } = require('../../lib/install/agents-md.cjs');
  assert.throws(
    () => generateAgentsMd('# Test\n', 'mystery'),
    (err) => err && err.code === 'runtime-unknown',
  );
});
