'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { walk, DEFAULT_EXCLUDES, DEFAULT_LIMITS } = require('./walk.cjs');

function withTree(files, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-walk-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function lineMatcher(name, needle) {
  return {
    name,
    onLine(line, lineNumber, ctx) {
      if (line.includes(needle)) return { path: ctx.relPath, line: lineNumber, text: line };
      return null;
    },
  };
}

function fileLister(name) {
  return { name, onFile(ctx) { return ctx.relPath; } };
}

test('WALK-1 one traversal feeds every registered extractor the same file', () => {
  withTree({ 'src/a.js': 'const token = "AKIA";\nWHY: because\n' }, (root) => {
    const secrets = lineMatcher('secrets', 'AKIA');
    const notes = lineMatcher('notes', 'WHY:');
    const { results, stats } = walk(root, [secrets, notes]);

    assert.equal(stats.filesVisited, 1);
    assert.deepEqual(results.get('secrets').map((f) => f.line), [1]);
    assert.deepEqual(results.get('notes').map((f) => f.line), [2]);
    assert.equal(results.get('secrets')[0].path, 'src/a.js');
    assert.equal(results.get('notes')[0].path, 'src/a.js');
  });
});

test('WALK-2 a throwing extractor is isolated and the healthy one keeps its findings', () => {
  withTree({ 'a.txt': 'needle here\n', 'b.txt': 'needle again\n' }, (root) => {
    const broken = {
      name: 'broken',
      onLine() { throw new Error('boom'); },
      onFileEnd() { return 'should-not-be-collected'; },
    };
    const healthy = lineMatcher('healthy', 'needle');
    const { results, warnings, stats } = walk(root, [broken, healthy]);

    assert.equal(stats.filesVisited, 2);
    assert.equal(results.get('healthy').length, 2);
    assert.deepEqual(results.get('broken'), []);
    const failures = warnings.filter((w) => w.code === 'walk-extractor-failed');
    assert.equal(failures.length, 2);
    assert.equal(failures[0].extractor, 'broken');
    assert.equal(failures[0].hook, 'onLine');
    assert.match(failures[0].cause, /boom/);
  });
});

test('WALK-3 no extractor defines onLine so the file is never split into lines', () => {
  withTree({ 'a.txt': 'one\ntwo\nthree\n', 'nested/b.txt': 'four\nfive\n' }, (root) => {
    const { results, stats } = walk(root, [fileLister('lister')]);

    assert.equal(stats.filesVisited, 2);
    assert.equal(stats.linesScanned, 0);
    assert.deepEqual(results.get('lister'), ['a.txt', 'nested/b.txt']);
  });
});

test('WALK-4 default excludes prune node_modules and generated artefacts', () => {
  withTree({
    'src/app.js': 'needle\n',
    'node_modules/pkg/index.js': 'needle\n',
    'dist/bundle.js': 'needle\n',
    'coverage/report.txt': 'needle\n',
    'src/vendor.min.js': 'needle\n',
    'package-lock.json': 'needle\n',
  }, (root) => {
    const { results } = walk(root, [lineMatcher('m', 'needle')]);
    assert.deepEqual(results.get('m').map((f) => f.path), ['src/app.js']);
    assert.ok(DEFAULT_EXCLUDES.includes('**/node_modules/**'));
  });
});

test('WALK-5 a binary file is skipped without reaching any extractor', () => {
  const bin = Buffer.alloc(64);
  for (let i = 0; i < bin.length; i++) bin[i] = i % 2 === 0 ? 0x00 : 0x41;
  withTree({ 'a.txt': 'needle\n', 'blob.dat': bin }, (root) => {
    const { results, stats } = walk(root, [lineMatcher('m', 'needle')]);
    assert.equal(stats.filesVisited, 1);
    assert.equal(stats.filesSkipped, 1);
    assert.deepEqual(results.get('m').map((f) => f.path), ['a.txt']);
  });
});

test('WALK-6 maxFiles cap stops the walk cleanly with a named warning', () => {
  withTree({
    'a.txt': 'needle\n', 'b.txt': 'needle\n', 'c.txt': 'needle\n', 'd.txt': 'needle\n',
  }, (root) => {
    const { results, stats, warnings } = walk(root, [lineMatcher('m', 'needle')], { maxFiles: 2 });
    assert.equal(stats.filesVisited, 2);
    assert.deepEqual(results.get('m').map((f) => f.path), ['a.txt', 'b.txt']);
    const hit = warnings.find((w) => w.code === 'walk-max-files');
    assert.equal(hit.cap, 'maxFiles');
    assert.equal(hit.limit, 2);
  });
});

test('WALK-7 maxFileBytes skips only the oversized file and warns', () => {
  withTree({ 'a-big.txt': 'x'.repeat(500) + '\n', 'b-small.txt': 'needle\n' }, (root) => {
    const { results, stats, warnings } = walk(root, [lineMatcher('m', 'needle')], { maxFileBytes: 100 });
    assert.equal(stats.filesVisited, 1);
    assert.equal(stats.filesSkipped, 1);
    assert.deepEqual(results.get('m').map((f) => f.path), ['b-small.txt']);
    const hit = warnings.find((w) => w.code === 'walk-file-too-large');
    assert.equal(hit.cap, 'maxFileBytes');
    assert.equal(hit.path, 'a-big.txt');
  });
});

test('WALK-8 maxTotalBytes stops the walk and returns what was gathered', () => {
  withTree({ 'a.txt': 'needle'.padEnd(100, '.'), 'b.txt': 'needle'.padEnd(100, '.') }, (root) => {
    const { results, stats, warnings } = walk(root, [lineMatcher('m', 'needle')], { maxTotalBytes: 150 });
    assert.equal(stats.filesVisited, 1);
    assert.equal(stats.bytesRead, 100);
    assert.deepEqual(results.get('m').map((f) => f.path), ['a.txt']);
    const hit = warnings.find((w) => w.code === 'walk-max-total-bytes');
    assert.equal(hit.cap, 'maxTotalBytes');
    assert.equal(hit.limit, 150);
  });
});

test('WALK-9 a symlinked file is skipped by default', () => {
  withTree({ 'real.txt': 'needle\n' }, (root) => {
    fs.symlinkSync(path.join(root, 'real.txt'), path.join(root, 'link.txt'));
    const { results, stats, warnings } = walk(root, [lineMatcher('m', 'needle')]);
    assert.equal(stats.filesVisited, 1);
    assert.equal(stats.filesSkipped, 1);
    assert.deepEqual(results.get('m').map((f) => f.path), ['real.txt']);
    const hit = warnings.find((w) => w.code === 'walk-symlink-skipped');
    assert.equal(hit.kind, 'file');
    assert.equal(hit.path, 'link.txt');
  });
});

test('WALK-10 a symlinked directory is skipped by default with a warning', () => {
  withTree({ 'real/inner.txt': 'needle\n' }, (root) => {
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'alias'));
    const { results, stats, warnings } = walk(root, [lineMatcher('m', 'needle')]);
    assert.equal(stats.filesVisited, 1);
    assert.deepEqual(results.get('m').map((f) => f.path), ['real/inner.txt']);
    const hit = warnings.find((w) => w.code === 'walk-symlink-skipped');
    assert.equal(hit.kind, 'directory');
    assert.equal(hit.path, 'alias');
  });
});

test('WALK-11 traversal order is deterministic across runs', () => {
  withTree({
    'z.txt': 'needle\n',
    'a.txt': 'needle\n',
    'm/2.txt': 'needle\n',
    'm/1.txt': 'needle\n',
    'b/deep/x.txt': 'needle\n',
  }, (root) => {
    const first = walk(root, [lineMatcher('m', 'needle')]);
    const second = walk(root, [lineMatcher('m', 'needle')]);
    const paths = (r) => r.results.get('m').map((f) => f.path);
    assert.deepEqual(paths(first), paths(second));
    assert.deepEqual(paths(first), ['a.txt', 'b/deep/x.txt', 'm/1.txt', 'm/2.txt', 'z.txt']);
    assert.deepEqual(first.stats, second.stats);
  });
});

test('WALK-12 nested directories are descended to any depth', () => {
  withTree({ 'a/b/c/d/deep.txt': 'needle\n', 'a/top.txt': 'needle\n' }, (root) => {
    const { results, stats } = walk(root, [lineMatcher('m', 'needle')]);
    assert.equal(stats.filesVisited, 2);
    assert.deepEqual(results.get('m').map((f) => f.path), ['a/b/c/d/deep.txt', 'a/top.txt']);
  });
});

test('WALK-13 an empty file is visited but yields no lines', () => {
  withTree({ 'empty.txt': '', 'full.txt': 'needle\n' }, (root) => {
    const { results, stats } = walk(root, [lineMatcher('m', 'needle')]);
    assert.equal(stats.filesVisited, 2);
    assert.equal(stats.linesScanned, 1);
    assert.deepEqual(results.get('m').map((f) => f.path), ['full.txt']);
  });
});

test('WALK-14 CRLF line endings split cleanly without a trailing carriage return', () => {
  withTree({ 'crlf.txt': 'alpha\r\nneedle\r\nomega\r\n' }, (root) => {
    const { results, stats } = walk(root, [lineMatcher('m', 'needle')]);
    assert.equal(stats.linesScanned, 3);
    assert.equal(results.get('m').length, 1);
    assert.equal(results.get('m')[0].line, 2);
    assert.equal(results.get('m')[0].text, 'needle');
  });
});

test('WALK-15 relPath uses forward slashes and ctx carries ext and size', () => {
  withTree({ 'deep/sub/File.TXT': 'needle\n' }, (root) => {
    const seen = [];
    const { results } = walk(root, [{
      name: 'ctx',
      onFile(ctx) { seen.push(ctx); return null; },
      onFileEnd(ctx) { return ctx.relPath; },
    }]);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].relPath, 'deep/sub/File.TXT');
    assert.ok(!seen[0].relPath.includes('\\'));
    assert.equal(seen[0].ext, '.txt');
    assert.equal(seen[0].size, 7);
    assert.equal(seen[0].file, path.join(root, 'deep', 'sub', 'File.TXT'));
    assert.deepEqual(results.get('ctx'), ['deep/sub/File.TXT']);
  });
});

test('WALK-16 hooks may return a single item or an array and both land in results', () => {
  withTree({ 'a.txt': 'one\ntwo\n' }, (root) => {
    const { results } = walk(root, [{
      name: 'multi',
      onFile() { return 'from-onFile'; },
      onLine(line) { return [line + '-a', line + '-b', null]; },
      onFileEnd() { return ['end-1', 'end-2']; },
    }]);
    assert.deepEqual(results.get('multi'), [
      'from-onFile', 'one-a', 'one-b', 'two-a', 'two-b', 'end-1', 'end-2',
    ]);
  });
});

test('WALK-17 include globs narrow the walk and count the rest as skipped', () => {
  withTree({ 'a.js': 'needle\n', 'b.md': 'needle\n', 'sub/c.js': 'needle\n' }, (root) => {
    const { results, stats } = walk(root, [lineMatcher('m', 'needle')], { include: ['**/*.js'] });
    assert.deepEqual(results.get('m').map((f) => f.path), ['a.js', 'sub/c.js']);
    assert.equal(stats.filesSkipped, 1);
  });
});

test('WALK-18 invalid root and invalid extractors raise NubosPilotError', () => {
  withTree({ 'a.txt': 'x\n' }, (root) => {
    assert.throws(() => walk(root, []), { code: 'walk-no-extractors' });
    assert.throws(() => walk(root, [{ onLine() {} }]), { code: 'walk-invalid-extractor' });
    assert.throws(
      () => walk(root, [fileLister('dup'), fileLister('dup')]),
      { code: 'walk-duplicate-extractor' },
    );
    assert.throws(() => walk(root, [{ name: 'noop' }]), { code: 'walk-extractor-without-hooks' });
    assert.throws(() => walk(path.join(root, 'missing'), [fileLister('l')]), { code: 'walk-root-unreadable' });
    assert.throws(() => walk(path.join(root, 'a.txt'), [fileLister('l')]), { code: 'walk-root-not-a-directory' });
    assert.throws(() => walk('', [fileLister('l')]), { code: 'walk-invalid-root' });
  });
});

test('WALK-19 followSymlinks still refuses to escape the root', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'np-walk-out-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-walk-in-'));
  try {
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'needle\n');
    fs.writeFileSync(path.join(root, 'own.txt'), 'needle\n');
    fs.symlinkSync(outside, path.join(root, 'escape'));

    const { results, stats, warnings } = walk(root, [lineMatcher('m', 'needle')], { followSymlinks: true });
    assert.equal(stats.filesVisited, 1);
    assert.deepEqual(results.get('m').map((f) => f.path), ['own.txt']);
    assert.ok(warnings.some((w) => w.code === 'walk-symlink-outside-root'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('WALK-20 followSymlinks detects a cycle instead of looping forever', () => {
  withTree({ 'sub/a.txt': 'needle\n' }, (root) => {
    fs.symlinkSync(root, path.join(root, 'sub', 'loop'));
    const { results, stats, warnings } = walk(root, [lineMatcher('m', 'needle')], { followSymlinks: true });
    assert.equal(stats.filesVisited, 1);
    assert.deepEqual(results.get('m').map((f) => f.path), ['sub/a.txt']);
    assert.ok(warnings.some((w) => w.code === 'walk-symlink-cycle'));
  });
});

test('WALK-21 default limits are the documented fail-safe values', () => {
  assert.deepEqual(DEFAULT_LIMITS, {
    maxFileBytes: 1024 * 1024,
    maxTotalBytes: 64 * 1024 * 1024,
    maxFiles: 5000,
  });
  assert.throws(() => { DEFAULT_LIMITS.maxFiles = 1; }, TypeError);
});
