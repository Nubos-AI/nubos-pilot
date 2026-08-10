'use strict';

const { safeYamlParse, DEFAULT_MAX_BYTES } = require('../../yaml.cjs');
const { make } = require('../finding.cjs');

const SCANNER = 'misconfig';
const KIND = 'kubernetes-manifest';

const FILES = Object.freeze(['**/*.yml', '**/*.yaml']);

const RULES = Object.freeze({
  privilegedContainer: Object.freeze({
    id: 'NPS-0550',
    rule_name: 'k8s_privileged_container',
    category: 'k8s-privilege',
    severity: 'critical',
    cwe: Object.freeze(['CWE-250']),
    reminder: 'A privileged container keeps all capabilities and unrestricted device access, so escaping to the node is a routine step rather than an exploit. Drop privileged and add only the specific capabilities the workload needs.',
  }),
  privilegeEscalation: Object.freeze({
    id: 'NPS-0551',
    rule_name: 'k8s_allow_privilege_escalation',
    category: 'k8s-privilege',
    severity: 'high',
    cwe: Object.freeze(['CWE-250']),
    reminder: 'allowPrivilegeEscalation lets a process gain more capabilities than its parent through setuid binaries or file capabilities, which defeats running as an unprivileged user. Set securityContext.allowPrivilegeEscalation: false.',
  }),
  privilegeEscalationDefault: Object.freeze({
    id: 'NPS-0552',
    rule_name: 'k8s_allow_privilege_escalation_default',
    category: 'k8s-privilege',
    severity: 'low',
    cwe: Object.freeze(['CWE-250']),
    reminder: 'allowPrivilegeEscalation defaults to true when it is not set, so the setuid escalation path is open unless it is disabled explicitly. Add securityContext.allowPrivilegeEscalation: false to the container.',
  }),
  runAsRoot: Object.freeze({
    id: 'NPS-0553',
    rule_name: 'k8s_run_as_root',
    category: 'k8s-privilege',
    severity: 'high',
    cwe: Object.freeze(['CWE-250']),
    reminder: 'Running as uid 0 means any container breakout, writable host mount or kernel bug is exercised with root authority. Set runAsNonRoot: true and a concrete non-zero runAsUser, and build the image so its files are readable by that uid.',
  }),
  hostNamespace: Object.freeze({
    id: 'NPS-0554',
    rule_name: 'k8s_host_namespace',
    category: 'k8s-isolation',
    severity: 'high',
    cwe: Object.freeze(['CWE-653']),
    reminder: 'Sharing a host namespace removes the isolation the sandbox is built on: hostNetwork exposes node-local services and cloud metadata, hostPID exposes every process on the node, and hostIPC exposes shared memory. Remove the flag, or move the workload to a dedicated node pool with an admission policy that scopes it.',
  }),
  hostPathCritical: Object.freeze({
    id: 'NPS-0555',
    rule_name: 'k8s_host_path_critical',
    category: 'k8s-isolation',
    severity: 'critical',
    cwe: Object.freeze(['CWE-668']),
    reminder: 'Mounting the container runtime socket or the host root filesystem is equivalent to root on the node, because the workload can start a new privileged container or edit host binaries. Remove the mount and use the runtime API through a broker that enforces what may be started.',
  }),
  hostPath: Object.freeze({
    id: 'NPS-0556',
    rule_name: 'k8s_host_path_mount',
    category: 'k8s-isolation',
    severity: 'high',
    cwe: Object.freeze(['CWE-668']),
    reminder: 'A hostPath volume reaches outside the sandbox into node state that other workloads share, and it survives the pod. Prefer a PersistentVolumeClaim, an emptyDir, or a projected configMap or secret; if the node path is genuinely required, mount it readOnly and pin the pod with an admission policy.',
  }),
  missingResourceLimits: Object.freeze({
    id: 'NPS-0557',
    rule_name: 'k8s_missing_resource_limits',
    category: 'k8s-resource-limits',
    severity: 'medium',
    cwe: Object.freeze(['CWE-770']),
    reminder: 'Without CPU and memory limits one container can consume the whole node and evict its neighbours, which turns a single runaway process into a cluster-wide outage. Set resources.limits.cpu and resources.limits.memory, and matching requests so the scheduler can place the pod.',
  }),
  dangerousCapability: Object.freeze({
    id: 'NPS-0558',
    rule_name: 'k8s_dangerous_capability',
    category: 'k8s-privilege',
    severity: 'high',
    cwe: Object.freeze(['CWE-250']),
    reminder: 'SYS_ADMIN is close to full root, NET_ADMIN and NET_RAW allow traffic interception and spoofing from inside the cluster network, and ALL grants every capability. Drop the capability, or narrow it to the one syscall group the workload actually needs.',
  }),
  writableRootFilesystem: Object.freeze({
    id: 'NPS-0559',
    rule_name: 'k8s_writable_root_filesystem',
    category: 'k8s-hardening',
    severity: 'low',
    cwe: Object.freeze(['CWE-732']),
    reminder: 'A writable root filesystem lets an intruder drop tools and modify application code in place, and it hides configuration drift. Set readOnlyRootFilesystem: true and mount an emptyDir over the paths that genuinely need writes.',
  }),
  mutableImageTag: Object.freeze({
    id: 'NPS-0560',
    rule_name: 'k8s_mutable_image_tag',
    category: 'k8s-supply-chain',
    severity: 'medium',
    cwe: Object.freeze(['CWE-494']),
    reminder: 'A floating tag means the code that runs after the next pull is not the code that was reviewed, and rollbacks stop being reproducible. Reference the image by digest, or by an immutable release tag that your registry forbids overwriting.',
  }),
  automountServiceAccountToken: Object.freeze({
    id: 'NPS-0561',
    rule_name: 'k8s_automount_service_account_token',
    category: 'k8s-hardening',
    severity: 'low',
    cwe: Object.freeze(['CWE-250']),
    reminder: 'An automounted service account token is readable by every process in the pod, so any code execution there becomes an API server credential. Set automountServiceAccountToken: false and request a scoped projected token only where it is needed.',
  }),
  wildcardRbac: Object.freeze({
    id: 'NPS-0562',
    rule_name: 'k8s_wildcard_rbac',
    category: 'k8s-rbac',
    severity: 'high',
    cwe: Object.freeze(['CWE-269']),
    reminder: 'A rule granting * verbs on * resources is cluster-admin in practice, including secrets and the ability to grant itself more. Enumerate the verbs and resources the subject needs and split the role if separate components share it.',
  }),
});

const WORKLOAD_KINDS = Object.freeze([
  'Pod', 'PodTemplate', 'Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet',
  'ReplicationController', 'Job', 'CronJob',
]);
const RBAC_KINDS = Object.freeze(['Role', 'ClusterRole']);
const SERVICE_ACCOUNT_KIND = 'ServiceAccount';
const CONTAINER_FIELDS = Object.freeze(['initContainers', 'containers', 'ephemeralContainers']);
const HOST_NAMESPACE_FIELDS = Object.freeze(['hostNetwork', 'hostPID', 'hostIPC']);
const DANGEROUS_CAPABILITIES = Object.freeze(['SYS_ADMIN', 'NET_ADMIN', 'NET_RAW', 'ALL']);
const RUNTIME_SOCKET_RE = /(^|\/)(docker|containerd|crio)\.sock$/;
const DOC_SEPARATOR_RE = /^---\s*(#.*)?$/;
const DOC_TERMINATOR_RE = /^\.\.\.\s*(#.*)?$/;
const DIGEST_RE = /@sha(256|512):[0-9a-f]+$/i;

function _isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function _looksLikeManifest(doc) {
  return _isPlainObject(doc)
    && typeof doc.apiVersion === 'string' && doc.apiVersion !== ''
    && typeof doc.kind === 'string' && doc.kind !== '';
}

function matches(relPath, parsed) {
  if (parsed !== undefined && parsed !== null) {
    if (Array.isArray(parsed)) return parsed.some(_looksLikeManifest);
    return _looksLikeManifest(parsed);
  }
  if (typeof relPath !== 'string' || !relPath) return false;
  return /\.ya?ml$/.test(relPath.replace(/\\/g, '/'));
}

function _isFatalYamlError(err) {
  const code = err && err.code;
  if (code === 'yaml-too-large' || code === 'yaml-invalid-input') return true;
  return !!err && typeof err.message === 'string' && /alias/i.test(err.message);
}

function _enforceSizeCapViaWrapper(content) {
  if (Buffer.byteLength(content, 'utf-8') > DEFAULT_MAX_BYTES) safeYamlParse(content, { kind: KIND });
}

function _splitDocuments(content) {
  const lines = content.split('\n');
  const docs = [];
  let buffer = [];
  let startLine = 1;
  const flush = () => {
    if (buffer.some((line) => line.trim() !== '')) {
      docs.push({ text: buffer.join('\n'), startLine });
    }
    buffer = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (DOC_SEPARATOR_RE.test(line) || DOC_TERMINATOR_RE.test(line)) {
      flush();
      startLine = i + 2;
      continue;
    }
    buffer.push(line);
  }
  flush();
  return docs;
}

function _indentOf(line) {
  const match = /^\s*/.exec(line);
  return match ? match[0].length : 0;
}

function _lineOfPattern(lines, pattern, from, until) {
  const end = until === undefined ? lines.length : Math.min(until, lines.length);
  for (let i = Math.max(0, from || 0); i < end; i += 1) {
    if (pattern.test(lines[i])) return i + 1;
  }
  return null;
}

function _lineOfText(lines, needle, from, until) {
  if (!needle) return null;
  const end = until === undefined ? lines.length : Math.min(until, lines.length);
  for (let i = Math.max(0, from || 0); i < end; i += 1) {
    if (lines[i].includes(needle)) return i + 1;
  }
  return null;
}

function _keyPattern(key) {
  return new RegExp('^\\s*(-\\s*)?' + key + '\\s*:');
}

function _escape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _containerWindow(lines, name) {
  if (typeof name !== 'string' || !name) return { start: null, end: lines.length };
  const escaped = _escape(name);
  const start = _lineOfPattern(lines, new RegExp('^\\s*-\\s*name\\s*:\\s*(["\']?)' + escaped + '\\1\\s*(#.*)?$'))
    || _lineOfPattern(lines, new RegExp('^\\s*name\\s*:\\s*(["\']?)' + escaped + '\\1\\s*(#.*)?$'));
  if (!start) return { start: null, end: lines.length };
  const indent = _indentOf(lines[start - 1]);
  for (let i = start; i < lines.length; i += 1) {
    if (/^\s*-\s*\S/.test(lines[i]) && _indentOf(lines[i]) <= indent) return { start, end: i };
  }
  return { start, end: lines.length };
}

function _podSpecs(doc) {
  const candidates = [
    doc.spec,
    _isPlainObject(doc.spec) && _isPlainObject(doc.spec.template) ? doc.spec.template.spec : null,
    _isPlainObject(doc.spec) && _isPlainObject(doc.spec.jobTemplate)
      && _isPlainObject(doc.spec.jobTemplate.spec) && _isPlainObject(doc.spec.jobTemplate.spec.template)
      ? doc.spec.jobTemplate.spec.template.spec
      : null,
    _isPlainObject(doc.template) ? doc.template.spec : null,
  ];
  return candidates.filter((spec) => _isPlainObject(spec)
    && CONTAINER_FIELDS.some((field) => Array.isArray(spec[field])));
}

function _containers(podSpec) {
  const out = [];
  for (const field of CONTAINER_FIELDS) {
    if (!Array.isArray(podSpec[field])) continue;
    for (const container of podSpec[field]) {
      if (_isPlainObject(container)) out.push({ field, container });
    }
  }
  return out;
}

function _imageTag(image) {
  if (typeof image !== 'string' || !image.trim()) return { pinned: false, tag: null };
  const spec = image.trim();
  if (DIGEST_RE.test(spec)) return { pinned: true, tag: null };
  const lastSlash = spec.lastIndexOf('/');
  const name = lastSlash === -1 ? spec : spec.slice(lastSlash + 1);
  const colon = name.lastIndexOf(':');
  if (colon === -1) return { pinned: false, tag: null };
  return { pinned: false, tag: name.slice(colon + 1) };
}

function _capabilityNames(container) {
  const sc = _isPlainObject(container.securityContext) ? container.securityContext : {};
  const caps = _isPlainObject(sc.capabilities) ? sc.capabilities : {};
  const added = Array.isArray(caps.add) ? caps.add : [];
  return added
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.trim().toUpperCase().replace(/^CAP_/, ''));
}

function _label(doc) {
  const name = _isPlainObject(doc.metadata) && typeof doc.metadata.name === 'string'
    ? doc.metadata.name
    : null;
  return doc.kind + (name ? ' "' + name + '"' : '');
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

function _checkContainer(ctx, podSpec, entry) {
  const {
    lines, offset, file, findings, doc,
  } = ctx;
  const { container } = entry;
  const name = typeof container.name === 'string' && container.name ? container.name : entry.field;
  const window = _containerWindow(lines, container.name);
  const anchor = window.start ? window.start + offset : null;
  const at = (key) => {
    if (!window.start) return anchor;
    const line = _lineOfPattern(lines, _keyPattern(key), window.start, window.end);
    return line ? line + offset : anchor;
  };
  const where = _label(doc) + ' container "' + name + '"';
  const sc = _isPlainObject(container.securityContext) ? container.securityContext : {};
  const podSc = _isPlainObject(podSpec.securityContext) ? podSpec.securityContext : {};

  if (sc.privileged === true) {
    findings.push(_finding(RULES.privilegedContainer, file, at('privileged'), where + ' runs privileged'));
  }

  if (sc.allowPrivilegeEscalation === true) {
    findings.push(_finding(
      RULES.privilegeEscalation,
      file,
      at('allowPrivilegeEscalation'),
      where + ' sets allowPrivilegeEscalation: true',
    ));
  } else if (sc.allowPrivilegeEscalation === undefined && sc.privileged !== true) {
    findings.push(_finding(
      RULES.privilegeEscalationDefault,
      file,
      anchor,
      where + ' does not set allowPrivilegeEscalation, which defaults to true',
    ));
  }

  const runAsNonRoot = sc.runAsNonRoot === undefined ? podSc.runAsNonRoot : sc.runAsNonRoot;
  const runAsUser = sc.runAsUser === undefined ? podSc.runAsUser : sc.runAsUser;
  if (runAsNonRoot === false || runAsUser === 0) {
    const detail = runAsUser === 0 ? 'runAsUser: 0' : 'runAsNonRoot: false';
    findings.push(_finding(
      RULES.runAsRoot,
      file,
      at(runAsUser === 0 ? 'runAsUser' : 'runAsNonRoot'),
      where + ' runs as root (' + detail + ')',
    ));
  }

  const dangerous = _capabilityNames(container).filter((cap) => DANGEROUS_CAPABILITIES.includes(cap));
  if (dangerous.length > 0) {
    findings.push(_finding(
      RULES.dangerousCapability,
      file,
      at('add'),
      where + ' adds the capability ' + dangerous.join(', '),
    ));
  }

  const resources = _isPlainObject(container.resources) ? container.resources : {};
  const limits = _isPlainObject(resources.limits) ? resources.limits : {};
  const missing = ['cpu', 'memory'].filter((key) => limits[key] === undefined || limits[key] === null);
  if (missing.length > 0) {
    findings.push(_finding(
      RULES.missingResourceLimits,
      file,
      _isPlainObject(resources.limits) ? at('limits') : anchor,
      where + ' declares no ' + missing.join(' or ') + ' limit',
    ));
  }

  if (sc.readOnlyRootFilesystem !== true) {
    findings.push(_finding(
      RULES.writableRootFilesystem,
      file,
      sc.readOnlyRootFilesystem === false ? at('readOnlyRootFilesystem') : anchor,
      where + ' has a writable root filesystem',
    ));
  }

  const image = _imageTag(container.image);
  if (!image.pinned && (image.tag === null || image.tag === 'latest')) {
    findings.push(_finding(
      RULES.mutableImageTag,
      file,
      at('image'),
      where + ' uses the mutable image reference ' + (typeof container.image === 'string' && container.image ? container.image.trim() : '(none)'),
    ));
  }
}

function _checkPodSpec(ctx, podSpec) {
  const {
    lines, offset, file, findings, doc,
  } = ctx;
  const where = _label(doc);
  for (const field of HOST_NAMESPACE_FIELDS) {
    if (podSpec[field] !== true) continue;
    const line = _lineOfPattern(lines, _keyPattern(field));
    findings.push(_finding(
      RULES.hostNamespace,
      file,
      line ? line + offset : null,
      where + ' sets ' + field + ': true',
    ));
  }
  const volumes = Array.isArray(podSpec.volumes) ? podSpec.volumes : [];
  for (const volume of volumes) {
    if (!_isPlainObject(volume) || !_isPlainObject(volume.hostPath)) continue;
    const hostPath = typeof volume.hostPath.path === 'string' ? volume.hostPath.path.trim() : '';
    const critical = hostPath === '/' || RUNTIME_SOCKET_RE.test(hostPath);
    const rule = critical ? RULES.hostPathCritical : RULES.hostPath;
    const line = _lineOfText(lines, hostPath ? 'path: ' + hostPath : 'hostPath')
      || _lineOfPattern(lines, _keyPattern('hostPath'));
    findings.push(_finding(
      rule,
      file,
      line ? line + offset : null,
      where + ' mounts the host path ' + (hostPath || '(unset)'),
    ));
  }
  for (const entry of _containers(podSpec)) _checkContainer(ctx, podSpec, entry);
}

function _checkServiceAccount(ctx) {
  const {
    lines, offset, file, findings, doc,
  } = ctx;
  if (doc.automountServiceAccountToken === false) return;
  const line = _lineOfPattern(lines, _keyPattern('automountServiceAccountToken'))
    || _lineOfPattern(lines, _keyPattern('kind'));
  findings.push(_finding(
    RULES.automountServiceAccountToken,
    file,
    line ? line + offset : null,
    _label(doc) + ' does not set automountServiceAccountToken: false',
  ));
}

function _checkRbac(ctx) {
  const {
    lines, offset, file, findings, doc,
  } = ctx;
  const rules = Array.isArray(doc.rules) ? doc.rules : [];
  for (const rule of rules) {
    if (!_isPlainObject(rule)) continue;
    const verbs = Array.isArray(rule.verbs) ? rule.verbs : [];
    const resources = Array.isArray(rule.resources) ? rule.resources : [];
    if (!verbs.includes('*') || !resources.includes('*')) continue;
    const line = _lineOfPattern(lines, _keyPattern('rules'));
    findings.push(_finding(
      RULES.wildcardRbac,
      file,
      line ? line + offset : null,
      _label(doc) + ' grants * verbs on * resources',
    ));
  }
}

function _checkDocument(entry, file, findings, warnings) {
  let doc;
  try {
    doc = safeYamlParse(entry.text, { kind: KIND });
  } catch (err) {
    if (_isFatalYamlError(err)) throw err;
    warnings.push('yaml-parse-failed');
    return;
  }
  if (doc == null) return;
  if (!_looksLikeManifest(doc)) {
    if (!_isPlainObject(doc)) warnings.push('unexpected-document-shape');
    return;
  }
  const ctx = {
    doc,
    lines: entry.text.split('\n'),
    offset: entry.startLine - 1,
    file,
    findings,
  };
  if (RBAC_KINDS.includes(doc.kind)) {
    _checkRbac(ctx);
    return;
  }
  if (doc.kind === SERVICE_ACCOUNT_KIND) {
    _checkServiceAccount(ctx);
    return;
  }
  if (!WORKLOAD_KINDS.includes(doc.kind)) return;
  const podSpecs = _podSpecs(doc);
  if (podSpecs.length === 0) {
    warnings.push('no-pod-spec-found');
    return;
  }
  for (const podSpec of podSpecs) _checkPodSpec(ctx, podSpec);
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
  _enforceSizeCapViaWrapper(content);
  const documents = _splitDocuments(content);
  if (documents.length === 0) {
    warnings.push('empty-document');
    return { findings, warnings };
  }
  for (const entry of documents) _checkDocument(entry, file, findings, warnings);
  return { findings, warnings: [...new Set(warnings)] };
}

module.exports = {
  RULES,
  FILES,
  matches,
  check,
};
