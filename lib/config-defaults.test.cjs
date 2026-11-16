const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildInstallConfig,
  DEFAULT_WORKFLOW,
  DEFAULT_MODEL_PROFILE,
  DEFAULT_SCOPE,
  DEFAULT_CONFIG_TREE,
  INSTALL_ECONOMY_MODE,
} = require('./config-defaults.cjs');

test('CFD-economy: install writes economy=ultra, but the resolved fallback stays lite', () => {
  assert.equal(INSTALL_ECONOMY_MODE, 'ultra');
  assert.equal(buildInstallConfig({ runtime: 'claude' }).agents.economy, 'ultra');
  // The keyless resolved fallback is intentionally conservative.
  assert.equal(DEFAULT_CONFIG_TREE.agents.economy, 'lite');
});

test('CFD-1: buildInstallConfig defaults preserve commit_artifacts:true (back-compat)', () => {
  const cfg = buildInstallConfig({ runtime: 'claude' });
  assert.equal(cfg.workflow.commit_artifacts, true);
});

test('CFD-2: buildInstallConfig honors explicit commit_artifacts:false from init interview', () => {
  const cfg = buildInstallConfig({ runtime: 'claude', commit_artifacts: false });
  assert.equal(cfg.workflow.commit_artifacts, false);
});

test('CFD-3: buildInstallConfig honors explicit commit_artifacts:true', () => {
  const cfg = buildInstallConfig({ runtime: 'claude', commit_artifacts: true });
  assert.equal(cfg.workflow.commit_artifacts, true);
});

test('CFD-4: non-boolean commit_artifacts is ignored (defends against bad input)', () => {
  const cfg = buildInstallConfig({ runtime: 'claude', commit_artifacts: 'no' });
  assert.equal(cfg.workflow.commit_artifacts, true);
});

test('CFD-5: defaults: scope=local, model_profile=frontier, response_language=en', () => {
  const cfg = buildInstallConfig({ runtime: 'claude' });
  assert.equal(cfg.scope, DEFAULT_SCOPE);
  assert.equal(cfg.model_profile, DEFAULT_MODEL_PROFILE);
  assert.equal(cfg.response_language, 'en');
});

test('CFD-6: workflow.commit_docs default mirrors DEFAULT_WORKFLOW', () => {
  const cfg = buildInstallConfig({});
  assert.equal(cfg.workflow.commit_docs, DEFAULT_WORKFLOW.commit_docs);
});

test('CFD-7: end-to-end — user answers "true" via askUser → commit_artifacts persists as true', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-cfd-affirm-'));
  try {
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# CLAUDE.md\n');
    const install = require('../bin/install.js');
    const answers = {};
    const askUser = async (spec) => {
      if (spec.question && spec.question.includes('commit nubos-pilot planning artefacts')) {
        answers.asked_commit_artifacts = true;
        return { value: true, source: 'test' };
      }
      if (spec.type === 'multiselect') return { value: ['claude'], source: 'test' };
      if (spec.type === 'select') return { value: spec.default || spec.options[0], source: 'test' };
      return { value: spec.default == null ? 'en' : spec.default, source: 'test' };
    };
    await install.runInstall({
      cwd: root, mode: 'init', askUser,
      flags: { agent: 'claude', scope: 'local' },
    });
    assert.equal(answers.asked_commit_artifacts, true, 'init must ask the commit_artifacts question');
    const cfg = JSON.parse(fs.readFileSync(path.join(root, '.nubos-pilot', 'config.json'), 'utf-8'));
    assert.equal(cfg.workflow.commit_artifacts, true);
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

test('CFD-SEC-1: buildInstallConfig writes always-on security defaults', () => {
  const cfg = buildInstallConfig({ runtime: 'claude' });
  assert.equal(cfg.security.enabled, true);
  assert.equal(cfg.security.scan_on_write, true);
  assert.equal(cfg.security.review_on_stop, true);
  assert.equal(cfg.security.review_on_commit, true);
  assert.equal(cfg.security.custom_rules_path, null);
  assert.equal(cfg.security.max_files_per_review, 30);
});

test('CFD-CONF-1: buildInstallConfig writes conformance.inject_criteria default', () => {
  const cfg = buildInstallConfig({ runtime: 'claude' });
  assert.equal(cfg.conformance.inject_criteria, true);
});

test('CD-SCAN-1 the scan block ships enabled with a conservative gate', () => {
  const { DEFAULT_CONFIG_TREE } = require('./config-defaults.cjs');
  const scan = DEFAULT_CONFIG_TREE.security.scan;
  assert.equal(scan.enabled, true);
  assert.equal(scan.min_severity, 'high');
  assert.equal(scan.fail_on, 'never', 'the scanner must never block a write or commit by default (ADR-0020)');
  assert.deepEqual(scan.ignore_scopes, ['dev'], 'dev dependencies must not gate by default');
  assert.equal(scan.license, false, 'license policy is opt-in, it is a project decision not a defect');
});

test('CD-SCAN-2 the deterministic scanners are on and the costly one is not blocking', () => {
  const { DEFAULT_CONFIG_TREE } = require('./config-defaults.cjs');
  const scan = DEFAULT_CONFIG_TREE.security.scan;
  for (const key of ['advisory', 'malicious', 'secrets', 'misconfig']) {
    assert.equal(scan[key], true, key + ' is deterministic and free, it should default on');
  }
  assert.ok(Number.isInteger(scan.max_findings_per_run) && scan.max_findings_per_run > 0);
});
