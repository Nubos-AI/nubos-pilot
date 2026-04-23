'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { extractFrontmatter } = require('./frontmatter.cjs');
const { atomicWriteFileSync, NubosPilotError, projectStateDir } = require('./core.cjs');
const { milestoneDir, parseMId } = require('./layout.cjs');

const STATUS_ENUM = new Set(['open', 'read', 'acted', 'archived']);
const AGENT_RE = /^[a-zA-Z0-9_\-\*]+$/;

function _slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'note';
}

let _lastTs = 0;
function _isoZ() {
  const now = Date.now();
  const adjusted = now > _lastTs ? now : _lastTs + 1;
  _lastTs = adjusted;
  return new Date(adjusted).toISOString();
}

function _genId() {
  return crypto.randomBytes(4).toString('hex');
}

function _handoffsRoot({ milestone, cwd }) {
  const base = projectStateDir(cwd || process.cwd());
  if (milestone) {
    const mNum = typeof milestone === 'string' ? parseMId(milestone) : milestone;
    return path.join(milestoneDir(mNum, cwd), 'handoffs');
  }
  return path.join(base, 'handoffs');
}

function _validateAgentName(field, value) {
  if (typeof value !== 'string' || value.length === 0 || !AGENT_RE.test(value)) {
    throw new NubosPilotError(
      'handoff-invalid-agent',
      `${field} must be a non-empty slug (alphanumerics, _, -, or *); got: ${JSON.stringify(value)}`,
      { field, value },
    );
  }
}

function _buildFilename({ createdAt, from, to, topic, id }) {
  const stamp = createdAt.replace(/[:.]/g, '-');
  const slug = _slugify(topic);
  return stamp + '__' + from + '-to-' + to + '__' + slug + '__' + id + '.md';
}

function _serialize({ id, from, to, topic, createdAt, milestone, slice, task, status, body }) {
  const fmLines = [
    '---',
    'schema_version: 1',
    'id: ' + id,
    'from_agent: ' + from,
    'to_agent: ' + to,
    'topic: ' + JSON.stringify(topic),
    'created_at: ' + createdAt,
    'milestone: ' + (milestone || 'null'),
    'slice: ' + (slice || 'null'),
    'task: ' + (task || 'null'),
    'status: ' + status,
    '---',
  ];
  const trimmed = (body || '').replace(/\s+$/, '');
  return fmLines.join('\n') + '\n\n' + (trimmed.length ? trimmed + '\n' : '');
}

function writeHandoff(input, cwd) {
  const o = input || {};
  _validateAgentName('from', o.from);
  _validateAgentName('to', o.to);
  if (typeof o.topic !== 'string' || o.topic.length === 0) {
    throw new NubosPilotError('handoff-missing-topic', 'topic required (non-empty string)', {});
  }
  const status = o.status || 'open';
  if (!STATUS_ENUM.has(status)) {
    throw new NubosPilotError(
      'handoff-invalid-status',
      `status '${status}' not in [${[...STATUS_ENUM].join(', ')}]`,
      { status },
    );
  }

  const id = _genId();
  const createdAt = _isoZ();
  const workingDir = cwd || process.cwd();
  const dir = _handoffsRoot({ milestone: o.milestone || null, cwd: workingDir });
  fs.mkdirSync(dir, { recursive: true });

  const filename = _buildFilename({
    createdAt,
    from: o.from,
    to: o.to,
    topic: o.topic,
    id,
  });
  const target = path.join(dir, filename);

  const content = _serialize({
    id,
    from: o.from,
    to: o.to,
    topic: o.topic,
    createdAt,
    milestone: o.milestone || null,
    slice: o.slice || null,
    task: o.task || null,
    status,
    body: o.body || '',
  });
  atomicWriteFileSync(target, content);
  return { id, path: target, filename, created_at: createdAt };
}

function _readHandoffFile(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  let fm;
  try { ({ frontmatter: fm } = extractFrontmatter(raw)); }
  catch { return null; }
  if (!fm || typeof fm.id !== 'string') return null;
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  return { frontmatter: fm, body, path: filePath };
}

function _listDirs({ milestone, cwd, global }) {
  const dirs = [];
  const working = cwd || process.cwd();
  if (!global) {
    if (milestone) {
      dirs.push(_handoffsRoot({ milestone, cwd: working }));
    } else {
      const msRoot = path.join(projectStateDir(working), 'milestones');
      try {
        const entries = fs.readdirSync(msRoot, { withFileTypes: true });
        for (const e of entries) {
          if (!e.isDirectory()) continue;
          const hDir = path.join(msRoot, e.name, 'handoffs');
          dirs.push(hDir);
        }
      } catch {}
    }
  }
  dirs.push(_handoffsRoot({ milestone: null, cwd: working }));
  return dirs;
}

function listHandoffs(opts, cwd) {
  const o = opts || {};
  const forAgent = o.for || null;
  const status = o.status || null;
  const milestone = o.milestone || null;
  const onlyGlobal = Boolean(o.global);

  if (forAgent) _validateAgentName('for', forAgent);
  if (status && !STATUS_ENUM.has(status)) {
    throw new NubosPilotError(
      'handoff-invalid-status',
      `status '${status}' not in [${[...STATUS_ENUM].join(', ')}]`,
      { status },
    );
  }

  const out = [];
  const seen = new Set();
  const dirs = _listDirs({ milestone, cwd, global: onlyGlobal });
  for (const dir of dirs) {
    let entries;
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (!name.endsWith('.md')) continue;
      const filePath = path.join(dir, name);
      if (seen.has(filePath)) continue;
      seen.add(filePath);
      const rec = _readHandoffFile(filePath);
      if (!rec) continue;
      const fm = rec.frontmatter;
      if (forAgent && fm.to_agent !== forAgent && fm.to_agent !== '*') continue;
      if (status && fm.status !== status) continue;
      out.push({
        id: String(fm.id),
        from_agent: fm.from_agent,
        to_agent: fm.to_agent,
        topic: fm.topic,
        created_at: fm.created_at,
        milestone: fm.milestone === 'null' ? null : fm.milestone,
        slice: fm.slice === 'null' ? null : fm.slice,
        task: fm.task === 'null' ? null : fm.task,
        status: fm.status,
        path: filePath,
      });
    }
  }
  out.sort((a, b) => {
    const byTs = String(a.created_at).localeCompare(String(b.created_at));
    if (byTs !== 0) return byTs;
    return String(a.id).localeCompare(String(b.id));
  });
  return out;
}

function readHandoff(id, cwd) {
  if (typeof id !== 'string' || id.length === 0) {
    throw new NubosPilotError('handoff-missing-id', 'id required', {});
  }
  const all = listHandoffs({}, cwd);
  const match = all.find((h) => h.id === id);
  if (!match) {
    throw new NubosPilotError('handoff-not-found', `no handoff with id ${id}`, { id });
  }
  const rec = _readHandoffFile(match.path);
  return {
    id: match.id,
    from_agent: match.from_agent,
    to_agent: match.to_agent,
    topic: match.topic,
    created_at: match.created_at,
    milestone: match.milestone,
    slice: match.slice,
    task: match.task,
    status: match.status,
    body: rec ? rec.body.replace(/^\s+/, '').replace(/\s+$/, '\n') : '',
    path: match.path,
  };
}

function setHandoffStatus(id, newStatus, cwd) {
  if (!STATUS_ENUM.has(newStatus)) {
    throw new NubosPilotError(
      'handoff-invalid-status',
      `status '${newStatus}' not in [${[...STATUS_ENUM].join(', ')}]`,
      { newStatus },
    );
  }
  const all = listHandoffs({}, cwd);
  const match = all.find((h) => h.id === id);
  if (!match) {
    throw new NubosPilotError('handoff-not-found', `no handoff with id ${id}`, { id });
  }
  const raw = fs.readFileSync(match.path, 'utf-8');
  const fmMatch = raw.match(/^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/);
  if (!fmMatch) {
    throw new NubosPilotError('handoff-frontmatter-missing', 'handoff file has no YAML frontmatter', { id });
  }
  const [, openFence, fmBody, closeFence] = fmMatch;
  if (!/^status:\s*.*$/m.test(fmBody)) {
    throw new NubosPilotError('handoff-status-line-missing', 'frontmatter has no status field', { id });
  }
  const newFmBody = fmBody.replace(/^status:\s*.*$/m, 'status: ' + newStatus);
  const rest = raw.slice(fmMatch[0].length);
  atomicWriteFileSync(match.path, openFence + newFmBody + closeFence + rest);
  return newStatus;
}

module.exports = {
  writeHandoff,
  listHandoffs,
  readHandoff,
  setHandoffStatus,
  STATUS_ENUM,
};
