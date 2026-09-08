'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const handler = require('./isolation.cjs');
const { _resetConfigCacheForTests } = require('../../lib/config.cjs');

function _ctx(cwd) {
  const out = [];
  const err = [];
  return {
    ctx: { cwd, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } },
    out: () => out.join(''),
    err: () => err.join(''),
  };
}

function _project(config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-isoh-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot', 'milestones'), { recursive: true });
  if (config) {
    fs.writeFileSync(path.join(root, '.nubos-pilot', 'config.json'), JSON.stringify(config, null, 2), 'utf-8');
  }
  if (typeof _resetConfigCacheForTests === 'function') _resetConfigCacheForTests();
  return root;
}

function _cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
  if (typeof _resetConfigCacheForTests === 'function') _resetConfigCacheForTests();
}

test('ISH-1: no args prints usage non-zero; --help exits zero', () => {
  const a = _ctx();
  assert.equal(handler.run([], a.ctx), 1);
  assert.match(a.out(), /Usage:/);
  const b = _ctx();
  assert.equal(handler.run(['--help'], b.ctx), 0);
  assert.match(b.out(), /never silently downgraded/);
});

test('ISH-2: status on a default project reports the direct tier and says it is not safety', () => {
  const root = _project(null);
  try {
    const c = _ctx(root);
    assert.equal(handler.run(['status'], c.ctx), 0);
    assert.match(c.out(), /tier: direct/);
    assert.match(c.out(), /isolates rights:\s+false/);
    assert.match(c.out(), /Does not protect against:/);
  } finally {
    _cleanup(root);
  }
});

test('ISH-3: status --json exposes the tier, its guarantees and the advisory', () => {
  const root = _project(null);
  try {
    const c = _ctx(root);
    assert.equal(handler.run(['status', '--json'], c.ctx), 0);
    const p = JSON.parse(c.out());
    assert.equal(p.tier, 'direct');
    assert.equal(p.effective_from, 'default');
    assert.equal(p.description.isolates_rights, false);
    assert.match(p.advisory, /full account rights/);
  } finally {
    _cleanup(root);
  }
});

test('ISH-4: workflow.worktree_isolation raises the reported tier to worktree', () => {
  const root = _project({ workflow: { worktree_isolation: true } });
  try {
    const c = _ctx(root);
    handler.run(['status', '--json'], c.ctx);
    const p = JSON.parse(c.out());
    assert.equal(p.tier, 'worktree');
    assert.equal(p.description.isolates_versions, true);
    assert.equal(p.description.isolates_rights, false, 'a worktree is not a sandbox');
    assert.equal(p.advisory, null);
  } finally {
    _cleanup(root);
  }
});

test('ISH-5: an invalid configured tier is refused rather than coerced', () => {
  const root = _project({ isolation: { tier: 'sandbox' } });
  try {
    const c = _ctx(root);
    assert.equal(handler.run(['status'], c.ctx), 1);
    assert.match(c.err(), /isolation-invalid-tier/);
  } finally {
    _cleanup(root);
  }
});

test('ISH-6: describe explains a tier and requires one', () => {
  const c = _ctx();
  assert.equal(handler.run(['describe', 'container', '--json'], c.ctx), 0);
  const d = JSON.parse(c.out());
  assert.equal(d.isolates_rights, true);

  const missing = _ctx();
  assert.equal(handler.run(['describe'], missing.ctx), 1);
  assert.match(missing.err(), /isolation-missing-tier/);

  const bogus = _ctx();
  assert.equal(handler.run(['describe', 'vm'], bogus.ctx), 1);
  assert.match(bogus.err(), /isolation-unknown-tier/);
});

test('ISH-7: probe reports availability and exits accordingly', () => {
  // Runs on whatever the machine has; assert the contract, not the outcome.
  const c = _ctx();
  const rc = handler.run(['probe', '--json'], c.ctx);
  const p = JSON.parse(c.out());
  assert.equal(typeof p.available, 'boolean');
  assert.equal(rc, p.available ? 0 : 1);
  if (!p.available) assert.ok(['runtime-not-installed', 'daemon-unreachable'].includes(p.reason));
});

test('ISH-8: wrap on a non-container tier reports a passthrough, not a bare command', () => {
  // A bare command would be indistinguishable from a wrapped one, which is how a
  // caller ends up believing an unwrapped spawn is contained.
  const root = _project(null);
  try {
    const c = _ctx(root);
    assert.equal(handler.run(['wrap', '--', 'node', '-v'], c.ctx), 0);
    const p = JSON.parse(c.out());
    assert.equal(p.wrapped, false);
    assert.equal(p.tier, 'direct');
    assert.equal(p.bin, 'node');
    assert.match(p.note, /host's own rights/);
  } finally {
    _cleanup(root);
  }
});

test('ISH-9: wrap requires a command after the separator', () => {
  const root = _project(null);
  try {
    for (const args of [['wrap'], ['wrap', '--']]) {
      const c = _ctx(root);
      assert.equal(handler.run(args, c.ctx), 1);
      assert.match(c.err(), /isolation-wrap-no-command/);
    }
  } finally {
    _cleanup(root);
  }
});

test('ISH-10: wrap on the container tier refuses when no runtime is usable', () => {
  const root = _project({ isolation: { tier: 'container' } });
  try {
    const probe = handler.probeContainerRuntime();
    const c = _ctx(root);
    const rc = handler.run(['wrap', '--', 'node', '-v'], c.ctx);
    if (probe.available) {
      // Docker present: the command must actually be wrapped.
      assert.equal(rc, 0);
      const p = JSON.parse(c.out());
      assert.equal(p.wrapped, true);
      assert.equal(p.bin, 'docker');
      assert.match(p.args.join(' '), /--network none/);
      assert.deepEqual(p.args.slice(-2), ['node', '-v']);
    } else {
      assert.equal(rc, 1);
      assert.match(c.err(), /isolation-container-unavailable/);
    }
  } finally {
    _cleanup(root);
  }
});

test('ISH-11: status on a container tier without a runtime exits non-zero', () => {
  const root = _project({ isolation: { tier: 'container' } });
  try {
    const probe = handler.probeContainerRuntime();
    const c = _ctx(root);
    const rc = handler.run(['status'], c.ctx);
    assert.equal(rc, probe.available ? 0 : 1);
    if (!probe.available) assert.match(c.err(), /isolation-container-unavailable/);
  } finally {
    _cleanup(root);
  }
});

test('ISH-12: an unknown verb lists the allowed set', () => {
  const c = _ctx();
  assert.equal(handler.run(['frobnicate'], c.ctx), 1);
  assert.match(c.err(), /isolation-unknown-verb/);
  assert.match(c.err(), /wrap/);
});
