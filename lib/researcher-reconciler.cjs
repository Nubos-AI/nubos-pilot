'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { NubosPilotError, normalizeText } = require('./core.cjs');
const { extractFrontmatter, stripFrontmatter } = require('./frontmatter.cjs');
const layout = require('./layout.cjs');

const DEFAULTS = Object.freeze({
  min_agreement_score: 0.5,
  max_contested: 2,
});

function researchDir(mNum, cwd) {
  return path.join(layout.milestoneDir(mNum, cwd), 'research');
}

function spawnOutputPath(mNum, spawnIndex, cwd) {
  return path.join(researchDir(mNum, cwd), 'spawn-' + spawnIndex + '.md');
}

function mergeOutputPath(mNum, cwd) {
  return path.join(researchDir(mNum, cwd), 'merge.md');
}

function finalResearchPath(mNum, cwd) {
  return layout.milestoneResearchPath(mNum, cwd);
}

function _safeReadText(filePath) {
  try { return fs.readFileSync(filePath, 'utf-8'); }
  catch (err) { if (err && err.code === 'ENOENT') return null; throw err; }
}

const _SECTION_HEADINGS = Object.freeze({
  decisions: /^##\s+Decisions\b/m,
  risks: /^##\s+Risks\b/m,
  patterns: /^##\s+Patterns\b/m,
  open_questions: /^##\s+Open\s+Questions\b/m,
  sources: /^##\s+Sources\b/m,
});

function _sectionBody(body, sectionRe) {
  const match = body.match(sectionRe);
  if (!match) return '';
  const after = body.slice(match.index + match[0].length);
  const next = after.match(/^##\s+\S/m);
  return next ? after.slice(0, next.index) : after;
}

function _entriesIn(sectionBody, idPrefix) {
  const re = new RegExp('^###\\s+(' + idPrefix + '-\\d+):\\s+([^\\n]+)$', 'gm');
  const matches = [...sectionBody.matchAll(re)];
  const entries = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const start = m.index + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : sectionBody.length;
    entries.push({
      id: m[1],
      text: m[2].trim(),
      block: sectionBody.slice(start, end),
    });
  }
  return entries;
}

function _readField(block, label) {
  const re = new RegExp('(?:^|\\n)[*-]?\\s*\\*\\*' + label + ':\\*\\*\\s*([^\\n]*(?:\\n(?![\\*-]\\s*\\*\\*)[^\\n]*)*)');
  const m = block.match(re);
  return m ? m[1].trim() : '';
}

function _emptySectionMarker(sectionBody) {
  const trimmed = sectionBody.trim();
  return /^_None\._?$/i.test(trimmed) || trimmed === '';
}

function parseSpawnOutput(filePath) {
  const raw = _safeReadText(filePath);
  if (raw == null) {
    throw new NubosPilotError(
      'researcher-spawn-missing',
      'spawn output file not found',
      { path: filePath },
    );
  }
  let fm = {};
  try { fm = extractFrontmatter(raw).frontmatter || {}; }
  catch (err) {
    throw new NubosPilotError(
      'researcher-spawn-frontmatter',
      'spawn output frontmatter unparseable',
      { path: filePath, cause: err && err.message },
    );
  }
  const body = stripFrontmatter(raw);

  function _harvest(section, idPrefix) {
    const secBody = _sectionBody(body, _SECTION_HEADINGS[section]);
    if (_emptySectionMarker(secBody)) return [];
    return _entriesIn(secBody, idPrefix).map((e) => ({
      id: e.id,
      text: e.text,
      rationale: _readField(e.block, 'Rationale'),
      confidence: _readField(e.block, 'Confidence'),
      evidence: _readField(e.block, 'Evidence'),
      reasoning: _readField(e.block, 'Reasoning'),
      severity: _readField(e.block, 'Severity'),
      mitigation: _readField(e.block, 'Mitigation'),
      description: _readField(e.block, 'Description'),
      source_type: _readField(e.block, 'Source-Type'),
      type: _readField(e.block, 'Type'),
      notes: _readField(e.block, 'Notes'),
      why_blocked: _readField(e.block, 'Why-blocked'),
    }));
  }

  return {
    spawn_index: typeof fm.spawn_index === 'number' ? fm.spawn_index : null,
    seed_delta: typeof fm.seed_delta === 'number' ? fm.seed_delta : null,
    task_query_hash: fm.task_query_hash || null,
    decisions: _harvest('decisions', 'D'),
    risks: _harvest('risks', 'R'),
    patterns: _harvest('patterns', 'P'),
    open_questions: _harvest('open_questions', 'Q'),
    sources: _harvest('sources', 'S'),
    _frontmatter: fm,
  };
}

function _normalizeText(s) {
  return normalizeText(s);
}

function _bucketByText(items) {
  const map = new Map();
  for (const it of items) {
    const key = _normalizeText(it.text);
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(it);
  }
  return map;
}

function classifyReasoningAgreement(entries) {
  if (!entries || entries.length < 2) return 'single';
  const traces = entries.map((e) => _normalizeText(e.reasoning)).filter(Boolean);
  if (traces.length < 2) return 'unknown';
  const unique = new Set(traces);
  if (unique.size === 1) return 'identical';
  const totalLen = traces.reduce((s, t) => s + t.length, 0);
  if (totalLen === 0) return 'unknown';
  let overlapCount = 0;
  for (let i = 0; i < traces.length; i++) {
    for (let j = i + 1; j < traces.length; j++) {
      if (_jaccard(traces[i], traces[j]) > 0.6) overlapCount++;
    }
  }
  if (overlapCount === 0) return 'orthogonal';
  return 'overlapping';
}

function _jaccard(a, b) {
  const sa = new Set(a.split(/\s+/));
  const sb = new Set(b.split(/\s+/));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

function reconcileSpawns(spawnOutputs) {
  if (!Array.isArray(spawnOutputs) || spawnOutputs.length === 0) {
    return {
      k: 0,
      final_decisions: [],
      contested: [],
      final_risks: [],
      final_patterns: [],
      final_open_questions: [],
      sources: [],
      agreement: { decisions: 0, risks: 0, patterns: 0 },
    };
  }
  const k = spawnOutputs.length;

  function _consolidate(key, idPrefix) {
    const allEntries = spawnOutputs.flatMap((s, idx) =>
      _ensureArray(s[key]).map((e) => ({ ...e, spawn_index: typeof s.spawn_index === 'number' ? s.spawn_index : idx })),
    );
    const buckets = _bucketByText(allEntries);
    const consolidated = [];
    const contested = [];
    let idCounter = 1;
    for (const [, entries] of buckets) {
      const spawns = new Set(entries.map((e) => e.spawn_index));
      const agreementCount = spawns.size;
      const reasoningTrace = classifyReasoningAgreement(entries);
      const confidences = entries.map((e) => e.confidence).filter(Boolean);
      const item = {
        id: idPrefix + '-' + idCounter++,
        text: entries[0].text,
        from_spawns: [...spawns].sort(),
        agreement_count: agreementCount,
        reasoning_trace_agreement: reasoningTrace,
        confidences,
        rationales: entries.map((e) => e.rationale).filter(Boolean),
        reasonings: entries.map((e) => e.reasoning).filter(Boolean),
        evidences: entries.map((e) => e.evidence).filter(Boolean),
      };
      if (agreementCount >= Math.min(2, k)) {
        consolidated.push(item);
      } else {
        contested.push(item);
      }
    }
    return { consolidated, contested };
  }

  const decisions = _consolidate('decisions', 'D');
  const risks = _consolidate('risks', 'R');
  const patterns = _consolidate('patterns', 'P');
  const openQ = _consolidate('open_questions', 'Q');
  const sources = _consolidate('sources', 'S');

  const decisionTotal = decisions.consolidated.length + decisions.contested.length;
  const agreementScore = decisionTotal === 0
    ? 1
    : decisions.consolidated.length / decisionTotal;

  return {
    k,
    final_decisions: decisions.consolidated,
    contested: decisions.contested,
    final_risks: [...risks.consolidated, ...risks.contested],
    final_patterns: patterns.consolidated,
    final_open_questions: [...openQ.consolidated, ...openQ.contested],
    sources: [...sources.consolidated, ...sources.contested],
    agreement: {
      decisions: agreementScore,
      decision_total: decisionTotal,
      decision_consensus: decisions.consolidated.length,
      decision_contested: decisions.contested.length,
    },
  };
}

function _ensureArray(v) { return Array.isArray(v) ? v : []; }

function prepareReconcilerInput(mNum, cwd, opts) {
  const o = opts || {};
  const dir = researchDir(mNum, cwd);
  if (!fs.existsSync(dir)) {
    throw new NubosPilotError(
      'researcher-reconcile-no-research-dir',
      'research/ dir not found for milestone ' + layout.mId(mNum),
      { milestone: mNum, dir },
    );
  }
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && /^spawn-\d+\.md$/.test(e.name))
    .map((e) => path.join(dir, e.name))
    .sort();
  if (entries.length === 0) {
    throw new NubosPilotError(
      'researcher-reconcile-no-spawn-files',
      'no spawn-*.md files in research/ dir',
      { milestone: mNum, dir },
    );
  }
  const spawnOutputs = entries.map(parseSpawnOutput);
  const merged = reconcileSpawns(spawnOutputs);
  return {
    milestone: mNum,
    milestone_id: layout.mId(mNum),
    research_dir: dir,
    spawn_paths: entries,
    spawn_count: entries.length,
    final_path: finalResearchPath(mNum, cwd),
    merge_path: mergeOutputPath(mNum, cwd),
    merged,
    thresholds: {
      min_agreement_score: typeof o.min_agreement_score === 'number' ? o.min_agreement_score : DEFAULTS.min_agreement_score,
      max_contested: typeof o.max_contested === 'number' ? o.max_contested : DEFAULTS.max_contested,
    },
  };
}

function disagreementGate(reconciledMerge, thresholds) {
  const t = thresholds || DEFAULTS;
  const min = typeof t.min_agreement_score === 'number' ? t.min_agreement_score : DEFAULTS.min_agreement_score;
  const maxC = typeof t.max_contested === 'number' ? t.max_contested : DEFAULTS.max_contested;
  const score = reconciledMerge && reconciledMerge.agreement
    ? Number(reconciledMerge.agreement.decisions || 0)
    : 0;
  const contested = reconciledMerge && reconciledMerge.contested
    ? reconciledMerge.contested.length
    : 0;
  const violations = [];
  if (score < min) {
    violations.push({
      code: 'agreement-score-low',
      message: 'agreement_score=' + score.toFixed(3) + ' < min ' + min,
      score,
      threshold: min,
    });
  }
  if (contested > maxC) {
    violations.push({
      code: 'too-many-contested',
      message: contested + ' contested decisions > max ' + maxC,
      contested_count: contested,
      threshold: maxC,
    });
  }
  return {
    needs_askuser: violations.length > 0,
    score,
    contested_count: contested,
    thresholds: { min_agreement_score: min, max_contested: maxC },
    violations,
  };
}

function gateFromFinalFrontmatter(rawContent, thresholds) {
  let fm = {};
  try { fm = extractFrontmatter(rawContent).frontmatter || {}; } catch {}
  const synthetic = {
    agreement: { decisions: Number(fm.agreement_score || 0) },
    contested: new Array(Math.max(0, Number(fm.contested_count) || 0)).fill(null),
  };
  return disagreementGate(synthetic, thresholds);
}

module.exports = {
  DEFAULTS,
  researchDir,
  spawnOutputPath,
  mergeOutputPath,
  finalResearchPath,
  parseSpawnOutput,
  classifyReasoningAgreement,
  reconcileSpawns,
  prepareReconcilerInput,
  disagreementGate,
  gateFromFinalFrontmatter,
};
