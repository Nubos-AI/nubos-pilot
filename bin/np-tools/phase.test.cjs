const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');

const phaseCli = require('./phase.cjs');

const _sandboxes = [];

function makeSink() {
  const chunks = [];
  const w = new Writable({
    write(chunk, _enc, cb) { chunks.push(chunk); cb(); },
  });
  w.toString = () => Buffer.concat(chunks.map((c) => Buffer.isBuffer(c) ? c : Buffer.from(String(c)))).toString('utf-8');
  return w;
}

function makeSandboxWithRoadmap(yaml) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-phase-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  fs.writeFileSync(path.join(root, '.nubos-pilot', 'roadmap.yaml'), yaml);
  _sandboxes.push(root);
  return root;
}

test.afterEach(() => {
  while (_sandboxes.length) {
    try { fs.rmSync(_sandboxes.pop(), { recursive: true, force: true }); } catch {  }
  }
});

test('PHASE-1: next-decimal 999 on empty roadmap → 999.1', () => {
  const sb = makeSandboxWithRoadmap('milestones:\n  - id: v1.0\n    name: v1\n    phases: []\n');
  const stdout = makeSink();
  const stderr = makeSink();
  const code = phaseCli.run(['next-decimal', '999', '--raw'], { cwd: sb, stdout, stderr });
  assert.equal(code, 0);
  assert.equal(stdout.toString(), '999.1');
});

test('PHASE-2: next-decimal scans existing 999.1 and 999.3 → 999.4', () => {
  const yaml = [
    'milestones:',
    '  - id: backlog',
    '    name: Backlog',
    '    phases:',
    '      - number: "999.1"',
    '        name: First',
    '        slug: first',
    '      - number: "999.3"',
    '        name: Third',
    '        slug: third',
  ].join('\n') + '\n';
  const sb = makeSandboxWithRoadmap(yaml);
  const stdout = makeSink();
  const stderr = makeSink();
  const code = phaseCli.run(['next-decimal', '999', '--raw'], { cwd: sb, stdout, stderr });
  assert.equal(code, 0);
  assert.equal(stdout.toString(), '999.4');
});

test('PHASE-3: invalid base rejected with phase-invalid-base', () => {
  const sb = makeSandboxWithRoadmap('milestones: []\n');
  const stdout = makeSink();
  const stderr = makeSink();
  const code = phaseCli.run(['next-decimal', 'abc'], { cwd: sb, stdout, stderr });
  assert.equal(code, 1);
  assert.match(stderr.toString(), /"code":\s*"phase-invalid-base"/);
});

test('PHASE-4: unknown subcommand prints usage', () => {
  const sb = makeSandboxWithRoadmap('milestones: []\n');
  const stdout = makeSink();
  const stderr = makeSink();
  const code = phaseCli.run(['unknown', '1'], { cwd: sb, stdout, stderr });
  assert.equal(code, 1);
  assert.match(stderr.toString(), /Usage:/);
});
