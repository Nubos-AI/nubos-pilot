'use strict';

// CLI surface for the OTLP span export (ADR-0026).
//
// Default verb is `dry-run`, not `send`. Egress is the irreversible action here:
// once spans reach a third-party backend they may be retained and indexed
// regardless of what happens locally, so the safe verb is the one you get by
// accident and the sending verb is the one you have to name.

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const otlp = require('../../lib/otlp.cjs');
const { collectTree } = require('../../lib/planning-tree.cjs');
const { readConfigPath } = require('../../lib/config.cjs');
const { projectStateDir, findProjectRoot } = require('../../lib/core.cjs');
const { getFlag, emitErrorEnvelope } = require('./_args.cjs');

function _usage() {
  return [
    'Usage:',
    '  np-tools.cjs otlp-export dry-run [--milestone <N>] [--pretty]',
    '  np-tools.cjs otlp-export write --out <path> [--milestone <N>]',
    '  np-tools.cjs otlp-export send [--milestone <N>] [--endpoint <url>] [--timeout-ms N]',
    '  np-tools.cjs otlp-export stats [--milestone <N>]',
    '',
    'Maps the milestone -> slice -> task -> agent-spawn hierarchy to an OTLP span',
    'tree and emits OTLP/HTTP JSON. The flat metrics JSONL keeps every span\'s',
    'numbers but throws the edges away, so "which slice was expensive, and which',
    'agent inside it" is unanswerable from it; the tree answers it directly.',
    '',
    'This is the wire format, not a client. Point it at Langfuse, an OpenTelemetry',
    'collector, or anything else that speaks OTLP — nubos-pilot bundles nothing,',
    'runs no daemon (ADR-0001) and adds no dependency (ADR-0002).',
    '',
    'Off by default. `send` requires telemetry.otlp.enabled = true and an endpoint;',
    'dry-run and write work regardless, because inspecting your own data locally is',
    'not egress. Config:',
    '',
    '  "telemetry": { "otlp": {',
    '    "enabled": false,',
    '    "endpoint": null,',
    '    "headers": {},',
    '    "service_name": "nubos-pilot",',
    '    "timeout_ms": 10000',
    '  }}',
    '',
    'Span ids are derived from the unit ids, so re-exporting a milestone updates',
    'the same trace instead of accumulating duplicates. A unit with no timed',
    'descendant is omitted rather than stamped with the current time.',
  ].join('\n');
}

// Kept as a named wrapper: this handler's contract is "hierarchy for a
// milestone", and lib/planning-tree.cjs is the one implementation shared with
// the roadmap-graph renderer (ADR-0027) so the two views cannot drift.
function collectHierarchy(cwd, only) {
  return collectTree(cwd, { milestone: Number.isInteger(only) ? only : null });
}

/**
 * Read every metrics JSONL file. A malformed line is skipped and counted rather
 * than aborting the export — one truncated write (a crash mid-append) must not
 * make the whole history unexportable.
 */
async function collectRecords(cwd) {
  const dir = path.join(projectStateDir(cwd), 'metrics');
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
  } catch (err) {
    if (err && err.code === 'ENOENT') return { records: [], malformed: 0 };
    throw err;
  }
  const records = [];
  let malformed = 0;
  for (const file of files) {
    const stream = fs.createReadStream(path.join(dir, file), { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed));
      } catch {
        malformed += 1;
      }
    }
  }
  return { records, malformed };
}

function _projectId(cwd) {
  // The repository directory name is stable for the life of a checkout, which is
  // what trace-id derivation needs. A random or timestamped id would make every
  // export a fresh trace.
  return path.basename(findProjectRoot(cwd));
}

function _milestoneFilter(rest, stderr) {
  const raw = getFlag(rest, '--milestone');
  if (raw === undefined) return { ok: true, value: null };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    stderr.write(JSON.stringify({
      code: 'otlp-bad-milestone',
      message: '--milestone must be a positive integer',
      details: { milestone: raw },
    }) + '\n');
    return { ok: false };
  }
  return { ok: true, value: n };
}

async function _build(cwd, rest, stderr) {
  const filter = _milestoneFilter(rest, stderr);
  if (!filter.ok) return null;
  const { records, malformed } = await collectRecords(cwd);
  const built = otlp.buildPayload({
    projectId: _projectId(cwd),
    milestones: collectHierarchy(cwd, filter.value),
    records,
    serviceName: readConfigPath(cwd, 'telemetry.otlp.service_name', otlp.DEFAULT_SERVICE_NAME),
  });
  built.stats.malformed_metric_lines = malformed;
  return built;
}

async function run(argv, ctx) {
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

  try {
    switch (verb) {
      case 'stats': {
        const built = await _build(cwd, rest, stderr);
        if (!built) return 1;
        stdout.write(JSON.stringify(built.stats, null, 2) + '\n');
        return 0;
      }

      case 'dry-run': {
        const built = await _build(cwd, rest, stderr);
        if (!built) return 1;
        stdout.write(JSON.stringify(built.payload, null, rest.includes('--pretty') ? 2 : 0) + '\n');
        return 0;
      }

      case 'write': {
        const out = getFlag(rest, '--out');
        if (!out) {
          stderr.write(JSON.stringify({
            code: 'otlp-missing-out',
            message: '--out <path> is required for the write verb',
            details: {},
          }) + '\n');
          return 1;
        }
        const built = await _build(cwd, rest, stderr);
        if (!built) return 1;
        fs.writeFileSync(out, JSON.stringify(built.payload, null, 2) + '\n', 'utf-8');
        stdout.write(JSON.stringify(Object.assign({ ok: true, out }, built.stats), null, 2) + '\n');
        return 0;
      }

      case 'send': {
        const enabled = readConfigPath(cwd, 'telemetry.otlp.enabled', false) === true;
        if (!enabled) {
          // Refuse rather than prompt. An export that can be talked into
          // happening is not opt-in, and this one leaves the machine.
          stderr.write(JSON.stringify({
            code: 'otlp-disabled',
            message: 'telemetry.otlp.enabled is false. Set it to true in .nubos-pilot/config.json to allow '
              + 'export. `dry-run` and `write` work without it — inspecting your own data locally is not egress.',
            details: { config_key: 'telemetry.otlp.enabled' },
          }) + '\n');
          return 1;
        }
        const endpoint = getFlag(rest, '--endpoint')
          || readConfigPath(cwd, 'telemetry.otlp.endpoint', null);
        if (!endpoint) {
          stderr.write(JSON.stringify({
            code: 'otlp-no-endpoint-configured',
            message: 'No OTLP endpoint. Set telemetry.otlp.endpoint or pass --endpoint <url>.',
            details: { config_key: 'telemetry.otlp.endpoint' },
          }) + '\n');
          return 1;
        }

        const built = await _build(cwd, rest, stderr);
        if (!built) return 1;
        if (built.stats.total_spans === 0) {
          // Sending an empty envelope is a request that says nothing; report it
          // as the no-op it is instead of a successful export.
          stdout.write(JSON.stringify(Object.assign({
            ok: true, sent: false, reason: 'no spans to export',
          }, built.stats), null, 2) + '\n');
          return 0;
        }

        const timeoutRaw = getFlag(rest, '--timeout-ms');
        const res = await otlp.postPayload(built.payload, {
          endpoint,
          headers: readConfigPath(cwd, 'telemetry.otlp.headers', {}) || {},
          timeoutMs: timeoutRaw !== undefined
            ? Number(timeoutRaw)
            : readConfigPath(cwd, 'telemetry.otlp.timeout_ms', otlp.DEFAULT_TIMEOUT_MS),
        });
        stdout.write(JSON.stringify(Object.assign({
          ok: true, sent: true, status: res.status, bytes_sent: res.bytes_sent,
        }, built.stats), null, 2) + '\n');
        return 0;
      }

      default: {
        stderr.write(JSON.stringify({
          code: 'otlp-unknown-verb',
          message: 'Unknown verb: ' + verb,
          details: { verb, allowed: ['dry-run', 'write', 'send', 'stats'] },
        }) + '\n');
        return 1;
      }
    }
  } catch (err) {
    emitErrorEnvelope(err, stderr, 'otlp-export-internal-error');
    return 1;
  }
}

module.exports = { run, collectHierarchy, collectRecords };

if (require.main === module) {
  run(process.argv.slice(2)).then((rc) => process.exit(rc));
}
