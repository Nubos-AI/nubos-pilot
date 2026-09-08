'use strict';

const { collectSnapshot, renderSnapshot } = require('../../lib/dashboard.cjs');
const { resolveLanguage, normalizeLanguage } = require('../../lib/language.cjs');

function _parseArgs(args) {
  const out = { json: false, noColor: false, lang: null };
  const list = Array.isArray(args) ? args : [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '--json')          out.json = true;
    else if (a === '--no-color') out.noColor = true;
    else if (a === '--lang')     out.lang = list[++i] || null;
    else if (a.startsWith('--lang=')) out.lang = a.slice('--lang='.length);
  }
  return out;
}

function run(args, opts) {
  const o = opts || {};
  const cwd = o.cwd || process.cwd();
  const stdout = o.stdout || process.stdout;
  const parsed = _parseArgs(args);

  const snap = collectSnapshot(cwd);
  if (parsed.json) {
    stdout.write(JSON.stringify(snap, null, 2) + '\n');
    return 0;
  }
  const useColor = !parsed.noColor && Boolean(stdout.isTTY);
  const language = parsed.lang ? normalizeLanguage(parsed.lang) : resolveLanguage(cwd);
  stdout.write(renderSnapshot(snap, { color: useColor, language }) + '\n');
  return 0;
}

module.exports = { run, _parseArgs };
