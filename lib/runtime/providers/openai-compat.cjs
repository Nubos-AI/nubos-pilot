'use strict';

const { NubosPilotError } = require('../../core.cjs');

const DEFAULT_TIMEOUT_MS = 120000;

function _hostOf(url) {
  try { return new URL(url).host; } catch { return 'provider'; }
}

function _parse(json) {
  const choice = json && Array.isArray(json.choices) ? json.choices[0] : null;
  const msg = (choice && choice.message) ? choice.message : {};
  const toolCalls = Array.isArray(msg.tool_calls)
    ? msg.tool_calls.map((tc, i) => ({
        id: (tc && tc.id) || ('call_' + i),
        name: tc && tc.function && tc.function.name,
        arguments: tc && tc.function && tc.function.arguments,
      }))
    : [];
  const usage = (json && json.usage) ? {
    tokens_in: typeof json.usage.prompt_tokens === 'number' ? json.usage.prompt_tokens : null,
    tokens_out: typeof json.usage.completion_tokens === 'number' ? json.usage.completion_tokens : null,
  } : null;
  return {
    content: typeof msg.content === 'string' ? msg.content : '',
    toolCalls,
    finishReason: (choice && choice.finish_reason) || null,
    usage,
    raw: msg,
  };
}

async function chat({ baseUrl, apiKeyEnv, model, messages, tools, effort, timeoutMs, fetchImpl, env }) {
  if (typeof baseUrl !== 'string' || !baseUrl) {
    throw new NubosPilotError('provider-no-base-url', 'openai-compat chat requires a base_url', {});
  }
  if (typeof model !== 'string' || !model) {
    throw new NubosPilotError('provider-no-model', 'openai-compat chat requires a model', {});
  }
  const f = fetchImpl || globalThis.fetch;
  if (typeof f !== 'function') {
    throw new NubosPilotError('provider-no-fetch', 'global fetch unavailable (node >=22 required)', {});
  }
  const e = env || process.env;
  const headers = { 'content-type': 'application/json' };
  if (apiKeyEnv) {
    const key = e[apiKeyEnv];
    if (!key) {
      throw new NubosPilotError(
        'provider-missing-api-key',
        'env var ' + apiKeyEnv + ' is empty or unset',
        { apiKeyEnv },
      );
    }
    headers.authorization = 'Bearer ' + key;
  }

  const body = { model, messages, stream: false };
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  if (typeof effort === 'string' && effort) body.reasoning_effort = effort;

  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const host = _hostOf(url);

  let res;
  try {
    res = await f(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs || DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    throw new NubosPilotError(
      'provider-request-failed',
      'request to ' + host + ' failed (' + ((err && (err.code || err.name)) || 'error') + ')',
      { host, cause: (err && (err.code || err.name)) || 'unknown' },
    );
  }

  if (!res.ok) {
    let snippet = '';
    try { snippet = (await res.text()).slice(0, 300); } catch {}
    throw new NubosPilotError(
      'provider-http-error',
      host + ' returned HTTP ' + res.status,
      { host, status: res.status, body: snippet },
    );
  }

  let json;
  try { json = await res.json(); }
  catch {
    throw new NubosPilotError('provider-bad-json', host + ' returned a non-JSON body', { host });
  }
  return _parse(json);
}

module.exports = { chat, _parse, _hostOf, DEFAULT_TIMEOUT_MS };
