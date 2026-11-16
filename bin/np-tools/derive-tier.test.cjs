'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { run } = require('./derive-tier.cjs');

function _capture() {
  const out = { text: '' };
  const err = { text: '' };
  return {
    stdout: { write: (s) => { out.text += s; return true; } },
    stderr: { write: (s) => { err.text += s; return true; } },
    out, err,
  };
}

test('DT-1: --files + --name with security keyword → opus', () => {
  const c = _capture();
  const code = run(['--files', 'app/Auth.php', '--name', 'add login throttling'], c);
  assert.strictEqual(code, 0);
  const r = JSON.parse(c.out.text);
  assert.strictEqual(r.tier, 'opus');
  assert.strictEqual(r.size, 'large');
});

test('DT-2: single doc file → haiku', () => {
  const c = _capture();
  const code = run(['--files', 'README.md', '--name', 'fix typo'], c);
  assert.strictEqual(code, 0);
  assert.strictEqual(JSON.parse(c.out.text).tier, 'haiku');
});

test('DT-3: ordinary task → sonnet', () => {
  const c = _capture();
  const code = run(['--files', 'app/Cart.php,app/Cart.test.php', '--name', 'add discount'], c);
  assert.strictEqual(code, 0);
  assert.strictEqual(JSON.parse(c.out.text).tier, 'sonnet');
});

test('DT-4: --plan reads frontmatter files + body name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-derive-tier-'));
  const plan = path.join(dir, 'T0001-PLAN.md');
  fs.writeFileSync(plan, [
    '---',
    'id: M001-S001-T0001',
    'files_modified:',
    '  - db/migrations/004_users.sql',
    '---',
    '',
    '# M001-S001-T0001 — Add users table migration',
    '',
    'Body text.',
  ].join('\n'));
  const c = _capture();
  const code = run(['--plan', plan], c);
  assert.strictEqual(code, 0);
  assert.strictEqual(JSON.parse(c.out.text).tier, 'opus');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('DT-5: unknown arg → error envelope, exit 1', () => {
  const c = _capture();
  const code = run(['--bogus'], c);
  assert.strictEqual(code, 1);
  assert.match(c.err.text, /derive-tier-unknown-arg/);
});

test('DT-6: --help → usage, exit 0', () => {
  const c = _capture();
  const code = run(['--help'], c);
  assert.strictEqual(code, 0);
  assert.match(c.out.text, /derive-tier/);
});

test('DT-7: no files → standard sonnet, no throw', () => {
  const c = _capture();
  const code = run(['--name', 'something'], c);
  assert.strictEqual(code, 0);
  assert.strictEqual(JSON.parse(c.out.text).tier, 'sonnet');
});
