'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { NubosPilotError } = require('./core.cjs');


function assertInsideBase(base, candidate, label) {
  if (typeof base !== 'string' || typeof candidate !== 'string') {
    throw new NubosPilotError(
      'safe-path-invalid-input',
      'assertInsideBase requires string base and candidate',
      { label: label || null },
    );
  }
  const baseResolved = path.resolve(base);
  let baseReal;
  try { baseReal = fs.realpathSync(baseResolved); }
  catch (err) {
    throw new NubosPilotError(
      'safe-path-base-missing',
      'assertInsideBase: base does not resolve to a real directory',
      { label: label || null, base: path.basename(baseResolved), cause: (err && err.code) || 'unknown' },
    );
  }
  const candAbs = path.isAbsolute(candidate) ? candidate : path.resolve(base, candidate);
  let probe = candAbs;
  let realProbe = null;
  const root = path.parse(probe).root;
  while (probe !== root) {
    try { realProbe = fs.realpathSync(probe); break; }
    catch {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  if (!realProbe) {
    realProbe = baseReal;
    probe = baseResolved;
  }
  const compareAgainst = candAbs === probe
    ? realProbe
    : path.join(realProbe, candAbs.slice(probe.length));
  const normCompare = path.normalize(compareAgainst);
  const normBase = path.normalize(baseReal);
  if (!(normCompare === normBase || normCompare.startsWith(normBase + path.sep))) {
    throw new NubosPilotError(
      'safe-path-outside-base',
      (label || 'path') + ' must resolve inside ' + path.basename(baseResolved),
      {
        label: label || null,
        base: path.basename(baseResolved),
        candidate: path.basename(candAbs),
      },
    );
  }
  return candAbs;
}

function assertInsideAnyOf(bases, candidate, label) {
  if (!Array.isArray(bases) || bases.length === 0) {
    throw new NubosPilotError(
      'safe-path-invalid-input',
      'assertInsideAnyOf requires non-empty bases array',
      { label: label || null },
    );
  }
  let lastErr;
  for (const b of bases) {
    try { return assertInsideBase(b, candidate, label); }
    catch (err) { lastErr = err; }
  }
  throw new NubosPilotError(
    'safe-path-outside-base',
    (label || 'path') + ' must resolve inside one of ' + bases.map((b) => path.basename(b)).join(' / '),
    {
      label: label || null,
      bases: bases.map((b) => path.basename(b)),
      candidate: path.basename(path.resolve(candidate)),
      lastCode: lastErr && lastErr.code,
    },
  );
}

const _IDENT_RE = /^[a-zA-Z0-9_-]+$/;

function assertSafeIdentifier(name, label) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 128 || !_IDENT_RE.test(name)) {
    throw new NubosPilotError(
      'safe-path-invalid-identifier',
      (label || 'identifier') + ' must match /^[a-zA-Z0-9_-]+$/ (1..128 chars)',
      { label: label || null, sample: typeof name === 'string' ? name.slice(0, 40) : typeof name },
    );
  }
  return name;
}

const _GIT_REF_RE = /^[A-Za-z0-9_./-]+$/;

function assertSafeGitRef(ref, label) {
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > 256
      || ref.startsWith('-') || !_GIT_REF_RE.test(ref)
      || ref.includes('..')) {
    throw new NubosPilotError(
      'safe-path-invalid-git-ref',
      (label || 'git ref') + ' rejected (must be ascii alphanumerics + ._/- , no leading -, no ".." segment)',
      { label: label || null, sample: typeof ref === 'string' ? ref.slice(0, 40) : typeof ref },
    );
  }
  return ref;
}

function assertSafeFlagValue(value, flag, opts) {
  const allowDashValues = !!(opts && opts.allowDashValues);
  if (typeof value !== 'string' || value.length === 0) {
    throw new NubosPilotError(
      'safe-path-missing-flag-value',
      'flag ' + flag + ' requires a non-empty value',
      { flag },
    );
  }
  if (!allowDashValues && value.startsWith('--')) {
    throw new NubosPilotError(
      'safe-path-flag-value-looks-like-flag',
      'flag ' + flag + ' value looks like another flag — reject to avoid arg-shifting',
      { flag, sample: value.slice(0, 40) },
    );
  }
  return value;
}

function assertInsideCwdOrTmp(candidate, cwd, label, errorCode) {
  const tmp = process.env.TMPDIR || '/tmp';
  try {
    return assertInsideAnyOf([cwd, tmp], candidate, label);
  } catch (err) {
    if (err && err.code === 'safe-path-outside-base') {
      throw new NubosPilotError(
        errorCode,
        label + ' must resolve inside cwd or TMPDIR',
        { label, cause: err.code, file: path.basename(candidate) },
      );
    }
    throw err;
  }
}

module.exports = {
  assertInsideBase,
  assertInsideAnyOf,
  assertInsideCwdOrTmp,
  assertSafeIdentifier,
  assertSafeGitRef,
  assertSafeFlagValue,
};
