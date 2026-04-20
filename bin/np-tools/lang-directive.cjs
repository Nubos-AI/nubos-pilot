'use strict';

const languageMod = require('../../lib/language.cjs');
const { NubosPilotError } = require('../../lib/core.cjs');

function _usage() {
  return 'Usage:\n  np-tools.cjs lang-directive [--json] [--lang <code>]';
}

function _emitError(err, stderr) {
  const code = err && err.name === 'NubosPilotError' ? err.code : 'lang-directive-internal-error';
  const message = (err && err.message) || String(err);
  const details = (err && err.details) || null;
  stderr.write(JSON.stringify({ code, message, details }) + '\n');
}

function run(argv, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const stderr = context.stderr || process.stderr;
  const args = Array.isArray(argv) ? argv.slice() : [];

  let wantJson = false;
  let override = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') { wantJson = true; continue; }
    if (a === '--lang') { override = args[++i] || null; continue; }
    if (a.startsWith('--lang=')) { override = a.slice('--lang='.length); continue; }
    if (a === '-h' || a === '--help') {
      stdout.write(_usage() + '\n');
      return 0;
    }
    stderr.write(JSON.stringify({
      code: 'lang-directive-unknown-arg',
      message: 'Unknown argument: ' + a,
      details: { arg: a },
    }) + '\n');
    return 1;
  }

  try {
    const language = override != null
      ? languageMod.normalizeLanguage(override)
      : languageMod.resolveLanguage(cwd);
    const directive = languageMod.buildDirective(language);
    if (wantJson) {
      stdout.write(JSON.stringify({ language, directive }) + '\n');
    } else {
      stdout.write(directive + '\n');
    }
    return 0;
  } catch (err) {
    _emitError(err, stderr);
    return 1;
  }
}

module.exports = { run };

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}
