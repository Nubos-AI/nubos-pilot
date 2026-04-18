const fs = require('node:fs');
const path = require('node:path');
const { NubosPilotError, findProjectRoot } = require('./core.cjs');
const { addPhase, insertPhaseAfter, parseRoadmap } = require('./roadmap.cjs');

const MAX_AUDIT_BYTES = 1024 * 1024;

function _projectRoot(cwd) {
  try {
    return findProjectRoot(cwd);
  } catch (err) {
    if (err && err.code === 'not-in-project') return path.resolve(cwd);
    throw err;
  }
}

function _phasesDir(cwd) {
  const root = _projectRoot(cwd);

  const primary = path.join(root, '.nubos-pilot', 'phases');
  if (fs.existsSync(primary)) return primary;
  return path.join(root, '.planning', 'phases');
}

function _parseDirNumber(name) {
  const m = name.match(/^(\d+(?:\.\d+)?)-/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function scanVerifications(_milestoneId, cwd = process.cwd()) {
  const dir = _phasesDir(cwd);
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir).sort();
  const gaps = [];
  for (const entry of entries) {
    const sourcePhase = _parseDirNumber(entry);
    if (sourcePhase == null) continue;

    
    const pad = entry.split('-')[0];
    const candidates = [
      path.join(dir, entry, pad + '-VERIFICATION.md'),
      path.join(dir, entry, 'VERIFICATION.md'),
    ];
    const verPath = candidates.find((p) => fs.existsSync(p));
    if (!verPath) continue;
    const body = fs.readFileSync(verPath, 'utf-8');
    for (const m of body.matchAll(/^## Gap:\s*(.+)$/gm)) {
      gaps.push({
        source_phase: sourcePhase,
        gap_type: 'explicit',
        description: m[1].trim(),
        severity: 'major',
      });
    }
    for (const m of body.matchAll(/^- \[ \]\s*(.+)$/gm)) {
      gaps.push({
        source_phase: sourcePhase,
        gap_type: 'unchecked-box',
        description: m[1].trim(),
        severity: 'minor',
      });
    }
    for (const m of body.matchAll(/^(.*(?:❌|FAIL).*)$/gm)) {
      gaps.push({
        source_phase: sourcePhase,
        gap_type: 'fail-marker',
        description: m[1].trim(),
        severity: 'critical',
      });
    }
  }
  return gaps;
}

function parseAuditFile(filepath, cwd = process.cwd()) {
  const root = _projectRoot(cwd);
  const resolved = path.resolve(cwd, filepath);

  

  const inside = resolved === root || resolved.startsWith(root + path.sep);
  if (!inside) {
    throw new NubosPilotError(
      'gaps-invalid-audit-path',
      'audit file must be inside the project root',
      { path: filepath, resolved, projectRoot: root },
    );
  }
  let stat;
  try { stat = fs.statSync(resolved); } catch (err) {
    throw new NubosPilotError(
      'gaps-audit-not-found',
      'audit file not found',
      { path: resolved, cause: err && err.code },
    );
  }
  if (stat.size > MAX_AUDIT_BYTES) {
    throw new NubosPilotError(
      'gaps-audit-too-large',
      'audit file exceeds ' + MAX_AUDIT_BYTES + ' byte cap',
      { path: resolved, size: stat.size },
    );
  }
  const body = fs.readFileSync(resolved, 'utf-8');

  const sections = body.split(/^## Gap:\s*/gm).slice(1);
  const gaps = [];
  for (const section of sections) {
    const [titleLine, ...rest] = section.split('\n');
    const title = titleLine.trim();
    const m = rest.join('\n').match(/\*\*Source phase:\*\*\s*(\d+(?:\.\d+)?)/m);
    if (!m) {
      throw new NubosPilotError(
        'gaps-missing-source-phase',
        '## Gap: section missing "**Source phase:** N" line',
        { path: resolved, gapTitle: title },
      );
    }
    gaps.push({
      source_phase: Number(m[1]),
      gap_type: 'explicit',
      description: title,
      severity: 'major',
    });
  }
  return gaps;
}

function _currentMilestoneId(cwd) {
  try {
    const { readState } = require('./state.cjs');
    const st = readState(cwd);
    if (st && st.frontmatter && st.frontmatter.milestone) {
      return String(st.frontmatter.milestone);
    }
  } catch (_err) {

  }
  const YAML = require('yaml');
  const { projectStateDir } = require('./core.cjs');
  let stateDir;
  try { stateDir = projectStateDir(cwd); } catch (_err) {
    stateDir = path.join(path.resolve(cwd), '.nubos-pilot');
  }
  const yamlPath = path.join(stateDir, 'roadmap.yaml');
  const raw = fs.readFileSync(yamlPath, 'utf-8');
  const doc = YAML.parse(raw);
  if (!doc || !Array.isArray(doc.milestones) || doc.milestones.length === 0) {
    throw new NubosPilotError(
      'gaps-no-milestone',
      'roadmap.yaml has no milestones — cannot resolve current milestone',
      { path: yamlPath },
    );
  }
  return String(doc.milestones[0].id);
}

function gapsToPhases(gaps, opts, cwd = process.cwd()) {
  const options = opts || {};
  if (!gaps || gaps.length === 0) return [];
  const groups = new Map();
  for (const g of gaps) {
    if (!groups.has(g.source_phase)) groups.set(g.source_phase, []);
    groups.get(g.source_phase).push(g);
  }
  const created = [];
  for (const [source, list] of groups) {
    const phaseDef = {
      slug: 'gap-fix-phase-' + String(source).replace(/\./g, '-'),
      name: 'Gap fix for phase ' + source,
      goal: 'Close ' + list.length + ' gap(s) identified in Phase ' + source + ' VERIFICATION.md / audit',
      depends_on: [source], 
      requirements: [],
      success_criteria: [],
      status: 'pending',
      plans: [],
    };
    const result = options.insertAfter != null
      ? insertPhaseAfter(options.insertAfter, phaseDef, cwd)
      : addPhase(_currentMilestoneId(cwd), phaseDef, cwd);
    created.push(result);
  }
  return created;
}

module.exports = {
  scanVerifications,
  parseAuditFile,
  gapsToPhases,

  _currentMilestoneId,
};

void parseRoadmap;
