#!/usr/bin/env node
const { spawnSync } = require('node:child_process');

const THRESHOLD = 70;

const res = spawnSync(
  'node',
  [
    '--test',
    '--experimental-test-coverage',
    "--test-coverage-include=lib/**",
    'lib/**/*.test.cjs',
  ],
  { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
);

const combined = (res.stdout || '') + '\n' + (res.stderr || '');

const m = combined.match(/^#?\s*all\s+files\s*\|\s*([\d.]+)/im);
if (!m) {
  console.error('Coverage parse error: could not find "all files" summary line.');
  console.error('--- raw output (tail) ---');
  console.error(combined.slice(-2000));
  process.exit(2);
}
const pct = Number(m[1]);
if (Number.isNaN(pct)) {
  console.error(`Coverage parse error: summary value not numeric (${m[1]}).`);
  process.exit(2);
}
if (pct < THRESHOLD) {
  console.error(`Coverage FAIL: ${pct.toFixed(2)}% < ${THRESHOLD}%`);
  process.exit(1);
}
if (res.status !== 0) {
  console.error(`Coverage OK: ${pct.toFixed(2)}% — BUT tests failed (exit ${res.status}).`);
  process.exit(res.status);
}
console.log(`Coverage OK: ${pct.toFixed(2)}%`);
process.exit(0);
