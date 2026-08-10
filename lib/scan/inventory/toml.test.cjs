'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseToml } = require('./toml.cjs');

function _code(code) {
  return (err) => err && err.name === 'NubosPilotError' && err.code === code;
}

test('TOML-1 repeated [[package]] headers become an array of tables', () => {
  const doc = parseToml([
    '[[package]]',
    'name = "serde"',
    'version = "1.0.197"',
    '',
    '[[package]]',
    'name = "anyhow"',
    'version = "1.0.80"',
  ].join('\n'));
  assert.ok(Array.isArray(doc.package));
  assert.equal(doc.package.length, 2);
  assert.deepEqual(doc.package.map((p) => p.name), ['serde', 'anyhow']);
  assert.deepEqual(doc.package.map((p) => p.version), ['1.0.197', '1.0.80']);
});

test('TOML-2 nested table headers build nested objects', () => {
  const doc = parseToml([
    '[tool.poetry]',
    'name = "demo"',
    '',
    '[tool.poetry.dependencies]',
    'python = "^3.12"',
    '',
    '[build-system]',
    'backend = "hatchling"',
  ].join('\n'));
  assert.deepEqual(doc, {
    tool: { poetry: { name: 'demo', dependencies: { python: '^3.12' } } },
    'build-system': { backend: 'hatchling' },
  });
});

test('TOML-3 every supported string form parses', () => {
  const cases = [
    ['basic', 'k = "plain"', 'plain'],
    ['escapes', 'k = "a\\nb\\tc\\"d\\\\e"', 'a\nb\tc"d\\e'],
    ['unicode escape', 'k = "caf\\u00e9"', 'café'],
    ['literal keeps backslashes', "k = 'C:\\path\\n'", 'C:\\path\\n'],
    ['empty basic', 'k = ""', ''],
    ['multiline basic', 'k = """\nline1\nline2\n"""', 'line1\nline2\n'],
    ['multiline basic inline start', 'k = """one\ntwo"""', 'one\ntwo'],
    ['multiline literal', "k = '''\nraw\\nvalue\n'''", 'raw\\nvalue\n'],
  ];
  for (const [label, input, expected] of cases) {
    assert.equal(parseToml(input).k, expected, label);
  }
});

test('TOML-4 integers accept signs, underscores and decimals', () => {
  const cases = [
    ['k = 123', 123],
    ['k = 0', 0],
    ['k = -17', -17],
    ['k = +42', 42],
    ['k = 1_000', 1000],
    ['k = 1_000_000', 1000000],
    ['k = -2_5', -25],
    ['k = 1.5', 1.5],
  ];
  for (const [input, expected] of cases) {
    assert.equal(parseToml(input).k, expected, input);
  }
});

test('TOML-5 booleans parse as booleans', () => {
  const doc = parseToml('a = true\nb = false\nc = "true"');
  assert.equal(doc.a, true);
  assert.equal(doc.b, false);
  assert.equal(doc.c, 'true');
});

test('TOML-6 arrays span lines and tolerate a trailing comma', () => {
  const doc = parseToml([
    'deps = [',
    '  "serde",',
    '  "anyhow",   # inline note',
    ']',
    'flat = ["a", "b"]',
    'nums = [1, 2, 3]',
    'empty = []',
  ].join('\n'));
  assert.deepEqual(doc.deps, ['serde', 'anyhow']);
  assert.deepEqual(doc.flat, ['a', 'b']);
  assert.deepEqual(doc.nums, [1, 2, 3]);
  assert.deepEqual(doc.empty, []);
});

test('TOML-7 inline tables parse into objects, including inside arrays', () => {
  const doc = parseToml([
    'sdist = { name = "attrs", version = "23.2.0", size = 1_024 }',
    'wheels = [{ url = "a.whl" }, { url = "b.whl" }]',
    'nothing = {}',
  ].join('\n'));
  assert.deepEqual(doc.sdist, { name: 'attrs', version: '23.2.0', size: 1024 });
  assert.deepEqual(doc.wheels, [{ url: 'a.whl' }, { url: 'b.whl' }]);
  assert.deepEqual(doc.nothing, {});
});

test('TOML-8 comments are stripped whole-line and after values', () => {
  const doc = parseToml([
    '# leading comment',
    '   # indented comment',
    'name = "demo"  # trailing comment with = and [brackets]',
    '',
    '[table] # comment after a header',
    'n = 7 # another',
  ].join('\n'));
  assert.deepEqual(doc, { name: 'demo', table: { n: 7 } });
});

test('TOML-9 CRLF line endings parse like LF', () => {
  const doc = parseToml('[[package]]\r\nname = "serde"\r\nversion = "1.0.197"\r\n');
  assert.deepEqual(doc, { package: [{ name: 'serde', version: '1.0.197' }] });
});

test('TOML-10 quoted keys allow spaces and dots', () => {
  const doc = parseToml([
    '"key with spaces" = 1',
    "'literal key' = 2",
    '["quoted.header"]',
    'inner = 3',
  ].join('\n'));
  assert.equal(doc['key with spaces'], 1);
  assert.equal(doc['literal key'], 2);
  assert.deepEqual(doc['quoted.header'], { inner: 3 });
});

test('TOML-11 blank lines and arbitrary indentation are ignored', () => {
  const doc = parseToml('\n\n    [a]\n\n\t b = 1\n\n        c = 2\n\n');
  assert.deepEqual(doc, { a: { b: 1, c: 2 } });
});

test('TOML-12 input over the byte cap throws toml-too-large', () => {
  assert.throws(() => parseToml('name = "x"', { maxBytes: 4 }), _code('toml-too-large'));
  assert.throws(() => parseToml('a'.repeat(5 * 1024 * 1024)), _code('toml-too-large'));
  assert.deepEqual(parseToml('n = 1', { maxBytes: 5 }), { n: 1 });
});

test('TOML-13 unsupported lines are skipped instead of throwing', () => {
  const cases = [
    ['dotted key', 'a.b = 1'],
    ['offset date-time', 'created = 1979-05-27T07:32:00Z'],
    ['local date', 'day = 1979-05-27'],
    ['float exponent', 'big = 5e+22'],
    ['hex integer', 'mask = 0xdeadbeef'],
    ['infinity', 'x = inf'],
    ['not a number', 'x = nan'],
    ['missing equals', 'orphan'],
    ['unterminated string', 'x = "open'],
    ['garbage', '%%%'],
  ];
  for (const [label, line] of cases) {
    const doc = parseToml(['name = "before"', line, 'version = "after"'].join('\n'));
    assert.deepEqual(doc, { name: 'before', version: 'after' }, label);
  }
});

test('TOML-14 empty and whitespace-only input yields an empty object', () => {
  assert.deepEqual(parseToml(''), {});
  assert.deepEqual(parseToml('\n  \t\n# only a comment\n'), {});
  assert.deepEqual(parseToml(null), {});
});

test('TOML-15 a Cargo.lock snippet yields package names, versions and dependencies', () => {
  const doc = parseToml([
    '# This file is automatically @generated by Cargo.',
    '# It is not intended for manual editing.',
    'version = 3',
    '',
    '[[package]]',
    'name = "anyhow"',
    'version = "1.0.80"',
    'source = "registry+https://github.com/rust-lang/crates.io-index"',
    'checksum = "5ad32ce52e4161730f7098c077cd2ed6229b5804ccf99e5366be1ab72400b7be"',
    '',
    '[[package]]',
    'name = "serde"',
    'version = "1.0.197"',
    'source = "registry+https://github.com/rust-lang/crates.io-index"',
    'dependencies = [',
    ' "serde_derive",',
    ']',
    '',
    '[[package]]',
    'name = "serde_derive"',
    'version = "1.0.197"',
    'dependencies = [',
    ' "proc-macro2",',
    ' "quote",',
    ' "syn",',
    ']',
    '',
  ].join('\r\n'));
  assert.equal(doc.version, 3);
  assert.deepEqual(
    doc.package.map((p) => p.name + '@' + p.version),
    ['anyhow@1.0.80', 'serde@1.0.197', 'serde_derive@1.0.197'],
  );
  assert.deepEqual(doc.package[1].dependencies, ['serde_derive']);
  assert.deepEqual(doc.package[2].dependencies, ['proc-macro2', 'quote', 'syn']);
  assert.equal(doc.package[0].checksum.length, 64);
});

test('TOML-16 a uv.lock snippet yields packages with inline table metadata', () => {
  const doc = parseToml([
    'version = 1',
    'requires-python = ">=3.12"',
    '',
    '[[package]]',
    'name = "attrs"',
    'version = "23.2.0"',
    'source = { registry = "https://pypi.org/simple" }',
    'sdist = { url = "https://files.pythonhosted.org/attrs-23.2.0.tar.gz", hash = "sha256:abc", size = 780820 }',
    'wheels = [',
    '    { url = "https://files.pythonhosted.org/attrs-23.2.0-py3-none-any.whl", hash = "sha256:def", size = 60752 },',
    ']',
    '',
    '[[package]]',
    'name = "click"',
    'version = "8.1.7"',
    'source = { registry = "https://pypi.org/simple" }',
    'dependencies = [',
    '    { name = "colorama", marker = "platform_system == \'Windows\'" },',
    ']',
  ].join('\n'));
  assert.deepEqual(
    doc.package.map((p) => [p.name, p.version]),
    [['attrs', '23.2.0'], ['click', '8.1.7']],
  );
  assert.deepEqual(doc.package[0].source, { registry: 'https://pypi.org/simple' });
  assert.equal(doc.package[0].sdist.size, 780820);
  assert.equal(doc.package[0].wheels.length, 1);
  assert.equal(doc.package[0].wheels[0].hash, 'sha256:def');
  assert.deepEqual(doc.package[1].dependencies, [
    { name: 'colorama', marker: "platform_system == 'Windows'" },
  ]);
  assert.equal(doc['requires-python'], '>=3.12');
});

test('TOML-17 later keys in a table win and headers reopen existing tables', () => {
  const doc = parseToml([
    '[a]',
    'x = 1',
    '[b]',
    'y = 2',
    '[a]',
    'z = 3',
  ].join('\n'));
  assert.deepEqual(doc, { a: { x: 1, z: 3 }, b: { y: 2 } });
});

test('TOML-18 keys named like Object prototype members stay own properties', () => {
  const doc = parseToml('__proto__ = "x"\nconstructor = "y"\ntoString = "z"');
  assert.equal(doc.__proto__, 'x');
  assert.equal(doc.constructor, 'y');
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
  assert.deepEqual(Object.keys(doc).sort(), ['__proto__', 'constructor', 'toString']);
});
