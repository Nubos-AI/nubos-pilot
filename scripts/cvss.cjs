'use strict';

const AV = Object.freeze({ N: 0.85, A: 0.62, L: 0.55, P: 0.2 });
const AC = Object.freeze({ L: 0.77, H: 0.44 });
const PR_UNCHANGED = Object.freeze({ N: 0.85, L: 0.62, H: 0.27 });
const PR_CHANGED = Object.freeze({ N: 0.85, L: 0.68, H: 0.5 });
const UI = Object.freeze({ N: 0.85, R: 0.62 });
const CIA = Object.freeze({ H: 0.56, L: 0.22, N: 0 });

const REQUIRED = Object.freeze(['AV', 'AC', 'PR', 'UI', 'S', 'C', 'I', 'A']);

function parseVector(vector) {
  const raw = String(vector == null ? '' : vector).trim();
  if (!/^CVSS:3\.[01]\//.test(raw)) return null;
  const metrics = {};
  for (const part of raw.split('/').slice(1)) {
    const eq = part.indexOf(':');
    if (eq <= 0) continue;
    metrics[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).toUpperCase();
  }
  for (const key of REQUIRED) {
    if (metrics[key] === undefined) return null;
  }
  return metrics;
}

function _roundUp(input) {
  const scaled = Math.round(input * 100000);
  if (scaled % 10000 === 0) return scaled / 100000;
  return (Math.floor(scaled / 10000) + 1) / 10;
}

function baseScore(vector) {
  const m = parseVector(vector);
  if (!m) return null;

  const changed = m.S === 'C';
  const av = AV[m.AV];
  const ac = AC[m.AC];
  const pr = (changed ? PR_CHANGED : PR_UNCHANGED)[m.PR];
  const ui = UI[m.UI];
  const c = CIA[m.C];
  const i = CIA[m.I];
  const a = CIA[m.A];
  if ([av, ac, pr, ui, c, i, a].some((v) => v === undefined)) return null;

  const iss = 1 - ((1 - c) * (1 - i) * (1 - a));
  const impact = changed
    ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15)
    : 6.42 * iss;
  if (impact <= 0) return 0;

  const exploitability = 8.22 * av * ac * pr * ui;
  const combined = changed
    ? Math.min(1.08 * (impact + exploitability), 10)
    : Math.min(impact + exploitability, 10);
  return _roundUp(combined);
}

function severityFromScore(score) {
  if (!Number.isFinite(score)) return null;
  if (score >= 9.0) return 'critical';
  if (score >= 7.0) return 'high';
  if (score >= 4.0) return 'medium';
  if (score > 0) return 'low';
  return 'info';
}

function severityFromVector(vector) {
  return severityFromScore(baseScore(vector));
}

module.exports = { parseVector, baseScore, severityFromScore, severityFromVector };
