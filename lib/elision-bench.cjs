'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const compress = require('./compress.cjs');
const elision = require('./elision.cjs');
const tokenCost = require('./token-cost.cjs');

const CRITICAL_RE = /\b(ERROR|FAIL(ED|URE)?|FATAL|Exception|Traceback|panic|AssertionError|assert(ion)? failed|denied|timeout)\b/i;
const MARKER_HASH_RE = /⟦elided:([a-f0-9]{12})\b/;

function _bytes(s) {
  return Buffer.byteLength(String(s), 'utf-8');
}

function criticalLines(text) {
  return String(text).split('\n').filter((l) => CRITICAL_RE.test(l)).map((l) => l.trim()).filter(Boolean);
}

function buildCorpus() {
  const jsonItems = [];
  for (let i = 0; i < 60; i += 1) {
    jsonItems.push(i === 41
      ? { id: i, status: 'error', message: 'connection refused to db-primary' }
      : { id: i, status: 'ok', message: 'row ' + i + ' processed cleanly with no remarks at all' });
  }
  const logLines = [];
  for (let i = 0; i < 80; i += 1) {
    logLines.push(i === 57
      ? '[2026-06-23T10:00:' + String(i).padStart(2, '0') + 'Z] FATAL migration 0042 failed: duplicate key value violates unique constraint'
      : '[2026-06-23T10:00:' + String(i).padStart(2, '0') + 'Z] INFO step ' + i + ' completed, 0 warnings, elapsed 12ms nominal');
  }
  const searchLines = [];
  for (let f = 0; f < 20; f += 1) {
    for (let h = 0; h < 6; h += 1) {
      searchLines.push('src/module' + f + '/file' + f + '.cjs:' + (10 + h) + ':  const handler = resolve(' + h + ');');
    }
  }
  searchLines.push('src/auth/login.cjs:88:  throw new Error("invalid credentials");');
  const codeLines = [
    "'use strict';",
    "const { compute } = require('./engine.cjs');",
    "const { validate } = require('./validate.cjs');",
    '',
    'class PaymentProcessor {',
    '  constructor(config) {',
  ];
  for (let i = 0; i < 10; i += 1) codeLines.push('    this.option' + i + ' = config.option' + i + ' !== undefined ? config.option' + i + ' : defaultFor(' + i + ');');
  codeLines.push('  }', '');
  codeLines.push('  chargeCustomer(amount, currency) {');
  for (let i = 0; i < 12; i += 1) codeLines.push('    const intermediateStep' + i + ' = compute(amount, currency, this.option' + (i % 10) + ', ' + i + ');');
  codeLines.push('    if (amount <= 0) throw new Error("invalid charge amount");');
  for (let i = 0; i < 8; i += 1) codeLines.push('    this.ledger.push({ step: ' + i + ', value: intermediateStep' + i + ', recordedAt: nowIsoString() });');
  codeLines.push('    return runningTotal;', '  }', '');
  codeLines.push('  refundCustomer(transactionId) {');
  for (let i = 0; i < 12; i += 1) codeLines.push('    const reversalEntry' + i + ' = validate(transactionId, this.option' + (i % 10) + ', ' + i + ');');
  codeLines.push('    return reversalReceipt;', '  }', '}', '', 'module.exports = { PaymentProcessor };');

  const diffLines = ['--- a/lib/pay.cjs', '+++ b/lib/pay.cjs', '@@ -1,40 +1,42 @@'];
  for (let i = 0; i < 40; i += 1) {
    if (i === 20) { diffLines.push('-  const fee = base * 0.1;'); diffLines.push('+  const fee = base * 0.15; // FATAL pricing change'); }
    else diffLines.push(' context line ' + i + ' unchanged surrounding code that adds bulk to the hunk');
  }
  return [
    { name: 'json-array-with-error', text: JSON.stringify(jsonItems),
      critical: ['connection refused to db-primary'] },
    { name: 'build-log-with-fatal', text: logLines.join('\n'),
      critical: ['FATAL migration 0042 failed', 'duplicate key value violates unique constraint'] },
    { name: 'grep-search-results', text: searchLines.join('\n'),
      critical: ['src/auth/login.cjs:88', 'invalid credentials'] },
    { name: 'unified-diff', text: diffLines.join('\n'),
      critical: ['FATAL pricing change', '0.15'] },
    { name: 'source-code', text: codeLines.join('\n'),
      critical: ['class PaymentProcessor {', 'chargeCustomer(amount, currency) {', 'throw new Error("invalid charge amount")', 'module.exports = { PaymentProcessor };'] },
  ];
}

function _variantFixtures(seed) {
  const jsonItems = [];
  const errAt = (41 + seed) % 60;
  for (let i = 0; i < 60; i += 1) {
    jsonItems.push(i === errAt
      ? { id: i, seed, status: 'error', message: 'connection refused to db-primary shard ' + seed }
      : { id: i, seed, status: 'ok', message: 'row ' + i + ' processed cleanly with no remarks at all' });
  }
  const logLines = [];
  const fatalAt = (57 + seed) % 80;
  for (let i = 0; i < 80; i += 1) {
    logLines.push(i === fatalAt
      ? '[2026-06-23T10:00:' + String(i).padStart(2, '0') + 'Z] FATAL migration ' + String(42 + seed).padStart(4, '0') + ' failed: duplicate key value violates unique constraint'
      : '[2026-06-23T10:00:' + String(i).padStart(2, '0') + 'Z] INFO step ' + i + ' completed, 0 warnings, elapsed 12ms nominal run ' + seed);
  }
  const searchLines = [];
  for (let f = 0; f < 20; f += 1) {
    for (let h = 0; h < 6; h += 1) {
      searchLines.push('src/module' + f + '/file' + f + '_' + seed + '.cjs:' + (10 + h) + ':  const handler = resolve(' + h + ');');
    }
  }
  searchLines.push('src/auth/login' + seed + '.cjs:88:  throw new Error("invalid credentials");');
  const codeLines = ["'use strict';", "const { compute } = require('./engine.cjs');", "const { validate } = require('./validate.cjs');", '', 'class Processor' + seed + ' {', '  chargeCustomer(amount, currency) {'];
  for (let i = 0; i < 20; i += 1) codeLines.push('    const intermediateStep' + i + ' = compute(amount, currency, this.option' + (i % 7) + ', ' + (i + seed) + ');');
  codeLines.push('    if (amount <= 0) throw new Error("invalid charge amount");');
  for (let i = 0; i < 16; i += 1) codeLines.push('    this.ledger.push({ step: ' + i + ', value: intermediateStep' + i + ', recordedAt: nowIsoString(' + seed + ') });');
  codeLines.push('    return runningTotal;', '  }', '', '  refundCustomer(transactionId) {');
  for (let i = 0; i < 16; i += 1) codeLines.push('    const reversalEntry' + i + ' = validate(transactionId, this.option' + (i % 7) + ', ' + (i + seed) + ');');
  codeLines.push('    return reversalReceipt;', '  }', '}', '', 'module.exports = { Processor' + seed + ' };');
  const diffLines = ['--- a/lib/pay' + seed + '.cjs', '+++ b/lib/pay' + seed + '.cjs', '@@ -1,40 +1,42 @@'];
  const changeAt = (20 + seed) % 40;
  for (let i = 0; i < 40; i += 1) {
    if (i === changeAt) { diffLines.push('-  const fee = base * 0.1;'); diffLines.push('+  const fee = base * 0.15; // FATAL pricing change ' + seed); }
    else diffLines.push(' context line ' + i + ' unchanged surrounding code that adds bulk to the hunk');
  }
  const sfx = '-s' + seed;
  return [
    { name: 'json-array-with-error' + sfx, text: JSON.stringify(jsonItems), critical: ['connection refused to db-primary shard ' + seed] },
    { name: 'build-log-with-fatal' + sfx, text: logLines.join('\n'), critical: ['FATAL migration ' + String(42 + seed).padStart(4, '0') + ' failed', 'duplicate key value violates unique constraint'] },
    { name: 'grep-search-results' + sfx, text: searchLines.join('\n'), critical: ['src/auth/login' + seed + '.cjs:88', 'invalid credentials'] },
    { name: 'unified-diff' + sfx, text: diffLines.join('\n'), critical: ['FATAL pricing change ' + seed, '0.15'] },
    { name: 'source-code' + sfx, text: codeLines.join('\n'), critical: ['class Processor' + seed + ' {', 'throw new Error("invalid charge amount")', 'module.exports = { Processor' + seed + ' };'] },
  ];
}

const SCALE_SEEDS = Object.freeze({ small: 1, medium: 12, large: 60 });

function buildCorpusScale(size) {
  if (size === 'small' || !size) return buildCorpus();
  const seeds = SCALE_SEEDS[size];
  if (!seeds) throw new Error('unknown corpus size "' + size + '" (small|medium|large)');
  const out = [];
  for (let s = 0; s < seeds; s += 1) out.push(..._variantFixtures(s));
  return out;
}

function _arm(name, holdoutRatio) {
  const h = crypto.createHash('sha256').update(String(name)).digest('hex').slice(0, 8);
  const frac = parseInt(h, 16) / 0x100000000;
  return frac < holdoutRatio ? 'control' : 'treatment';
}

function runScale(opts) {
  const o = opts || {};
  const size = o.size || 'medium';
  const holdoutRatio = Number.isFinite(o.holdoutRatio) ? o.holdoutRatio : 0.2;
  let corpus = buildCorpusScale(size);
  if (Number.isFinite(o.maxCases) && o.maxCases > 0) corpus = corpus.slice(0, o.maxCases);

  const arms = { control: [], treatment: [] };
  const strata = {};
  for (const fixture of corpus) {
    const arm = _arm(fixture.name, holdoutRatio);
    const c = fidelityCase(fixture, o);
    c.arm = arm;
    arms[arm].push(c);
    if (arm !== 'treatment') continue;
    const t = c.type;
    if (!strata[t]) strata[t] = { type: t, n: 0, bytes_before: 0, bytes_after: 0, invariants_ok: true };
    strata[t].n += 1;
    strata[t].bytes_before += c.bytes_before;
    strata[t].bytes_after += c.bytes_after;
    if (!c.ok) strata[t].invariants_ok = false;
  }

  const sum = (list, k) => list.reduce((s, c) => s + c[k], 0);
  const savedPct = (before, after) => (before ? Math.round((1 - after / before) * 100) : 0);
  const tBefore = sum(arms.treatment, 'bytes_before');
  const tAfter = sum(arms.treatment, 'bytes_after');
  const tSaved = savedPct(tBefore, tAfter);
  const cSaved = arms.control.length ? savedPct(sum(arms.control, 'bytes_before'), sum(arms.control, 'bytes_after')) : null;
  const tOk = arms.treatment.every((c) => c.ok);
  const cOk = arms.control.every((c) => c.ok);

  return {
    strata: Object.values(strata).map((s) => Object.assign({}, s, { saved_pct: savedPct(s.bytes_before, s.bytes_after) })),
    summary: {
      size,
      fixtures: corpus.length,
      holdout_ratio: holdoutRatio,
      control_n: arms.control.length,
      treatment_n: arms.treatment.length,
      treatment_saved_pct: tSaved,
      control_saved_pct: cSaved,
      generalization_gap_pct: cSaved === null ? null : Math.abs(tSaved - cSaved),
      savings_est: tokenCost.summarizeSavings({ bytesBefore: tBefore, bytesAfter: tAfter, charsPerToken: o.charsPerToken, pricePerMTok: o.pricePerMTok, currency: o.currency }),
      treatment_invariants_ok: tOk,
      control_invariants_ok: cOk,
      invariants_ok: tOk && cOk,
      failed: arms.treatment.concat(arms.control).filter((c) => !c.ok).map((c) => c.name),
    },
  };
}

function _tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-elision-bench-'));
  const storeFn = (text, type) => {
    try { return elision.store(text, { type }, dir); }
    catch { return null; }
  };
  return { dir, storeFn };
}

function fidelityCase(fixture, opts) {
  const o = opts || {};
  const { dir, storeFn } = _tmpStore();
  try {
    const res = compress.compressBlock(fixture.text, {
      minBlockBytes: Number.isFinite(o.minBlockBytes) ? o.minBlockBytes : undefined,
      store: storeFn,
    });
    const before = _bytes(fixture.text);
    const after = _bytes(res.compressed);
    const crit = (fixture.critical && fixture.critical.length) ? fixture.critical : criticalLines(fixture.text);
    const critPreserved = crit.every((l) => res.compressed.includes(l));
    let reversible = !res.changed;
    let retrievalExact = !res.changed;
    if (res.changed) {
      const m = res.compressed.match(MARKER_HASH_RE);
      if (m) {
        const back = elision.retrieve(m[1], dir);
        retrievalExact = back.status === 'ok' && back.original === fixture.text;
        reversible = retrievalExact;
      } else {
        reversible = false;
        retrievalExact = false;
      }
    }
    return {
      name: fixture.name,
      type: res.type,
      changed: res.changed,
      bytes_before: before,
      bytes_after: after,
      ratio: before ? after / before : 1,
      saved_pct: before ? Math.round((1 - after / before) * 100) : 0,
      critical_total: crit.length,
      critical_preserved: critPreserved,
      reversible,
      retrieval_exact: retrievalExact,
      ok: critPreserved && reversible && retrievalExact,
    };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function runFidelity(opts) {
  const o = opts || {};
  const corpus = (o.corpus && o.corpus.length) ? o.corpus : buildCorpus();
  const cases = corpus.map((f) => fidelityCase(f, o));
  const totBefore = cases.reduce((s, c) => s + c.bytes_before, 0);
  const totAfter = cases.reduce((s, c) => s + c.bytes_after, 0);
  return {
    cases,
    summary: {
      fixtures: cases.length,
      compressed: cases.filter((c) => c.changed).length,
      avg_ratio: cases.length ? cases.reduce((s, c) => s + c.ratio, 0) / cases.length : 1,
      total_saved_pct: totBefore ? Math.round((1 - totAfter / totBefore) * 100) : 0,
      invariants_ok: cases.every((c) => c.ok),
      failed: cases.filter((c) => !c.ok).map((c) => c.name),
    },
  };
}

function buildEqCases() {
  const corpus = buildCorpus();
  const byName = Object.fromEntries(corpus.map((f) => [f.name, f.text]));
  return [
    { name: 'find-the-error-item', context: byName['json-array-with-error'],
      question: 'Which item id has status "error", and what is its message? Answer concisely.',
      must_contain: ['41', 'connection refused'] },
    { name: 'find-the-fatal', context: byName['build-log-with-fatal'],
      question: 'What FATAL error occurred during migration, and which migration number?',
      must_contain: ['0042', 'duplicate key'] },
  ];
}

function _expandToolSchema() {
  return [{
    type: 'function',
    function: {
      name: 'context-expand',
      description: 'Retrieve the full original text behind a ⟦elided:<hash>⟧ marker. Pass the 12-char hash.',
      parameters: { type: 'object', properties: { hash: { type: 'string' } }, required: ['hash'] },
    },
  }];
}

async function _ask(chat, provider, context, question, dir, useTools) {
  const sys = 'You answer strictly from the provided context. If a ⟦elided:<hash>⟧ marker hides '
    + 'detail you need, call context-expand with the hash. Be concise.';
  const messages = [
    { role: 'system', content: sys },
    { role: 'user', content: 'Context:\n' + context + '\n\nQuestion: ' + question },
  ];
  const tools = useTools ? _expandToolSchema() : undefined;
  for (let i = 0; i < 4; i += 1) {
    const resp = await chat({ ...provider, messages, tools });
    if (!resp.toolCalls || !resp.toolCalls.length) return resp.content || '';
    messages.push({ role: 'assistant', content: resp.content || '', tool_calls: resp.toolCalls.map((tc) => ({
      id: tc.id, type: 'function', function: { name: tc.name, arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || {}) },
    })) });
    for (const tc of resp.toolCalls) {
      let out = 'Error: unknown tool';
      if (tc.name === 'context-expand') {
        const a = typeof tc.arguments === 'string' ? JSON.parse(tc.arguments || '{}') : (tc.arguments || {});
        const r = elision.retrieve(a.hash, dir);
        out = r.status === 'ok' ? r.original : 'Error: ' + r.status;
      }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: out });
    }
  }
  const last = messages[messages.length - 1];
  return (last && typeof last.content === 'string') ? last.content : '';
}

function _hasAll(answer, needles) {
  const a = String(answer).toLowerCase();
  return needles.every((n) => a.includes(String(n).toLowerCase()));
}

async function runEquivalence(args) {
  const a = args || {};
  const chat = a.chatImpl;
  const provider = a.provider;
  if (typeof chat !== 'function' || !provider) {
    throw new Error('runEquivalence requires { chatImpl, provider }');
  }
  const cases = (a.cases && a.cases.length) ? a.cases : buildEqCases();
  const { dir, storeFn } = _tmpStore();
  const out = [];
  try {
    for (const c of cases) {
      const res = compress.compressBlock(c.context, { minBlockBytes: a.minBlockBytes, store: storeFn });
      const compressed = res.changed ? res.compressed : c.context;
      const rawAns = await _ask(chat, provider, c.context, c.question, dir, false);
      const cmpAns = await _ask(chat, provider, compressed, c.question, dir, true);
      const rawOk = _hasAll(rawAns, c.must_contain);
      const cmpOk = _hasAll(cmpAns, c.must_contain);
      out.push({
        name: c.name, compressed_block: res.changed, type: res.type,
        raw_ok: rawOk, compressed_ok: cmpOk, equivalent: rawOk === cmpOk,
        regression: rawOk && !cmpOk,
      });
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  return {
    cases: out,
    summary: {
      cases: out.length,
      equivalent: out.filter((c) => c.equivalent).length,
      regressions: out.filter((c) => c.regression).map((c) => c.name),
      no_regression: out.every((c) => !c.regression),
    },
  };
}

function formatReport(report) {
  const lines = [];
  lines.push('Elision fidelity — ' + report.summary.compressed + '/' + report.summary.fixtures
    + ' fixtures crushed, avg ratio ' + report.summary.avg_ratio.toFixed(2)
    + ', total ' + report.summary.total_saved_pct + '% saved, invariants '
    + (report.summary.invariants_ok ? 'OK' : 'FAILED: ' + report.summary.failed.join(', ')));
  for (const c of report.cases) {
    lines.push('  ' + (c.ok ? '✓' : '✗') + ' ' + c.name.padEnd(24) + ' [' + c.type + '] '
      + c.saved_pct + '% saved, ' + c.critical_total + ' critical line(s) '
      + (c.critical_preserved ? 'kept' : 'LOST') + ', '
      + (c.reversible ? 'reversible' : 'IRREVERSIBLE'));
  }
  return lines.join('\n');
}

function formatScale(report) {
  const s = report.summary;
  const lines = [];
  lines.push('Elision scale fidelity — size=' + s.size + ', ' + s.fixtures + ' fixtures, holdout '
    + Math.round(s.holdout_ratio * 100) + '% (' + s.control_n + ' control / ' + s.treatment_n + ' treatment)');
  lines.push('  treatment: ' + s.treatment_saved_pct + '% saved, invariants ' + (s.treatment_invariants_ok ? 'OK' : 'FAILED')
    + ' · held-out control: ' + (s.control_saved_pct === null ? 'n/a' : s.control_saved_pct + '% saved, invariants ' + (s.control_invariants_ok ? 'OK' : 'FAILED'))
    + (s.generalization_gap_pct === null ? '' : ' · generalization gap ' + s.generalization_gap_pct + '%')
    + (s.failed.length ? ' · failed: ' + s.failed.join(', ') : ''));
  if (s.savings_est) {
    const e = s.savings_est;
    lines.push('  est. saved: ~' + e.tokens_saved_est.toLocaleString('en-US') + ' tokens (treatment, @ ' + e.chars_per_token + ' chars/tok)'
      + (e.cost_saved_est !== undefined ? ' ≈ ' + e.cost_saved_est + ' ' + e.currency + ' @ ' + e.price_per_mtok + '/Mtok' : ' — pass --price-per-mtok for a cost estimate'));
  }
  for (const st of report.strata.sort((a, b) => a.type.localeCompare(b.type))) {
    lines.push('  ' + (st.invariants_ok ? '✓' : '✗') + ' ' + st.type.padEnd(12) + ' n=' + String(st.n).padEnd(4) + st.saved_pct + '% saved');
  }
  return lines.join('\n');
}

module.exports = {
  CRITICAL_RE,
  criticalLines,
  buildCorpus,
  buildCorpusScale,
  buildEqCases,
  fidelityCase,
  runFidelity,
  runScale,
  runEquivalence,
  formatReport,
  formatScale,
};
