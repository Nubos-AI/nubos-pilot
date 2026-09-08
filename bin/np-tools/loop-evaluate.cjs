'use strict';

const fs = require('node:fs');

const { NubosPilotError } = require('../../lib/core.cjs');
const nubosloop = require('../../lib/nubosloop.cjs');

function _parseJson(raw, source) {
  try { return JSON.parse(raw); }
  catch (err) {
    throw new NubosPilotError(
      'loop-evaluate-invalid-json',
      'loop-evaluate ' + source + ' did not parse as JSON: ' + (err && err.message ? err.message : 'parse error'),
      { source, hint: 'expected a JSON array of { critic, findings[] } records' },
    );
  }
}

function _readJsonArg(rest) {
  const inlineIdx = rest.indexOf('--json');
  if (inlineIdx !== -1 && rest[inlineIdx + 1]) {
    return _parseJson(rest[inlineIdx + 1], '--json');
  }
  const fileIdx = rest.indexOf('--file');
  if (fileIdx !== -1 && rest[fileIdx + 1]) {
    let raw;
    try { raw = fs.readFileSync(rest[fileIdx + 1], 'utf-8'); }
    catch (err) {
      throw new NubosPilotError(
        'loop-evaluate-file-unreadable',
        '--file path could not be read',
        { path: rest[fileIdx + 1], cause: err && err.message },
      );
    }
    return _parseJson(raw, '--file ' + rest[fileIdx + 1]);
  }
  throw new NubosPilotError(
    'loop-evaluate-missing-input',
    'loop-evaluate requires --json <inline> or --file <path-to-critic-outputs.json>',
    { hint: 'expected an array of { critic, findings[] } records' },
  );
}

function _resolveRound(rest) {
  const idx = rest.indexOf('--round');
  if (idx === -1) return 1;
  const v = Number(rest[idx + 1]);
  return Number.isFinite(v) && v >= 1 ? Math.round(v) : 1;
}

function _resolveMaxRounds(rest, cwd) {
  const idx = rest.indexOf('--max-rounds');
  if (idx === -1) return nubosloop.resolveLoopOpts(cwd).maxRounds;
  return nubosloop.resolveLoopOpts(cwd, { maxRounds: rest[idx + 1] }).maxRounds;
}

function run(args, ctx) {
  const context = ctx || {};
  const cwd = context.cwd || process.cwd();
  const stdout = context.stdout || process.stdout;
  const list = Array.isArray(args) ? args : [];
  const outputs = _readJsonArg(list);
  if (!Array.isArray(outputs)) {
    throw new NubosPilotError(
      'loop-evaluate-invalid-input',
      'critic outputs must be a JSON array',
      { got: typeof outputs },
    );
  }
  const round = _resolveRound(list);
  const maxRounds = _resolveMaxRounds(list, cwd);
  const result = nubosloop.evaluateLoop({ round }, outputs, { maxRounds });
  stdout.write(JSON.stringify(result) + '\n');
  return result;
}

module.exports = { run };
