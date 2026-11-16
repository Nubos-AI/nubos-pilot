const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { safeYamlParse } = require('./yaml.cjs');
const {
  withFileLock,
  atomicWriteFileSync,
  projectStateDir,
  NubosPilotError,
} = require('./core.cjs');

const GENERATED_HEADER = '<!-- Generated from roadmap.yaml — do not edit by hand -->';

function _yamlPath(cwd) {
  return path.join(projectStateDir(cwd), 'roadmap.yaml');
}

function _mdPath(cwd) {
  return path.join(projectStateDir(cwd), 'ROADMAP.md');
}

const { validateSchemaVersion } = require('./roadmap-schema.cjs');

function _readYaml(p) {
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf-8');
  } catch (err) {
    throw new NubosPilotError(
      'roadmap-render-read-error',
      'roadmap.yaml not readable',
      { path: p, cause: err && err.code },
    );
  }
  let data;
  try {
    data = safeYamlParse(raw, { kind: 'roadmap-render' });
  } catch (err) {
    throw new NubosPilotError(
      'roadmap-render-read-error',
      'roadmap.yaml invalid YAML',
      { path: p, cause: err && err.message },
    );
  }
  validateSchemaVersion(data, p);
  return data;
}

function _statusLabel(status) {
  switch (status) {
    case 'done':
    case 'complete':
      return 'Complete';
    case 'verified':
      return 'Verified';
    case 'failed':
      return 'Failed';
    case 'deferred':
      return 'Deferred';
    case 'in-progress':
      return 'In Progress';
    case 'backlog':
      return 'Backlog';
    case 'pending':
      return 'Not started';
    default:
      return status ? String(status) : 'Not started';
  }
}

function _plansComplete(plans) {
  if (!Array.isArray(plans) || plans.length === 0) return '0/0';
  const total = plans.length;
  const done = plans.filter((p) => p && p.complete === true).length;
  return `${done}/${total}`;
}

function _dependsOnStr(v) {
  if (v == null) return '-';
  if (Array.isArray(v)) return v.length ? v.map(String).join(', ') : '-';
  return String(v);
}

function _renderPhaseDetail(lines, ph) {
  lines.push(`### Phase ${ph.number}: ${ph.name || ''}`);
  lines.push(`**Goal**: ${ph.goal || ''}`);
  lines.push(`**Depends on**: ${_dependsOnStr(ph.depends_on)}`);
  const reqs = Array.isArray(ph.requirements) ? ph.requirements : [];
  lines.push(`**Requirements**: ${reqs.length ? reqs.join(', ') : '-'}`);
  const sc = Array.isArray(ph.success_criteria) ? ph.success_criteria : [];
  if (sc.length) {
    lines.push('**Success Criteria**:');
    for (let i = 0; i < sc.length; i++) {
      lines.push(`  ${i + 1}. ${sc[i]}`);
    }
  } else {
    lines.push('**Success Criteria**: -');
  }
  const plans = Array.isArray(ph.plans) ? ph.plans : [];
  if (plans.length) {
    lines.push('**Plans**:');
    for (const pl of plans) {
      const box = pl && pl.complete ? 'x' : ' ';
      const id = pl && pl.id ? pl.id : '';
      const title = pl && pl.title ? pl.title : '';
      lines.push(`  - [${box}] ${id}${title ? ' — ' + title : ''}`);
    }
  } else {
    lines.push('**Plans**: -');
  }
  lines.push('');
}

function _renderBacklogSection(lines, milestone) {
  lines.push('## Backlog');
  lines.push('');
  const phases = Array.isArray(milestone.phases) ? milestone.phases : [];
  if (phases.length === 0) {
    lines.push('*No backlog items.*');
    lines.push('');
    return;
  }
  for (const ph of phases) {
    if (!ph || ph.number == null) continue;
    lines.push(`- [ ] Phase ${ph.number}: ${ph.name || ''}`);
  }
  lines.push('');
}

function _renderMilestoneDetail(lines, ms) {
  lines.push(`### ${ms.id || ''}: ${ms.name || ''}`);
  lines.push(`**Status**: ${_statusLabel(ms.status)}`);
  lines.push(`**Goal**: ${ms.goal || ''}`);
  const reqs = Array.isArray(ms.requirements) ? ms.requirements : [];
  lines.push(`**Requirements**: ${reqs.length ? reqs.join(', ') : '-'}`);
  const sc = Array.isArray(ms.success_criteria) ? ms.success_criteria : [];
  if (sc.length) {
    lines.push('**Success Criteria**:');
    for (let i = 0; i < sc.length; i++) {
      const item = sc[i];
      const text = typeof item === 'string' ? item : (item && item.text) || JSON.stringify(item);
      lines.push(`  ${i + 1}. ${text}`);
    }
  } else {
    lines.push('**Success Criteria**: -');
  }
  const slices = Array.isArray(ms.slices) ? ms.slices : [];
  if (slices.length) {
    lines.push('**Slices**:');
    for (const sl of slices) {
      const status = _statusLabel(sl.status);
      lines.push(`  - ${sl.id || '?'} (${status}): ${sl.name || ''}`);
    }
  } else {
    lines.push('**Slices**: -');
  }
  lines.push('');
}

function renderMarkdown(data) {
  const lines = [];
  lines.push(GENERATED_HEADER);
  lines.push('');
  lines.push('# Roadmap');
  lines.push('');
  lines.push('## Overview');
  lines.push('');

  if (!data || !Array.isArray(data.milestones)) {
    lines.push('*No milestones defined.*');
    lines.push('');
    return lines.join('\n') + '\n';
  }

  const tablePhases = [];
  for (const ms of data.milestones) {
    if (!ms || !Array.isArray(ms.phases)) continue;
    if (ms.id === 'backlog') continue;
    for (const ph of ms.phases) {
      if (!ph || ph.number == null) continue;
      tablePhases.push(ph);
    }
  }

  const regularMilestones = data.milestones.filter((m) => m && m.id !== 'backlog');
  const sliceMilestones = regularMilestones.filter((m) => m && Array.isArray(m.slices));
  lines.push(`Milestones: ${regularMilestones.length}. Phases: ${tablePhases.length}.`);
  lines.push('');

  if (sliceMilestones.length > 0) {
    lines.push('## Milestones');
    lines.push('');
    lines.push('| Milestone | Status | Slices |');
    lines.push('|-----------|--------|--------|');
    for (const ms of sliceMilestones) {
      const id = ms.id || '';
      const name = ms.name || '';
      const st = _statusLabel(ms.status);
      const sliceCount = Array.isArray(ms.slices) ? ms.slices.length : 0;
      lines.push(`| ${id} ${name} | ${st} | ${sliceCount} |`);
    }
    lines.push('');
  }

  if (tablePhases.length > 0) {
    lines.push('## Progress');
    lines.push('');
    lines.push('| Phase | Plans Complete | Status |');
    lines.push('|-------|----------------|--------|');
    for (const ph of tablePhases) {
      const num = String(ph.number);
      const name = ph.name || '';
      const pc = _plansComplete(ph.plans);
      const st = _statusLabel(ph.status);
      lines.push(`| ${num}. ${name} | ${pc} | ${st} |`);
    }
    lines.push('');
  }

  if (sliceMilestones.length > 0) {
    lines.push('## Milestone Details');
    lines.push('');
    for (const ms of sliceMilestones) {
      if (ms.collapsed === true) {
        const at = ms.collapsed_at || '';
        const summary = `${ms.id}${at ? ' — completed on ' + at : ''}`;
        lines.push(`<details><summary>${summary}</summary>`);
        lines.push('');
        _renderMilestoneDetail(lines, ms);
        lines.push('</details>');
        lines.push('');
      } else {
        _renderMilestoneDetail(lines, ms);
      }
    }
  }

  if (tablePhases.length > 0) {
    lines.push('## Phase Details');
    lines.push('');
    for (const ms of data.milestones) {
      if (!ms || !Array.isArray(ms.phases)) continue;
      if (ms.id === 'backlog') continue;
      const phases = ms.phases.filter((ph) => ph && ph.number != null);
      if (phases.length === 0) continue;
      if (ms.collapsed === true) {
        const at = ms.collapsed_at || '';
        const summary = `${ms.id}${at ? ' — completed on ' + at : ''}`;
        lines.push(`<details><summary>${summary}</summary>`);
        lines.push('');
        for (const ph of phases) _renderPhaseDetail(lines, ph);
        lines.push('</details>');
        lines.push('');
      } else {
        for (const ph of phases) _renderPhaseDetail(lines, ph);
      }
    }
  }

  const backlog = data.milestones.find((m) => m && m.id === 'backlog');
  if (backlog) {
    _renderBacklogSection(lines, backlog);
  }

  return lines.join('\n') + '\n';
}

function renderRoadmap(cwd = process.cwd()) {
  const ymlPath = _yamlPath(cwd);
  const mdPath = _mdPath(cwd);
  return withFileLock(ymlPath, () => withFileLock(mdPath, () => {
    const data = _readYaml(ymlPath);
    const content = renderMarkdown(data);
    atomicWriteFileSync(mdPath, content);
  }));
}

module.exports = { renderRoadmap, renderMarkdown, GENERATED_HEADER, _yamlPath, _mdPath };
