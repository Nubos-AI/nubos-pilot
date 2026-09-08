const { test } = require('node:test');
const assert = require('node:assert/strict');

const subcmd = require('./spawn-offhost.cjs');

function _capture(fn) {
  const out = []; const err = [];
  const oo = process.stdout.write.bind(process.stdout);
  const oe = process.stderr.write.bind(process.stderr);
  process.stdout.write = (c) => { out.push(String(c)); return true; };
  process.stderr.write = (c) => { err.push(String(c)); return true; };
  return Promise.resolve(fn()).then((rc) => {
    process.stdout.write = oo; process.stderr.write = oe;
    return { rc, stdout: out.join(''), stderr: err.join('') };
  }, (e) => { process.stdout.write = oo; process.stderr.write = oe; throw e; });
}

test('SOH-1: _parse reads agent/task, the boolean flags, --cwd and --no-audit', () => {
  const p = subcmd._parse(['--agent', 'np-executor', '--task', 'do x', '--allow-bash', '--max-iterations', '5', '--cwd', '/wt', '--no-audit']);
  assert.equal(p.agent, 'np-executor');
  assert.equal(p.task, 'do x');
  assert.equal(p.allowBash, true);
  assert.equal(p.readOnly, false);
  assert.equal(p.maxIterations, 5);
  assert.equal(p.cwd, '/wt');
  assert.equal(p.skipAudit, true);
});

test('SOH-2: missing args prints usage and returns 1', async () => {
  const { rc, stderr } = await _capture(() => subcmd.run([]));
  assert.equal(rc, 1);
  assert.match(stderr, /Usage:/);
});

test('SOH-3: --agent without a task returns 1', async () => {
  const { rc } = await _capture(() => subcmd.run(['--agent', 'np-executor']));
  assert.equal(rc, 1);
});
