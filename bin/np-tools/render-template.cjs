'use strict';

const { NubosPilotError } = require('../../lib/core.cjs');
const { loadTemplate } = require('../../lib/template.cjs');

function _parseArgs(args) {
  const out = { name: null, varsJson: null, varsFile: null };
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('-')) { rest.push(a); continue; }
    if (a === '--vars' || a === '-v') { out.varsJson = args[++i] || null; continue; }
    if (a === '--vars-file' || a === '-V') { out.varsFile = args[++i] || null; continue; }
  }
  if (rest.length) out.name = rest[0];
  return out;
}

function _readVars(parsed) {
  let raw = parsed.varsJson;
  if (!raw && parsed.varsFile) {
    const fs = require('node:fs');
    raw = fs.readFileSync(parsed.varsFile, 'utf-8');
  }
  if (!raw) {
    throw new NubosPilotError('render-template-missing-vars',
      'vars JSON required (via --vars or --vars-file)', {});
  }
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new Error('vars must be a JSON object');
    }
    return obj;
  } catch (err) {
    throw new NubosPilotError('render-template-invalid-vars',
      'invalid vars JSON: ' + err.message, { cause: err.message });
  }
}

function run(args, opts) {
  const o = opts || {};
  const cwd = o.cwd || process.cwd();
  const stdout = o.stdout || process.stdout;
  const parsed = _parseArgs(args || []);
  if (!parsed.name) {
    throw new NubosPilotError('render-template-missing-name',
      'template name required (e.g. milestone/CONTEXT)', {});
  }
  const vars = _readVars(parsed);
  const rendered = loadTemplate(parsed.name, vars, cwd);
  stdout.write(rendered);
  return 0;
}

module.exports = { run, _parseArgs, _readVars };
