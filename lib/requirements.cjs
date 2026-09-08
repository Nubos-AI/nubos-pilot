'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { NubosPilotError } = require('./core.cjs');

const REQ_ID_RE = /^[A-Z][A-Z0-9]{0,15}-[A-Za-z0-9.]{1,10}$/;
const ENTRY_RE = /^\s*[-*]\s*(?:\[( |x|X)\]\s*)?\*\*([A-Z][A-Z0-9]{0,15}-[A-Za-z0-9.]{1,10})\*\*\s*:?\s*(.*)$/;
const SECTION_RE = /^##\s+(.*?)\s*$/;
const PLACEHOLDER_IDS = Object.freeze(['REQ-TBD']);
const MAX_BYTES = 2 * 1024 * 1024;

function requirementsPath(root) {
  return path.join(root, '.nubos-pilot', 'REQUIREMENTS.md');
}

function isRequirementId(value) {
  return typeof value === 'string' && REQ_ID_RE.test(value);
}

function isPlaceholder(id) {
  return PLACEHOLDER_IDS.includes(String(id));
}

function parseRequirements(markdown) {
  const text = typeof markdown === 'string' ? markdown : '';
  const entries = [];
  const seen = new Map();
  const duplicates = [];
  let section = null;
  let inFence = false;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(?:```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;

    const heading = line.match(SECTION_RE);
    if (heading) { section = heading[1]; continue; }

    const entry = line.match(ENTRY_RE);
    if (!entry) continue;

    const id = entry[2];
    const record = {
      id,
      text: entry[3].trim(),
      section,
      checked: entry[1] === 'x' || entry[1] === 'X',
      line: i + 1,
      placeholder: isPlaceholder(id),
    };
    if (seen.has(id)) duplicates.push(id);
    else seen.set(id, record);
    entries.push(record);
  }

  return { entries, byId: seen, duplicates: [...new Set(duplicates)] };
}

function readRequirements(root) {
  const target = requirementsPath(root);
  let raw;
  try { raw = fs.readFileSync(target, 'utf-8'); }
  catch { return { present: false, path: target, entries: [], byId: new Map(), duplicates: [] }; }
  if (Buffer.byteLength(raw, 'utf-8') > MAX_BYTES) {
    throw new NubosPilotError(
      'requirements-too-large',
      'REQUIREMENTS.md exceeds the ' + MAX_BYTES + ' byte cap',
      { path: target },
    );
  }
  return Object.assign({ present: true, path: target }, parseRequirements(raw));
}

function knownIds(root) {
  return [...readRequirements(root).byId.keys()];
}

function sections(root) {
  const out = new Map();
  for (const entry of readRequirements(root).entries) {
    const key = entry.section || '';
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(entry);
  }
  return out;
}

function normalizeIdList(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value == null ? '' : value).split(/[,\s]+/);
  const out = [];
  for (const item of raw) {
    const id = String(item || '').trim().toUpperCase();
    if (!id) continue;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

function validateIds(ids, root) {
  const wanted = normalizeIdList(ids);
  const store = readRequirements(root);
  const malformed = wanted.filter((id) => !isRequirementId(id));
  const wellFormed = wanted.filter((id) => isRequirementId(id));
  const placeholders = wellFormed.filter(isPlaceholder);
  const unknown = store.present
    ? wellFormed.filter((id) => !isPlaceholder(id) && !store.byId.has(id))
    : [];
  return {
    ids: wellFormed,
    malformed,
    unknown,
    placeholders,
    requirements_present: store.present,
    ok: malformed.length === 0 && unknown.length === 0 && placeholders.length === 0,
  };
}

function assertIds(ids, root) {
  const result = validateIds(ids, root);
  if (result.malformed.length) {
    throw new NubosPilotError(
      'requirements-id-malformed',
      'not a requirement id: ' + result.malformed.join(', ') + ' (expected e.g. REQ-01, AUTH-02)',
      { malformed: result.malformed },
    );
  }
  if (result.placeholders.length) {
    throw new NubosPilotError(
      'requirements-id-placeholder',
      'refusing the placeholder id ' + result.placeholders.join(', ')
        + ' — replace it in REQUIREMENTS.md with a real requirement first',
      { placeholders: result.placeholders },
    );
  }
  if (result.unknown.length) {
    throw new NubosPilotError(
      'requirements-id-unknown',
      'no such requirement in REQUIREMENTS.md: ' + result.unknown.join(', '),
      { unknown: result.unknown, known: knownIds(root) },
    );
  }
  return result.ids;
}

function unassignedIds(root, roadmapDoc) {
  const assigned = new Set();
  const doc = roadmapDoc && typeof roadmapDoc === 'object' ? roadmapDoc : {};
  for (const collection of [doc.milestones, doc.phases]) {
    for (const unit of Array.isArray(collection) ? collection : []) {
      for (const id of Array.isArray(unit && unit.requirements) ? unit.requirements : []) {
        assigned.add(String(id).toUpperCase());
      }
    }
  }
  return readRequirements(root).entries
    .filter((e) => !e.placeholder && !assigned.has(e.id.toUpperCase()))
    .map((e) => e.id)
    .filter((id, i, list) => list.indexOf(id) === i);
}

module.exports = {
  REQ_ID_RE,
  PLACEHOLDER_IDS,
  MAX_BYTES,
  requirementsPath,
  isRequirementId,
  isPlaceholder,
  parseRequirements,
  readRequirements,
  knownIds,
  sections,
  normalizeIdList,
  validateIds,
  assertIds,
  unassignedIds,
};
