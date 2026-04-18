const fs = require('node:fs');
const path = require('node:path');

function _padded(n) {
  const s = String(n);
  return s.padStart(2, '0');
}

function _findPhaseDir(sandboxCwd, phase) {
  const padded = _padded(phase);
  const phasesRoot = path.join(sandboxCwd, '.nubos-pilot', 'phases');
  const entries = fs.readdirSync(phasesRoot, { withFileTypes: true });
  const hit = entries.find(
    (e) => e.isDirectory() && (e.name === padded || e.name.startsWith(padded + '-')),
  );
  if (!hit) throw new Error('stub-planner: phase dir not found for ' + phase);
  return path.join(phasesRoot, hit.name);
}

function plan(sandboxCwd, phase, mode, iteration) {
  const padded = _padded(phase);
  const phaseDir = _findPhaseDir(sandboxCwd, phase);
  const content = [
    '---',
    'phase: "' + phase + '"',
    'plan: "' + padded + '-01"',
    'iter: ' + iteration,
    'mode: ' + mode,
    '---',
    '',
    '# Stub PLAN.md (iter ' + iteration + ', mode ' + mode + ')',
    '',
    '<!-- stub-hash: ' + iteration + '-' + mode + '-' + Date.now() + ' -->',
    '',
    '<tasks>',
    '<task id="T01" wave="1" tier="sonnet" depends_on="[]">one</task>',
    '<task id="T02" wave="2" tier="sonnet" depends_on="[T01]">two</task>',
    '</tasks>',
    '',
  ].join('\n');
  const planPath = path.join(phaseDir, padded + '-01-PLAN.md');
  fs.writeFileSync(planPath, content, 'utf-8');
  return { written: true, iteration, path: planPath };
}

module.exports = { plan };
