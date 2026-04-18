const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function mkTmp(scope) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'np-' + scope + '-'));
}
function capture() {
  let buf = '';
  return { stub: { write: (s) => { buf += s; return true; } }, get: () => buf };
}

test('dispatch: emits JSON {skill, args} from computeNextStep result (INST-06, D-17)', async (t) => {
  const dispatch = require('../../bin/np-tools/dispatch.cjs');
  const root = mkTmp('dispatch-plan');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });

  const mockNext = () => ({ nextAction: 'plan', reasoning: 'no PLAN.md', ambiguous: false });
  const cap = capture();
  await dispatch.run(['07'], { cwd: root, stdout: cap.stub, computeNextStep: mockNext });
  const payload = JSON.parse(cap.get());
  assert.equal(payload.skill, 'np-plan');
  assert.deepEqual(payload.args, { phase: '07' });
});

test('dispatch: --action=execute override wins over state recommendation (D-18)', async (t) => {
  const dispatch = require('../../bin/np-tools/dispatch.cjs');
  const root = mkTmp('dispatch-override');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });

  const mockNext = () => ({ nextAction: 'plan', reasoning: 'no PLAN.md', ambiguous: false });
  const cap = capture();
  await dispatch.run(['07', '--action=execute'], { cwd: root, stdout: cap.stub, computeNextStep: mockNext });
  const payload = JSON.parse(cap.get());
  assert.equal(payload.skill, 'np-execute', 'explicit --action override must win');
});
