const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = [
  path.join(ROOT, 'lib'),
  path.join(ROOT, 'bin', 'np-tools'),
];

const ALLOWLIST = new Set([
  'lib/install/staging.cjs',
]);

const CONSOLE_RE = /\bconsole\.(log|warn|error|info|debug)\s*\(/;

function walk(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, acc);
    else if (entry.name.endsWith('.cjs') && !entry.name.endsWith('.test.cjs')) acc.push(abs);
  }
  return acc;
}

function rel(abs) {
  return path.relative(ROOT, abs).split(path.sep).join('/');
}

test('LOG-1: no console.* in lib/ or bin/np-tools/ business logic (use lib/logger.cjs)', () => {
  const offenders = [];
  for (const dir of SCAN_DIRS) {
    for (const abs of walk(dir, [])) {
      const r = rel(abs);
      if (ALLOWLIST.has(r)) continue;
      if (CONSOLE_RE.test(fs.readFileSync(abs, 'utf-8'))) offenders.push(r);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'console.* found — route through lib/logger.cjs, or add a justified path to the allowlist: ' + offenders.join(', '),
  );
});

test('LOG-2: logging-policy allowlist has no stale entries', () => {
  for (const r of ALLOWLIST) {
    const abs = path.join(ROOT, r);
    assert.ok(fs.existsSync(abs), 'allowlisted file no longer exists: ' + r);
    assert.ok(
      CONSOLE_RE.test(fs.readFileSync(abs, 'utf-8')),
      'allowlisted file no longer uses console.* — remove it from the allowlist: ' + r,
    );
  }
});
