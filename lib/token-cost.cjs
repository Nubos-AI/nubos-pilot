'use strict';

const DEFAULT_CHARS_PER_TOKEN = 4;

function _round(n) {
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function estimateTokens(bytes, charsPerToken) {
  const cpt = Number.isFinite(charsPerToken) && charsPerToken > 0 ? charsPerToken : DEFAULT_CHARS_PER_TOKEN;
  return Math.max(0, _round((Number(bytes) || 0) / cpt));
}

function estimateCost(tokens, pricePerMTok) {
  if (!Number.isFinite(pricePerMTok) || pricePerMTok <= 0) return null;
  return (Number(tokens) || 0) / 1e6 * pricePerMTok;
}

function summarizeSavings(opts) {
  const o = opts || {};
  const before = Number(o.bytesBefore) || 0;
  const after = Number(o.bytesAfter) || 0;
  const bytesSaved = Math.max(0, before - after);
  const cpt = Number.isFinite(o.charsPerToken) && o.charsPerToken > 0 ? o.charsPerToken : DEFAULT_CHARS_PER_TOKEN;
  const tokensSaved = estimateTokens(bytesSaved, cpt);
  const cost = estimateCost(tokensSaved, o.pricePerMTok);
  const out = {
    bytes_saved: bytesSaved,
    chars_per_token: cpt,
    tokens_saved_est: tokensSaved,
    saved_pct: before ? Math.round((bytesSaved / before) * 100) : 0,
  };
  if (cost !== null) {
    out.price_per_mtok = o.pricePerMTok;
    out.currency = typeof o.currency === 'string' && o.currency ? o.currency : 'USD';
    out.cost_saved_est = Math.round(cost * 10000) / 10000;
  }
  return out;
}

module.exports = {
  DEFAULT_CHARS_PER_TOKEN,
  estimateTokens,
  estimateCost,
  summarizeSavings,
};
