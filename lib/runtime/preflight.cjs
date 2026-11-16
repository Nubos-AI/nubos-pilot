'use strict';

const { NubosPilotError } = require('../core.cjs');
const { _hostOf } = require('./providers/openai-compat.cjs');

const DEFAULT_PREFLIGHT_TIMEOUT_MS = 10000;

function _isLocal(baseUrl) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i.test(baseUrl || '');
}

async function preflight({ baseUrl, apiKeyEnv, model, fetchImpl, env, timeoutMs }) {
  const out = { ok: false, reachable: false, modelPresent: false, models: [], hint: null, host: 'provider' };
  if (typeof baseUrl !== 'string' || !baseUrl) {
    out.hint = 'provider has no base_url';
    return out;
  }
  const f = fetchImpl || globalThis.fetch;
  const e = env || process.env;
  const url = baseUrl.replace(/\/+$/, '') + '/models';
  out.host = _hostOf(url);

  const headers = {};
  if (apiKeyEnv && e[apiKeyEnv]) headers.authorization = 'Bearer ' + e[apiKeyEnv];

  let res;
  try {
    res = await f(url, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs || DEFAULT_PREFLIGHT_TIMEOUT_MS) });
  } catch {
    out.hint = 'cannot reach ' + out.host
      + (_isLocal(baseUrl) ? ' — is the model server running? (e.g. `ollama serve`)' : ' — check base_url / network');
    return out;
  }
  if (!res.ok) {
    out.hint = out.host + ' returned HTTP ' + res.status + ' for /models';
    return out;
  }
  out.reachable = true;

  let json = null;
  try { json = await res.json(); } catch {}
  const data = json && Array.isArray(json.data) ? json.data : [];
  out.models = data.map((m) => m && m.id).filter((id) => typeof id === 'string');

  out.modelPresent = !model || out.models.includes(model);
  if (!out.modelPresent) {
    out.hint = 'model "' + model + '" not available on ' + out.host
      + (_isLocal(baseUrl) ? ' — run: ollama pull ' + model : ' — check the model name / your access');
    return out;
  }

  out.ok = true;
  return out;
}

async function assertPreflight(args) {
  const r = await preflight(args);
  if (!r.ok) {
    throw new NubosPilotError(
      'preflight-failed',
      r.hint || ('preflight failed for ' + r.host),
      { host: r.host, reachable: r.reachable, modelPresent: r.modelPresent, model: args && args.model },
    );
  }
  return r;
}

module.exports = { preflight, assertPreflight, _isLocal, DEFAULT_PREFLIGHT_TIMEOUT_MS };
