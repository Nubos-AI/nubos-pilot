const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { runAgentLoop, DEFAULT_MAX_ITERATIONS } = require('./agent-loop.cjs');
const { toolsetFor } = require('./tools/index.cjs');
const elision = require('../elision.cjs');

function _bigLog() {
  const lines = [];
  for (let i = 0; i < 300; i++) {
    if (i % 73 === 0) lines.push('ERROR: boom at module_' + i);
    else lines.push('[info] step ' + i + ' ok processed record ' + (i * 7) + ' ' + 'x'.repeat(30));
  }
  return lines.join('\n');
}

const _dirs = [];
function _ws(files) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'np-loop-')));
  for (const [rel, content] of Object.entries(files || {})) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }
  _dirs.push(root);
  return root;
}
afterEach(() => { while (_dirs.length) { try { fs.rmSync(_dirs.pop(), { recursive: true, force: true }); } catch {} } });

function _scriptedChat(turns) {
  let i = 0;
  const seen = [];
  const fn = async ({ messages }) => {
    seen.push(JSON.parse(JSON.stringify(messages)));
    const t = turns[Math.min(i, turns.length - 1)];
    i++;
    if (t.toolCalls) {
      return { content: t.content || '', toolCalls: t.toolCalls, finishReason: 'tool_calls', raw: { role: 'assistant', content: t.content || '', tool_calls: t.toolCalls.map((c) => ({ id: c.id, function: { name: c.name, arguments: c.arguments } })) } };
    }
    return { content: t.content, toolCalls: [], finishReason: 'stop', raw: { role: 'assistant', content: t.content } };
  };
  fn.seen = seen;
  return fn;
}

test('AL-1: a final-answer turn returns immediately, stopped=final', async () => {
  const chatImpl = _scriptedChat([{ content: 'done' }]);
  const out = await runAgentLoop({
    systemPrompt: 'you are x', task: 'do it',
    toolset: toolsetFor(['Read']), provider: { baseUrl: 'http://x/v1', model: 'm' }, chatImpl,
  });
  assert.equal(out.content, 'done');
  assert.equal(out.stopped, 'final');
  assert.equal(out.iterations, 1);
});

test('AL-2: a tool call is executed in the workspace and fed back, then a final answer', async () => {
  const cwd = _ws({ 'data.txt': 'hello' });
  const chatImpl = _scriptedChat([
    { toolCalls: [{ id: 't1', name: 'Read', arguments: '{"path":"data.txt"}' }] },
    { content: 'the file says hello' },
  ]);
  const out = await runAgentLoop({
    systemPrompt: 's', task: 'read data.txt', cwd,
    toolset: toolsetFor(['Read']), provider: { baseUrl: 'http://x/v1', model: 'm' }, chatImpl,
  });
  assert.equal(out.stopped, 'final');
  assert.equal(out.iterations, 2);
  assert.deepEqual(out.toolLog, [{ name: 'Read', ok: true }]);
  const lastTurnMsgs = chatImpl.seen[1];
  const toolMsg = lastTurnMsgs.find((m) => m.role === 'tool');
  assert.equal(toolMsg.tool_call_id, 't1');
  assert.equal(toolMsg.content, '1\thello');
});

test('AL-3: a failing tool call returns an error string, ok=false, loop continues', async () => {
  const cwd = _ws({});
  const chatImpl = _scriptedChat([
    { toolCalls: [{ id: 't1', name: 'Read', arguments: '{"path":"missing.txt"}' }] },
    { content: 'could not read' },
  ]);
  const out = await runAgentLoop({
    systemPrompt: 's', task: 't', cwd,
    toolset: toolsetFor(['Read']), provider: { baseUrl: 'http://x/v1', model: 'm' }, chatImpl,
  });
  assert.equal(out.toolLog[0].ok, false);
  assert.equal(out.stopped, 'final');
});

test('AL-4: a model that never stops hits the iteration cap', async () => {
  const cwd = _ws({ 'a.txt': 'x' });
  const chatImpl = _scriptedChat([{ toolCalls: [{ id: 't', name: 'Read', arguments: '{"path":"a.txt"}' }] }]);
  const out = await runAgentLoop({
    systemPrompt: 's', task: 't', cwd, maxIterations: 3,
    toolset: toolsetFor(['Read']), provider: { baseUrl: 'http://x/v1', model: 'm' }, chatImpl,
  });
  assert.equal(out.stopped, 'max-iterations');
  assert.equal(out.iterations, 3);
  assert.equal(out.toolLog.length, 3);
});

test('AL-5: missing toolset / provider throw loud', async () => {
  let a = null; try { await runAgentLoop({ provider: { model: 'm' } }); } catch (e) { a = e; }
  assert.equal(a.code, 'agent-loop-no-toolset');
  let b = null; try { await runAgentLoop({ toolset: toolsetFor(['Read']) }); } catch (e) { b = e; }
  assert.equal(b.code, 'agent-loop-no-provider');
});

test('AL-6: DEFAULT_MAX_ITERATIONS is a sane positive cap', () => {
  assert.ok(DEFAULT_MAX_ITERATIONS >= 1 && DEFAULT_MAX_ITERATIONS <= 100);
});

test('AL-8: compression default OFF — tool result enters history verbatim, no blocks compressed', async () => {
  const cwd = _ws({ 'log.txt': _bigLog() });
  const chatImpl = _scriptedChat([
    { toolCalls: [{ id: 't1', name: 'Read', arguments: '{"path":"log.txt"}' }] },
    { content: 'done' },
  ]);
  const out = await runAgentLoop({
    systemPrompt: 's', task: 't', cwd,
    toolset: toolsetFor(['Read']), provider: { baseUrl: 'http://x/v1', model: 'm' }, chatImpl,
  });
  const toolMsg = chatImpl.seen[1].find((m) => m.role === 'tool');
  assert.ok(!toolMsg.content.includes('⟦elided:'), 'no marker when compression off');
  assert.equal(out.compression.blocks_compressed, 0);
  assert.equal(out.compression.bytes_after, out.compression.bytes_before);
});

test('AL-9: compression ON — large tool result is crushed in history, original retrievable from Elision store', async () => {
  const cwd = _ws({
    'log.txt': _bigLog(),
    '.nubos-pilot/config.json': JSON.stringify({ compression: { enabled: true } }),
  });
  const chatImpl = _scriptedChat([
    { toolCalls: [{ id: 't1', name: 'Read', arguments: '{"path":"log.txt"}' }] },
    { content: 'done' },
  ]);
  const out = await runAgentLoop({
    systemPrompt: 's', task: 't', cwd,
    toolset: toolsetFor(['Read']), provider: { baseUrl: 'http://x/v1', model: 'm' }, chatImpl,
  });
  const toolMsg = chatImpl.seen[1].find((m) => m.role === 'tool');
  assert.equal(out.compression.blocks_compressed, 1);
  assert.ok(out.compression.bytes_after < out.compression.bytes_before, 'history shrank');
  const m = toolMsg.content.match(/⟦elided:([a-f0-9]{12})/);
  assert.ok(m, 'marker with hash present in history');
  const back = elision.retrieve(m[1], cwd);
  assert.equal(back.status, 'ok');
  assert.ok(back.original.includes('ERROR: boom at module_0'), 'original recoverable byte-for-byte');
});

test('AL-10: end-to-end — model retrieves an elided original mid-loop via context-expand', async () => {
  const cwd = _ws({
    'log.txt': _bigLog(),
    '.nubos-pilot/config.json': JSON.stringify({ compression: { enabled: true } }),
  });
  let expanded = null;
  const chat = async ({ messages }) => {
    chat.n = (chat.n || 0) + 1;
    if (chat.n === 1) {
      return { content: '', finishReason: 'tool_calls', toolCalls: [{ id: 'r1', name: 'Read', arguments: '{"path":"log.txt"}' }] };
    }
    if (chat.n === 2) {
      const toolMsg = messages.filter((m) => m.role === 'tool').pop();
      const hash = toolMsg.content.match(/⟦elided:([a-f0-9]{12})/)[1];
      return { content: '', finishReason: 'tool_calls', toolCalls: [{ id: 'r2', name: 'context-expand', arguments: JSON.stringify({ hash }) }] };
    }
    expanded = messages.filter((m) => m.role === 'tool').pop().content;
    return { content: 'done', finishReason: 'stop', toolCalls: [] };
  };
  const out = await runAgentLoop({
    systemPrompt: 's', task: 't', cwd,
    toolset: toolsetFor(['Read'], { withExpand: true }), provider: { baseUrl: 'http://x/v1', model: 'm' }, chatImpl: chat,
  });
  assert.equal(out.stopped, 'final');
  assert.ok(expanded.includes('ERROR: boom at module_0'), 'model recovered the full original byte-for-byte');
  assert.ok(!expanded.includes('⟦elided:'), 'the expanded original carries no marker');
});

test('AL-7: assistant echo is rebuilt in OpenAI wire shape; ids round-trip even if provider omits them', async () => {
  const cwd = _ws({ 'a.txt': 'A', 'b.txt': 'B' });
  const chatImpl = async ({ messages }) => {
    chatImpl.seen = (chatImpl.seen || []).concat([JSON.parse(JSON.stringify(messages))]);
    if (!chatImpl.called) {
      chatImpl.called = true;
      return {
        content: '', finishReason: 'tool_calls',
        toolCalls: [
          { id: 'call_0', name: 'Read', arguments: '{"path":"a.txt"}' },
          { id: 'call_1', name: 'Read', arguments: '{"path":"b.txt"}' },
        ],
        raw: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'Read' } }] },
      };
    }
    return { content: 'done', toolCalls: [], finishReason: 'stop', raw: { role: 'assistant', content: 'done' } };
  };
  const out = await runAgentLoop({
    systemPrompt: 's', task: 't', cwd,
    toolset: toolsetFor(['Read']), provider: { baseUrl: 'http://x/v1', model: 'm' }, chatImpl,
  });
  assert.equal(out.stopped, 'final');
  const secondTurn = chatImpl.seen[1];
  const assistant = secondTurn.find((m) => m.role === 'assistant' && m.tool_calls);
  assert.equal(assistant.tool_calls[0].type, 'function');
  assert.equal(assistant.tool_calls[0].function.name, 'Read');
  assert.deepEqual(assistant.tool_calls.map((c) => c.id), ['call_0', 'call_1']);
  const toolMsgs = secondTurn.filter((m) => m.role === 'tool');
  assert.deepEqual(toolMsgs.map((m) => m.tool_call_id), ['call_0', 'call_1']);
});

test('AL-12: output_steering ON — system prompt is enriched and mechanical turns downgrade effort', async () => {
  const cwd = _ws({
    'a.txt': 'A',
    '.nubos-pilot/config.json': JSON.stringify({
      compression: {
        enabled: true,
        output_steering: { enabled: true, verbosity_profile: 'terse', effort_routing: { enabled: true, base_effort: 'high', mechanical_effort: 'low' } },
      },
    }),
  });
  const seen = [];
  const chatImpl = async (args) => {
    seen.push({ effort: args.effort, system: (args.messages.find((m) => m.role === 'system') || {}).content });
    if (seen.length === 1) {
      return { content: '', finishReason: 'tool_calls', toolCalls: [{ id: 'c0', name: 'Read', arguments: '{"path":"a.txt"}' }], raw: { role: 'assistant', content: '' } };
    }
    return { content: 'done', toolCalls: [], finishReason: 'stop', raw: { role: 'assistant', content: 'done' } };
  };
  const out = await runAgentLoop({
    systemPrompt: 'you are x', task: 't', cwd,
    toolset: toolsetFor(['Read']), provider: { baseUrl: 'http://x/v1', model: 'm', effort: 'high' }, chatImpl,
  });
  assert.equal(out.stopped, 'final');
  assert.match(seen[0].system, /<nubos_output_shaping>[\s\S]*<\/nubos_output_shaping>$/, 'system prompt carries the shaping block');
  assert.equal(seen[0].effort, 'high', 'first turn (new user ask) keeps full effort');
  assert.equal(seen[1].effort, 'low', 'second turn (clean tool result) downgrades to low');
});
