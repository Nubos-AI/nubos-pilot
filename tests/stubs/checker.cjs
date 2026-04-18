const fs = require('node:fs');
const path = require('node:path');

function _mode(sandboxCwd) {
  const p = path.join(sandboxCwd, '.test-checker-mode.json');
  if (!fs.existsSync(p)) return 'pass';
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && parsed.mode ? String(parsed.mode) : 'pass';
  } catch {
    return 'pass';
  }
}

function check(sandboxCwd, iteration) {
  const mode = _mode(sandboxCwd);
  if (mode === 'pass') {
    return { status: 'passed', findings: [] };
  }
  if (mode === 'fail-pass') {
    if (iteration === 1) {
      return {
        status: 'issues_found',
        findings: [
          { category: 'missing-success-criterion', severity: 'critical',
            target: 'PLAN.md §SC-1', message: 'SC-1 has no covering task.' },
        ],
      };
    }
    return { status: 'passed', findings: [] };
  }
  if (mode === 'fail-fail') {
    return {
      status: 'issues_found',
      findings: [
        { category: 'non-atomic-task', severity: 'major',
          target: 'T02', message: 'T02 bundles two concerns.' },
      ],
    };
  }
  return { status: 'passed', findings: [] };
}

module.exports = { check };
