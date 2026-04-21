const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const INSTALL_JS = path.join(__dirname, '..', '..', 'bin', 'install.js');
const PKG_VERSION = String(require('../../package.json').version);

function runCli(args) {
  return spawnSync(process.execPath, [INSTALL_JS, ...args], {
    cwd: __dirname,
    encoding: 'utf-8',
  });
}

test('--version prints package.json version on stdout and exits 0', () => {
  const res = runCli(['--version']);
  assert.equal(res.status, 0, 'exit code must be 0; stderr=' + res.stderr);
  assert.equal(res.stdout.trim(), PKG_VERSION);
});

test('-v is an alias for --version', () => {
  const res = runCli(['-v']);
  assert.equal(res.status, 0, 'exit code must be 0; stderr=' + res.stderr);
  assert.equal(res.stdout.trim(), PKG_VERSION);
});

test('--version short-circuits before flag parsing and ignores other args', () => {
  const res = runCli(['--version', '--agent=bogus']);
  assert.equal(res.status, 0,
    '--version must win over invalid flags; stderr=' + res.stderr);
  assert.equal(res.stdout.trim(), PKG_VERSION);
});
