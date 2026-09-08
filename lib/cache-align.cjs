'use strict';

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const ISO_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/;
const HEX_RE = /\b[0-9a-f]{32,64}\b/i;
const VOLATILE = Object.freeze([
  ['uuid', UUID_RE],
  ['iso_datetime', ISO_RE],
  ['jwt', JWT_RE],
  ['hex_hash', HEX_RE],
]);

function _systemText(system) {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n');
  }
  return '';
}

function detectVolatile(system) {
  const text = _systemText(system);
  const findings = [];
  for (const [kind, re] of VOLATILE) {
    const m = text.match(re);
    if (m) findings.push({ kind, sample_len: m[0].length });
  }
  return findings;
}

function _sortKeys(v) {
  if (Array.isArray(v)) return v.map(_sortKeys);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = _sortKeys(v[k]);
    return out;
  }
  return v;
}

function _byCodepoint(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalizeTools(tools) {
  return tools
    .map(_sortKeys)
    .map((t) => ({ t, name: String(t && t.name), body: JSON.stringify(t) }))
    .sort((a, b) => _byCodepoint(a.name, b.name) || _byCodepoint(a.body, b.body))
    .map((x) => x.t);
}

function _anyCacheControl(system, tools) {
  if (Array.isArray(system) && system.some((b) => b && b.cache_control)) return true;
  if (Array.isArray(tools) && tools.some((t) => t && t.cache_control)) return true;
  return false;
}

function alignAnthropicBody(body) {
  const findings = detectVolatile(body && body.system);
  if (!body || !Array.isArray(body.tools) || body.tools.length === 0) {
    return { body, findings, applied: false };
  }
  if (_anyCacheControl(body.system, body.tools)) {
    return { body, findings, applied: false };
  }
  const tools = normalizeTools(body.tools);
  const last = tools.length - 1;
  tools[last] = Object.assign({}, tools[last], { cache_control: { type: 'ephemeral' } });
  return { body: Object.assign({}, body, { tools }), findings, applied: true };
}

module.exports = {
  detectVolatile,
  normalizeTools,
  alignAnthropicBody,
};
