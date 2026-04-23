'use strict';

const fs = require('node:fs');
const { NubosPilotError } = require('../../lib/core.cjs');
const { writeHandoff } = require('../../lib/handoff.cjs');

function _parseArgs(args) {
  const out = {
    from: null, to: null, topic: null,
    milestone: null, slice: null, task: null,
    body: null, bodyFile: null,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--from')       { out.from = args[++i] || null; continue; }
    if (a === '--to')         { out.to = args[++i] || null; continue; }
    if (a === '--topic')      { out.topic = args[++i] || null; continue; }
    if (a === '--milestone')  { out.milestone = args[++i] || null; continue; }
    if (a === '--slice')      { out.slice = args[++i] || null; continue; }
    if (a === '--task')       { out.task = args[++i] || null; continue; }
    if (a === '--body')       { out.body = args[++i] || null; continue; }
    if (a === '--body-file')  { out.bodyFile = args[++i] || null; continue; }
  }
  return out;
}

function run(args, opts) {
  const o = opts || {};
  const cwd = o.cwd || process.cwd();
  const stdout = o.stdout || process.stdout;
  const parsed = _parseArgs(Array.isArray(args) ? args : []);

  let body = parsed.body || '';
  if (parsed.bodyFile) {
    try { body = fs.readFileSync(parsed.bodyFile, 'utf-8'); }
    catch (err) {
      throw new NubosPilotError(
        'handoff-body-file-read-failed',
        'failed to read --body-file: ' + (err && err.message),
        { path: parsed.bodyFile },
      );
    }
  }

  const result = writeHandoff({
    from: parsed.from,
    to: parsed.to,
    topic: parsed.topic,
    milestone: parsed.milestone,
    slice: parsed.slice,
    task: parsed.task,
    body,
  }, cwd);

  stdout.write(JSON.stringify(result) + '\n');
  return 0;
}

module.exports = { run, _parseArgs };
