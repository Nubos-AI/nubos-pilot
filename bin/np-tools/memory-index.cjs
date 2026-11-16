'use strict';

const fs = require('node:fs');
const { NubosPilotError } = require('../../lib/core.cjs');
const { resolveMemory } = require('./_memory-resolve.cjs');

function _parseArgs(args) {
  const out = { recordsFile: null, recordsJson: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--records-file') { out.recordsFile = args[++i] || null; continue; }
    if (a === '--records')      { out.recordsJson = args[++i] || null; continue; }
  }
  return out;
}

function _readRecords(parsed) {
  if (parsed.recordsFile) {
    let raw;
    try { raw = fs.readFileSync(parsed.recordsFile, 'utf-8'); }
    catch (err) {
      throw new NubosPilotError(
        'memory-records-file-read-failed',
        'failed to read --records-file: ' + (err && err.message),
        { path: parsed.recordsFile },
      );
    }
    try { return JSON.parse(raw); }
    catch {
      const lines = raw.split('\n').filter((l) => l.trim());
      const out = [];
      for (const l of lines) {
        try { out.push(JSON.parse(l)); }
        catch (err) {
          throw new NubosPilotError(
            'memory-records-file-invalid-json',
            'records file is neither JSON array nor JSONL',
            { line: l.slice(0, 80) },
          );
        }
      }
      return out;
    }
  }
  if (parsed.recordsJson) {
    try { return JSON.parse(parsed.recordsJson); }
    catch (err) {
      throw new NubosPilotError(
        'memory-records-arg-invalid-json',
        '--records is not valid JSON',
        { error: err && err.message },
      );
    }
  }
  throw new NubosPilotError(
    'memory-index-missing-records',
    'either --records <json-array> or --records-file <path> required',
    {},
  );
}

async function run(args, opts) {
  const o = opts || {};
  const stdout = o.stdout || process.stdout;
  const parsed = _parseArgs(Array.isArray(args) ? args : []);
  const records = _readRecords(parsed);
  if (!Array.isArray(records)) {
    throw new NubosPilotError('memory-records-not-array', 'records must be a JSON array', {});
  }

  const memory = resolveMemory(o);
  const result = await memory.index(records);
  stdout.write(JSON.stringify(result) + '\n');
  return 0;
}

module.exports = { run, _parseArgs };
