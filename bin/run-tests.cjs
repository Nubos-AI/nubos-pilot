#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TEST_FILES = ['*.test.cjs', 'lib/**/*.test.cjs', 'tests/**/*.test.cjs', 'bin/**/*.test.cjs', 'scripts/**/*.test.cjs'];

function run({ coverage = false } = {}) {
  const args = ['--test'];
  if (coverage) {
    args.push('--experimental-test-coverage', '--test-coverage-include=lib/**', '--test-coverage-lines=70');
  }
  const result = spawnSync(process.execPath, [...args, ...TEST_FILES], {
    cwd: path.join(__dirname, '..'), stdio: 'inherit',
  });
  if (result.error) console.error(result.error.message);
  if (result.signal) console.error(`Test runner terminated by ${result.signal}`);
  return result.status ?? 1;
}

if (require.main === module) process.exitCode = run({ coverage: process.argv.includes('--coverage') });
module.exports = { run };
