'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { NubosPilotError } = require('../../lib/core.cjs');
const outputLint = require('../../lib/output-lint.cjs');
const { getSchema, listSchemas, inferSchemaForFile } = require('../../lib/schemas/index.cjs');

function _parseArgs(list) {
  const out = { file: null, schema: null, format: 'json', enforce: false };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '--file' || a === '-f') out.file = list[++i];
    else if (a === '--schema' || a === '-s') out.schema = list[++i];
    else if (a === '--format') out.format = list[++i];
    else if (a === '--enforce') out.enforce = true;
    else if (a === '--md') out.format = 'md';
    else if (a === '--text') out.format = 'text';
  }
  return out;
}

function _renderText(result) {
  const lines = [];
  lines.push((result.ok ? 'OK' : 'FAIL') + ' [' + (result.schema_name || '?') + '] ' + (result.path || '<inline>'));
  if (!result.ok) {
    for (const v of (result.violations || [])) {
      lines.push('  - [' + v.code + '] ' + v.path + ': ' + v.message);
    }
  }
  return lines.join('\n');
}

function _emit(result, format, stdout) {
  if (format === 'text') {
    stdout.write(_renderText(result) + '\n');
    return;
  }
  stdout.write(JSON.stringify(result, null, 2));
}

function _verbCheck(flags, stdout) {
  if (!flags.file) {
    throw new NubosPilotError('output-lint-missing-file', 'check requires --file <path>', {});
  }
  const schemaName = flags.schema || inferSchemaForFile(flags.file);
  if (!schemaName) {
    throw new NubosPilotError(
      'output-lint-cannot-infer-schema',
      'cannot infer schema from filename; pass --schema <name>',
      { file: flags.file, available: listSchemas() },
    );
  }
  const schema = getSchema(schemaName);
  const result = outputLint.lintFile(flags.file, schema);
  _emit(result, flags.format, stdout);
  if (flags.enforce && !result.ok) {
    return 1;
  }
  return 0;
}

function _verbPrompt(flags, stdout) {
  if (!flags.schema) {
    throw new NubosPilotError('output-lint-missing-schema', 'prompt requires --schema <name>', {
      available: listSchemas(),
    });
  }
  const schema = getSchema(flags.schema);
  stdout.write(outputLint.schemaPrompt(schema));
  return 0;
}

function _verbList(_flags, stdout) {
  const payload = listSchemas().map((name) => {
    const s = getSchema(name);
    return {
      name,
      artifact: s.artifact || null,
      description: s.description || null,
      required_frontmatter: (s.frontmatter && s.frontmatter.required) || [],
    };
  });
  stdout.write(JSON.stringify(payload, null, 2));
  return 0;
}

function run(args, ctx) {
  const context = ctx || {};
  const stdout = context.stdout || process.stdout;
  const list = Array.isArray(args) ? args : [];
  const verb = list[0];
  const flags = _parseArgs(list.slice(1));

  switch (verb) {
    case 'check':
      return _verbCheck(flags, stdout);
    case 'prompt':
    case 'schema-prompt':
      return _verbPrompt(flags, stdout);
    case 'list':
      return _verbList(flags, stdout);
    default:
      throw new NubosPilotError(
        'output-lint-unknown-verb',
        'output-lint: unknown verb: ' + String(verb),
        { verb, allowed: ['check', 'prompt', 'list'] },
      );
  }
}

module.exports = { run };
