const { askUser } = require('../../lib/askuser.cjs');
const { NubosPilotError } = require('../../lib/core.cjs');
const { emitErrorEnvelope } = require('./_args.cjs');

function _usage() {
  return 'Usage:\n  np-tools.cjs askuser --json \'{...spec...}\'';
}

// ── stdout answer contract (one line, consumed as CHOICE=$(… askuser …)) ────
//   input       → the typed line, verbatim
//   select      → the chosen option's label, verbatim (the label IS the
//                 contract — no quoting, no trimming, no stringify)
//   confirm     → "true" | "false", LOCKED. The answer is a boolean, so its
//                 rendering must not depend on the prompt language: a German
//                 "ja" and an English "y" both print "true".
//                 This lock covers THIS CLI's stdout only. It is not the whole
//                 contract a workflow sees: under Claude Code the workflows
//                 route confirm to the native AskUserQuestion tool and never
//                 execute this file, and that path answers with the button
//                 label ("Yes"/"No"). A workflow comparing [[ "$X" == "true" ]]
//                 is therefore broken on the primary path. Match both — see the
//                 canonical idiom in workflows/new-project.md.
//   multiselect → a JSON array of labels. Multi-value answers are not
//                 `case`-dispatchable in ANY format; consume them with
//                 jq/node, e.g. `jq -r '.[]'`.
// Anything else (a raw option object, a function, …) means a runtime handed
// back a value it should have normalised. JSON.stringify used to paper over
// exactly that and shipped "[object Object]"-class garbage into a case arm, so
// this fails loud instead.
function _formatValue(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return JSON.stringify(value);
  throw new NubosPilotError(
    'askuser-unsupported-answer',
    'askUser returned a value that is not renderable as a shell answer: '
      + Object.prototype.toString.call(value)
      + ' — the runtime adapter must normalise options to their label',
    { valueType: Array.isArray(value) ? 'array' : typeof value },
  );
}

async function run(argv, ctx) {
  const context = ctx || {};
  const stdout = context.stdout || process.stdout;
  const stderr = context.stderr || process.stderr;
  const args = Array.isArray(argv) ? argv.slice() : [];
  const idx = args.indexOf('--json');
  if (idx < 0 || idx + 1 >= args.length) {
    stderr.write(_usage() + '\n');
    return 1;
  }
  let spec;
  try {
    spec = JSON.parse(args[idx + 1]);
  } catch (err) {
    stderr.write(JSON.stringify({ code: 'askuser-invalid-json', message: err.message, details: null }) + '\n');
    return 1;
  }
  try {
    const result = await askUser(spec);
    const value = result && typeof result === 'object' && 'value' in result ? result.value : result;
    stdout.write(_formatValue(value) + '\n');
    return 0;
  } catch (err) {
    emitErrorEnvelope(err, stderr, 'askuser-internal-error');
    return 1;
  }
}

module.exports = { run };

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => process.exit(code)).catch((err) => {
    process.stderr.write(String((err && err.stack) || err) + '\n');
    process.exit(1);
  });
}
