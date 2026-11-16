'use strict';

// CLI surface for the session handoff document (ADR-0025).
//
// Named `resume-doc` rather than `handoff-*` on purpose: the `handoff-write` /
// `handoff-read` family is agent-to-agent messaging under ADR-0015, and the two
// are different artefacts with different lifetimes. Conflating the verbs would
// make `handoff-list` ambiguous.

const fs = require('node:fs');
const sh = require('../../lib/session-handoff.cjs');
const learnings = require('../../lib/learnings.cjs');
const { getFlag, emitErrorEnvelope } = require('./_args.cjs');

function _usage() {
  return [
    'Usage:',
    '  np-tools.cjs resume-doc write  (--doc <json> | --doc-file <path>) [--milestone M<NNN>] [--task <full-id>]',
    '  np-tools.cjs resume-doc lint   (--doc <json> | --doc-file <path>)',
    '  np-tools.cjs resume-doc read   [--json]',
    '  np-tools.cjs resume-doc status [--json]',
    '  np-tools.cjs resume-doc ack    (--summary <text> | --summary-file <path>)',
    '  np-tools.cjs resume-doc learnings [--log] [--task <full-id>] [--milestone M<NNN>]',
    '',
    'The session handoff is the six-section re-entry brief written at a session',
    'boundary. Section 5 (failed_approaches) is mandatory: it is the only section',
    'git cannot reconstruct, because a commit records what worked and never what',
    'was tried and reverted.',
    '',
    'Document shape (JSON):',
    '  {',
    '    "goal": "why this project exists, a few sentences",',
    '    "status": "running | partial | blocked",',
    '    "active_files":      [{"path": "lib/x.cjs", "purpose": "what it does here"}],',
    '    "changes":           [{"what": "…", "why": "…"}],',
    '    "failed_approaches": [{"approach": "what was tried", "why_failed": "the cause"}],',
    '    "next_steps":        [{"step": "…", "command": "/np:execute-phase 3"}]',
    '  }',
    '',
    'An empty failed_approaches list requires no_failed_approaches_reason — a',
    'session where nothing was abandoned and a session that skipped the section',
    'must not look identical on disk.',
    '',
    'Never record a secret VALUE. Variable names are fine and encouraged; the',
    'writer refuses tokens, keys, JWTs and credentialed URLs.',
    '',
    '`status` returns gate: none | blocked | clear. /np:resume-work refuses to',
    'proceed to code work while the gate is blocked.',
  ].join('\n');
}

function _readDoc(rest, stderr) {
  const inline = getFlag(rest, '--doc');
  const file = getFlag(rest, '--doc-file');
  if (!inline && !file) {
    stderr.write(JSON.stringify({
      code: 'resume-doc-missing-doc',
      message: 'either --doc <json> or --doc-file <path> is required',
      details: {},
    }) + '\n');
    return null;
  }
  const raw = inline || fs.readFileSync(file, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    stderr.write(JSON.stringify({
      code: 'resume-doc-invalid-json',
      message: 'The document is not valid JSON',
      details: { cause: err && err.message, source: inline ? '--doc' : file },
    }) + '\n');
    return null;
  }
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

  try {
    switch (verb) {
      case 'write': {
        const doc = _readDoc(rest, stderr);
        if (!doc) return 1;
        const res = sh.writeHandoff(doc, cwd, {
          milestone: getFlag(rest, '--milestone') || null,
          task: getFlag(rest, '--task') || null,
        });
        stdout.write(JSON.stringify(res, null, 2) + '\n');
        return 0;
      }

      case 'lint': {
        const doc = _readDoc(rest, stderr);
        if (!doc) return 1;
        sh.validateDoc(doc);
        stdout.write(JSON.stringify({
          ok: true,
          sections: sh.SECTIONS,
          failed_approaches: doc.failed_approaches.length,
          explained_empty: doc.failed_approaches.length === 0,
        }, null, 2) + '\n');
        return 0;
      }

      case 'read': {
        const record = sh.readHandoff(cwd);
        if (!record) {
          stderr.write(JSON.stringify({
            code: 'resume-doc-none',
            message: 'No session handoff exists for this project',
            details: { path: sh.statePath(cwd) },
          }) + '\n');
          return 1;
        }
        if (rest.includes('--json')) {
          stdout.write(JSON.stringify(record, null, 2) + '\n');
          return 0;
        }
        // Default to the human artefact — this verb exists so the next session
        // reads the brief, not so it parses the record.
        stdout.write(fs.readFileSync(sh.resumePath(cwd), 'utf-8'));
        return 0;
      }

      case 'status': {
        const st = sh.handoffStatus(cwd);
        if (rest.includes('--json')) {
          stdout.write(JSON.stringify(st, null, 2) + '\n');
          return 0;
        }
        stdout.write(st.gate + '\n');
        return 0;
      }

      case 'ack': {
        const inline = getFlag(rest, '--summary');
        const file = getFlag(rest, '--summary-file');
        if (!inline && !file) {
          stderr.write(JSON.stringify({
            code: 'resume-doc-missing-summary',
            message: 'either --summary <text> or --summary-file <path> is required',
            details: {},
          }) + '\n');
          return 1;
        }
        const summary = inline || fs.readFileSync(file, 'utf-8');
        stdout.write(JSON.stringify(sh.ackHandoff(summary, cwd), null, 2) + '\n');
        return 0;
      }

      case 'learnings': {
        const record = sh.readHandoff(cwd);
        if (!record) {
          stderr.write(JSON.stringify({
            code: 'resume-doc-none',
            message: 'No session handoff exists for this project',
            details: { path: sh.statePath(cwd) },
          }) + '\n');
          return 1;
        }
        const candidates = sh.toLearningCandidates(record.doc, {
          task_id: getFlag(rest, '--task') || record.task || undefined,
          milestone_id: getFlag(rest, '--milestone') || record.milestone || undefined,
        });
        if (!rest.includes('--log')) {
          stdout.write(JSON.stringify({ ok: true, logged: false, candidates }, null, 2) + '\n');
          return 0;
        }
        const logged = [];
        for (const c of candidates) {
          learnings.logLearning(c, cwd);
          logged.push(c.pattern);
        }
        stdout.write(JSON.stringify({ ok: true, logged: true, count: logged.length, patterns: logged }, null, 2) + '\n');
        return 0;
      }

      default: {
        stderr.write(JSON.stringify({
          code: 'resume-doc-unknown-verb',
          message: 'Unknown verb: ' + verb,
          details: { verb, allowed: ['write', 'lint', 'read', 'status', 'ack', 'learnings'] },
        }) + '\n');
        return 1;
      }
    }
  } catch (err) {
    emitErrorEnvelope(err, stderr, 'resume-doc-internal-error');
    return 1;
  }
}

module.exports = { run };

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}
