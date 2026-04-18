const fs = require('node:fs');
const path = require('node:path');
const { withFileLock, atomicWriteFileSync, projectStateDir, NubosPilotError } = require('./core.cjs');

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const KV_RE = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/;
const CANONICAL_KEYS = [
  'schema_version',
  'milestone',
  'milestone_name',
  'current_phase',
  'current_plan',
  'current_task',
  'last_updated',
  'progress',
  'session',
];

const NESTED_KEYS = new Set(['progress', 'session']);

function _coerceScalar(v) {
  if (v === 'null' || v === '') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d+\.\d+$/.test(v)) return Number(v);
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  return v;
}

function _parseFlatOrNested(yamlText) {

  
  const fm = {};
  const lines = yamlText.split(/\r?\n/);
  let currentNestedKey = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const indent = (line.match(/^ */) || [''])[0].length;
    const trimmed = line.trim();

    if (indent === 0) {
      const kv = trimmed.match(KV_RE);
      if (!kv) continue;
      const key = kv[1];
      const rawVal = kv[2].trim();
      if (NESTED_KEYS.has(key) && rawVal === '') {

        fm[key] = {};
        currentNestedKey = key;
      } else {
        fm[key] = _coerceScalar(rawVal);
        currentNestedKey = null;
      }
    } else if (currentNestedKey) {

      const kv = trimmed.match(KV_RE);
      if (!kv) continue;
      fm[currentNestedKey][kv[1]] = _coerceScalar(kv[2].trim());
    }
  }
  return fm;
}

function _defaultProgress() {
  return {
    total_phases: 0,
    completed_phases: 0,
    total_plans: 0,
    completed_plans: 0,
    percent: 0,
  };
}

function _defaultSession(preservedLastActivity) {
  return {
    stopped_at: null,
    resume_file: null,
    last_activity: preservedLastActivity == null ? null : preservedLastActivity,
  };
}

function migrateV1ToV2(fmV1) {
  const out = {
    schema_version: 2,
    milestone: fmV1.milestone == null ? null : fmV1.milestone,
    milestone_name: fmV1.milestone_name == null ? null : fmV1.milestone_name,
    current_phase: fmV1.current_phase == null ? null : fmV1.current_phase,
    current_plan: fmV1.current_plan == null ? null : fmV1.current_plan,
    current_task: 'current_task' in fmV1 ? fmV1.current_task : null,
    last_updated: fmV1.last_updated == null ? null : fmV1.last_updated,
    progress: _isPlainObject(fmV1.progress) ? { ..._defaultProgress(), ...fmV1.progress } : _defaultProgress(),
    session: _isPlainObject(fmV1.session)
      ? { ..._defaultSession(fmV1.last_updated), ...fmV1.session }
      : _defaultSession(fmV1.last_updated),
  };
  return out;
}

function _isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseState(raw) {
  const m = raw.match(FM_RE);
  if (!m) {
    throw new NubosPilotError(
      'schema-version-mismatch',
      'STATE.md missing frontmatter',
      { raw: raw.slice(0, 200) },
    );
  }
  const fm = _parseFlatOrNested(m[1]);

  if (fm.schema_version === 1) {
    return { frontmatter: migrateV1ToV2(fm), body: m[2] };
  }
  if (fm.schema_version === 2) {

    if (!_isPlainObject(fm.progress)) fm.progress = _defaultProgress();
    if (!_isPlainObject(fm.session)) fm.session = _defaultSession(fm.last_updated);
    return { frontmatter: fm, body: m[2] };
  }
  throw new NubosPilotError(
    'schema-version-mismatch',
    `STATE.md schema_version=${fm.schema_version}, supported: [1, 2]`,
    { got: fm.schema_version, supported: [1, 2] },
  );
}

function _formatScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  if (s.includes(':') || /^\s/.test(s)) return `"${s}"`;
  return s;
}

function serializeState({ frontmatter, body }) {

  const fm = { ...frontmatter, schema_version: 2 };

  const lines = ['---'];
  const seen = new Set();

  function emitKey(k) {
    if (!(k in fm)) return;
    const v = fm[k];
    if (NESTED_KEYS.has(k) && _isPlainObject(v)) {
      lines.push(`${k}:`);
      for (const nk of Object.keys(v)) {
        lines.push(`  ${nk}: ${_formatScalar(v[nk])}`);
      }
    } else {
      lines.push(`${k}: ${_formatScalar(v)}`);
    }
    seen.add(k);
  }

  for (const k of CANONICAL_KEYS) emitKey(k);
  for (const k of Object.keys(fm)) {
    if (seen.has(k)) continue;
    emitKey(k);
  }

  lines.push('---', '');
  const bodyClean = String(body == null ? '' : body).replace(/^\n+/, '');
  return lines.join('\n') + bodyClean;
}

function statePath(cwd = process.cwd()) {
  return path.join(projectStateDir(cwd), 'STATE.md');
}

function readState(cwd = process.cwd()) {
  const p = statePath(cwd);
  return parseState(fs.readFileSync(p, 'utf-8'));
}

function writeState(next, cwd = process.cwd()) {
  const p = statePath(cwd);
  return withFileLock(p, () => atomicWriteFileSync(p, serializeState(next)));
}

function mutateState(mutator, cwd = process.cwd()) {
  const p = statePath(cwd);
  return withFileLock(p, () => {
    const current = parseState(fs.readFileSync(p, 'utf-8'));
    const next = mutator(current);
    atomicWriteFileSync(p, serializeState(next));
    return next;
  });
}

module.exports = {
  readState,
  writeState,
  mutateState,
  statePath,
  parseState,
  serializeState,
  migrateV1ToV2,
  CANONICAL_KEYS,
};
