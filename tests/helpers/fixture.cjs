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

function seedPhaseDir(root, n, slug, files) {
  const padded = String(n).padStart(2, '0');
  const dirName = slug ? padded + '-' + slug : padded;
  const phaseDir = path.join(root, '.nubos-pilot', 'phases', dirName);
  fs.mkdirSync(phaseDir, { recursive: true });
  const payload = files || {};
  for (const [name, content] of Object.entries(payload)) {
    const target = path.join(phaseDir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf-8');
  }
  return phaseDir;
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

module.exports = { makeSandbox, seedRoadmapYaml, seedPhaseDir, cleanupAll };
