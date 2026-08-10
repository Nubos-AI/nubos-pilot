'use strict';

const path = require('node:path');
const { NubosPilotError } = require('../core.cjs');

const REGISTRY = Object.freeze({
  verification: require('./verification.cjs'),
  validation: require('./validation.cjs'),
  'researcher-output': require('./researcher-output.cjs'),
  'research-final': require('./research-final.cjs'),
});

function getSchema(name) {
  const schema = REGISTRY[name];
  if (!schema) {
    throw new NubosPilotError(
      'output-schema-not-found',
      'Unknown output schema: ' + String(name),
      { name, available: Object.keys(REGISTRY) },
    );
  }
  return schema;
}

function listSchemas() {
  return Object.keys(REGISTRY);
}

function _basename(p) { return path.basename(String(p || '')); }

function inferSchemaForFile(filePath) {
  const base = _basename(filePath);
  if (/-VERIFICATION\.md$/.test(base)) return 'verification';
  if (/-VALIDATION\.md$/.test(base)) return 'validation';
  if (/-RESEARCH\.md$/.test(base)) return 'research-final';
  if (/^spawn-\d+\.md$/.test(base)) return 'researcher-output';
  return null;
}

module.exports = { getSchema, listSchemas, inferSchemaForFile, REGISTRY };
