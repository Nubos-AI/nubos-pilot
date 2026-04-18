const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function mkTmp(scope) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'np-' + scope + '-'));
}

test('manifest: buildManifest walks payload dir and produces SHA-256 hashes (INST-01, D-02)', (t) => {
  const { buildManifest } = require('../../lib/install/manifest.cjs');
  const tmp = mkTmp('manifest-build');
  t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
  fs.writeFileSync(path.join(tmp, 'a.md'), 'hello');
  const m = buildManifest(tmp, '1.0.0');
  assert.equal(typeof m.files['a.md'], 'string');
  assert.equal(m.files['a.md'].length, 64, 'sha256 hex = 64 chars');
  assert.equal(m.version, '1.0.0');
});

test('manifest: diffManifests returns stale/added/changed sets (INST-08, D-06)', () => {
  const { diffManifests } = require('../../lib/install/manifest.cjs');
  const oldM = { files: { 'kept.md': 'aa', 'gone.md': 'bb', 'changed.md': 'cc' } };
  const newM = { files: { 'kept.md': 'aa', 'changed.md': 'dd', 'new.md': 'ee' } };
  const d = diffManifests(oldM, newM);
  assert.deepEqual(d.stale, ['gone.md']);
  assert.deepEqual(d.added, ['new.md']);
  assert.deepEqual(d.changed, ['changed.md']);
});

test('manifest: writeManifest uses atomic tmp+rename (D-04)', (t) => {
  const { writeManifest, readManifest } = require('../../lib/install/manifest.cjs');
  const tmp = mkTmp('manifest-w');
  t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
  writeManifest(tmp, { version: '1.0.0', timestamp: '2026-04-16T00:00:00Z', files: {} });
  const got = readManifest(tmp);
  assert.equal(got.version, '1.0.0');
  const leftovers = fs.readdirSync(tmp).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'no *.tmp siblings after atomic write');
});
