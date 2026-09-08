'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { projectStateDir, atomicWriteFileSync, withFileLock, NubosPilotError, safeAssign } = require('./core.cjs');
const { TASK_ID_RE, MILESTONE_ID_RE } = require('./ids.cjs');
const { assertValid } = require('./validate.cjs');
const { runMigrators } = require('./migrate.cjs');

const STORE_SCHEMA = 'learnings.v1';

const STOPWORDS = new Set([
  'the','a','an','of','to','in','on','for','and','or','is','are','was','were',
  'be','as','by','at','it','this','that','these','those','with','from','into',
  'der','die','das','und','oder','von','zu','im','auf','für',
  'ist','sind','war','waren','sein','als','bei','an','mit','aus','nach',
]);

const STORE_VERSION = 1;
const DEFAULT_THRESHOLD = 0.2;
const DEFAULT_MIN_OCCURRENCE = 1;
const DEFAULT_MIN_CONFIDENCE = 0.3;
const DEFAULT_BYPASS_THRESHOLD = 0.5;
const STORE_REL = path.join('knowledge', 'learnings.json');

const OCCURRENCE_SATURATION = 8;
const OCCURRENCE_FLOOR = 0.8;
const OUTCOME_WEIGHTS = Object.freeze({
  verified: 1,
  partial: 0.6,
  failed: 0.25,
  reverted: 0.15,
});
const OUTCOME_WEIGHT_UNKNOWN = 1;
const OUTCOME_HISTORY_WEIGHT = 0.3;
const RECENCY_HALF_LIFE_DAYS = 90;
const RECENCY_FLOOR = 0.5;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const MAX_PATTERN_BYTES = 4 * 1024;
const MAX_OUTCOME_BYTES = 4 * 1024;
const MAX_LEARNINGS = 1000;
const MAX_STORE_BYTES = 8 * 1024 * 1024;
const MAX_PROVENANCE_IDS = 50;

const MIGRATORS = Object.freeze({
});

function _storePath(cwd) {
  return path.join(projectStateDir(cwd), STORE_REL);
}

const MAX_TOKEN_LENGTH = 64;

function _tokenize(text) {
  const lower = String(text || '').toLowerCase();
  const tokens = lower.match(/[a-z0-9][a-z0-9\-_]{1,}/g) || [];
  return tokens.filter((t) => t.length >= 2 && t.length <= MAX_TOKEN_LENGTH && !STOPWORDS.has(t));
}

function _fingerprint(text) {
  const tokens = _tokenize(text);
  const sorted = Array.from(new Set(tokens)).sort();
  return crypto.createHash('sha1').update(sorted.join(' ')).digest('hex').slice(0, 16);
}

function _jaccard(aTokens, bTokens) {
  const setA = aTokens instanceof Set ? aTokens : new Set(aTokens || []);
  const setB = bTokens instanceof Set ? bTokens : new Set(bTokens || []);
  if (!setA.size && !setB.size) return 0;
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function _outcomeWeight(outcome) {
  const key = String(outcome || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(OUTCOME_WEIGHTS, key)
    ? OUTCOME_WEIGHTS[key]
    : OUTCOME_WEIGHT_UNKNOWN;
}

function _occurrenceScore(occurrence) {
  const n = Number(occurrence);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const ramp = Math.min(1, Math.log1p(n) / Math.log1p(OCCURRENCE_SATURATION));
  return OCCURRENCE_FLOOR + (1 - OCCURRENCE_FLOOR) * ramp;
}

function _recencyScore(lastSeen, now) {
  const seen = Date.parse(String(lastSeen || ''));
  if (!Number.isFinite(seen)) return RECENCY_FLOOR;
  const ageDays = (now - seen) / MS_PER_DAY;
  if (!(ageDays > 0)) return 1;
  const decayed = Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
  return RECENCY_FLOOR + (1 - RECENCY_FLOOR) * decayed;
}

function _outcomeScore(learning) {
  const current = _outcomeWeight(learning && learning.outcome);
  const history = Array.isArray(learning && learning.outcome_history)
    ? learning.outcome_history.filter((h) => h && typeof h === 'object')
    : [];
  if (!history.length) return current;
  let sum = 0;
  for (const h of history) sum += _outcomeWeight(h.outcome);
  const past = sum / history.length;
  return (1 - OUTCOME_HISTORY_WEIGHT) * current + OUTCOME_HISTORY_WEIGHT * past;
}

function _confidence(learning, now) {
  if (!learning || typeof learning !== 'object') return 0;
  const at = Number.isFinite(now) ? now : Date.now();
  const score = _occurrenceScore(learning.occurrence)
    * _outcomeScore(learning)
    * _recencyScore(learning.last_seen, at);
  if (!Number.isFinite(score) || score < 0) return 0;
  return score > 1 ? 1 : score;
}

function _emptyStore() {
  return { version: STORE_VERSION, learnings: [] };
}

function _readStore(cwd) {
  const p = _storePath(cwd);
  if (!fs.existsSync(p)) return _emptyStore();
  let st;
  try { st = fs.statSync(p); }
  catch (err) {
    throw new NubosPilotError(
      'learnings-store-unreadable',
      'learnings.json could not be stat-checked: ' + (err && err.message),
      { path: p, cause: err && err.code },
    );
  }
  if (st.size > 2 * MAX_STORE_BYTES) {
    throw new NubosPilotError(
      'learnings-store-oversized',
      'learnings.json size ' + st.size + ' exceeds 2 × MAX_STORE_BYTES (' + (2 * MAX_STORE_BYTES) + ')',
      { path: p, size: st.size, max: 2 * MAX_STORE_BYTES, hint: 'a teammate-committed oversized store can DoS every CLI invocation; back up + remove the file or trim it manually.' },
    );
  }
  let obj;
  try { obj = JSON.parse(fs.readFileSync(p, 'utf-8')); }
  catch (err) {
    throw new NubosPilotError(
      'learnings-store-corrupt',
      'learnings.json is not valid JSON: ' + (err && err.message),
      { path: p, hint: 'inspect the file; restore from a backup or remove it to start fresh.' },
    );
  }
  if (!obj || typeof obj !== 'object') {
    throw new NubosPilotError(
      'learnings-store-corrupt',
      'learnings.json is not a JSON object',
      { path: p },
    );
  }
  if (obj.version === STORE_VERSION) {
    assertValid(obj, STORE_SCHEMA, 'learnings-store-corrupt', { path: p });
    return obj;
  }
  const migrated = _migrate(obj, p);
  if (migrated) return migrated;
  throw new NubosPilotError(
    'learnings-store-version-mismatch',
    'learnings.json version ' + obj.version + ' is not understood by this nubos-pilot release (expected ' + STORE_VERSION + ').',
    {
      path: p,
      expected: STORE_VERSION,
      got: obj.version,
      hint: 'no migrator from v' + obj.version + ' → v' + STORE_VERSION + ' is registered. Either upgrade nubos-pilot to a release that ships the migrator, or back up the file and remove it to start fresh.',
    },
  );
}

function _assertLearningRecords(records, p) {
  if (!Array.isArray(records)) {
    throw new NubosPilotError(
      'learnings-store-corrupt',
      'learnings[] must be an array',
      { path: p },
    );
  }
  assertValid({ version: STORE_VERSION, learnings: records }, STORE_SCHEMA, 'learnings-store-corrupt', { path: p });
}

function _migrate(obj, p, migrators) {
  return runMigrators(obj, {
    versionField: 'version',
    targetVersion: STORE_VERSION,
    migrators: migrators || MIGRATORS,
    schema: STORE_SCHEMA,
    code: 'learnings-store-corrupt',
    details: { path: p },
  });
}

function _evictIfOverCap(store, opts) {
  if (!Array.isArray(store.learnings)) return [];
  const o = opts || {};
  const stderr = o.stderr || process.stderr;
  const silent = o.silent === true;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  function _byEvictionOrder(a, b) {
    const cd = _confidence(a, now) - _confidence(b, now);
    if (cd !== 0) return cd;
    return String(a.last_seen || '').localeCompare(String(b.last_seen || ''));
  }
  const sorted = store.learnings.slice().sort(_byEvictionOrder);
  const evicted = [];
  while (sorted.length > MAX_LEARNINGS) evicted.push(sorted.shift());
  store.learnings = sorted;
  let totalBytes = Buffer.byteLength(JSON.stringify(store), 'utf-8');
  while (totalBytes > MAX_STORE_BYTES && store.learnings.length > 0) {
    const dropped = store.learnings.shift();
    evicted.push(dropped);
    totalBytes -= Buffer.byteLength(JSON.stringify(dropped), 'utf-8') + 1;
  }
  if (evicted.length && !silent) {
    try {
      stderr.write('learnings-eviction: dropped ' + evicted.length
        + ' entries (' + evicted.map((e) => e.fingerprint).join(',') + ')\n');
    } catch { }
  }
  return evicted;
}

function _writeStore(store, cwd) {
  const p = _storePath(cwd);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (!Array.isArray(store && store.learnings)) {
    throw new NubosPilotError(
      'learnings-store-corrupt',
      '_writeStore: store.learnings must be an array',
      { path: p },
    );
  }
  _assertLearningRecords(store.learnings, p);
  return withFileLock(p, () => {
    atomicWriteFileSync(p, JSON.stringify(store, null, 2), 'utf-8', 0o600);
    return p;
  });
}

function _assertOptionalId(value, re, label) {
  if (value == null) return;
  if (typeof value !== 'string' || !re.test(value)) {
    throw new TypeError('logLearning: ' + label + ' must match ' + re.toString() + ' (got ' + JSON.stringify(value) + ')');
  }
}

function logLearning(entry, cwd) {
  if (!entry || typeof entry !== 'object') {
    throw new TypeError('logLearning: entry must be an object');
  }
  if (!entry.pattern || typeof entry.pattern !== 'string') {
    throw new TypeError('logLearning: entry.pattern (string) is required');
  }
  if (Buffer.byteLength(entry.pattern, 'utf-8') > MAX_PATTERN_BYTES) {
    throw new TypeError('logLearning: entry.pattern exceeds ' + MAX_PATTERN_BYTES + ' bytes (R10 cap from second review).');
  }
  if (!entry.outcome || typeof entry.outcome !== 'string') {
    throw new TypeError('logLearning: entry.outcome (string) is required');
  }
  if (Buffer.byteLength(entry.outcome, 'utf-8') > MAX_OUTCOME_BYTES) {
    throw new TypeError('logLearning: entry.outcome exceeds ' + MAX_OUTCOME_BYTES + ' bytes.');
  }
  _assertOptionalId(entry.task_id, TASK_ID_RE, 'task_id');
  _assertOptionalId(entry.milestone_id, MILESTONE_ID_RE, 'milestone_id');
  const fp = _fingerprint(entry.pattern);
  const tokens = Array.from(new Set(_tokenize(entry.pattern))).sort();
  const now = new Date().toISOString();
  const p = _storePath(cwd);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return withFileLock(p, () => {
    const store = _readStore(cwd);
    const existing = store.learnings.find((l) => l.fingerprint === fp);
    if (existing) {
      existing.occurrence += 1;
      existing.last_seen = now;
      const tasks = Array.from(new Set([...(existing.task_ids || []), ...(entry.task_id ? [entry.task_id] : [])]));
      existing.task_ids = tasks.slice(-MAX_PROVENANCE_IDS);
      const milestones = Array.from(new Set([...(existing.milestone_ids || []), ...(entry.milestone_id ? [entry.milestone_id] : [])]));
      existing.milestone_ids = milestones.slice(-MAX_PROVENANCE_IDS);
      if (entry.outcome && entry.outcome !== existing.outcome) {
        const journal = Array.isArray(existing.outcome_history) ? existing.outcome_history.slice() : [];
        journal.push({ outcome: existing.outcome, replaced_at: now });
        existing.outcome_history = journal.slice(-5);
        existing.outcome = entry.outcome;
      } else if (entry.outcome && !existing.outcome) {
        existing.outcome = entry.outcome;
      }
      if (!Array.isArray(existing.tokens)) existing.tokens = tokens;
    } else {
      store.learnings.push({
        fingerprint: fp,
        pattern: entry.pattern,
        tokens,
        outcome: entry.outcome,
        occurrence: 1,
        first_seen: now,
        last_seen: now,
        task_ids: entry.task_id ? [entry.task_id] : [],
        milestone_ids: entry.milestone_id ? [entry.milestone_id] : [],
      });
    }
    _evictIfOverCap(store);
    const bak = p + '.bak';
    if (fs.existsSync(p)) {
      const tmpBak = p + '.bak.tmp';
      try {
        fs.copyFileSync(p, tmpBak);
        fs.renameSync(tmpBak, bak);
      } catch {
        try { fs.unlinkSync(tmpBak); } catch { }
        try { fs.copyFileSync(p, bak); } catch { }
      }
    }
    atomicWriteFileSync(p, JSON.stringify(store, null, 2), 'utf-8', 0o600);
    return store;
  });
}

function matchExistingLearning(query, cwd, opts) {
  const o = safeAssign(
    {
      threshold: DEFAULT_THRESHOLD,
      minOccurrence: DEFAULT_MIN_OCCURRENCE,
      minConfidence: DEFAULT_MIN_CONFIDENCE,
      limit: 5,
    },
    opts || {},
  );
  const store = _readStore(cwd);
  const queryTokens = _tokenize(query);
  if (!queryTokens.length || !store.learnings.length) {
    return { hits: [], best: null };
  }
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const querySet = new Set(queryTokens);
  const qLen = querySet.size;
  const t = o.threshold;
  const minRatio = Number.isFinite(t) && t > 0 ? t : 0;
  const minConf = Number.isFinite(o.minConfidence) ? o.minConfidence : 0;
  const scored = [];
  for (const l of store.learnings) {
    const lTokens = Array.isArray(l.tokens) ? l.tokens : _tokenize(l.pattern);
    const lLen = new Set(lTokens).size;
    if (qLen === 0 || lLen === 0) continue;
    const ratio = qLen < lLen ? qLen / lLen : lLen / qLen;
    if (ratio < minRatio) continue;
    const similarity = _jaccard(querySet, lTokens);
    if (similarity < o.threshold || (l.occurrence || 0) < o.minOccurrence) continue;
    const confidence = _confidence(l, now);
    if (confidence < minConf) continue;
    scored.push({ similarity, confidence, learning: l });
  }
  scored.sort((a, b) =>
    (b.similarity * b.confidence) - (a.similarity * a.confidence)
    || b.similarity - a.similarity
    || (b.learning.occurrence || 0) - (a.learning.occurrence || 0));
  const hits = scored.slice(0, o.limit).map(({ learning, similarity, confidence }) => {
    const projected = safeAssign({}, learning);
    delete projected.tokens;
    projected.similarity = similarity;
    projected.confidence = confidence;
    return projected;
  });
  return { hits, best: hits[0] || null };
}

function listLearnings(cwd) {
  const store = _readStore(cwd);
  return store.learnings.slice();
}

function clearLearnings(cwd) {
  return _writeStore(_emptyStore(), cwd);
}

function _setStoreForTests(store, cwd) {
  return _writeStore(store, cwd);
}

module.exports = {
  STORE_VERSION,
  DEFAULT_THRESHOLD,
  DEFAULT_MIN_OCCURRENCE,
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_BYPASS_THRESHOLD,
  OUTCOME_WEIGHTS,
  RECENCY_HALF_LIFE_DAYS,
  _confidence,
  _outcomeWeight,
  _occurrenceScore,
  _recencyScore,
  _outcomeScore,
  MAX_PATTERN_BYTES,
  MAX_OUTCOME_BYTES,
  MAX_LEARNINGS,
  MAX_STORE_BYTES,
  MIGRATORS,
  _evictIfOverCap,
  logLearning,
  matchExistingLearning,
  listLearnings,
  clearLearnings,
  _fingerprint,
  _tokenize,
  _jaccard,
  _setStoreForTests,
  _storePath,
  _readStore,
  _migrate,
  _assertLearningRecords,
};
