const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const {
  projectStateDir,
  NubosPilotError,
  withFileLock,
  atomicWriteFileSync,
} = require('./core.cjs');
const { renderMarkdown } = require('./roadmap-render.cjs');

function roadmapPath(cwd) {
  try {
    return path.join(projectStateDir(cwd), 'roadmap.yaml');
  } catch (err) {
    if (!err || err.code !== 'not-in-project') throw err;
    return path.join(path.resolve(cwd), '.planning', 'roadmap.yaml');
  }
}

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

function _normalizePlans(rawPlans, phaseStatus) {
  if (!Array.isArray(rawPlans)) return [];
  return rawPlans.map((p) => {
    if (p && typeof p === 'object' && 'id' in p) {
      return {
        id: String(p.id),
        title: typeof p.title === 'string' ? p.title : '',
        complete: typeof p.complete === 'boolean' ? p.complete : phaseStatus === 'done',
      };
    }

    return { id: String(p), title: '', complete: phaseStatus === 'done' };
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
      complete: s.status === 'done' || s.status === 'complete'
        || (s.status == null && (milestoneStatus === 'done' || milestoneStatus === 'complete')),
    };
  });
}

function parseRoadmap(cwd = process.cwd()) {
  const p = roadmapPath(cwd);
  const raw = _readRaw(p);

  let data;
  try {
    data = YAML.parse(raw);
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
        complete: ms.status === 'done' || ms.status === 'complete',
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
        complete: ph.status === 'done' || ph.status === 'complete',
      });
    }
  }

  return { phases, raw, doc: data, path: p };
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

function _mdPath(cwd) {
  try {
    return path.join(projectStateDir(cwd), 'ROADMAP.md');
  } catch (err) {
    if (!err || err.code !== 'not-in-project') throw err;
    return path.join(path.resolve(cwd), '.planning', 'ROADMAP.md');
  }
}

function _mutate(cwd, fn) {
  const yamlPath = roadmapPath(cwd);
  const mdPath = _mdPath(cwd);
  return withFileLock(yamlPath, () => {
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
    try { doc = YAML.parse(raw); } catch (err) {
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
    const result = fn(doc);
    atomicWriteFileSync(yamlPath, YAML.stringify(doc, { indent: 2 }));
    atomicWriteFileSync(mdPath, renderMarkdown(doc));
    return result;
  });
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
  addBacklogEntry,
  collapseMilestone,
};
