'use strict';

const { NubosPilotError } = require('../../lib/core.cjs');

function getFlag(rest, name, opts) {
  const idx = rest.indexOf(name);
  if (idx === -1) return undefined;
  const next = rest[idx + 1];
  const allowDash = opts && opts.allowDashValues === true;
  if (!allowDash && typeof next === 'string' && next.startsWith('--')) {
    return undefined;
  }
  return next;
}

function positionalArgs(rest, valuedFlags) {
  const list = Array.isArray(rest) ? rest : [];
  const valued = new Set(valuedFlags || []);
  return list.filter(
    (a, i) => a && !String(a).startsWith('--') && !valued.has(list[i - 1]),
  );
}

function getJsonFlag(rest, name, missingCode, hint) {
  const raw = getFlag(rest, name);
  if (raw === undefined) {
    throw new NubosPilotError(
      missingCode,
      name + ' is required',
      hint ? { hint } : {},
    );
  }
  try { return JSON.parse(raw); }
  catch (err) {
    throw new NubosPilotError(
      missingCode + '-invalid-json',
      name + ' must be valid JSON',
      { cause: err && err.message },
    );
  }
}

function optionalJsonFlag(rest, name) {
  const raw = getFlag(rest, name);
  if (raw === undefined) return undefined;
  try { return JSON.parse(raw); }
  catch (err) {
    throw new NubosPilotError(
      'arg-invalid-json',
      name + ' must be valid JSON when provided',
      { cause: err && err.message, flag: name },
    );
  }
}

function assertMatch(value, re, code, label) {
  if (typeof value !== 'string' || !re.test(value)) {
    throw new NubosPilotError(
      code,
      label + ' must match ' + re.toString() + ' (got ' + JSON.stringify(value) + ')',
      { value },
    );
  }
}

function assertOptionalMatch(value, re, code, label) {
  if (value == null) return;
  assertMatch(value, re, code, label);
}

function emitErrorEnvelope(err, stderr, fallbackCode) {
  const code = err && err.name === 'NubosPilotError' ? err.code : fallbackCode;
  const message = (err && err.message) || String(err);
  const details = (err && err.details) || null;
  stderr.write(JSON.stringify({ code, message, details }) + '\n');
}

module.exports = {
  getFlag,
  positionalArgs,
  getJsonFlag,
  optionalJsonFlag,
  assertMatch,
  assertOptionalMatch,
  emitErrorEnvelope,
};
