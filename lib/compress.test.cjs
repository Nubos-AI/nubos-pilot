'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const compress = require('./compress.cjs');

function bigJsonArray(n, withError) {
  const arr = [];
  for (let i = 0; i < n; i += 1) arr.push({ id: i, name: 'row-' + i, status: 'ok' });
  if (withError) arr[Math.floor(n / 2)] = { id: 999, name: 'boom', status: 'ERROR: disk full' };
  return JSON.stringify(arr);
}

test('CMP-1: detectType classifies json/diff/search/log/plain', () => {
  assert.equal(compress.detectType(bigJsonArray(30)), 'json-array');
  assert.equal(compress.detectType('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n'), 'diff');
  const search = Array.from({ length: 8 }, (_, i) => 'src/a.js:' + (i + 1) + ':match').join('\n');
  assert.equal(compress.detectType(search), 'search');
  const log = Array.from({ length: 12 }, (_, i) => 'INFO line ' + i).concat('ERROR boom').join('\n');
  assert.equal(compress.detectType(log), 'log');
  assert.equal(compress.detectType('just some short prose'), 'plain');
});

test('CMP-2: crushJsonArray drops middle but keeps error item + head + tail', () => {
  const res = compress.crushJsonArray(bigJsonArray(60, true));
  assert.ok(res, 'should compress a 60-item array');
  assert.ok(res.dropped > 0);
  const kept = JSON.parse(res.compressed);
  assert.ok(kept.length < 60);
  assert.ok(kept.some((it) => /ERROR/.test(JSON.stringify(it))), 'error item survives');
  assert.equal(kept[0].id, 0, 'head preserved');
});

test('CMP-3: adversarial — small array is not worth compressing (null)', () => {
  assert.equal(compress.crushJsonArray(bigJsonArray(5)), null);
});

test('CMP-4: crushLog keeps ERROR + stack lines, drops INFO noise', () => {
  const lines = [];
  for (let i = 0; i < 200; i += 1) lines.push('INFO progress ' + i);
  lines.push('ERROR something failed');
  lines.push('    at foo (bar.js:1:1)');
  const res = compress.crushLog(lines.join('\n'));
  assert.ok(res && res.dropped > 0);
  assert.match(res.compressed, /ERROR something failed/);
  assert.match(res.compressed, /at foo/);
  assert.match(res.compressed, /elided/);
});

test('CMP-5: crushSearch caps matches per file', () => {
  const lines = [];
  for (let i = 1; i <= 40; i += 1) lines.push('src/big.js:' + i + ':hit ' + i);
  const res = compress.crushSearch(lines.join('\n'));
  assert.ok(res && res.dropped > 0);
  assert.ok(res.compressed.split('\n').length <= 30);
});

test('CMP-6: crushDiff keeps every +/- line', () => {
  const diff = [
    '--- a/x.js', '+++ b/x.js', '@@ -1,6 +1,6 @@',
    ' ctx1', ' ctx2', ' ctx3', ' ctx4', '-removed', '+added', ' ctx5', ' ctx6', ' ctx7', ' ctx8',
  ].join('\n');
  const res = compress.crushDiff(diff);
  assert.ok(res && res.dropped > 0);
  assert.match(res.compressed, /-removed/);
  assert.match(res.compressed, /\+added/);
});

test('CMP-7: compressBlock leaves small/plain text byte-identical', () => {
  const small = 'hello world';
  const out = compress.compressBlock(small, { minBlockBytes: 2048 });
  assert.equal(out.changed, false);
  assert.equal(out.compressed, small);
});

test('CMP-8: compressBlock appends a Elision marker when a store is provided', () => {
  const seen = [];
  const out = compress.compressBlock(bigJsonArray(80, true), {
    minBlockBytes: 100,
    store: (orig, type) => { seen.push(type); return 'abcdef012345'; },
  });
  assert.equal(out.changed, true);
  assert.match(out.compressed, /⟦elided:abcdef012345 \d+ items elided · \d+ flagged kept · retrieve: nubos elision-get abcdef012345⟧/);
  assert.deepEqual(seen, ['json-array']);
});

test('CMP-9: compressPrompt only touches fenced blocks and is deterministic', () => {
  const blob = 'intro text\n\n```json\n' + bigJsonArray(80, true) + '\n```\n\noutro text';
  const a = compress.compressPrompt(blob, { minBlockBytes: 100, store: () => 'aaaaaaaaaaaa' });
  const b = compress.compressPrompt(blob, { minBlockBytes: 100, store: () => 'aaaaaaaaaaaa' });
  assert.equal(a.stats.blocks_compressed, 1);
  assert.ok(a.stats.bytes_after < a.stats.bytes_before);
  assert.match(a.text, /^intro text/);
  assert.match(a.text, /outro text$/);
  assert.equal(a.text, b.text, 'deterministic');
});

test('CMP-10: compressPrompt with no large blocks leaves the blob unchanged', () => {
  const blob = 'just a normal prompt with `tiny` inline code and no big fences.';
  const out = compress.compressPrompt(blob, { minBlockBytes: 2048, store: () => 'x' });
  assert.equal(out.stats.blocks_compressed, 0);
  assert.equal(out.text, blob);
});

function gutter(text) {
  return text.split('\n').map((l, i) => (i + 1) + '\t' + l).join('\n');
}

test('CMP-12: detectType sees through a line-number gutter (Read-tool style N\\t prefix)', () => {
  const diff = '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n';
  assert.equal(compress.detectType(gutter(diff)), 'diff');
  assert.equal(compress.detectType(gutter(bigJsonArray(30))), 'json-array');
  const search = Array.from({ length: 8 }, (_, i) => 'src/a.js:' + (i + 1) + ':match').join('\n');
  assert.equal(compress.detectType(gutter(search)), 'search');
});

test('CMP-13: compressBlock crushes a gutter-prefixed diff and stores the raw original', () => {
  const diffLines = ['--- a/x.js', '+++ b/x.js', '@@ -1,6 +1,6 @@'];
  for (let i = 0; i < 60; i += 1) diffLines.push(' ctx unchanged line ' + i + ' ' + 'z'.repeat(40));
  diffLines.push('-removed thing'); diffLines.push('+added thing');
  const raw = gutter(diffLines.join('\n'));
  let stored = null;
  const out = compress.compressBlock(raw, {
    minBlockBytes: 100,
    store: (orig, type) => { stored = { orig, type }; return 'abcdef012345'; },
  });
  assert.equal(out.changed, true);
  assert.equal(out.type, 'diff');
  assert.ok(out.compressed.length < raw.length, 'gutter-prefixed diff now compresses');
  assert.equal(stored.orig, raw, 'raw gutter-bearing original is stored byte-exact');
});

test('CMP-14: crushCode keeps signatures/closers + throw, elides statement bodies', () => {
  const lines = ['class Svc {', '  run(input) {'];
  for (let i = 0; i < 30; i += 1) lines.push('    const v' + i + ' = compute(input, ' + i + ');');
  lines.push('    if (!input) throw new Error("missing input");');
  for (let i = 0; i < 10; i += 1) lines.push('    this.acc.push({ k: ' + i + ', v: v' + i + ' });');
  lines.push('    return this.acc;', '  }', '}');
  const text = lines.join('\n');
  const out = compress.crushCode(text);
  assert.ok(out, 'a body-heavy class should crush');
  assert.match(out.compressed, /class Svc \{/);
  assert.match(out.compressed, /run\(input\) \{/);
  assert.match(out.compressed, /throw new Error\("missing input"\)/);
  assert.ok(!out.compressed.includes('const v15 ='), 'deep statement bodies are elided');
  assert.ok(!out.compressed.includes('this.acc.push({ k: 5'), 'inline object-literal statements are elided');
  assert.ok(out.compressed.length < text.length);
});

test('CMP-15: detectType reads source as "code" even with throw new Error (code before log)', () => {
  const lines = ["'use strict';", "const x = require('./x.cjs');", 'function handler(req) {'];
  for (let i = 0; i < 20; i += 1) lines.push('  const part' + i + ' = transform(req, ' + i + ');');
  lines.push('  if (!req) throw new Error("bad request");', '  return part0;', '}');
  assert.equal(compress.detectType(lines.join('\n')), 'code');
});

function bigProse(withCritical) {
  const filler = 'The pipeline reads each source block and routes it to a type-specific reducer. '
    + 'Ordinary statements are sampled while structural lines survive intact. '
    + 'This keeps the crushed view legible without changing the stored original. ';
  let text = filler.repeat(12);
  if (withCritical) text += 'IMPORTANT: the retention window must never be shortened below the audit floor. ';
  text += filler.repeat(12);
  return text;
}

test('CMP-16: detectType classifies long prose as "prose", short prose stays "plain"', () => {
  assert.equal(compress.detectType('just some short prose'), 'plain');
  assert.equal(compress.detectType(bigProse(true)), 'prose');
});

test('CMP-17: crushProse keeps head + tail + critical sentence, samples the middle', () => {
  const res = compress.crushProse(bigProse(true));
  assert.ok(res && res.dropped > 0, 'a long prose block should crush');
  assert.match(res.compressed, /IMPORTANT: the retention window must never be shortened/);
  assert.match(res.compressed, /elided/);
  assert.ok(res.compressed.length < bigProse(true).length);
});

test('CMP-18: brace counter is not fooled by braces inside strings/comments', () => {
  const lines = ['function build(cfg) {'];
  for (let i = 0; i < 20; i += 1) {
    lines.push('  const tmpl' + i + ' = "open { and close } in a string";  // a } comment brace');
  }
  lines.push('  if (!cfg) throw new Error("no cfg");');
  lines.push('  return tmpl0;', '}');
  const text = lines.join('\n');
  assert.equal(compress.detectType(text), 'code');
  const out = compress.crushCode(text);
  assert.ok(out && out.dropped > 0, 'string/comment braces must not block crushing');
  assert.match(out.compressed, /function build\(cfg\) \{/);
  assert.match(out.compressed, /throw new Error\("no cfg"\)/);
  assert.ok(!out.compressed.includes('tmpl15'), 'interior statements are still elided');
});

test('CMP-19: Python is detected as code and crushed by indent, not braces', () => {
  const lines = ['import os', '', 'class Worker:', '    def run(self, items):'];
  for (let i = 0; i < 25; i += 1) lines.push('        value_' + i + ' = transform(items, ' + i + ')');
  lines.push('        if not items:', '            raise ValueError("empty")');
  lines.push('        return value_0');
  const text = lines.join('\n');
  assert.equal(compress.detectType(text), 'code');
  const out = compress.crushCode(text);
  assert.ok(out && out.dropped > 0, 'a body-heavy Python method should crush');
  assert.match(out.compressed, /class Worker:/);
  assert.match(out.compressed, /def run\(self, items\):/);
  assert.match(out.compressed, /raise ValueError\("empty"\)/);
  assert.match(out.compressed, /^import os/m);
  assert.ok(!out.compressed.includes('value_15 ='), 'deep statement bodies are elided');
});

test('CMP-20: compressBlock routes prose through crushProse and stores the raw original', () => {
  let stored = null;
  const out = compress.compressBlock(bigProse(true), {
    minBlockBytes: 100,
    store: (orig, type) => { stored = { orig, type }; return 'beadfeed1234'; },
  });
  assert.equal(out.changed, true);
  assert.equal(out.type, 'prose');
  assert.equal(stored.orig, bigProse(true), 'raw prose original is stored byte-exact');
  assert.match(out.compressed, /⟦elided:beadfeed1234 \d+ sentences elided/);
});

test('CMP-22: crushers emit a terse "what survived" summary used in the speaking marker', () => {
  const logLines = [];
  for (let i = 0; i < 200; i += 1) logLines.push('INFO progress ' + i);
  logLines.push('ERROR boom', '    at f (a.js:1:1)');
  assert.match(compress.crushLog(logLines.join('\n')).summary, /error\/stack line/);

  const searchLines = [];
  for (let i = 1; i <= 40; i += 1) searchLines.push('src/big.js:' + i + ':hit ' + i);
  assert.match(compress.crushSearch(searchLines.join('\n')).summary, /\d+\/\d+ files/);

  const code = ['class S {', '  run() {'];
  for (let i = 0; i < 30; i += 1) code.push('    const v' + i + ' = f(' + i + ');');
  code.push('    return v0;', '  }', '}');
  assert.match(compress.crushCode(code.join('\n')).summary, /signature/);

  const out = compress.compressBlock(bigJsonArray(80, true), { minBlockBytes: 100, store: () => 'abcdef012345' });
  assert.match(out.compressed, /elided · .+ · retrieve:/, 'marker carries the gist between count and retrieve hint');
});

test('CMP-21: store opted-in but failing (null hash) declines compression — never a markerless lossy view', () => {
  const out = compress.compressBlock(bigJsonArray(80, true), {
    minBlockBytes: 100,
    store: () => null,
  });
  assert.equal(out.changed, false, 'must not apply lossy compression without a recovery path');
  assert.equal(out.compressed, bigJsonArray(80, true), 'original returned byte-identical');
  assert.ok(!/elided/.test(out.compressed), 'no elision marker, no dropped content');
});

test('CMP-11: crushLogToBudget fits the byte budget and keeps errors', () => {
  const lines = [];
  for (let i = 0; i < 500; i += 1) lines.push('INFO noise line number ' + i);
  lines.push('ERROR the real failure is here');
  const out = compress.crushLogToBudget(lines.join('\n'), 500);
  assert.ok(Buffer.byteLength(out, 'utf-8') <= 500);
  assert.match(out, /ERROR the real failure/);
});

test('CMP-23: crushLogToBudget terminates on a single over-budget line with no newline', () => {
  const oneLine = 'ERROR ' + 'x'.repeat(5000);
  const out = compress.crushLogToBudget(oneLine, 500);
  assert.ok(out.length <= 500);
});
