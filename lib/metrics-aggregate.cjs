const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { NubosPilotError, findProjectRoot } = require('./core.cjs');

const SAFE_PHASE_RE = /^[A-Za-z0-9._-]+$/;

function _zeroPhaseShape(phase) {
  return {
    phase,
    record_count: 0,
    total_tokens_in: null,
    total_tokens_out: null,
    partial_tokens: false,
    avg_duration_ms_by_tier: {},
    avg_duration_ms_by_agent: {},
    retry_count_sum: 0,
    error_count: 0,
    error_rate: 0,
    agents_seen: [],
    first_record_at: null,
    last_record_at: null,
  };
}

function _readJsonlLines(filePath, onRecord) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    stream.on('error', (err) => {
      if (err && err.code === 'ENOENT') { resolve(); return; }
      reject(err);
    });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (raw) => {
      const line = String(raw).trim();
      if (!line) return;
      try {
        const rec = JSON.parse(line);
        onRecord(rec);
      } catch (_err) {
        process.stderr.write('metrics-aggregate: skipping malformed JSONL line in ' + filePath + '\n');
      }
    });
    rl.on('close', () => resolve());
    rl.on('error', (err) => reject(err));
  });
}

function _metricsDir(cwd) {
  const root = findProjectRoot(cwd || process.cwd());
  return path.join(root, '.nubos-pilot', 'metrics');
}

function _aggregateFromRecords(records, phase) {
  const shape = _zeroPhaseShape(phase);
  let tokensInSum = 0;
  let tokensOutSum = 0;
  let anyNull = false;
  let anyValue = false;
  const durByTier = {};
  const countByTier = {};
  const durByAgent = {};
  const countByAgent = {};
  const agentsSet = new Set();
  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    shape.record_count += 1;
    if (r.agent) agentsSet.add(String(r.agent));
    if (typeof r.retry_count === 'number') shape.retry_count_sum += r.retry_count;
    if (r.status && r.status !== 'ok') shape.error_count += 1;
    if (r.started_at) {
      if (!shape.first_record_at || r.started_at < shape.first_record_at) shape.first_record_at = r.started_at;
      if (!shape.last_record_at || r.started_at > shape.last_record_at) shape.last_record_at = r.started_at;
    }
    if (r.tokens_in === null || r.tokens_out === null) {
      anyNull = true;
    } else {
      anyValue = true;
      tokensInSum += Number(r.tokens_in) || 0;
      tokensOutSum += Number(r.tokens_out) || 0;
    }
    const d = typeof r.duration_ms === 'number' ? r.duration_ms : null;
    if (d !== null) {
      if (r.tier) {
        durByTier[r.tier] = (durByTier[r.tier] || 0) + d;
        countByTier[r.tier] = (countByTier[r.tier] || 0) + 1;
      }
      if (r.agent) {
        durByAgent[r.agent] = (durByAgent[r.agent] || 0) + d;
        countByAgent[r.agent] = (countByAgent[r.agent] || 0) + 1;
      }
    }
  }
  shape.agents_seen = Array.from(agentsSet).sort();
  if (anyValue && anyNull) {
    shape.total_tokens_in = tokensInSum;
    shape.total_tokens_out = tokensOutSum;
    shape.partial_tokens = true;
  } else if (anyValue) {
    shape.total_tokens_in = tokensInSum;
    shape.total_tokens_out = tokensOutSum;
    shape.partial_tokens = false;
  } else {
    shape.total_tokens_in = null;
    shape.total_tokens_out = null;
    shape.partial_tokens = false;
  }
  shape.error_rate = shape.record_count > 0 ? shape.error_count / shape.record_count : 0;
  for (const t of Object.keys(durByTier)) {
    shape.avg_duration_ms_by_tier[t] = durByTier[t] / countByTier[t];
  }
  for (const a of Object.keys(durByAgent)) {
    shape.avg_duration_ms_by_agent[a] = durByAgent[a] / countByAgent[a];
  }
  return shape;
}

async function aggregatePhase(phase, opts) {
  const phaseStr = String(phase);
  if (!SAFE_PHASE_RE.test(phaseStr)) {
    throw new NubosPilotError(
      'metrics-invalid-phase',
      'metrics-aggregate phase must match /^[A-Za-z0-9._-]+$/: ' + phaseStr,
      { phase: phaseStr },
    );
  }
  let dir;
  try {
    dir = _metricsDir(opts && opts.cwd);
  } catch (err) {
    if (err && err.code === 'not-in-project') return _zeroPhaseShape(phaseStr);
    throw err;
  }
  const filePath = path.join(dir, 'phase-' + phaseStr + '.jsonl');
  const records = [];
  await _readJsonlLines(filePath, (r) => records.push(r));
  return _aggregateFromRecords(records, phaseStr);
}

async function aggregateSession(sinceIso, opts) {
  let dir;
  try {
    dir = _metricsDir(opts && opts.cwd);
  } catch (err) {
    if (err && err.code === 'not-in-project') {
      return {
        since_iso: sinceIso || null,
        record_count: 0,
        by_phase: {},
        total_tokens_in: null,
        total_tokens_out: null,
        partial_tokens: false,
        total_duration_ms: 0,
        error_count: 0,
        phases_touched: [],
      };
    }
    throw err;
  }
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return {
        since_iso: sinceIso || null,
        record_count: 0,
        by_phase: {},
        total_tokens_in: null,
        total_tokens_out: null,
        partial_tokens: false,
        total_duration_ms: 0,
        error_count: 0,
        phases_touched: [],
      };
    }
    throw err;
  }
  const relevant = files.filter((f) => /^(phase-.+|meta)\.jsonl$/.test(f)).sort();
  const byPhaseRecords = {};
  for (const f of relevant) {
    const key = f === 'meta.jsonl' ? 'meta' : f.slice('phase-'.length, -('.jsonl'.length));
    byPhaseRecords[key] = byPhaseRecords[key] || [];
    await _readJsonlLines(path.join(dir, f), (r) => {
      if (sinceIso && r && r.started_at && r.started_at < sinceIso) return;
      byPhaseRecords[key].push(r);
    });
  }
  const by_phase = {};
  let record_count = 0;
  let total_duration_ms = 0;
  let error_count = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let anyNull = false;
  let anyValue = false;
  for (const key of Object.keys(byPhaseRecords)) {
    const agg = _aggregateFromRecords(byPhaseRecords[key], key);
    by_phase[key] = agg;
    record_count += agg.record_count;
    error_count += agg.error_count;
    for (const r of byPhaseRecords[key]) {
      if (!r || typeof r !== 'object') continue;
      if (typeof r.duration_ms === 'number') total_duration_ms += r.duration_ms;
      if (r.tokens_in === null || r.tokens_out === null) {
        anyNull = true;
      } else {
        anyValue = true;
        tokensIn += Number(r.tokens_in) || 0;
        tokensOut += Number(r.tokens_out) || 0;
      }
    }
  }
  const total_tokens_in = anyValue ? tokensIn : null;
  const total_tokens_out = anyValue ? tokensOut : null;
  return {
    since_iso: sinceIso || null,
    record_count,
    by_phase,
    total_tokens_in,
    total_tokens_out,
    partial_tokens: anyValue && anyNull,
    total_duration_ms,
    error_count,
    phases_touched: Object.keys(by_phase).sort(),
  };
}

module.exports = { aggregatePhase, aggregateSession, _readJsonlLines };
