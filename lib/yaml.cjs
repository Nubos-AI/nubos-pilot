'use strict';

const YAML = require('yaml');
const { NubosPilotError } = require('./core.cjs');


const DEFAULT_MAX_BYTES = 1 * 1024 * 1024;  // 1 MiB — matches lib/roadmap.cjs cap
const DEFAULT_MAX_ALIASES = 100;

function safeYamlParse(raw, opts) {
  const o = opts || {};
  const maxBytes = Number.isFinite(o.maxBytes) ? o.maxBytes : DEFAULT_MAX_BYTES;
  const maxAliases = Number.isFinite(o.maxAliases) ? o.maxAliases : DEFAULT_MAX_ALIASES;
  if (typeof raw !== 'string') {
    throw new NubosPilotError(
      'yaml-invalid-input',
      'safeYamlParse requires string input',
      { kind: o.kind || null, type: typeof raw },
    );
  }
  const byteLen = Buffer.byteLength(raw, 'utf-8');
  if (byteLen > maxBytes) {
    throw new NubosPilotError(
      'yaml-too-large',
      'YAML input exceeds size cap (' + byteLen + ' > ' + maxBytes + ' bytes)',
      { kind: o.kind || null, bytes: byteLen, maxBytes },
    );
  }
  try {
    return YAML.parse(raw, { maxAliasCount: maxAliases });
  } catch (err) {
    throw new NubosPilotError(
      'yaml-parse-failed',
      'YAML parse failed: ' + (err && err.message ? err.message.slice(0, 200) : 'unknown'),
      { kind: o.kind || null, cause: (err && err.name) || 'YAMLError' },
    );
  }
}

module.exports = {
  safeYamlParse,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_ALIASES,
};
