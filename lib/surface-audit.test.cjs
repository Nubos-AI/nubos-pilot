const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LIB_DIR = path.resolve(__dirname);
const BAN_RE = /require\s*\(\s*['"](node:)?child_process['"]\s*\)|from\s+['"](node:)?child_process['"]/;
const SUBPROCESS_IDENTIFIERS = /\b(execSync|execFileSync|spawnSync|spawn|exec|execFile|fork)\s*\(/;

const SUBPROCESS_WHITELIST = new Set(['git.cjs']);

function libFiles() {
  return fs
    .readdirSync(LIB_DIR)
    .filter(
      (f) =>
        f.endsWith('.cjs') &&
        !f.endsWith('.test.cjs') &&
        f !== 'surface-audit.test.cjs' &&
        !SUBPROCESS_WHITELIST.has(f)
    )
    .map((f) => path.join(LIB_DIR, f));
}

test('SC 4 / ADR-0001: no lib/*.cjs imports child_process', () => {
  const files = libFiles();
  assert.ok(files.length >= 2, `expected >=2 lib/*.cjs files, scanned ${files.length}`);
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf-8');
    assert.ok(
      !BAN_RE.test(src),
      `SC 4 violation in ${path.relative(LIB_DIR, file)}: lib/ must NOT import child_process (see ADR-0001 / CONTEXT D-14).`
    );
  }
});

test('SC 4 (defense-in-depth): no subprocess identifiers in lib/*.cjs', () => {
  const files = libFiles();
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf-8');
    assert.ok(
      !SUBPROCESS_IDENTIFIERS.test(src),
      `SC 4 violation in ${path.relative(LIB_DIR, file)}: lib/ must not call subprocess APIs (see ADR-0001 / CONTEXT D-14).`
    );
  }
});
