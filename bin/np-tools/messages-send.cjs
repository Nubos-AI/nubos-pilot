'use strict';

const fs = require('node:fs');
const { NubosPilotError, projectStateDir } = require('../../lib/core.cjs');
const { send } = require('../../lib/messaging.cjs');
const safePath = require('../../lib/safe-path.cjs');

function _parseArgs(args) {
  const out = {
    from: null, to: null, phase: null, round: null,
    kind: null, subject: null, body: null, bodyFile: null,
    expectsReply: false, inReplyTo: null,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--from')          { out.from = args[++i] || null; continue; }
    if (a === '--to')            { out.to = args[++i] || null; continue; }
    if (a === '--phase')         { out.phase = args[++i] || null; continue; }
    if (a === '--task')          { out.phase = args[++i] || null; continue; }
    if (a === '--round')         { out.round = args[++i] || null; continue; }
    if (a === '--kind')          { out.kind = args[++i] || null; continue; }
    if (a === '--subject')       { out.subject = args[++i] || null; continue; }
    if (a === '--body')          { out.body = args[++i] || null; continue; }
    if (a === '--body-file')     { out.bodyFile = args[++i] || null; continue; }
    if (a === '--expects-reply') { out.expectsReply = true; continue; }
    if (a === '--in-reply-to')   { out.inReplyTo = args[++i] || null; continue; }
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
    let resolved;
    try {
      resolved = safePath.assertInsideAnyOf([cwd, projectStateDir(cwd)], parsed.bodyFile, 'body-file');
    } catch (err) {
      if (err && (err.code === 'safe-path-outside-base' || err.code === 'safe-path-invalid-input' || err.code === 'safe-path-base-missing')) {
        throw new NubosPilotError(
          'messages-body-file-not-allowed',
          '--body-file must reside inside the project or .nubos-pilot/: ' + parsed.bodyFile,
          { path: parsed.bodyFile, cause: err.code },
        );
      }
      throw err;
    }
    try { body = fs.readFileSync(resolved, 'utf-8'); }
    catch (err) {
      throw new NubosPilotError(
        'messages-body-file-read-failed',
        'failed to read --body-file: ' + (err && err.message),
        { path: parsed.bodyFile },
      );
    }
  }

  let round = null;
  if (parsed.round !== null && parsed.round !== '') {
    const n = Number(parsed.round);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      throw new NubosPilotError(
        'messages-invalid-round',
        '--round must be a non-negative integer; got: ' + JSON.stringify(parsed.round),
        { round: parsed.round },
      );
    }
    round = n;
  }

  const result = send({
    from: parsed.from,
    to: parsed.to,
    phase: parsed.phase,
    round,
    kind: parsed.kind,
    subject: parsed.subject,
    body,
    expects_reply: parsed.expectsReply,
    in_reply_to: parsed.inReplyTo,
  }, cwd);

  stdout.write(JSON.stringify(result) + '\n');
  return 0;
}

module.exports = { run, _parseArgs };
