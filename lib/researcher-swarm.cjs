'use strict';

const crypto = require('node:crypto');

const { DEFAULT_THRESHOLD, DEFAULT_MIN_OCCURRENCE, DEFAULT_MIN_CONFIDENCE, DEFAULT_BYPASS_THRESHOLD } = require('./knowledge-adapter.cjs');
const config = require('./config.cjs');
const elision = require('./elision.cjs');
const { normalizeText } = require('./core.cjs');

const DEFAULT_K = 3;
const MIN_K = 1;
const MAX_K = 5;

const SEED_DELTAS = [
  'Treat training-data recall as a hypothesis to verify against primary documentation; downgrade unverified claims to LOW confidence.',
  'Survey breadth-first before narrowing — enumerate every viable option you find, even ones that look obviously inferior, before recommending.',
  'Be contrarian: assume the obvious recommendation is wrong and justify whether it actually is. If it survives the challenge, your confidence is higher.',
  'Surface unknowns explicitly: anything you cannot verify becomes an Open Question, not an [ASSUMED] filled with a plausible default.',
  'Stress-test the leading recommendation: name the most plausible failure mode that would make it the wrong choice, then assess how likely that mode is in scope.',
];

if (SEED_DELTAS.length < MAX_K) {
  throw new Error(
    'SEED_DELTAS must contain at least MAX_K (' + MAX_K + ') entries — got ' + SEED_DELTAS.length,
  );
}

function _readSwarmConfig(cwd) {
  const swarm = config.tryReadConfigPath(cwd, 'swarm', {});
  return swarm && typeof swarm === 'object' && !Array.isArray(swarm) ? swarm : {};
}

function _coerceK(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_K;
  return Math.max(MIN_K, Math.min(MAX_K, Math.round(n)));
}

function resolveSwarmOpts(cwd, override) {
  const cfg = _readSwarmConfig(cwd);
  const r = (cfg && cfg.research) || {};
  const o = override || {};
  const rawK = o.k != null ? o.k : (r.k != null ? r.k : DEFAULT_K);
  const k = _coerceK(rawK);
  const threshold = o.threshold != null
    ? Number(o.threshold)
    : (r.threshold != null ? Number(r.threshold) : DEFAULT_THRESHOLD);
  const minOccurrence = o.minOccurrence != null
    ? Number(o.minOccurrence)
    : (r.minOccurrence != null ? Number(r.minOccurrence) : DEFAULT_MIN_OCCURRENCE);
  const minConfidence = o.minConfidence != null
    ? Number(o.minConfidence)
    : (r.minConfidence != null ? Number(r.minConfidence) : DEFAULT_MIN_CONFIDENCE);
  const bypassThreshold = o.bypassThreshold != null
    ? Number(o.bypassThreshold)
    : (r.bypassThreshold != null ? Number(r.bypassThreshold) : DEFAULT_BYPASS_THRESHOLD);
  return { k, threshold, minOccurrence, minConfidence, bypassThreshold };
}

function _dedupInputRef(input, cwd) {
  if (!cwd) return null;
  const cx = elision.compressionContext(cwd);
  return cx.store ? cx.store(JSON.stringify(input), 'json-array') : null;
}

function buildSpawnSpecs(input, k, opts) {
  if (!input || typeof input !== 'object') {
    throw new TypeError('buildSpawnSpecs: input object is required');
  }
  const safeK = _coerceK(k);
  const o = opts || {};
  const inputRef = _dedupInputRef(input, o.cwd);
  const specs = [];
  for (let i = 0; i < safeK; i += 1) {
    const spec = {
      index: i,
      seed_delta: i,
      seed_nudge: SEED_DELTAS[i % SEED_DELTAS.length],
      input,
    };
    if (inputRef) spec.input_ref = inputRef;
    specs.push(spec);
  }
  return specs;
}

function _semanticKey(text) {
  const normalised = normalizeText(text);
  return crypto.createHash('sha1').update(normalised).digest('hex').slice(0, 16);
}

function _ensureArray(v) {
  return Array.isArray(v) ? v : [];
}

function _agreementOnDecisions(decisions, k) {
  if (!Array.isArray(decisions) || !decisions.length || !k) return 0;
  let sumRatio = 0;
  for (const d of decisions) {
    const agreement = Array.isArray(d.from_spawns) ? d.from_spawns.length : 0;
    sumRatio += Math.min(1, agreement / k);
  }
  return Number((sumRatio / decisions.length).toFixed(3));
}

function _mergeDecisions(outputs) {
  const buckets = new Map();
  outputs.forEach((out, idx) => {
    for (const d of _ensureArray(out.decisions)) {
      if (!d || typeof d.claim !== 'string') continue;
      const key = _semanticKey(d.claim);
      if (!buckets.has(key)) {
        buckets.set(key, {
          claim: d.claim,
          confidence: d.confidence || 'MEDIUM',
          provenance: d.provenance || '[ASSUMED]',
          fromSpawns: [],
        });
      }
      const b = buckets.get(key);
      if (!b.fromSpawns.includes(idx)) b.fromSpawns.push(idx);
      if (d.provenance === '[VERIFIED]' && b.provenance !== '[VERIFIED]') b.provenance = '[VERIFIED]';
    }
  });
  const k = outputs.length;
  const majority = Math.ceil(k / 2);
  const accepted = [];
  const flagged = [];
  for (const b of buckets.values()) {
    const record = {
      claim: b.claim,
      confidence: b.confidence,
      provenance: b.provenance,
      agreement: b.fromSpawns.length,
      from_spawns: b.fromSpawns.slice(),
    };
    if (b.fromSpawns.length >= majority) {
      record.flagged = false;
      accepted.push(record);
    } else {
      record.flagged = true;
      flagged.push(record);
    }
  }
  accepted.sort((a, b) => b.agreement - a.agreement || a.claim.localeCompare(b.claim));
  flagged.sort((a, b) => b.agreement - a.agreement || a.claim.localeCompare(b.claim));
  return { accepted, flagged };
}

function _mergeByKey(outputs, cfg) {
  const buckets = new Map();
  outputs.forEach((out, idx) => {
    for (const entry of _ensureArray(out[cfg.listField])) {
      const parsed = cfg.keyOf(entry);
      if (!parsed) continue;
      const { key, item } = parsed;
      if (!buckets.has(key)) {
        buckets.set(key, Object.assign(cfg.build(item), { fromSpawns: [] }));
      }
      const b = buckets.get(key);
      if (!b.fromSpawns.includes(idx)) b.fromSpawns.push(idx);
      if (typeof cfg.escalate === 'function') cfg.escalate(b, item);
    }
  });
  return Array.from(buckets.values())
    .map((b) => Object.assign(cfg.toRecord(b), { seen_by: b.fromSpawns.slice() }))
    .sort((a, b) => b.seen_by.length - a.seen_by.length
      || cfg.sortText(a).localeCompare(cfg.sortText(b)));
}

const _SEVERITY_ORDER = { LOW: 0, MEDIUM: 1, HIGH: 2 };

function _mergeRisks(outputs) {
  return _mergeByKey(outputs, {
    listField: 'risks',
    keyOf: (r) => (r && typeof r.description === 'string'
      ? { key: _semanticKey(r.description), item: r }
      : null),
    build: (r) => ({ description: r.description, severity: r.severity || 'MEDIUM' }),
    escalate: (b, r) => {
      if ((_SEVERITY_ORDER[r.severity] || 0) > (_SEVERITY_ORDER[b.severity] || 0)) {
        b.severity = r.severity;
      }
    },
    toRecord: (b) => ({ description: b.description, severity: b.severity }),
    sortText: (rec) => rec.description,
  });
}

function _mergePatterns(outputs) {
  const buckets = new Map();
  outputs.forEach((out, idx) => {
    for (const p of _ensureArray(out.patterns)) {
      if (!p || typeof p.name !== 'string') continue;
      const key = _semanticKey(p.name);
      if (!buckets.has(key)) {
        buckets.set(key, {
          name: p.name,
          description: p.description || '',
          fromSpawns: [],
        });
      }
      const b = buckets.get(key);
      if (!b.fromSpawns.includes(idx)) b.fromSpawns.push(idx);
      if (!b.description && p.description) b.description = p.description;
    }
  });
  const k = outputs.length;
  const threshold = Math.min(2, Math.max(1, k));
  const accepted = [];
  const demoted = [];
  for (const b of buckets.values()) {
    const record = {
      name: b.name,
      description: b.description,
      agreement: b.fromSpawns.length,
      from_spawns: b.fromSpawns.slice(),
    };
    if (b.fromSpawns.length >= threshold) {
      accepted.push(record);
    } else {
      record.provenance = '[ASSUMED]';
      demoted.push(record);
    }
  }
  accepted.sort((a, b) => b.agreement - a.agreement || a.name.localeCompare(b.name));
  demoted.sort((a, b) => a.name.localeCompare(b.name));
  return { accepted, demoted };
}

function _mergeOpenQuestions(outputs) {
  return _mergeByKey(outputs, {
    listField: 'open_questions',
    keyOf: (q) => {
      if (!q) return null;
      const text = typeof q === 'string' ? q : q.question;
      if (!text) return null;
      return { key: _semanticKey(text), item: { text, blocking_for: (q && q.blocking_for) || null } };
    },
    build: (q) => ({ question: q.text, blockingFor: q.blocking_for }),
    toRecord: (b) => ({ question: b.question, blocking_for: b.blockingFor }),
    sortText: (rec) => rec.question,
  });
}

function _mergeSources(outputs) {
  return _mergeByKey(outputs, {
    listField: 'sources',
    keyOf: (s) => (s && s.url ? { key: String(s.url).toLowerCase(), item: s } : null),
    build: (s) => ({ url: s.url, credibility: s.credibility || 'MEDIUM', note: s.note || '' }),
    escalate: (b, s) => {
      if ((_SEVERITY_ORDER[s.credibility] || 0) > (_SEVERITY_ORDER[b.credibility] || 0)) {
        b.credibility = s.credibility;
      }
      if (!b.note && s.note) b.note = s.note;
    },
    toRecord: (b) => ({ url: b.url, credibility: b.credibility, note: b.note }),
    sortText: (rec) => rec.url,
  });
}

function mergeConsensus(outputs) {
  if (!Array.isArray(outputs)) {
    throw new TypeError('mergeConsensus: outputs must be an array');
  }
  const decisions = _mergeDecisions(outputs);
  const patterns = _mergePatterns(outputs);
  return {
    decisions: decisions.accepted,
    flagged_decisions: decisions.flagged,
    risks: _mergeRisks(outputs),
    patterns: patterns.accepted,
    demoted_patterns: patterns.demoted,
    open_questions: _mergeOpenQuestions(outputs),
    sources: _mergeSources(outputs),
    meta: {
      k: outputs.length,
      agreement_score: _agreementOnDecisions(
        decisions.accepted.concat(decisions.flagged),
        outputs.length,
      ),
      flagged_count: decisions.flagged.length,
    },
  };
}

function renderConsensusToMarkdown(consensus, opts) {
  const o = Object.assign({ heading: 'Researcher-Schwarm Consensus' }, opts || {});
  const lines = [];
  lines.push('# ' + o.heading);
  lines.push('');
  lines.push('<consensus_meta>');
  lines.push('k: ' + consensus.meta.k);
  lines.push('agreement_score: ' + consensus.meta.agreement_score.toFixed(3));
  lines.push('flagged_count: ' + consensus.meta.flagged_count);
  lines.push('</consensus_meta>');
  lines.push('');
  lines.push('## Decisions (Mehrheit)');
  if (!consensus.decisions.length) lines.push('_None._');
  for (const d of consensus.decisions) {
    lines.push('- ' + d.claim + '  ' + d.provenance + '  agreement=' + d.agreement);
  }
  if (consensus.flagged_decisions.length) {
    lines.push('');
    lines.push('## Flagged Decisions (no majority)');
    for (const d of consensus.flagged_decisions) {
      lines.push('- ⚠ ' + d.claim + '  ' + d.provenance + '  agreement=' + d.agreement);
    }
  }
  lines.push('');
  lines.push('## Risks (Union)');
  if (!consensus.risks.length) lines.push('_None._');
  for (const r of consensus.risks) {
    lines.push('- [' + r.severity + '] ' + r.description + '  seen_by=' + r.seen_by.length);
  }
  lines.push('');
  lines.push('## Patterns (Schnittmenge ≥ 2)');
  if (!consensus.patterns.length) lines.push('_None._');
  for (const p of consensus.patterns) {
    lines.push('- ' + p.name + (p.description ? ': ' + p.description : '') + '  agreement=' + p.agreement);
  }
  if (consensus.demoted_patterns.length) {
    lines.push('');
    lines.push('## Demoted Patterns (solo, [ASSUMED])');
    for (const p of consensus.demoted_patterns) {
      lines.push('- ' + p.name + (p.description ? ': ' + p.description : ''));
    }
  }
  lines.push('');
  lines.push('## Open Questions');
  if (!consensus.open_questions.length) lines.push('_None._');
  for (const q of consensus.open_questions) {
    lines.push('- ' + q.question + (q.blocking_for ? '  (blocking: ' + q.blocking_for + ')' : ''));
  }
  lines.push('');
  lines.push('## Sources');
  if (!consensus.sources.length) lines.push('_None._');
  for (const s of consensus.sources) {
    lines.push('- [' + s.credibility + '] ' + s.url + (s.note ? ' — ' + s.note : ''));
  }
  return lines.join('\n') + '\n';
}

module.exports = {
  DEFAULT_K,
  MIN_K,
  MAX_K,
  DEFAULT_THRESHOLD,
  DEFAULT_MIN_OCCURRENCE,
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_BYPASS_THRESHOLD,
  SEED_DELTAS,
  resolveSwarmOpts,
  buildSpawnSpecs,
  mergeConsensus,
  renderConsensusToMarkdown,
};
