'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { NubosPilotError } = require('../../lib/core.cjs');

const PACKAGE_TEMPLATES_DIR = path.resolve(__dirname, '..', '..', 'templates');

function _emitError(err, stderr) {
  const code = err && err.name === 'NubosPilotError' ? err.code : 'template-path-internal-error';
  const message = (err && err.message) || String(err);
  const details = (err && err.details) || null;
  stderr.write(JSON.stringify({ code, message, details }) + '\n');
}

function resolveTemplatePath(name) {
  if (!name || typeof name !== 'string') {
    throw new NubosPilotError('template-invalid-name', 'template name must be a non-empty string', { name });
  }
  const segments = name.split(/[/\\]/);
  for (const seg of segments) {
    if (seg === '' || seg === '..' || seg === '.') {
      throw new NubosPilotError('template-invalid-name', 'template name segment invalid: ' + seg, { name, segment: seg });
    }
  }
  const withExt = /\.[a-z0-9]+$/i.test(name) ? name : name + '.md';
  const full = path.resolve(PACKAGE_TEMPLATES_DIR, withExt);
  const guard = PACKAGE_TEMPLATES_DIR + path.sep;
  if (!full.startsWith(guard)) {
    throw new NubosPilotError('template-path-traversal', 'template name escapes templates directory', { name, resolved: full });
  }
  if (!fs.existsSync(full)) {
    throw new NubosPilotError('template-not-found', 'template not found: ' + name, { name, path: full });
  }
  return full;
}

function run(argv, ctx) {
  const context = ctx || {};
  const stdout = context.stdout || process.stdout;
  const stderr = context.stderr || process.stderr;
  const args = Array.isArray(argv) ? argv.slice() : [];
  if (args.length === 0 || args[0] === '--help') {
    stderr.write('Usage: np-tools.cjs template-path <name>\n');
    return 1;
  }
  try {
    const out = resolveTemplatePath(args[0]);
    stdout.write(out);
    return 0;
  } catch (err) {
    _emitError(err, stderr);
    return 1;
  }
}

module.exports = { run, resolveTemplatePath, PACKAGE_TEMPLATES_DIR };

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}
