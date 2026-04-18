const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');

const codeReviewCli = require('./code-review.cjs');

const _sandboxes = [];

function makeSink() {
  const chunks = [];
  const w = new Writable({
    write(chunk, _enc, cb) { chunks.push(chunk); cb(); },
  });
  w.toString = () => Buffer.concat(chunks.map((c) => Buffer.isBuffer(c) ? c : Buffer.from(String(c)))).toString('utf-8');
  return w;
}

function makeSandbox(yaml) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-code-review-'));
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

const DEMO_YAML = [
  'milestones:',
  '  - id: v1.0',
  '    name: v1',
  '    phases:',
  '      - number: 10',
  '        name: Review Utility',
  '        slug: review-utility',
  '        status: in-progress',
].join('\n') + '\n';

test('CR-1: happy path emits code-review payload with default depth standard', () => {
  const sb = makeSandbox(DEMO_YAML);
  const stdout = makeSink();
  const stderr = makeSink();
  const code = codeReviewCli.run(['10'], { cwd: sb, stdout, stderr });
  assert.equal(code, 0, 'stderr=' + stderr.toString());
  const parsed = JSON.parse(stdout.toString());
  assert.equal(parsed._workflow, 'code-review');
  assert.equal(parsed.phase, '10');
  assert.equal(parsed.padded, '10');
  assert.equal(parsed.depth, 'standard');
  assert.ok(parsed.review_path.endsWith('10-REVIEW.md'));
  assert.ok(parsed.agents && parsed.agents.code_reviewer === 'np-code-reviewer');
});

test('CR-2: --depth=deep overrides default', () => {
  const sb = makeSandbox(DEMO_YAML);
  const stdout = makeSink();
  const stderr = makeSink();
  const code = codeReviewCli.run(['10', '--depth=deep'], { cwd: sb, stdout, stderr });
  assert.equal(code, 0);
  const parsed = JSON.parse(stdout.toString());
  assert.equal(parsed.depth, 'deep');
});

test('CR-3: invalid depth rejected with code-review-invalid-depth', () => {
  const sb = makeSandbox(DEMO_YAML);
  const stdout = makeSink();
  const stderr = makeSink();
  const code = codeReviewCli.run(['10', '--depth=sloppy'], { cwd: sb, stdout, stderr });
  assert.equal(code, 1);
  assert.match(stderr.toString(), /"code":\s*"code-review-invalid-depth"/);
});

test('CR-4: unknown phase rejected with code-review-not-found', () => {
  const sb = makeSandbox(DEMO_YAML);
  const stdout = makeSink();
  const stderr = makeSink();
  const code = codeReviewCli.run(['999'], { cwd: sb, stdout, stderr });
  assert.equal(code, 1);
  assert.match(stderr.toString(), /"code":\s*"code-review-not-found"/);
});

test('CR-5: missing phase arg prints usage', () => {
  const sb = makeSandbox(DEMO_YAML);
  const stdout = makeSink();
  const stderr = makeSink();
  const code = codeReviewCli.run([], { cwd: sb, stdout, stderr });
  assert.equal(code, 1);
  assert.match(stderr.toString(), /Usage:/);
});
