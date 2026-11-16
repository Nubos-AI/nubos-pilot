'use strict';

const { safeYamlParse } = require('../../yaml.cjs');
const { make } = require('../finding.cjs');

const SCANNER = 'misconfig';
const KIND = 'github-workflow';

const FILES = Object.freeze(['**/.github/workflows/*.yml', '**/.github/workflows/*.yaml']);

const WORKFLOW_PATH_RE = /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/;

const RULES = Object.freeze({
  untrustedCheckout: Object.freeze({
    id: 'NPS-0500',
    rule_name: 'workflow_untrusted_checkout',
    category: 'ci-untrusted-code',
    severity: 'critical',
    cwe: Object.freeze(['CWE-829']),
    reminder: 'pull_request_target and workflow_run run with repository secrets and a write-capable token in the base repository context. Checking out the pull request head there executes fork-controlled code with those credentials. Either drop the explicit ref and build only the trusted base, or split the workflow: an unprivileged pull_request job produces an artifact, and a separate privileged job consumes it without running fork code.',
  }),
  scriptInjection: Object.freeze({
    id: 'NPS-0501',
    rule_name: 'workflow_script_injection',
    category: 'ci-script-injection',
    severity: 'high',
    cwe: Object.freeze(['CWE-78', 'CWE-94']),
    reminder: 'An attacker-controlled expression is expanded by the runner into the shell script before it executes, so a crafted branch name, issue title or comment body becomes shell code. Bind the value to an intermediate env var and reference it quoted ("$TITLE"), which keeps it as data instead of program text.',
  }),
  permissionsWriteAll: Object.freeze({
    id: 'NPS-0502',
    rule_name: 'workflow_permissions_write_all',
    category: 'ci-token-permissions',
    severity: 'medium',
    cwe: Object.freeze(['CWE-732']),
    reminder: 'write-all grants the workflow token every scope, including contents, packages, deployments and id-token. Replace it with the specific scopes the job needs, for example permissions: { contents: read }.',
  }),
  permissionsAbsent: Object.freeze({
    id: 'NPS-0503',
    rule_name: 'workflow_permissions_absent',
    category: 'ci-token-permissions',
    severity: 'low',
    cwe: Object.freeze(['CWE-732']),
    reminder: 'With no permissions block the token falls back to the repository or organisation default, which is write in older settings. Declare an explicit top-level permissions block so the granted scope is visible and stable.',
  }),
  unpinnedThirdPartyAction: Object.freeze({
    id: 'NPS-0504',
    rule_name: 'workflow_unpinned_third_party_action',
    category: 'ci-supply-chain',
    severity: 'medium',
    cwe: Object.freeze(['CWE-494', 'CWE-829']),
    reminder: 'A tag or branch is a mutable pointer, so whoever controls the action repository can change the code a released tag resolves to. Pin third-party actions to a full 40-character commit SHA and record the intended version in a trailing comment.',
  }),
  unpinnedFirstPartyAction: Object.freeze({
    id: 'NPS-0505',
    rule_name: 'workflow_unpinned_first_party_action',
    category: 'ci-supply-chain',
    severity: 'low',
    cwe: Object.freeze(['CWE-829']),
    reminder: 'Even a GitHub-maintained action at a tag resolves through a mutable pointer. Pinning actions/* and github/* to a commit SHA makes the build reproducible and removes the tag-move path entirely.',
  }),
  secretsInUntrustedTrigger: Object.freeze({
    id: 'NPS-0506',
    rule_name: 'workflow_secrets_in_untrusted_trigger',
    category: 'ci-secret-exposure',
    severity: 'high',
    cwe: Object.freeze(['CWE-522']),
    reminder: 'A pull_request_target workflow is triggered by untrusted forks, so any secret placed in the environment is reachable by whatever that workflow ends up running, including build scripts and dependency lifecycle hooks from the fork. Keep secrets out of this workflow and move the privileged work to a trigger that only runs trusted code.',
  }),
  selfHostedPublicTrigger: Object.freeze({
    id: 'NPS-0507',
    rule_name: 'workflow_self_hosted_public_trigger',
    category: 'ci-untrusted-code',
    severity: 'high',
    cwe: Object.freeze(['CWE-829']),
    reminder: 'Self-hosted runners are persistent machines with no isolation between jobs, and a pull_request trigger lets any fork schedule work on them. Use ephemeral GitHub-hosted runners for fork-triggerable workflows, or gate the job behind an environment approval and a one-shot runner.',
  }),
});

const EXPRESSION_RE = /\$\{\{([\s\S]*?)\}\}/g;
const CONTEXT_REF_RE = /\b(github|secrets|inputs|vars|env|matrix|steps|needs|job|jobs|runner|strategy)((?:\s*\.\s*[A-Za-z0-9_-]+)*)/g;

const SAFE_EVENT_LEAVES = Object.freeze([
  'sha', 'head_sha', 'merge_commit_sha', 'before', 'after',
  'number', 'id', 'node_id', 'run_number', 'run_attempt',
  'action', 'state', 'status', 'conclusion', 'event', 'ref_type',
  'merged', 'draft', 'locked', 'private', 'fork',
  'created_at', 'updated_at', 'closed_at', 'merged_at',
  'default_branch', 'full_name',
]);

const UNTRUSTED_CHECKOUT_REF_RE = /github\s*\.\s*event\s*\.\s*(pull_request\s*\.\s*head\s*\.\s*(sha|ref)|workflow_run\s*\.\s*head_[a-z_]+)/;
const CHECKOUT_ACTION_RE = /^actions\/checkout(\/|@|$)/;
const SHA_PIN_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i;
const TOKEN_USE_RE = /secrets\s*\.\s*GITHUB_TOKEN|github\s*\.\s*token|\bGITHUB_TOKEN\b|\bGH_TOKEN\b/;
const FIRST_PARTY_OWNERS = Object.freeze(['actions', 'github']);
const UNTRUSTED_CHECKOUT_TRIGGERS = Object.freeze(['pull_request_target', 'workflow_run']);
const FORK_TRIGGERS = Object.freeze(['pull_request', 'pull_request_target']);

function matches(relPath) {
  if (typeof relPath !== 'string' || !relPath) return false;
  const normalized = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  return WORKFLOW_PATH_RE.test(normalized);
}

function _isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function _isFatalYamlError(err) {
  const code = err && err.code;
  if (code === 'yaml-too-large' || code === 'yaml-invalid-input') return true;
  return !!err && typeof err.message === 'string' && /alias/i.test(err.message);
}

function _triggerNames(doc) {
  const on = doc.on === undefined ? doc[true] : doc.on;
  if (typeof on === 'string') return [on.trim()];
  if (Array.isArray(on)) return on.filter((entry) => typeof entry === 'string').map((entry) => entry.trim());
  if (_isPlainObject(on)) return Object.keys(on);
  return [];
}

function _jobs(doc) {
  if (!_isPlainObject(doc.jobs)) return [];
  const out = [];
  for (const [id, job] of Object.entries(doc.jobs)) {
    if (_isPlainObject(job)) out.push({ id, job });
  }
  return out;
}

function _steps(job) {
  return Array.isArray(job.steps) ? job.steps.filter(_isPlainObject) : [];
}

function _lineOfText(lines, needle, from) {
  if (!needle) return null;
  for (let i = Math.max(0, from || 0); i < lines.length; i += 1) {
    if (lines[i].includes(needle)) return i + 1;
  }
  return null;
}

function _lineOfPattern(lines, pattern, from) {
  for (let i = Math.max(0, from || 0); i < lines.length; i += 1) {
    if (pattern.test(lines[i])) return i + 1;
  }
  return null;
}

function _lineOfKey(lines, key, from) {
  return _lineOfPattern(lines, new RegExp('^\\s*(-\\s*)?' + key + '\\s*:'), from);
}

function _stepLine(lines, step) {
  if (typeof step.uses === 'string') {
    const line = _lineOfText(lines, step.uses.trim());
    if (line) return line;
  }
  if (typeof step.name === 'string') {
    const line = _lineOfText(lines, step.name.trim());
    if (line) return line;
  }
  if (typeof step.run === 'string') {
    const first = step.run.split('\n').find((entry) => entry.trim());
    if (first) {
      const line = _lineOfText(lines, first.trim());
      if (line) return line;
    }
  }
  return null;
}

function _contextRefs(expression) {
  const refs = [];
  let match = CONTEXT_REF_RE.exec(expression);
  while (match) {
    const segments = (match[2] || '')
      .split('.')
      .map((segment) => segment.trim())
      .filter(Boolean);
    refs.push({ namespace: match[1], segments });
    match = CONTEXT_REF_RE.exec(expression);
  }
  CONTEXT_REF_RE.lastIndex = 0;
  return refs;
}

function _isAttackerControlledRef(ref, prTriggered) {
  if (ref.namespace !== 'github') return false;
  const segments = ref.segments;
  if (segments.length === 0) return false;
  const head = segments[0];
  if (head === 'head_ref') return true;
  if (head === 'ref' || head === 'ref_name') return prTriggered;
  if (head !== 'event') return false;
  if (segments.length === 1) return true;
  if (segments[1] === 'inputs') return false;
  return !SAFE_EVENT_LEAVES.includes(segments[segments.length - 1]);
}

function _attackerControlledExpressions(text, prTriggered) {
  const out = [];
  let match = EXPRESSION_RE.exec(text);
  while (match) {
    const body = match[1];
    const hit = _contextRefs(body).some((ref) => _isAttackerControlledRef(ref, prTriggered));
    if (hit && !out.includes(match[0])) out.push(match[0]);
    match = EXPRESSION_RE.exec(text);
  }
  EXPRESSION_RE.lastIndex = 0;
  return out;
}

function _secretRefs(value, out) {
  if (typeof value === 'string') {
    let match = EXPRESSION_RE.exec(value);
    while (match) {
      const refs = _contextRefs(match[1]);
      for (const ref of refs) {
        if (ref.namespace === 'secrets' && ref.segments.length > 0) {
          const name = ref.segments[0];
          if (!out.includes(name)) out.push(name);
        }
      }
      match = EXPRESSION_RE.exec(value);
    }
    EXPRESSION_RE.lastIndex = 0;
    return out;
  }
  if (_isPlainObject(value)) {
    for (const entry of Object.values(value)) _secretRefs(entry, out);
  }
  return out;
}

function _runnerLabels(runsOn) {
  if (typeof runsOn === 'string') return [runsOn.trim()];
  if (Array.isArray(runsOn)) return runsOn.filter((entry) => typeof entry === 'string').map((entry) => entry.trim());
  if (_isPlainObject(runsOn)) {
    const labels = [];
    if (typeof runsOn.group === 'string') labels.push(runsOn.group.trim());
    if (typeof runsOn.labels === 'string') labels.push(runsOn.labels.trim());
    if (Array.isArray(runsOn.labels)) {
      for (const entry of runsOn.labels) if (typeof entry === 'string') labels.push(entry.trim());
    }
    return labels;
  }
  return [];
}

function _parseUses(uses) {
  if (typeof uses !== 'string') return null;
  const spec = uses.trim().replace(/\s+#.*$/, '');
  if (!spec || spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('docker://')) return null;
  const at = spec.lastIndexOf('@');
  const repo = at === -1 ? spec : spec.slice(0, at);
  const ref = at === -1 ? '' : spec.slice(at + 1);
  if (!repo.includes('/')) return null;
  return { spec, repo, ref, owner: repo.split('/')[0].toLowerCase() };
}

function _finding(rule, file, line, title) {
  return make({
    id: rule.id,
    rule_name: rule.rule_name,
    scanner: SCANNER,
    category: rule.category,
    severity: rule.severity,
    cwe: rule.cwe,
    file,
    line,
    title,
    reminder: rule.reminder,
  });
}

function _checkUntrustedCheckout(state) {
  const { doc, lines, file, findings, triggers } = state;
  if (!triggers.some((name) => UNTRUSTED_CHECKOUT_TRIGGERS.includes(name))) return;
  const trigger = triggers.find((name) => UNTRUSTED_CHECKOUT_TRIGGERS.includes(name));
  for (const { id, job } of _jobs(doc)) {
    for (const step of _steps(job)) {
      const uses = _parseUses(step.uses);
      if (!uses || !CHECKOUT_ACTION_RE.test(uses.repo + '@')) continue;
      const ref = _isPlainObject(step.with) ? step.with.ref : null;
      if (typeof ref !== 'string' || !UNTRUSTED_CHECKOUT_REF_RE.test(ref)) continue;
      findings.push(_finding(
        RULES.untrustedCheckout,
        file,
        _lineOfText(lines, ref.trim()) || _stepLine(lines, step),
        'job "' + id + '" checks out untrusted code (ref: ' + ref.trim() + ') in a ' + trigger + ' workflow',
      ));
    }
  }
}

function _checkScriptInjection(state) {
  const { doc, lines, file, findings, triggers } = state;
  const prTriggered = triggers.some((name) => name.startsWith('pull_request') || name === 'workflow_run');
  for (const { id, job } of _jobs(doc)) {
    for (const step of _steps(job)) {
      if (typeof step.run !== 'string' || !step.run) continue;
      for (const expression of _attackerControlledExpressions(step.run, prTriggered)) {
        findings.push(_finding(
          RULES.scriptInjection,
          file,
          _lineOfText(lines, expression) || _stepLine(lines, step),
          'job "' + id + '" interpolates ' + expression + ' into a run block',
        ));
      }
    }
  }
}

function _checkPermissions(state) {
  const {
    doc, lines, file, findings, raw,
  } = state;
  if (doc.permissions === 'write-all') {
    findings.push(_finding(
      RULES.permissionsWriteAll,
      file,
      _lineOfKey(lines, 'permissions'),
      'workflow grants the token permissions: write-all',
    ));
  }
  const jobs = _jobs(doc);
  const jobsLine = _lineOfKey(lines, 'jobs') || 0;
  for (const { id, job } of jobs) {
    if (job.permissions !== 'write-all') continue;
    findings.push(_finding(
      RULES.permissionsWriteAll,
      file,
      _lineOfText(lines, 'write-all', jobsLine),
      'job "' + id + '" grants the token permissions: write-all',
    ));
  }
  if (doc.permissions !== undefined) return;
  const unscoped = jobs.filter(({ job }) => job.permissions === undefined);
  if (unscoped.length === 0 || !TOKEN_USE_RE.test(raw)) return;
  findings.push(_finding(
    RULES.permissionsAbsent,
    file,
    _lineOfKey(lines, 'jobs'),
    'workflow uses the repository token with no permissions block ('
      + unscoped.length + ' job' + (unscoped.length === 1 ? '' : 's') + ' inherit the default scope)',
  ));
}

function _checkActionPinning(state) {
  const {
    doc, lines, file, findings,
  } = state;
  for (const { id, job } of _jobs(doc)) {
    for (const step of _steps(job)) {
      const uses = _parseUses(step.uses);
      if (!uses || SHA_PIN_RE.test(uses.ref)) continue;
      const firstParty = FIRST_PARTY_OWNERS.includes(uses.owner);
      const rule = firstParty ? RULES.unpinnedFirstPartyAction : RULES.unpinnedThirdPartyAction;
      const ref = uses.ref || 'default branch';
      findings.push(_finding(
        rule,
        file,
        _lineOfText(lines, uses.spec) || _stepLine(lines, step),
        'job "' + id + '" uses ' + uses.repo + ' at the mutable ref ' + ref,
      ));
    }
  }
}

function _checkSecretExposure(state) {
  const {
    doc, lines, file, findings, triggers,
  } = state;
  if (!triggers.includes('pull_request_target')) return;
  const scopes = [{ label: 'workflow', env: doc.env, anchor: null }];
  for (const { id, job } of _jobs(doc)) {
    scopes.push({ label: 'job "' + id + '"', env: job.env, anchor: null });
    _steps(job).forEach((step, index) => {
      const name = typeof step.name === 'string' && step.name ? step.name : 'step ' + (index + 1);
      scopes.push({ label: 'job "' + id + '" / ' + name, env: step.env, anchor: step });
    });
  }
  for (const scope of scopes) {
    if (!_isPlainObject(scope.env)) continue;
    const secrets = _secretRefs(scope.env, []);
    if (secrets.length === 0) continue;
    const anchorLine = scope.anchor ? _stepLine(lines, scope.anchor) : null;
    const from = anchorLine ? anchorLine - 1 : 0;
    findings.push(_finding(
      RULES.secretsInUntrustedTrigger,
      file,
      _lineOfText(lines, 'secrets.' + secrets[0], from)
        || _lineOfKey(lines, 'env', from)
        || anchorLine,
      scope.label + ' exposes secrets.' + secrets.join(', secrets.') + ' to a pull_request_target workflow',
    ));
  }
}

function _checkSelfHostedRunner(state) {
  const {
    doc, lines, file, findings, triggers,
  } = state;
  const trigger = triggers.find((name) => FORK_TRIGGERS.includes(name));
  if (!trigger) return;
  for (const { id, job } of _jobs(doc)) {
    const labels = _runnerLabels(job['runs-on']).map((label) => label.toLowerCase());
    if (!labels.includes('self-hosted')) continue;
    findings.push(_finding(
      RULES.selfHostedPublicTrigger,
      file,
      _lineOfText(lines, 'self-hosted') || _lineOfKey(lines, 'runs-on'),
      'job "' + id + '" runs on a self-hosted runner and is triggered by ' + trigger,
    ));
  }
}

function check(content, opts) {
  const o = opts || {};
  const file = typeof o.file === 'string' && o.file ? o.file : null;
  const findings = [];
  const warnings = [];
  if (typeof content !== 'string') {
    warnings.push('invalid-input');
    return { findings, warnings };
  }
  let doc;
  try {
    doc = safeYamlParse(content, { kind: KIND });
  } catch (err) {
    if (_isFatalYamlError(err)) throw err;
    warnings.push('yaml-parse-failed');
    return { findings, warnings };
  }
  if (doc == null) {
    warnings.push('empty-document');
    return { findings, warnings };
  }
  if (!_isPlainObject(doc)) {
    warnings.push('unexpected-document-shape');
    return { findings, warnings };
  }
  const state = {
    doc,
    raw: content,
    lines: content.split('\n'),
    file,
    findings,
    triggers: _triggerNames(doc),
  };
  if (state.triggers.length === 0) warnings.push('no-triggers-declared');
  if (!_isPlainObject(doc.jobs)) warnings.push('no-jobs-declared');
  _checkUntrustedCheckout(state);
  _checkScriptInjection(state);
  _checkPermissions(state);
  _checkActionPinning(state);
  _checkSecretExposure(state);
  _checkSelfHostedRunner(state);
  return { findings, warnings };
}

module.exports = {
  RULES,
  FILES,
  matches,
  check,
};
