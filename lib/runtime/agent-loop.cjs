'use strict';

const { NubosPilotError } = require('../core.cjs');
const compress = require('../compress.cjs');
const elision = require('../elision.cjs');
const steering = require('../output-steering.cjs');
const { EXPAND_TOOL_NAME } = require('./tools/index.cjs');

const DEFAULT_MAX_ITERATIONS = 25;

function _compressToolResult(text, cx) {
  if (!cx || !cx.enabled || typeof cx.store !== 'function') return text;
  try {
    const res = compress.compressBlock(text, { minBlockBytes: cx.minBlockBytes, store: cx.store });
    return (res && res.changed) ? res.compressed : text;
  } catch {
    return text;
  }
}

async function runAgentLoop(a) {
  const {
    systemPrompt, task, toolset, provider, cwd,
    maxIterations, chatImpl,
  } = a || {};
  if (!toolset || typeof toolset.execute !== 'function') {
    throw new NubosPilotError('agent-loop-no-toolset', 'runAgentLoop requires a toolset with execute()', {});
  }
  if (!provider || typeof provider.model !== 'string') {
    throw new NubosPilotError('agent-loop-no-provider', 'runAgentLoop requires a provider with a model', {});
  }
  const chat = chatImpl || require('./providers/openai-compat.cjs').chat;
  const max = Math.max(1, maxIterations || DEFAULT_MAX_ITERATIONS);
  const schemas = (toolset.schemas && toolset.schemas.length) ? toolset.schemas : undefined;

  const cx = elision.compressionContext(cwd);
  const os = cx.outputSteering || { enabled: false, effortRouting: false };
  const compression = { tool_results: 0, blocks_compressed: 0, bytes_before: 0, bytes_after: 0 };

  const messages = [];
  if (systemPrompt) {
    const sys = os.enabled ? steering.enrichSystemPrompt(String(systemPrompt), os.profile) : String(systemPrompt);
    messages.push({ role: 'system', content: sys });
  }
  messages.push({ role: 'user', content: String(task == null ? '' : task) });

  const toolLog = [];

  for (let i = 0; i < max; i++) {
    const turnProvider = os.effortRouting
      ? { ...provider, effort: steering.routeEffort(provider.effort, steering.classifyTurn(messages), { mechanicalEffort: os.mechanicalEffort }) }
      : provider;
    const resp = await chat({ ...turnProvider, messages, tools: schemas });

    if (!resp.toolCalls || resp.toolCalls.length === 0) {
      return { content: resp.content || '', iterations: i + 1, stopped: 'final', toolLog, compression };
    }

    messages.push({
      role: 'assistant',
      content: resp.content || '',
      tool_calls: resp.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || {}),
        },
      })),
    });

    for (const tc of resp.toolCalls) {
      const raw = String(toolset.execute(tc.name, tc.arguments, { cwd: cwd || process.cwd() }));
      toolLog.push({ name: tc.name, ok: !raw.startsWith('Error:') });
      const stored = tc.name === EXPAND_TOOL_NAME ? raw : _compressToolResult(raw, cx);
      compression.tool_results += 1;
      compression.bytes_before += Buffer.byteLength(raw, 'utf-8');
      compression.bytes_after += Buffer.byteLength(stored, 'utf-8');
      if (stored !== raw) compression.blocks_compressed += 1;
      messages.push({ role: 'tool', tool_call_id: tc.id, content: stored });
    }
  }

  const last = messages[messages.length - 1];
  return {
    content: (last && typeof last.content === 'string') ? last.content : '',
    iterations: max,
    stopped: 'max-iterations',
    toolLog,
    compression,
  };
}

module.exports = { runAgentLoop, DEFAULT_MAX_ITERATIONS };
