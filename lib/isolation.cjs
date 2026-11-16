'use strict';

// Execution isolation tiers (ADR-0029).
//
// The uncomfortable fact this makes explicit: nubos-pilot installs into a host
// CLI and therefore *inherits that host's permissions*. It has never had an
// isolation story of its own. ADR-0008's worktree isolation is real but is about
// something else — it separates working-tree *versions* so parallel slices do not
// collide, and a worktree grants exactly the same filesystem rights as the parent
// checkout. Calling that a sandbox would be a category error.
//
// Three tiers, named so the weakest one cannot be mistaken for protection:
//
//   direct     — no isolation from nubos-pilot. The agent has whatever the host
//                CLI grants it, which is usually the whole filesystem under the
//                user's account. This is the default because it is the status quo,
//                not because it is safe.
//   worktree   — version isolation (ADR-0008). Parallel slices cannot corrupt each
//                other's working tree. Rights are unchanged from `direct`.
//   container  — rights isolation. The agent runs inside a container that mounts
//                the project directory and nothing else, with no network by
//                default.
//
// The rule that shapes every function below: a requested tier is never silently
// downgraded. If `container` is configured and Docker is unavailable, this refuses
// rather than falling back — an operator who asked for isolation and got `direct`
// without being told is worse off than one who got an error, because they will
// run untrusted plans believing they are contained.

// No child_process here, by architectural rule: lib/ never spawns (ADR-0001,
// D-14; only lib/git.cjs is exempt). That is why probing the container runtime
// lives in bin/np-tools/isolation.cjs and its result is *injected* into
// assertTierAvailable below. The constraint improves the design rather than
// bending it — this module cannot silently acquire the fact it gates on, so the
// caller is forced to state where the fact came from.
const fs = require('node:fs');
const path = require('node:path');
const { NubosPilotError } = require('./core.cjs');

const TIERS = Object.freeze(['direct', 'worktree', 'container']);

// Ordered weakest → strongest, for comparisons like "at least worktree".
const TIER_STRENGTH = Object.freeze({ direct: 0, worktree: 1, container: 2 });

const DEFAULT_TIER = 'direct';

// A small, stated default rather than "latest": an image tag that moves under you
// changes the sandbox's contents without any change to this repo.
const DEFAULT_IMAGE = 'node:22-bookworm-slim';

const DEFAULT_CONTAINER = Object.freeze({
  image: DEFAULT_IMAGE,
  // No network unless the operator opts in. An agent that can reach the internet
  // can exfiltrate the repository it was given, which is the failure mode a
  // container is usually adopted to prevent.
  network: 'none',
  user: null,
  memory: null,
  cpus: null,
  mounts: Object.freeze([]),
});

const VALID_NETWORKS = Object.freeze(['none', 'bridge', 'host']);

const MOUNT_MODES = Object.freeze(['ro', 'rw']);

function _err(code, message, details) {
  return new NubosPilotError(code, message, details || {});
}

const MAX_LINK_HOPS = 40;

function realPath(p, hops) {
  const abs = path.resolve(p);
  const depth = hops || 0;
  if (depth > MAX_LINK_HOPS) return abs;

  try {
    return fs.realpathSync(abs);
  } catch { /* not fully resolvable — keep going */ }

  try {
    if (fs.lstatSync(abs).isSymbolicLink()) {
      const link = fs.readlinkSync(abs);
      const target = path.isAbsolute(link) ? link : path.resolve(path.dirname(abs), link);
      if (target !== abs) return realPath(target, depth + 1);
    }
  } catch { /* not a link, or unreadable — keep going */ }

  let current = abs;
  const tail = [];
  while (true) {
    const parent = path.dirname(current);
    if (parent === current) return abs;
    tail.unshift(path.basename(current));
    current = parent;
    let resolved;
    try {
      resolved = fs.realpathSync(current);
    } catch {
      continue;
    }
    return path.join(resolved, ...tail);
  }
}

function pathAliases(p) {
  const abs = path.resolve(p);
  const parent = path.dirname(abs);
  const out = new Set([abs, realPath(abs)]);
  if (parent !== abs) out.add(path.join(realPath(parent), path.basename(abs)));
  return out;
}

/**
 * What a tier actually guarantees. Returned as data so the CLI, the docs and the
 * doctor check all describe it identically — three prose copies of a security
 * boundary is how the three come to disagree.
 */
function describeTier(tier) {
  switch (tier) {
    case 'direct':
      return {
        tier: 'direct',
        isolates_versions: false,
        isolates_rights: false,
        network_restricted: false,
        summary: 'No isolation from nubos-pilot. The agent holds whatever rights the host CLI grants, '
          + 'normally the entire filesystem readable by your user account.',
        use_when: 'You wrote the plan, or you trust it as much as you trust your own shell.',
        does_not_protect_against: [
          'a plan that edits files outside the project',
          'a plan that reads credentials from your home directory',
          'a plan that makes network calls',
        ],
      };
    case 'worktree':
      return {
        tier: 'worktree',
        isolates_versions: true,
        isolates_rights: false,
        network_restricted: false,
        summary: 'Version isolation only (ADR-0008). Parallel slices get separate working trees, so they '
          + 'cannot corrupt each other. Filesystem rights are identical to `direct`.',
        use_when: 'Running slices in parallel. This is a correctness measure, not a security one.',
        does_not_protect_against: [
          'anything `direct` fails to protect against — a worktree grants the same rights as the parent checkout',
        ],
      };
    case 'container':
      return {
        tier: 'container',
        isolates_versions: true,
        isolates_rights: true,
        network_restricted: true,
        summary: 'Rights isolation. The agent runs in a container that mounts the project directory and '
          + 'nothing else, with no network unless explicitly enabled.',
        use_when: 'Executing a plan you did not write or review — a generated plan, a plan from a shared '
          + 'repository, or any run you would not give your shell to.',
        does_not_protect_against: [
          'a container escape (this is a container, not a VM)',
          'anything reachable through a mount or network you enabled yourself',
          'the plan committing bad code — isolation bounds blast radius, it does not review',
        ],
      };
    default:
      throw _err('isolation-unknown-tier', 'Unknown isolation tier: ' + String(tier), { tier, allowed: TIERS });
  }
}

/**
 * Resolve the effective tier from config.
 *
 * `workflow.worktree_isolation` predates this and stays authoritative for its own
 * concern: when it is on, the floor is `worktree`. It can raise the tier but never
 * lower it, so a project that opted into containers does not lose them by leaving
 * the older flag off.
 *
 * @param {object} cfg {tier, worktreeIsolation}
 */
function resolveTier(cfg) {
  const c = cfg || {};
  const requested = c.tier === undefined || c.tier === null ? DEFAULT_TIER : c.tier;
  if (!TIERS.includes(requested)) {
    throw _err(
      'isolation-invalid-tier',
      'isolation.tier must be one of ' + TIERS.join(' | ') + ' (got ' + JSON.stringify(requested) + ')',
      { tier: requested, allowed: TIERS },
    );
  }
  const floor = c.worktreeIsolation === true ? 'worktree' : 'direct';
  return TIER_STRENGTH[requested] >= TIER_STRENGTH[floor] ? requested : floor;
}

function atLeast(tier, minimum) {
  return TIER_STRENGTH[tier] >= TIER_STRENGTH[minimum];
}

// The reasons a probe may report. Kept here so lib, bin and the docs agree on the
// vocabulary even though only bin can produce it: "runtime missing" and "runtime
// present but the daemon is down" need different fixes, and a caller that only
// sees a boolean reports the wrong one.
const PROBE_REASONS = Object.freeze(['runtime-not-installed', 'daemon-unreachable']);

/**
 * Validate an extra mount. Anything outside the project must be read-only, and a
 * few paths are refused entirely.
 *
 * The reason this is strict: the point of the container tier is that the agent
 * reaches the project and nothing else. A writable mount of the home directory
 * re-opens exactly the hole the tier was adopted to close, and it would do so
 * while the operator still believes they are contained.
 */
function validateMount(mount, projectDir) {
  if (!mount || typeof mount !== 'object') {
    throw _err('isolation-bad-mount', 'A mount must be an object {source, target, mode}', { mount });
  }
  const { source, target } = mount;
  const mode = mount.mode || 'ro';
  if (typeof source !== 'string' || !source.trim()) {
    throw _err('isolation-mount-no-source', 'A mount needs a source path', { mount });
  }
  if (typeof target !== 'string' || !target.startsWith('/')) {
    throw _err('isolation-mount-bad-target', 'A mount target must be an absolute container path', { mount });
  }
  if (!MOUNT_MODES.includes(mode)) {
    throw _err('isolation-mount-bad-mode', 'A mount mode must be ro or rw', { mode, allowed: MOUNT_MODES });
  }

  // `-v source:target:mode` is colon-delimited, so a colon in either half shifts
  // every field after it. Docker rejects the result, but as a parser error about
  // a spec the operator never wrote — refusing here names the actual mount.
  for (const [field, value] of [['source', source], ['target', target]]) {
    if (value.includes(':')) {
      throw _err(
        'isolation-mount-colon-in-path',
        'A mount ' + field + ' must not contain a colon: ' + value + '. The bind spec is colon-delimited, '
        + 'so a colon here silently shifts the target and the mode.',
        { field, value },
      );
    }
  }

  const absSource = realPath(source);
  const absProject = realPath(projectDir);
  const insideProject = absSource === absProject || absSource.startsWith(absProject + path.sep);

  if (!insideProject && mode === 'rw') {
    throw _err(
      'isolation-mount-writable-outside-project',
      'A writable mount outside the project directory defeats the container tier: ' + absSource
      + '. Mount it read-only, or move what the plan needs into the project.',
      { source: absSource, project: absProject, mode },
    );
  }

  // Sockets and device trees are host control surfaces; mounting them read-only
  // does not make them safe. The docker socket in particular is a root shell.
  const forbidden = ['/var/run/docker.sock', '/run/docker.sock', '/proc', '/sys', '/dev'];
  const candidates = pathAliases(source);
  for (const bad of forbidden) {
    for (const cmp of pathAliases(bad)) {
      for (const candidate of candidates) {
        if (candidate === cmp || candidate.startsWith(cmp + path.sep)) {
          throw _err(
            'isolation-mount-forbidden-source',
            'Refusing to mount ' + candidate + ' into the sandbox — it is a host control surface, and '
            + 'read-only does not contain it (the docker socket is a root shell).',
            { source: candidate, matched: bad },
          );
        }
      }
    }
  }

  return { source: absSource, target, mode };
}

/**
 * Build the container invocation that wraps a command.
 *
 * Returns {bin, args} rather than running anything, so the caller keeps control of
 * stdio, timeouts and env — and so this is testable without Docker present.
 *
 * @param {object} spec
 * @param {string} spec.projectDir     host path mounted as the workdir
 * @param {string[]} spec.argv         command + args to run inside
 * @param {object} [spec.container]    tier config (image, network, mounts, user, memory, cpus)
 * @param {object} [spec.env]          env vars to forward by NAME (values passed through)
 * @param {string} [spec.workdir]      container workdir (default /workspace)
 */
function buildContainerCommand(spec) {
  const s = spec || {};
  const cfg = Object.assign({}, DEFAULT_CONTAINER, s.container || {});
  const projectDir = s.projectDir;
  if (typeof projectDir !== 'string' || !projectDir.trim()) {
    throw _err('isolation-no-project-dir', 'buildContainerCommand requires a projectDir', {});
  }
  if (!Array.isArray(s.argv) || s.argv.length === 0) {
    throw _err('isolation-no-argv', 'buildContainerCommand requires a non-empty argv', {});
  }
  if (!VALID_NETWORKS.includes(cfg.network)) {
    throw _err(
      'isolation-invalid-network',
      'isolation.container.network must be one of ' + VALID_NETWORKS.join(' | '),
      { network: cfg.network, allowed: VALID_NETWORKS },
    );
  }
  if (typeof cfg.image !== 'string' || !cfg.image.trim()) {
    throw _err('isolation-no-image', 'isolation.container.image must be a non-empty image reference', {});
  }

  const absProject = realPath(projectDir);
  const workdir = s.workdir || '/workspace';

  const args = ['run', '--rm', '-i'];

  // Least privilege, stated explicitly rather than relying on daemon defaults —
  // a default that changes between Docker versions would silently change the
  // sandbox.
  args.push('--network', cfg.network);
  args.push('--cap-drop', 'ALL');
  args.push('--security-opt', 'no-new-privileges');
  // The project mount is writable because the agent's job is to edit the project.
  // Everything else the container can write is a tmpfs that vanishes with it.
  args.push('--read-only');
  args.push('--tmpfs', '/tmp:rw,nosuid,nodev,size=256m');
  args.push('-v', absProject + ':' + workdir + ':rw');
  args.push('-w', workdir);

  if (cfg.user) args.push('--user', String(cfg.user));
  if (cfg.memory) args.push('--memory', String(cfg.memory));
  if (cfg.cpus) args.push('--cpus', String(cfg.cpus));

  for (const mount of (Array.isArray(cfg.mounts) ? cfg.mounts : [])) {
    const m = validateMount(mount, absProject);
    args.push('-v', m.source + ':' + m.target + ':' + m.mode);
  }

  // Env is forwarded by name only (`-e NAME`), never as `-e NAME=value`. The
  // value then travels through the Docker API rather than appearing in the
  // process table, where `ps` would expose every API key on a shared machine.
  for (const name of Object.keys(s.env || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw _err('isolation-bad-env-name', 'Refusing to forward a malformed env var name', { name });
    }
    args.push('-e', name);
  }

  args.push(cfg.image);
  args.push(...s.argv);

  return { bin: 'docker', args, workdir, project_mount: absProject + ':' + workdir + ':rw' };
}

/**
 * Assert that the resolved tier can actually be delivered.
 *
 * This is the function that refuses to downgrade. Called before any spawn that
 * claims to be isolated.
 */
function assertTierAvailable(tier, opts) {
  const o = opts || {};
  if (tier === 'container') {
    const probe = o.probe;
    if (!probe || typeof probe.available !== 'boolean') {
      // Refusing an absent probe rather than defaulting either way. Defaulting to
      // available would make this function a rubber stamp; defaulting to
      // unavailable would make a caller that forgot the probe look like a broken
      // Docker install and send them debugging the wrong thing.
      throw _err(
        'isolation-probe-required',
        'assertTierAvailable("container") requires an injected runtime probe. lib/ cannot spawn '
        + '(ADR-0001), so the caller must supply the result of a container-runtime check.',
        { tier },
      );
    }
    if (!probe.available) {
      throw _err(
        'isolation-container-unavailable',
        'isolation.tier is "container" but no container runtime is usable (' + probe.reason + ': '
        + probe.detail + '). Refusing to run: silently falling back to `direct` would hand the plan '
        + 'your full account rights while you believe it is contained. Install/start Docker, or set '
        + 'isolation.tier explicitly to "direct" or "worktree" to accept that.',
        { tier, reason: probe.reason, detail: probe.detail },
      );
    }
    return { ok: true, tier, runtime: probe };
  }
  if (tier === 'worktree' || tier === 'direct') {
    return { ok: true, tier };
  }
  throw _err('isolation-unknown-tier', 'Unknown isolation tier: ' + String(tier), { tier, allowed: TIERS });
}

/**
 * A one-line advisory for the operator, used by doctor and the workflows.
 * Returns null when there is nothing worth saying.
 */
function advisory(tier, cwd) {
  if (tier !== 'direct') return null;
  // Only nag when there is something to lose: a project with no plans yet has no
  // untrusted code to run.
  try {
    const plansExist = fs.existsSync(path.join(cwd || process.cwd(), '.nubos-pilot', 'milestones'));
    if (!plansExist) return null;
  } catch {
    return null;
  }
  return 'isolation.tier is "direct": executor agents run with your full account rights. '
    + 'Set isolation.tier to "container" before executing a plan you did not write.';
}

module.exports = {
  TIERS,
  TIER_STRENGTH,
  DEFAULT_TIER,
  DEFAULT_IMAGE,
  DEFAULT_CONTAINER,
  VALID_NETWORKS,
  MOUNT_MODES,
  PROBE_REASONS,
  realPath,
  describeTier,
  resolveTier,
  atLeast,
  validateMount,
  buildContainerCommand,
  assertTierAvailable,
  advisory,
};
