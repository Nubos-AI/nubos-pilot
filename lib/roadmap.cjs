const fs = require('node:fs');
const YAML = require('yaml');
const { safeYamlParse } = require('./yaml.cjs');
const {
  NubosPilotError,
  withFileLock,
  atomicWriteFileSync,
} = require('./core.cjs');
const {
  renderMarkdown,
  _yamlPath: roadmapPath,
  _mdPath,
} = require('./roadmap-render.cjs');
const {
  validateSchemaVersion: _validateSchemaVersion,
  validateConditionalVersion: _validateConditionalVersion,
  requiredSchemaVersion: _requiredSchemaVersion,
  CURRENT_SCHEMA_VERSION,
  CONDITIONAL_SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  MILESTONE_STATUSES,
  MILESTONE_DONE_STATUSES,
  SLICE_STATUSES,
  isDoneMilestoneStatus,
} = require('./roadmap-schema.cjs');

function _readRaw(p) {
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch (err) {
    throw new NubosPilotError(
      'roadmap-parse-error',
      'roadmap.yaml not readable',
      { path: p, cause: err && err.code },
    );
  }
}

function _normalizeDependsOn(v) {
  if (v == null) return null;
  if (Array.isArray(v)) {
    if (v.length === 0) return null;
    return v.map(String).join(', ');
  }
  return String(v);
}

const _DONE_STATUSES = new Set(MILESTONE_DONE_STATUSES);
const _VALID_MILESTONE_STATUSES = new Set(MILESTONE_STATUSES);

function _isDoneStatus(status) {
  return isDoneMilestoneStatus(status);
}

function _normalizePlans(rawPlans, phaseStatus) {
  if (!Array.isArray(rawPlans)) return [];
  return rawPlans.map((p) => {
    if (p && typeof p === 'object' && 'id' in p) {
      return {
        id: String(p.id),
        title: typeof p.title === 'string' ? p.title : '',
        complete: typeof p.complete === 'boolean' ? p.complete : _isDoneStatus(phaseStatus),
      };
    }

    return { id: String(p), title: '', complete: _isDoneStatus(phaseStatus) };
  });
}

function _normalizeSlices(rawSlices, milestoneStatus) {
  if (!Array.isArray(rawSlices)) return [];
  return rawSlices.map((s) => {
    const id = typeof s.id === 'string' ? s.id : '';
    return {
      id,
      name: typeof s.name === 'string' ? s.name : '',
      goal: typeof s.goal === 'string' ? s.goal : '',
      status: typeof s.status === 'string' ? s.status : 'pending',
      tasks: Array.isArray(s.tasks) ? s.tasks.slice() : [],
      complete: _isDoneStatus(s.status)
        || (s.status == null && _isDoneStatus(milestoneStatus)),
    };
  });
}

const _parseRoadmapCache = new Map();
function _resetParseRoadmapCacheForTests() { _parseRoadmapCache.clear(); }

function parseRoadmap(cwd = process.cwd()) {
  const p = roadmapPath(cwd);
  const cacheEntry = _parseRoadmapCache.get(p);
  if (cacheEntry) {
    try {
      const st = fs.statSync(p);
      if (st.mtimeMs === cacheEntry.mtimeMs && st.size === cacheEntry.size) {
        return cacheEntry.value;
      }
    } catch { /* fall through */ }
  }
  const raw = _readRaw(p);

  let data;
  try {
    data = safeYamlParse(raw, { kind: 'roadmap' });
  } catch (err) {
    throw new NubosPilotError(
      'roadmap-parse-error',
      'roadmap.yaml invalid YAML',
      { path: p, cause: err && err.message },
    );
  }

  if (!data || typeof data !== 'object' || !Array.isArray(data.milestones)) {
    throw new NubosPilotError(
      'roadmap-parse-error',
      'roadmap.yaml missing milestones array',
      { path: p },
    );
  }

  _validateSchemaVersion(data, p);
  _validateConditionalVersion(data, p);

  const phases = [];
  for (const ms of data.milestones) {
    if (!ms) continue;
    if (Array.isArray(ms.slices)) {
      const mNumber = ms.number != null ? String(ms.number) : (ms.id || '');
      phases.push({
        number: mNumber,
        id: ms.id || '',
        name: ms.name || '',
        goal: typeof ms.goal === 'string' ? ms.goal : '',
        depends_on: _normalizeDependsOn(ms.depends_on),
        requirements: Array.isArray(ms.requirements) ? ms.requirements.slice() : [],
        success_criteria: Array.isArray(ms.success_criteria) ? ms.success_criteria.slice() : [],
        slices: _normalizeSlices(ms.slices, ms.status),
        plans: _normalizePlans(ms.plans, ms.status),
        status: typeof ms.status === 'string' ? ms.status : 'pending',
        complete: _isDoneStatus(ms.status),
      });
      continue;
    }
    if (!Array.isArray(ms.phases)) continue;
    for (const ph of ms.phases) {
      if (!ph || ph.number == null) continue;
      phases.push({
        number: String(ph.number),
        name: ph.name || '',
        slug: ph.slug || '',
        goal: ph.goal || '',
        depends_on: _normalizeDependsOn(ph.depends_on),
        requirements: Array.isArray(ph.requirements) ? ph.requirements.slice() : [],
        success_criteria: Array.isArray(ph.success_criteria) ? ph.success_criteria.slice() : [],
        plans: _normalizePlans(ph.plans, ph.status),
        slices: _normalizeSlices(ph.slices, ph.status),
        status: typeof ph.status === 'string' ? ph.status : 'pending',
        complete: _isDoneStatus(ph.status),
      });
    }
  }

  const result = { phases, raw, doc: data, path: p };
  try {
    const st = fs.statSync(p);
    _parseRoadmapCache.set(p, { value: result, mtimeMs: st.mtimeMs, size: st.size });
  } catch { /* unable to stat — skip caching */ }
  return result;
}

function getPhase(n, cwd = process.cwd()) {
  const want = String(n);
  const { phases } = parseRoadmap(cwd);
  const hit = phases.find((p) => p.number === want);
  if (!hit) {
    throw new NubosPilotError(
      'phase-not-found',
      `Phase ${want} not found in roadmap.yaml`,
      { requested: want },
    );
  }
  return hit;
}

function listPhases(cwd = process.cwd()) {
  return parseRoadmap(cwd).phases;
}

function phaseComplete(n, cwd = process.cwd()) {
  return getPhase(n, cwd).complete;
}

const _MAX_ROADMAP_BYTES = 1024 * 1024;
const _SLUG_RE = /^[a-z0-9-]+$/;

function _mutate(cwd, fn, opts) {
  const yamlPath = roadmapPath(cwd);
  const mdPath = _mdPath(cwd);
  const lockOpts = opts && opts.lock ? opts.lock : undefined;
  return withFileLock(yamlPath, () => withFileLock(mdPath, () => {
    let stat;
    try { stat = fs.statSync(yamlPath); } catch (err) {
      throw new NubosPilotError(
        'roadmap-write-read-error',
        'roadmap.yaml not readable',
        { path: yamlPath, cause: err && err.code },
      );
    }
    if (stat.size > _MAX_ROADMAP_BYTES) {
      throw new NubosPilotError(
        'roadmap-too-large',
        'roadmap.yaml exceeds 1 MB cap',
        { path: yamlPath, size: stat.size },
      );
    }
    const raw = fs.readFileSync(yamlPath, 'utf-8');
    let doc;
    try { doc = safeYamlParse(raw, { kind: 'roadmap' }); } catch (err) {
      throw new NubosPilotError(
        'roadmap-write-parse-error',
        'roadmap.yaml invalid YAML',
        { path: yamlPath, cause: err && err.message },
      );
    }
    if (!doc || !Array.isArray(doc.milestones)) {
      throw new NubosPilotError(
        'roadmap-write-parse-error',
        'roadmap.yaml missing milestones array',
        { path: yamlPath },
      );
    }
    _validateSchemaVersion(doc, yamlPath);
    _validateConditionalVersion(doc, yamlPath);
    const result = fn(doc);
    if (opts && typeof opts.skipWrite === 'function' && opts.skipWrite(result)) return result;
    // Derived from the document, not a constant. Stamping CURRENT unconditionally
    // downgraded a v3 roadmap to 2 on every unrelated mutation — stripping the
    // marker that stops an older install from ignoring `when` and running a gated
    // slice. It also has to be able to drop back to 2 when the last condition is
    // removed, so this is deliberately not a max().
    doc.schema_version = _requiredSchemaVersion(doc);
    atomicWriteFileSync(yamlPath, YAML.stringify(doc, { indent: 2 }));
    atomicWriteFileSync(mdPath, renderMarkdown(doc));
    return result;
  }, lockOpts), lockOpts);
}

function mutateMilestoneNode(n, fn, cwd = process.cwd(), opts) {
  const want = String(n);
  return _mutate(cwd, (doc) => {
    const target = _findPhaseTarget(doc, want);
    if (!target) {
      throw new NubosPilotError(
        'phase-not-found',
        'Phase ' + want + ' not found in roadmap.yaml',
        { requested: want },
      );
    }
    return fn(target);
  }, opts);
}

function _validateSlug(slug) {
  if (slug == null || slug === '' || typeof slug !== 'string') {
    throw new NubosPilotError(
      'roadmap-invalid-slug',
      'phase slug required',
      { slug: slug == null ? '' : slug },
    );
  }
  if (!_SLUG_RE.test(slug)) {
    throw new NubosPilotError(
      'roadmap-invalid-slug',
      'phase slug must match /^[a-z0-9-]+$/',
      { slug },
    );
  }
}

function _normalizePhaseDef(phaseDef) {
  const def = phaseDef || {};
  _validateSlug(def.slug);
  return {
    slug: def.slug,
    name: def.name || '',
    goal: typeof def.goal === 'string' ? def.goal : '',
    depends_on: Array.isArray(def.depends_on) ? def.depends_on.slice() : [],
    requirements: Array.isArray(def.requirements) ? def.requirements.slice() : [],
    success_criteria: Array.isArray(def.success_criteria) ? def.success_criteria.slice() : [],
    status: typeof def.status === 'string' ? def.status : 'pending',
    plans: Array.isArray(def.plans) ? def.plans.slice() : [],
  };
}

function addMilestone(milestone, cwd = process.cwd()) {
  const m = milestone || {};
  if (!m.id || typeof m.id !== 'string') {
    throw new NubosPilotError(
      'roadmap-invalid-milestone',
      'milestone.id required',
      { id: m.id == null ? '' : m.id },
    );
  }
  return _mutate(cwd, (doc) => {
    if (doc.milestones.some((x) => x && x.id === m.id)) {
      throw new NubosPilotError(
        'roadmap-duplicate-milestone',
        'milestone id already exists',
        { id: m.id },
      );
    }
    const entry = {
      id: m.id,
      name: m.name || '',
      phases: Array.isArray(m.phases) ? m.phases.slice() : [],
    };
    doc.milestones.push(entry);
    return { milestoneId: entry.id, name: entry.name };
  });
}

function addPhase(milestoneId, phaseDef, cwd = process.cwd()) {
  const def = _normalizePhaseDef(phaseDef);
  return _mutate(cwd, (doc) => {
    const ms = doc.milestones.find((x) => x && x.id === milestoneId);
    if (!ms) {
      throw new NubosPilotError(
        'roadmap-milestone-not-found',
        'milestone not found',
        { id: milestoneId },
      );
    }
    if (!Array.isArray(ms.phases)) ms.phases = [];
    if (ms.phases.some((p) => p && p.slug === def.slug)) {
      throw new NubosPilotError(
        'roadmap-duplicate-slug',
        'phase slug already used in this milestone',
        { slug: def.slug, milestone: milestoneId },
      );
    }

    let maxInt = 0;
    for (const p of ms.phases) {
      if (!p || p.number == null) continue;
      const n = Number(p.number);
      if (Number.isInteger(n) && n > maxInt) maxInt = n;
    }
    const next = maxInt + 1;
    const phase = Object.assign({ number: next }, def);
    ms.phases.push(phase);
    return { milestoneId, number: next, slug: def.slug };
  });
}

function insertPhaseAfter(baseNumber, phaseDef, cwd = process.cwd()) {
  const base = Number(baseNumber);
  if (!Number.isInteger(base)) {
    throw new NubosPilotError(
      'roadmap-base-phase-not-found',
      'base phase number must be integer',
      { number: baseNumber },
    );
  }
  const def = _normalizePhaseDef(phaseDef);
  return _mutate(cwd, (doc) => {

    let target = null;
    for (const ms of doc.milestones) {
      if (!ms || !Array.isArray(ms.phases)) continue;
      if (ms.phases.some((p) => p && Number(p.number) === base)) {
        target = ms;
        break;
      }
    }
    if (!target) {
      throw new NubosPilotError(
        'roadmap-base-phase-not-found',
        'base phase not found in any milestone',
        { number: base },
      );
    }
    if (target.phases.some((p) => p && p.slug === def.slug)) {
      throw new NubosPilotError(
        'roadmap-duplicate-slug',
        'phase slug already used in this milestone',
        { slug: def.slug, milestone: target.id },
      );
    }

    let maxSuffix = 0;
    for (const p of target.phases) {
      if (!p || p.number == null) continue;
      const s = String(p.number);
      if (s.startsWith(base + '.')) {
        const suf = Number(s.slice(String(base).length + 1));
        if (Number.isInteger(suf) && suf > maxSuffix) maxSuffix = suf;
      }
    }

    const newNumber = base + '.' + (maxSuffix + 1);
    const phase = Object.assign({ number: newNumber }, def);

    const baseIdx = target.phases.findIndex((p) => p && Number(p.number) === base);
    target.phases.splice(baseIdx + 1, 0, phase);
    return { milestoneId: target.id, number: newNumber, slug: def.slug };
  });
}

function addBacklogEntry(description, opts) {
  const cwd = (opts && opts.cwd) || process.cwd();
  if (typeof description !== 'string' || !description.trim()) {
    throw new NubosPilotError(
      'roadmap-invalid-description',
      'addBacklogEntry: description must be non-empty string',
      { description },
    );
  }
  if (description.length > 500) {
    throw new NubosPilotError(
      'roadmap-description-too-long',
      'addBacklogEntry: description must be <= 500 chars',
      { length: description.length },
    );
  }
  if (/\n\n---\n/.test(description)) {
    throw new NubosPilotError(
      'roadmap-invalid-description',
      'addBacklogEntry: description must not contain YAML separator pattern',
      { description },
    );
  }
  return _mutate(cwd, (doc) => {
    let m = doc.milestones.find((x) => x && x.id === 'backlog');
    if (!m) {
      m = { id: 'backlog', name: 'Backlog', phases: [] };
      doc.milestones.push(m);
    }
    if (!Array.isArray(m.phases)) m.phases = [];
    const prefix = '999.';
    let max = 0;
    for (const ph of m.phases) {
      if (!ph || ph.number == null) continue;
      const n = String(ph.number);
      if (n.startsWith(prefix)) {
        const suf = Number(n.slice(prefix.length));
        if (Number.isInteger(suf) && suf > max) max = suf;
      }
    }
    const next = '999.' + (max + 1);
    const { slugify } = require('./layout.cjs');
    const slug = slugify(description);
    m.phases.push({
      number: next,
      name: description,
      slug,
      status: 'backlog',
      requirements: [],
      plans: [],
    });
    return { backlog_number: next, backlog_slug: slug };
  });
}

function _normalizeScList(scs) {
  if (!Array.isArray(scs)) {
    throw new NubosPilotError(
      'roadmap-invalid-success-criteria',
      'success_criteria must be an array',
      { received: typeof scs },
    );
  }
  const out = [];
  for (let i = 0; i < scs.length; i++) {
    const sc = scs[i];
    if (typeof sc === 'string') {
      const s = sc.trim();
      if (!s) {
        throw new NubosPilotError('roadmap-invalid-success-criteria',
          'success_criteria[' + i + '] must be non-empty', { index: i });
      }
      out.push(s);
      continue;
    }
    if (sc && typeof sc === 'object') {
      const id = typeof sc.id === 'string' ? sc.id.trim() : '';
      const text = typeof sc.text === 'string' ? sc.text.trim() : '';
      if (!id || !/^SC-\d+$/.test(id)) {
        throw new NubosPilotError('roadmap-invalid-success-criteria',
          'success_criteria[' + i + '].id must match /^SC-\\d+$/', { index: i, id: sc.id });
      }
      if (!text) {
        throw new NubosPilotError('roadmap-invalid-success-criteria',
          'success_criteria[' + i + '].text must be non-empty', { index: i });
      }
      out.push({ id, text });
      continue;
    }
    throw new NubosPilotError('roadmap-invalid-success-criteria',
      'success_criteria[' + i + '] must be string or {id,text}', { index: i });
  }
  return out;
}

function _normalizeReqList(reqs) {
  if (!Array.isArray(reqs)) {
    throw new NubosPilotError('roadmap-invalid-requirements',
      'requirements must be an array', { received: typeof reqs });
  }
  return reqs.map((r, i) => {
    if (typeof r !== 'string' || !r.trim()) {
      throw new NubosPilotError('roadmap-invalid-requirements',
        'requirements[' + i + '] must be non-empty string', { index: i });
    }
    return r.trim();
  });
}

function _findPhaseTarget(doc, want) {
  for (const ms of doc.milestones) {
    if (!ms) continue;
    if (Array.isArray(ms.slices) && String(ms.number) === want) return ms;
    if (Array.isArray(ms.phases)) {
      const hit = ms.phases.find((ph) => ph && String(ph.number) === want);
      if (hit) return hit;
    }
  }
  return null;
}

function updatePhase(n, patch, cwd = process.cwd()) {
  const want = String(n);
  const p = patch || {};
  const allowed = ['name', 'goal', 'requirements', 'success_criteria'];
  const unknown = Object.keys(p).filter((k) => !allowed.includes(k));
  if (unknown.length) {
    throw new NubosPilotError('roadmap-invalid-patch',
      'updatePhase: unknown keys: ' + unknown.join(', '),
      { unknown, allowed });
  }
  const prepared = {};
  if ('name' in p) {
    if (typeof p.name !== 'string' || !p.name.trim()) {
      throw new NubosPilotError('roadmap-invalid-patch',
        'name must be non-empty string', {});
    }
    prepared.name = p.name.trim();
  }
  if ('goal' in p) {
    if (typeof p.goal !== 'string') {
      throw new NubosPilotError('roadmap-invalid-patch',
        'goal must be string', {});
    }
    prepared.goal = p.goal;
  }
  if ('requirements' in p) prepared.requirements = _normalizeReqList(p.requirements);
  if ('success_criteria' in p) prepared.success_criteria = _normalizeScList(p.success_criteria);

  return _mutate(cwd, (doc) => {
    const target = _findPhaseTarget(doc, want);
    if (!target) {
      throw new NubosPilotError('phase-not-found',
        'Phase ' + want + ' not found in roadmap.yaml',
        { requested: want });
    }
    const updated = [];
    for (const k of Object.keys(prepared)) {
      target[k] = prepared[k];
      updated.push(k);
    }
    return { number: want, name: target.name || '', fields_updated: updated };
  });
}

function setMilestoneStatus(n, status, cwd = process.cwd()) {
  if (typeof status !== 'string' || !_VALID_MILESTONE_STATUSES.has(status)) {
    throw new NubosPilotError(
      'roadmap-invalid-status',
      'setMilestoneStatus: invalid status: ' + status,
      { status, allowed: [..._VALID_MILESTONE_STATUSES] },
    );
  }
  const want = String(n);
  return _mutate(cwd, (doc) => {
    const target = _findPhaseTarget(doc, want);
    if (!target) {
      throw new NubosPilotError(
        'phase-not-found',
        'Phase ' + want + ' not found in roadmap.yaml',
        { requested: want },
      );
    }
    const previous = typeof target.status === 'string' ? target.status : null;
    target.status = status;
    return { number: want, status, previous, changed: previous !== status };
  });
}

function setSliceStatus(n, sliceId, status, cwd = process.cwd()) {
  if (typeof status !== 'string' || !SLICE_STATUSES.includes(status)) {
    throw new NubosPilotError(
      'roadmap-invalid-slice-status',
      'setSliceStatus: invalid status: ' + status,
      { status, allowed: SLICE_STATUSES.slice() },
    );
  }
  const want = String(n);
  const wantSlice = String(sliceId);
  return _mutate(cwd, (doc) => {
    const target = _findPhaseTarget(doc, want);
    if (!target) {
      throw new NubosPilotError(
        'phase-not-found',
        'Phase ' + want + ' not found in roadmap.yaml',
        { requested: want },
      );
    }
    const slices = Array.isArray(target.slices) ? target.slices : null;
    const hit = slices && slices.find((s) => s && String(s.id) === wantSlice);
    if (!hit) {
      throw new NubosPilotError(
        'roadmap-slice-not-found',
        'Slice ' + wantSlice + ' not found in milestone ' + want,
        { milestone: want, slice: wantSlice },
      );
    }
    const previous = typeof hit.status === 'string' ? hit.status : null;
    hit.status = status;
    return {
      number: want, slice: wantSlice, status, previous, changed: previous !== status,
    };
  });
}

function collapseMilestone(milestoneId, opts) {
  const cwd = (opts && opts.cwd) || process.cwd();
  if (typeof milestoneId !== 'string' || !/^[vV0-9._-]+$/.test(milestoneId)) {
    throw new NubosPilotError(
      'roadmap-invalid-milestone-id',
      'collapseMilestone: id must match /^[vV0-9._-]+$/: ' + milestoneId,
      { milestoneId },
    );
  }
  return _mutate(cwd, (doc) => {
    const m = doc.milestones.find((x) => x && x.id === milestoneId);
    if (!m) {
      throw new NubosPilotError(
        'roadmap-milestone-not-found',
        'collapseMilestone: milestone "' + milestoneId + '" not found',
        { milestoneId },
      );
    }
    const alreadyCollapsed = m.collapsed === true;
    m.collapsed = true;
    if (!m.collapsed_at) m.collapsed_at = new Date().toISOString().slice(0, 10);
    return { milestoneId, already_collapsed: alreadyCollapsed };
  });
}

module.exports = {
  parseRoadmap,
  getPhase,
  listPhases,
  phaseComplete,
  addMilestone,
  addPhase,
  insertPhaseAfter,
  updatePhase,
  addBacklogEntry,
  collapseMilestone,
  setMilestoneStatus,
  setSliceStatus,
  mutateMilestoneNode,
  _findPhaseTarget,
  _VALID_MILESTONE_STATUSES,
  _DONE_STATUSES,
  _validateSchemaVersion,
  _validateConditionalVersion,
  _requiredSchemaVersion,
  CURRENT_SCHEMA_VERSION,
  CONDITIONAL_SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  _resetParseRoadmapCacheForTests,
};
