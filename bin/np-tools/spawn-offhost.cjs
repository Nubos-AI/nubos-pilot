'use strict';

const fs = require('node:fs');
const { NubosPilotError } = require('../../lib/core.cjs');
const { dispatchOffHost } = require('../../lib/runtime/dispatch.cjs');

function _usage() {
  process.stderr.write(
    'Usage: np-tools.cjs spawn-offhost --agent <name> (--task <str> | --task-file <path>) '
    + '[--cwd <dir>] [--phase P] [--plan P] [--task-id T] [--max-iterations N] [--allow-bash] [--read-only] [--no-audit]\n',
  );
}

function _parse(argv) {
  const out = { allowBash: false, readOnly: false };
  const a = argv.slice();
  while (a.length) {
    const f = a.shift();
    if (f === '--agent') out.agent = a.shift();
    else if (f === '--task') out.task = a.shift();
    else if (f === '--task-file') out.taskFile = a.shift();
    else if (f === '--phase') out.phase = a.shift();
    else if (f === '--plan') out.plan = a.shift();
    else if (f === '--task-id') out.taskId = a.shift();
    else if (f === '--max-iterations') out.maxIterations = Number(a.shift());
    else if (f === '--cwd') out.cwd = a.shift();
    else if (f === '--output-schema') out.outputSchema = a.shift();
    else if (f === '--allow-bash') out.allowBash = true;
    else if (f === '--read-only') out.readOnly = true;
    else if (f === '--no-audit') out.skipAudit = true;
  }
  return out;
}

async function run(argv) {
  const args = Array.isArray(argv) ? argv.slice() : process.argv.slice(3);
  if (!args.length || args[0] === '--help') { _usage(); return 1; }
  const parsed = _parse(args);

  let task = parsed.task;
  if (parsed.taskFile) {
    try { task = fs.readFileSync(parsed.taskFile, 'utf-8'); }
    catch { process.stderr.write(JSON.stringify({ code: 'spawn-offhost-task-file-unreadable', file: require('node:path').basename(parsed.taskFile) }) + '\n'); return 1; }
  }
  if (!parsed.agent || typeof task !== 'string') { _usage(); return 1; }

  try {
    const result = await dispatchOffHost({
      agent: parsed.agent,
      task,
      cwd: parsed.cwd || process.cwd(),
      phase: parsed.phase,
      plan: parsed.plan,
      taskId: parsed.taskId,
      maxIterations: parsed.maxIterations,
      allowBash: parsed.allowBash,
      readOnly: parsed.readOnly,
      skipAudit: parsed.skipAudit,
      outputSchema: parsed.outputSchema,
    });
    if (result && result.metrics_recorded === false) {
      process.stderr.write('spawn-offhost: metrics row was not recorded (telemetry only; run succeeded)\n');
    }
    if (result && result.rule9 && result.rule9.ok === false) {
      process.stderr.write('spawn-offhost: Rule-9 violation (' + (result.rule9.violation || result.rule9.error)
        + ') — the agent did not satisfy the search bar. Do NOT commit this output as-is; re-run or route back to the agent.\n');
    }
    if (result && result.capability && result.capability.ok === false) {
      const c = result.capability;
      process.stderr.write('spawn-offhost: the model advertised ' + c.toolsAdvertised
        + ' tool(s) but made zero tool calls — the provider/model likely does NOT support OpenAI function/tool-calling. '
        + (c.mutating
          ? 'This agent edits files; off-host it produced NO changes. Route it to a tool-calling-capable model or keep it native.'
          : 'If this agent was expected to inspect the workspace, its output may be ungrounded — verify before relying on it.')
        + '\n');
    }
    process.stdout.write(JSON.stringify(result) + '\n');
    return 0;
  } catch (err) {
    if (err && err.name === 'NubosPilotError') {
      process.stderr.write(JSON.stringify({ code: err.code, message: err.message, details: err.details }) + '\n');
    } else {
      process.stderr.write(String((err && err.stack) || err) + '\n');
    }
    return 1;
  }
}

module.exports = { run, _parse };

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => process.exit(code || 0));
}
