const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');

const _sandboxes = [];

function makeSandbox(opts) {
  const options = opts || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-test-'));
  fs.mkdirSync(path.join(root, '.nubos-pilot'), { recursive: true });
  if (options.stateMd !== undefined && options.stateMd !== null) {
    fs.writeFileSync(path.join(root, '.nubos-pilot', 'STATE.md'), options.stateMd, 'utf-8');
  }
  _sandboxes.push(root);
  return root;
}

function seedRoadmapYaml(root, data) {
  const target = path.join(root, '.nubos-pilot', 'roadmap.yaml');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, YAML.stringify(data, { indent: 2 }), 'utf-8');
}

function seedMilestoneDir(root, mNum, files) {
  const id = 'M' + String(mNum).padStart(3, '0');
  const mDir = path.join(root, '.nubos-pilot', 'milestones', id);
  fs.mkdirSync(mDir, { recursive: true });
  fs.mkdirSync(path.join(mDir, 'slices'), { recursive: true });
  for (const [name, content] of Object.entries(files || {})) {
    const target = path.join(mDir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf-8');
  }
  return mDir;
}

function seedSliceDir(root, mNum, sNum, files) {
  const mId = 'M' + String(mNum).padStart(3, '0');
  const sId = 'S' + String(sNum).padStart(3, '0');
  const sDir = path.join(root, '.nubos-pilot', 'milestones', mId, 'slices', sId);
  fs.mkdirSync(sDir, { recursive: true });
  fs.mkdirSync(path.join(sDir, 'tasks'), { recursive: true });
  for (const [name, content] of Object.entries(files || {})) {
    const target = path.join(sDir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf-8');
  }
  return sDir;
}

function cleanupAll() {
  while (_sandboxes.length) {
    const p = _sandboxes.pop();
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch {

    }
  }
}

module.exports = { makeSandbox, seedRoadmapYaml, seedMilestoneDir, seedSliceDir, cleanupAll };
