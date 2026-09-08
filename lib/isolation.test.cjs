'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const iso = require('./isolation.cjs');

function _code(code) {
  return (err) => err && err.name === 'NubosPilotError' && err.code === code;
}

// -------------------------------------------------------------- describeTier

test('IS-1: every tier is describable and the set is exactly three', () => {
  assert.deepEqual(iso.TIERS, ['direct', 'worktree', 'container']);
  for (const tier of iso.TIERS) {
    const d = iso.describeTier(tier);
    assert.equal(d.tier, tier);
    assert.ok(d.summary.length > 40);
    assert.ok(Array.isArray(d.does_not_protect_against) && d.does_not_protect_against.length > 0);
  }
});

test('IS-2: the description states plainly that worktree isolates versions, not rights', () => {
  // Treating ADR-0008 worktrees as a sandbox is a category error, and the whole
  // point of publishing this as data is that the three copies of the claim
  // (CLI, docs, doctor) cannot drift apart.
  const wt = iso.describeTier('worktree');
  assert.equal(wt.isolates_versions, true);
  assert.equal(wt.isolates_rights, false);
  const direct = iso.describeTier('direct');
  assert.equal(direct.isolates_rights, false);
  assert.equal(direct.isolates_versions, false);
  const c = iso.describeTier('container');
  assert.equal(c.isolates_rights, true);
});

test('IS-3: even the container tier names what it does not protect against', () => {
  // A tier that claims total protection invites exactly the trust it cannot earn.
  const c = iso.describeTier('container');
  assert.ok(c.does_not_protect_against.some((s) => /escape/i.test(s)));
  assert.ok(c.does_not_protect_against.some((s) => /review/i.test(s)));
});

test('IS-4: an unknown tier is refused', () => {
  assert.throws(() => iso.describeTier('vm'), _code('isolation-unknown-tier'));
  assert.throws(() => iso.describeTier(undefined), _code('isolation-unknown-tier'));
});

// -------------------------------------------------------------- resolveTier

test('IS-5: the default tier is direct', () => {
  assert.equal(iso.resolveTier({}), 'direct');
  assert.equal(iso.resolveTier(null), 'direct');
  assert.equal(iso.resolveTier({ tier: null }), 'direct');
});

test('IS-6: worktree_isolation raises the floor to worktree', () => {
  assert.equal(iso.resolveTier({ worktreeIsolation: true }), 'worktree');
  assert.equal(iso.resolveTier({ tier: 'direct', worktreeIsolation: true }), 'worktree');
});

test('IS-7: the legacy flag can raise the tier but never lower it', () => {
  // A project that opted into containers must not lose them by leaving the older
  // worktree flag off.
  assert.equal(iso.resolveTier({ tier: 'container', worktreeIsolation: false }), 'container');
  assert.equal(iso.resolveTier({ tier: 'container', worktreeIsolation: true }), 'container');
  assert.equal(iso.resolveTier({ tier: 'worktree', worktreeIsolation: false }), 'worktree');
});

test('IS-8: an invalid tier is refused rather than coerced to the default', () => {
  assert.throws(() => iso.resolveTier({ tier: 'sandbox' }), _code('isolation-invalid-tier'));
  assert.throws(() => iso.resolveTier({ tier: 7 }), _code('isolation-invalid-tier'));
});

test('IS-9: atLeast orders the tiers weakest to strongest', () => {
  assert.equal(iso.atLeast('container', 'worktree'), true);
  assert.equal(iso.atLeast('worktree', 'container'), false);
  assert.equal(iso.atLeast('direct', 'direct'), true);
});

// ------------------------------------------------------------------- mounts

test('IS-10: a mount inside the project may be writable', () => {
  const m = iso.validateMount({ source: '/proj/sub', target: '/workspace/sub', mode: 'rw' }, '/proj');
  assert.equal(m.mode, 'rw');
});

test('IS-11: a writable mount outside the project is refused', () => {
  // This re-opens exactly the hole the container tier was adopted to close, while
  // the operator still believes they are contained.
  assert.throws(
    () => iso.validateMount({ source: '/home/me', target: '/home', mode: 'rw' }, '/proj'),
    _code('isolation-mount-writable-outside-project'),
  );
});

test('IS-12: a read-only mount outside the project is allowed', () => {
  const m = iso.validateMount({ source: '/opt/toolchain', target: '/opt/toolchain', mode: 'ro' }, '/proj');
  assert.equal(m.mode, 'ro');
});

test('IS-13: host control surfaces are refused even read-only', () => {
  // Read-only does not contain the docker socket — it is a root shell either way.
  for (const bad of ['/var/run/docker.sock', '/run/docker.sock', '/proc', '/sys', '/dev', '/dev/kmsg']) {
    assert.throws(
      () => iso.validateMount({ source: bad, target: '/mnt/x', mode: 'ro' }, '/proj'),
      _code('isolation-mount-forbidden-source'),
      'expected a refusal for ' + bad,
    );
  }
});

test('IS-14: a malformed mount is refused with a specific code', () => {
  assert.throws(() => iso.validateMount(null, '/proj'), _code('isolation-bad-mount'));
  assert.throws(() => iso.validateMount({ target: '/x' }, '/proj'), _code('isolation-mount-no-source'));
  assert.throws(
    () => iso.validateMount({ source: '/proj/a', target: 'relative' }, '/proj'),
    _code('isolation-mount-bad-target'),
  );
  assert.throws(
    () => iso.validateMount({ source: '/proj/a', target: '/x', mode: 'wr' }, '/proj'),
    _code('isolation-mount-bad-mode'),
  );
});

test('IS-15: mode defaults to read-only', () => {
  assert.equal(iso.validateMount({ source: '/opt/x', target: '/opt/x' }, '/proj').mode, 'ro');
});

test('IS-16: a path that merely shares a prefix with the project is treated as outside', () => {
  // `/project-secrets` must not pass as inside `/project`.
  assert.throws(
    () => iso.validateMount({ source: '/project-secrets', target: '/s', mode: 'rw' }, '/project'),
    _code('isolation-mount-writable-outside-project'),
  );
});

// ---------------------------------------------------------- container command

test('IS-17: the container command mounts the project writable at the workdir', () => {
  const cmd = iso.buildContainerCommand({ projectDir: '/proj', argv: ['node', '-v'] });
  assert.equal(cmd.bin, 'docker');
  assert.ok(cmd.args.includes('--rm'));
  const vIdx = cmd.args.indexOf('-v');
  assert.equal(cmd.args[vIdx + 1], '/proj:/workspace:rw');
  assert.deepEqual(cmd.args.slice(-2), ['node', '-v']);
});

test('IS-18: least privilege is stated explicitly, not left to daemon defaults', () => {
  // A default that changes between Docker versions would silently change the
  // sandbox.
  const { args } = iso.buildContainerCommand({ projectDir: '/proj', argv: ['sh'] });
  const joined = args.join(' ');
  assert.match(joined, /--network none/);
  assert.match(joined, /--cap-drop ALL/);
  assert.match(joined, /--security-opt no-new-privileges/);
  assert.match(joined, /--read-only/);
  assert.match(joined, /--tmpfs \/tmp:rw,nosuid,nodev/);
});

test('IS-19: network defaults to none and an unknown network is refused', () => {
  assert.match(
    iso.buildContainerCommand({ projectDir: '/proj', argv: ['sh'] }).args.join(' '),
    /--network none/,
  );
  assert.throws(
    () => iso.buildContainerCommand({ projectDir: '/proj', argv: ['sh'], container: { network: 'macvlan' } }),
    _code('isolation-invalid-network'),
  );
});

test('IS-20: env is forwarded by NAME only, never as NAME=value', () => {
  // `-e NAME=value` puts the secret in the process table where ps exposes it.
  const { args } = iso.buildContainerCommand({
    projectDir: '/proj', argv: ['sh'], env: { ANTHROPIC_API_KEY: 'sk-secret-value' },
  });
  assert.ok(args.includes('ANTHROPIC_API_KEY'));
  assert.ok(!args.some((a) => a.includes('sk-secret-value')), 'a secret value must never reach argv');
  const idx = args.indexOf('ANTHROPIC_API_KEY');
  assert.equal(args[idx - 1], '-e');
});

test('IS-21: a malformed env var name is refused', () => {
  assert.throws(
    () => iso.buildContainerCommand({ projectDir: '/proj', argv: ['sh'], env: { 'BAD NAME': 'x' } }),
    _code('isolation-bad-env-name'),
  );
  assert.throws(
    () => iso.buildContainerCommand({ projectDir: '/proj', argv: ['sh'], env: { 'X=Y; rm -rf /': 'x' } }),
    _code('isolation-bad-env-name'),
  );
});

test('IS-22: resource limits and user are passed through when set', () => {
  const { args } = iso.buildContainerCommand({
    projectDir: '/proj', argv: ['sh'],
    container: { user: '1000:1000', memory: '2g', cpus: '1.5' },
  });
  const joined = args.join(' ');
  assert.match(joined, /--user 1000:1000/);
  assert.match(joined, /--memory 2g/);
  assert.match(joined, /--cpus 1\.5/);
});

test('IS-23: extra mounts are validated, not passed through blindly', () => {
  assert.throws(
    () => iso.buildContainerCommand({
      projectDir: '/proj', argv: ['sh'],
      container: { mounts: [{ source: '/var/run/docker.sock', target: '/sock', mode: 'ro' }] },
    }),
    _code('isolation-mount-forbidden-source'),
  );
});

test('IS-24: the image is required and the default is pinned, not "latest"', () => {
  // An image tag that moves under you changes the sandbox contents with no change
  // to this repo.
  assert.ok(!/latest/.test(iso.DEFAULT_IMAGE), 'the default image must be pinned: ' + iso.DEFAULT_IMAGE);
  assert.throws(
    () => iso.buildContainerCommand({ projectDir: '/proj', argv: ['sh'], container: { image: '' } }),
    _code('isolation-no-image'),
  );
});

test('IS-25: projectDir and argv are required', () => {
  assert.throws(() => iso.buildContainerCommand({ argv: ['sh'] }), _code('isolation-no-project-dir'));
  assert.throws(() => iso.buildContainerCommand({ projectDir: '/proj' }), _code('isolation-no-argv'));
  assert.throws(() => iso.buildContainerCommand({ projectDir: '/proj', argv: [] }), _code('isolation-no-argv'));
});

// ------------------------------------------------------------ availability

test('IS-26: lib never spawns — the probe is injected, and an absent one is refused', () => {
  // lib/ must not import child_process (ADR-0001, D-14), so this module cannot
  // acquire the fact it gates on. Refusing an absent probe is deliberate:
  // defaulting to available would make the gate a rubber stamp, and defaulting to
  // unavailable would send a caller who forgot the probe to debug Docker.
  assert.equal(typeof iso.probeContainerRuntime, 'undefined', 'probing belongs to bin/, not lib/');
  assert.throws(() => iso.assertTierAvailable('container'), _code('isolation-probe-required'));
  assert.throws(() => iso.assertTierAvailable('container', {}), _code('isolation-probe-required'));
  assert.throws(() => iso.assertTierAvailable('container', { probe: {} }), _code('isolation-probe-required'));
  assert.deepEqual(iso.PROBE_REASONS, ['runtime-not-installed', 'daemon-unreachable']);
});

test('IS-27: direct and worktree are always available', () => {
  assert.equal(iso.assertTierAvailable('direct').ok, true);
  assert.equal(iso.assertTierAvailable('worktree').ok, true);
});

test('IS-28: an unavailable container runtime refuses instead of downgrading', () => {
  // The core safety property: an operator who asked for isolation and silently got
  // `direct` will run untrusted plans believing they are contained.
  assert.throws(
    () => iso.assertTierAvailable('container', {
      probe: { available: false, reason: 'runtime-not-installed', detail: 'docker is not on PATH' },
    }),
    _code('isolation-container-unavailable'),
  );
  try {
    iso.assertTierAvailable('container', {
      probe: { available: false, reason: 'daemon-unreachable', detail: 'down' },
    });
    assert.fail('expected a refusal');
  } catch (err) {
    // The message must say why refusing beats falling back, or the next reader
    // "fixes" it by adding a fallback.
    assert.match(err.message, /falling back/i);
    assert.match(err.message, /direct/);
  }
});

test('IS-29: an available runtime satisfies the container tier', () => {
  const res = iso.assertTierAvailable('container', {
    probe: { available: true, bin: 'docker', version: '27.0.0' },
  });
  assert.equal(res.ok, true);
  assert.equal(res.runtime.version, '27.0.0');
});

test('IS-30: assertTierAvailable rejects an unknown tier', () => {
  assert.throws(() => iso.assertTierAvailable('vm'), _code('isolation-unknown-tier'));
});

// ---------------------------------------------------------------- advisory

test('IS-31: the direct-tier advisory fires only once there are plans to run', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'np-iso-'));
  try {
    fs.mkdirSync(path.join(empty, '.nubos-pilot'), { recursive: true });
    assert.equal(iso.advisory('direct', empty), null, 'no plans yet means nothing to warn about');
    fs.mkdirSync(path.join(empty, '.nubos-pilot', 'milestones'), { recursive: true });
    assert.match(iso.advisory('direct', empty), /full account rights/);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('IS-32: no advisory for the stronger tiers', () => {
  assert.equal(iso.advisory('worktree', process.cwd()), null);
  assert.equal(iso.advisory('container', process.cwd()), null);
});

test('IS-33: a symlink inside the project cannot smuggle a writable mount of its target', () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'np-iso-link-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'np-iso-out-'));
  try {
    fs.symlinkSync(outside, path.join(proj, 'escape'));
    assert.throws(
      () => iso.validateMount({ source: path.join(proj, 'escape'), target: '/mnt/x', mode: 'rw' }, proj),
      _code('isolation-mount-writable-outside-project'),
    );
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('IS-34: a symlink to a host control surface is refused like the surface itself', () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'np-iso-sock-'));
  try {
    fs.symlinkSync('/var/run/docker.sock', path.join(proj, 'sock'));
    assert.throws(
      () => iso.validateMount({ source: path.join(proj, 'sock'), target: '/sock', mode: 'ro' }, proj),
      _code('isolation-mount-forbidden-source'),
    );
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('IS-35: realPath resolves the deepest existing ancestor and keeps the rest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-iso-real-'));
  try {
    const real = fs.realpathSync(root);
    assert.equal(iso.realPath(path.join(root, 'not', 'created', 'yet')),
      path.join(real, 'not', 'created', 'yet'));
    assert.equal(iso.realPath('/proj'), path.resolve('/proj'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('IS-36: a symlinked project directory is mounted as its real path', () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'np-iso-realproj-'));
  const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'np-iso-linkdir-')), 'proj');
  try {
    fs.symlinkSync(real, link);
    const { args } = iso.buildContainerCommand({ projectDir: link, argv: ['sh'] });
    const v = args[args.indexOf('-v') + 1];
    assert.equal(v, fs.realpathSync(real) + ':/workspace:rw');
  } finally {
    fs.rmSync(real, { recursive: true, force: true });
    fs.rmSync(path.dirname(link), { recursive: true, force: true });
  }
});

test('ISO-31: a colon in a mount path is refused rather than shifting the bind spec', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'np-iso-colon-'));
  try {
    assert.throws(
      () => iso.validateMount({ source: project, target: '/mnt/x:/etc:rw' }, project),
      _code('isolation-mount-colon-in-path'),
    );
    assert.throws(
      () => iso.validateMount({ source: project + '/a:b', target: '/mnt/x' }, project),
      _code('isolation-mount-colon-in-path'),
    );
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});
