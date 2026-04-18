const fs = require('node:fs');
const { appendRecord, buildRecord } = require('../../lib/metrics.cjs');

function _usage() {
  return [
    'Usage:',
    '  np-tools.cjs metrics record --agent X --tier haiku|sonnet|opus --resolved-model M \\',
    '                              --phase P --plan PL --task T \\',
    '                              --started ISO --ended ISO \\',
    '                              --tokens-in N --tokens-out M \\',
    '                              --status ok|error|timeout --runtime claude|codex|gemini|opencode \\',
    '                              [--retry-count N] [--error-code C --error-message MSG]',
    '  np-tools.cjs metrics record --json @file:/path/to/record.json',
    '  np-tools.cjs metrics now | start-timestamp | end-timestamp',
  ].join('\n');
}

function _parseArgs(argv) {
  const out = { retry_count: 0, tokens_in: null, tokens_out: null, error: null };
  let errorCode = null;
  let errorMessage = null;
  let jsonPtr = null;
  let i = 0;
  while (i < argv.length) {
    const flag = argv[i++];
    const val = argv[i++];
    switch (flag) {
      case '--agent':          out.agent = val; break;
      case '--tier':           out.tier = val; break;
      case '--resolved-model': out.resolved_model = val; break;
      case '--phase':          out.phase = val; break;
      case '--plan':           out.plan = val; break;
      case '--task':           out.task = val; break;
      case '--started':        out.started_at = val; break;
      case '--ended':          out.ended_at = val; break;
      case '--tokens-in':      out.tokens_in = parseInt(val, 10); break;
      case '--tokens-out':     out.tokens_out = parseInt(val, 10); break;
      case '--retry-count':    out.retry_count = parseInt(val, 10); break;
      case '--status':         out.status = val; break;
      case '--runtime':        out.runtime = val; break;
      case '--error-code':     errorCode = val; break;
      case '--error-message':  errorMessage = val; break;
      case '--json':           jsonPtr = val; break;
      default: break;
    }
  }
  if (errorCode || errorMessage) {
    out.error = { code: errorCode || 'unknown', message: errorMessage || '' };
  }
  return { parsed: out, jsonPtr };
}

function _readJsonPtr(ptr) {
  const prefix = '@file:';
  const filePath = ptr.startsWith(prefix) ? ptr.slice(prefix.length) : ptr;
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw);
}

function run(argv) {
  const args = Array.isArray(argv) ? argv.slice() : process.argv.slice(3);
  const sub = args.shift();

  if (sub === 'now' || sub === 'start-timestamp' || sub === 'end-timestamp') {
    process.stdout.write(new Date().toISOString() + '\n');
    return 0;
  }

  if (sub === 'record') {
    try {
      const { parsed, jsonPtr } = _parseArgs(args);
      const input = jsonPtr ? _readJsonPtr(jsonPtr) : parsed;
      const record = buildRecord(input);
      const file = appendRecord(record, { cwd: process.cwd() });
      process.stdout.write(file + '\n');
      return 0;
    } catch (err) {
      if (err && err.name === 'NubosPilotError') {
        process.stderr.write(
          JSON.stringify({ code: err.code, message: err.message, details: err.details }) + '\n',
        );
      } else {
        process.stderr.write(String((err && err.stack) || err) + '\n');
      }
      return 1;
    }
  }

  process.stderr.write(_usage() + '\n');
  return 1;
}

module.exports = { run };

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}
