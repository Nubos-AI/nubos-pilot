'use strict';

// CLI surface for execution isolation tiers (ADR-0029).
//
// `status` is the verb operators run; `wrap` is the verb the executor spawn path
// runs to obtain a container invocation. `wrap` prints the command instead of
// executing it, so the caller keeps stdio, timeout and env handling — and so this
// stays testable on a machine with no Docker.

const { execFileSync } = require('node:child_process');
const iso = require('../../lib/isolation.cjs');
const { readConfigPath } = require('../../lib/config.cjs');
const { findProjectRoot } = require('../../lib/core.cjs');
const { getFlag, emitErrorEnvelope } = require('./_args.cjs');

/**
 * Is a container runtime usable right now?
 *
 * Lives here rather than in lib/isolation.cjs because lib/ never spawns
 * (ADR-0001, D-14). The result is injected into `iso.assertTierAvailable`, which
 * refuses to run without it — so this module owns the only place a subprocess is
 * involved in the isolation decision.
 *
 * Returns a reason, not a boolean: "runtime missing" and "runtime present but the
 * daemon is down" need different fixes.
 */
function probeContainerRuntime(opts) {
  const o = opts || {};
  const bin = o.bin || 'docker';
  try {
    const out = execFileSync(bin, ['version', '--format', '{{.Server.Version}}'], {
      encoding: 'utf-8',
      timeout: o.timeoutMs || 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const version = String(out).trim();
    if (!version) {
      return { available: false, reason: 'daemon-unreachable', detail: 'no server version reported' };
    }
    return { available: true, bin, version };
  } catch (err) {
    const code = err && err.code;
    if (code === 'ENOENT') {
      return { available: false, reason: 'runtime-not-installed', detail: bin + ' is not on PATH' };
    }
    if (code === 'ETIMEDOUT') {
      return { available: false, reason: 'daemon-unreachable', detail: bin + ' version timed out' };
    }
    return {
      available: false,
      reason: 'daemon-unreachable',
      detail: (err && err.stderr ? String(err.stderr).trim().slice(0, 200) : String(err && err.message)),
    };
  }
}

function _usage() {
  return [
    'Usage:',
    '  np-tools.cjs isolation status [--json]',
    '  np-tools.cjs isolation describe <direct|worktree|container> [--json]',
    '  np-tools.cjs isolation probe [--json]',
    '  np-tools.cjs isolation wrap [--workdir <path>] [--env NAME[,NAME...]] -- <command> [args...]',
    '',
    'nubos-pilot installs into a host CLI and inherits that host\'s permissions, so',
    'the honest default is that there is no isolation of its own. The three tiers',
    'name that plainly:',
    '',
    '  direct     no isolation. The agent has whatever your host CLI grants —',
    '             normally your entire account. This is the status quo, not safety.',
    '  worktree   version isolation only (ADR-0008). Parallel slices cannot corrupt',
    '             each other. Rights are unchanged from direct.',
    '  container  rights isolation. Project directory mounted, nothing else, no',
    '             network by default.',
    '',
    'Config:',
    '  "isolation": {',
    '    "tier": "direct",',
    '    "container": {',
    '      "image": "node:22-bookworm-slim",',
    '      "network": "none",',
    '      "user": null, "memory": null, "cpus": null,',
    '      "mounts": [{"source": "/opt/toolchain", "target": "/opt/toolchain", "mode": "ro"}]',
    '    }',
    '  }',
    '',
    'workflow.worktree_isolation still works and raises the floor to `worktree`; it',
    'can raise the tier but never lower it.',
    '',
    'A configured tier is never silently downgraded. If `container` is set and no',
    'container runtime is usable, every verb that would claim isolation refuses —',
    'falling back to `direct` unannounced would hand a plan your full account rights',
    'while you believe it is contained.',
  ].join('\n');
}

function _containerConfig(cwd) {
  const declared = readConfigPath(cwd, 'isolation.container', null);
  return Object.assign({}, iso.DEFAULT_CONTAINER, declared && typeof declared === 'object' ? declared : {});
}

function _resolve(cwd) {
  return iso.resolveTier({
    tier: readConfigPath(cwd, 'isolation.tier', null),
    worktreeIsolation: readConfigPath(cwd, 'workflow.worktree_isolation', false) === true,
  });
}

function run(argv, ctx) {
  const context = ctx || {};
  const stdout = context.stdout || process.stdout;
  const stderr = context.stderr || process.stderr;
  const cwd = context.cwd || process.cwd();
  const args = Array.isArray(argv) ? argv.slice() : [];

  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    stdout.write(_usage() + '\n');
    return args.length === 0 ? 1 : 0;
  }

  const verb = args[0];
  const rest = args.slice(1);
  const asJson = rest.includes('--json');

  try {
    switch (verb) {
      case 'status': {
        const tier = _resolve(cwd);
        const description = iso.describeTier(tier);
        const advisory = iso.advisory(tier, cwd);
        const runtime = tier === 'container' ? probeContainerRuntime() : null;
        const payload = {
          tier,
          effective_from: readConfigPath(cwd, 'isolation.tier', null) === null ? 'default' : 'config',
          description,
          runtime,
          advisory,
          container: tier === 'container' ? _containerConfig(cwd) : null,
        };
        if (asJson) {
          stdout.write(JSON.stringify(payload, null, 2) + '\n');
        } else {
          stdout.write('tier: ' + tier + '\n');
          stdout.write('isolates versions: ' + description.isolates_versions + '\n');
          stdout.write('isolates rights:   ' + description.isolates_rights + '\n');
          stdout.write(description.summary + '\n');
          stdout.write('\nDoes not protect against:\n');
          for (const item of description.does_not_protect_against) stdout.write('  - ' + item + '\n');
          if (advisory) stdout.write('\n' + advisory + '\n');
        }
        // A configured container tier with no runtime is a broken configuration,
        // not merely informational.
        if (tier === 'container' && runtime && !runtime.available) {
          stderr.write(JSON.stringify({
            code: 'isolation-container-unavailable',
            message: 'isolation.tier is "container" but no container runtime is usable ('
              + runtime.reason + ': ' + runtime.detail + ')',
            details: runtime,
          }) + '\n');
          return 1;
        }
        return 0;
      }

      case 'describe': {
        const tier = rest.find((a) => !a.startsWith('--'));
        if (!tier) {
          stderr.write(JSON.stringify({
            code: 'isolation-missing-tier',
            message: 'describe requires a tier: ' + iso.TIERS.join(' | '),
            details: { allowed: iso.TIERS },
          }) + '\n');
          return 1;
        }
        const d = iso.describeTier(tier);
        stdout.write(asJson ? JSON.stringify(d, null, 2) + '\n' : d.summary + '\n\n' + 'Use when: ' + d.use_when + '\n');
        return 0;
      }

      case 'probe': {
        const probe = probeContainerRuntime();
        stdout.write(asJson ? JSON.stringify(probe, null, 2) + '\n'
          : (probe.available ? 'available: ' + probe.bin + ' ' + probe.version + '\n'
            : 'unavailable: ' + probe.reason + ' (' + probe.detail + ')\n'));
        return probe.available ? 0 : 1;
      }

      case 'wrap': {
        const sep = rest.indexOf('--');
        if (sep === -1 || sep === rest.length - 1) {
          stderr.write(JSON.stringify({
            code: 'isolation-wrap-no-command',
            message: 'wrap requires a command after `--`',
            details: {},
          }) + '\n');
          return 1;
        }
        const flags = rest.slice(0, sep);
        const command = rest.slice(sep + 1);

        const tier = _resolve(cwd);
        // Refuse before building anything: the caller is about to run a command it
        // believes is contained.
        iso.assertTierAvailable(tier, { probe: tier === 'container' ? probeContainerRuntime() : null });

        if (tier !== 'container') {
          // Report the passthrough explicitly rather than emitting a bare command
          // that looks identical to a wrapped one.
          stdout.write(JSON.stringify({
            tier, wrapped: false, bin: command[0], args: command.slice(1),
            note: 'tier ' + tier + ' does not wrap the command; it runs with the host\'s own rights',
          }, null, 2) + '\n');
          return 0;
        }

        const envNames = String(getFlag(flags, '--env') || '')
          .split(',').map((s) => s.trim()).filter(Boolean);
        const env = {};
        for (const name of envNames) env[name] = true;

        const built = iso.buildContainerCommand({
          projectDir: findProjectRoot(cwd),
          argv: command,
          container: _containerConfig(cwd),
          env,
          workdir: getFlag(flags, '--workdir') || undefined,
        });
        stdout.write(JSON.stringify(Object.assign({ tier, wrapped: true }, built), null, 2) + '\n');
        return 0;
      }

      default: {
        stderr.write(JSON.stringify({
          code: 'isolation-unknown-verb',
          message: 'Unknown verb: ' + verb,
          details: { verb, allowed: ['status', 'describe', 'probe', 'wrap'] },
        }) + '\n');
        return 1;
      }
    }
  } catch (err) {
    emitErrorEnvelope(err, stderr, 'isolation-internal-error');
    return 1;
  }
}

module.exports = { run, probeContainerRuntime };

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}
