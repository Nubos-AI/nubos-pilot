'use strict';

const { safeYamlParse } = require('../../yaml.cjs');
const { make } = require('../finding.cjs');

const SCANNER = 'misconfig';
const KIND = 'docker-compose';

const FILES = Object.freeze([
  '**/docker-compose*.yml', '**/docker-compose*.yaml',
  '**/compose*.yml', '**/compose*.yaml',
]);

const COMPOSE_BASENAME_RE = /^(docker-compose|compose)[^/]*\.ya?ml$/;

const RULES = Object.freeze({
  privileged: Object.freeze({
    id: 'NPS-0600',
    rule_name: 'compose_privileged_service',
    category: 'compose-privilege',
    severity: 'critical',
    cwe: Object.freeze(['CWE-250']),
    reminder: 'A privileged service keeps every capability and unrestricted device access, so it can reach host devices and kernel interfaces directly. Remove privileged and grant only the specific cap_add entries the service needs.',
  }),
  dockerSocket: Object.freeze({
    id: 'NPS-0601',
    rule_name: 'compose_docker_socket_mount',
    category: 'compose-isolation',
    severity: 'critical',
    cwe: Object.freeze(['CWE-668']),
    reminder: 'Access to the container runtime socket is root on the host: the service can start a privileged container that mounts the host filesystem. Remove the mount, or put a proxy in front of the socket that allows only the specific API calls required.',
  }),
  sensitiveHostMount: Object.freeze({
    id: 'NPS-0602',
    rule_name: 'compose_sensitive_host_mount',
    category: 'compose-isolation',
    severity: 'high',
    cwe: Object.freeze(['CWE-668']),
    reminder: 'Bind-mounting /, /etc, /proc or /sys hands the container the host configuration and kernel interfaces, which turns any code execution in the container into host compromise. Mount only the specific directory the service reads, and add :ro.',
  }),
  hostNetwork: Object.freeze({
    id: 'NPS-0603',
    rule_name: 'compose_host_network_mode',
    category: 'compose-isolation',
    severity: 'high',
    cwe: Object.freeze(['CWE-653']),
    reminder: 'network_mode: host removes network isolation, so the service binds directly on host interfaces and can reach loopback-only services and cloud metadata endpoints. Use a compose network and publish only the ports that must be reachable.',
  }),
  hostPid: Object.freeze({
    id: 'NPS-0604',
    rule_name: 'compose_host_pid_mode',
    category: 'compose-isolation',
    severity: 'high',
    cwe: Object.freeze(['CWE-653']),
    reminder: 'pid: host exposes every process on the machine, including their command lines and /proc entries, which is a direct path to credentials passed as arguments. Remove it, or share a PID namespace with only the one container that needs it.',
  }),
  dangerousCapability: Object.freeze({
    id: 'NPS-0605',
    rule_name: 'compose_dangerous_capability',
    category: 'compose-privilege',
    severity: 'high',
    cwe: Object.freeze(['CWE-250']),
    reminder: 'SYS_ADMIN is close to full root, SYS_PTRACE allows reading other processes, and NET_ADMIN or NET_RAW allow traffic interception and spoofing. Drop the capability, or replace it with the narrower one that covers the actual need.',
  }),
  exposedServicePort: Object.freeze({
    id: 'NPS-0606',
    rule_name: 'compose_exposed_datastore_port',
    category: 'compose-network-exposure',
    severity: 'high',
    cwe: Object.freeze(['CWE-668']),
    reminder: 'A published port with no host interface binds on every address, so a datastore that should only be reachable from sibling containers becomes reachable from the network. Drop the ports entry and let services talk over the compose network, or bind it to 127.0.0.1 (127.0.0.1:5432:5432).',
  }),
  hardcodedPassword: Object.freeze({
    id: 'NPS-0607',
    rule_name: 'compose_hardcoded_password',
    category: 'compose-secret',
    severity: 'high',
    cwe: Object.freeze(['CWE-798']),
    reminder: 'A credential written into the compose file is committed, shared and visible in docker inspect for anyone who can reach the daemon. Move the value to an env_file that is git-ignored, or to a secret, and reference it as ${VAR}. Rotate the value now that it has been committed.',
  }),
  mutableImageTag: Object.freeze({
    id: 'NPS-0608',
    rule_name: 'compose_mutable_image_tag',
    category: 'compose-supply-chain',
    severity: 'medium',
    cwe: Object.freeze(['CWE-494']),
    reminder: 'An absent tag or :latest resolves to whatever the registry serves at pull time, so what runs is not what was reviewed and a rollback is not reproducible. Reference the image by digest, or by an immutable release tag.',
  }),
  rootUserWithHostMount: Object.freeze({
    id: 'NPS-0609',
    rule_name: 'compose_root_user_with_host_mount',
    category: 'compose-hardening',
    severity: 'low',
    cwe: Object.freeze(['CWE-250']),
    reminder: 'A container without an explicit user runs as root, and combined with a bind mount it writes root-owned files onto the host and can modify whatever the mount exposes. Set user: to a non-root uid:gid and make the mounted directory writable by it.',
  }),
});

const DANGEROUS_CAPABILITIES = Object.freeze([
  'SYS_ADMIN', 'SYS_PTRACE', 'SYS_MODULE', 'SYS_BOOT', 'SYS_RAWIO',
  'NET_ADMIN', 'NET_RAW', 'DAC_READ_SEARCH', 'ALL',
]);
const SENSITIVE_HOST_PATHS = Object.freeze(['/', '/etc', '/proc', '/sys', '/var/lib/docker', '/root']);
const RUNTIME_SOCKET_RE = /(^|\/)(docker|containerd|crio)\.sock$/;
const DATASTORE_IMAGE_RE = /(^|\/)(postgres|postgis|mysql|mariadb|percona|mongo|redis|valkey|memcached|elasticsearch|opensearch|clickhouse|cassandra|scylla|couchdb|couchbase|neo4j|influxdb|rabbitmq|kafka|zookeeper|etcd|arangodb|mssql|sqlserver|oracle)/i;
const DATASTORE_NAME_RE = /(postgres|mysql|mariadb|mongo|redis|valkey|memcache|elastic|opensearch|clickhouse|cassandra|couch|neo4j|influx|rabbit|kafka|zookeeper|etcd|db|database)/i;
const DATASTORE_PORTS = Object.freeze([
  1433, 1521, 2181, 2379, 3306, 5432, 5433, 5672, 5984, 6379, 7000, 7474, 7687,
  8086, 8529, 9042, 9092, 9200, 9300, 11211, 15672, 27017, 27018, 27019,
]);
const SECRET_KEY_RE = /(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)/i;
const SECRET_KEY_EXEMPT_RE = /(_file$|_path$|_name$|_id$|_user$|_enabled$|public)/i;
const INTERPOLATION_ONLY_RE = /^\$(\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*)$/;
const ROOT_USER_RE = /^(root|0)(:.*)?$/;
const DIGEST_RE = /@sha(256|512):[0-9a-f]+$/i;
const UNSPECIFIED_HOST_IPS = Object.freeze(['0.0.0.0', '::', '[::]', '*']);

function _isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function matches(relPath) {
  if (typeof relPath !== 'string' || !relPath) return false;
  const normalized = relPath.replace(/\\/g, '/');
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
  return COMPOSE_BASENAME_RE.test(basename);
}

function _isFatalYamlError(err) {
  const code = err && err.code;
  if (code === 'yaml-too-large' || code === 'yaml-invalid-input') return true;
  return !!err && typeof err.message === 'string' && /alias/i.test(err.message);
}

function _escape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function _serviceWindow(lines, name) {
  const servicesLine = _lineOfPattern(lines, /^\s*services\s*:/) || 0;
  const pattern = new RegExp('^\\s+(["\']?)' + _escape(name) + '\\1\\s*:\\s*(#.*)?$');
  const start = _lineOfPattern(lines, pattern, servicesLine);
  if (!start) return { start: null, end: lines.length };
  const indent = _indentOf(lines[start - 1]);
  for (let i = start; i < lines.length; i += 1) {
    if (lines[i].trim() === '') continue;
    if (_indentOf(lines[i]) <= indent) return { start, end: i };
  }
  return { start, end: lines.length };
}

function _services(doc) {
  const source = _isPlainObject(doc.services) ? doc.services : null;
  if (!source) return [];
  const out = [];
  for (const [name, service] of Object.entries(source)) {
    if (_isPlainObject(service)) out.push({ name, service });
  }
  return out;
}

function _volumeMounts(service) {
  const volumes = Array.isArray(service.volumes) ? service.volumes : [];
  const out = [];
  for (const volume of volumes) {
    if (typeof volume === 'string') {
      const parts = volume.split(':');
      const source = parts.length >= 2 ? parts[0] : null;
      out.push({ raw: volume, source, bind: !!source && /^[./~$]/.test(source) });
      continue;
    }
    if (!_isPlainObject(volume)) continue;
    const source = typeof volume.source === 'string' ? volume.source : null;
    const bind = volume.type === 'bind' || (!!source && /^[./~$]/.test(source));
    out.push({ raw: source || 'bind', source, bind });
  }
  return out;
}

function _normalizeHostPath(source) {
  if (typeof source !== 'string' || !source) return null;
  const trimmed = source.trim();
  if (!trimmed.startsWith('/')) return null;
  const collapsed = trimmed.replace(/\/+/g, '/');
  return collapsed.length > 1 ? collapsed.replace(/\/$/, '') : '/';
}

function _publishedPorts(service) {
  const ports = Array.isArray(service.ports) ? service.ports : [];
  const out = [];
  for (const port of ports) {
    if (typeof port === 'number') {
      out.push({ raw: String(port), hostIp: null, target: port });
      continue;
    }
    if (typeof port === 'string') {
      const spec = port.trim().replace(/\/(tcp|udp|sctp)$/i, '');
      const bracket = /^\[([^\]]+)\]:(.*)$/.exec(spec);
      const hostIp = bracket ? bracket[1] : null;
      const rest = bracket ? bracket[2] : spec;
      const parts = rest.split(':');
      if (!bracket && parts.length >= 3) {
        out.push({ raw: port, hostIp: parts[0], target: Number(parts[2].split('-')[0]) });
        continue;
      }
      const target = parts[parts.length - 1];
      out.push({ raw: port, hostIp, target: Number(target.split('-')[0]) });
      continue;
    }
    if (!_isPlainObject(port)) continue;
    if (port.published === undefined || port.published === null) continue;
    out.push({
      raw: String(port.published) + ':' + String(port.target),
      hostIp: typeof port.host_ip === 'string' ? port.host_ip : null,
      target: Number(port.target),
    });
  }
  return out;
}

function _envEntries(service) {
  const environment = service.environment;
  const out = [];
  if (_isPlainObject(environment)) {
    for (const [key, value] of Object.entries(environment)) {
      out.push({ key, value: value == null ? '' : String(value) });
    }
    return out;
  }
  if (Array.isArray(environment)) {
    for (const entry of environment) {
      if (typeof entry !== 'string') continue;
      const eq = entry.indexOf('=');
      if (eq === -1) continue;
      out.push({ key: entry.slice(0, eq).trim(), value: entry.slice(eq + 1) });
    }
  }
  return out;
}

function _capabilityNames(service) {
  const added = Array.isArray(service.cap_add) ? service.cap_add : [];
  return added
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.trim().toUpperCase().replace(/^CAP_/, ''));
}

function _imageTag(image) {
  if (typeof image !== 'string' || !image.trim()) return { present: false, pinned: false, tag: null };
  const spec = image.trim();
  if (DIGEST_RE.test(spec)) return { present: true, pinned: true, tag: null };
  const lastSlash = spec.lastIndexOf('/');
  const name = lastSlash === -1 ? spec : spec.slice(lastSlash + 1);
  const colon = name.lastIndexOf(':');
  if (colon === -1) return { present: true, pinned: false, tag: null };
  return { present: true, pinned: false, tag: name.slice(colon + 1) };
}

function _isDatastore(name, service, target) {
  if (typeof service.image === 'string' && DATASTORE_IMAGE_RE.test(service.image)) return true;
  if (DATASTORE_NAME_RE.test(name)) return true;
  return Number.isFinite(target) && DATASTORE_PORTS.includes(target);
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

function _checkService(state, name, service) {
  const { lines, file, findings } = state;
  const window = _serviceWindow(lines, name);
  const anchor = window.start;
  const at = (key) => (window.start
    ? _lineOfPattern(lines, new RegExp('^\\s*' + key + '\\s*:'), window.start, window.end) || anchor
    : null);
  const atText = (needle) => (window.start
    ? _lineOfText(lines, needle, window.start, window.end) || anchor
    : null);
  const where = 'service "' + name + '"';

  if (service.privileged === true) {
    findings.push(_finding(RULES.privileged, file, at('privileged'), where + ' runs privileged'));
  }

  const mounts = _volumeMounts(service);
  const bindMounts = mounts.filter((mount) => mount.bind);
  for (const mount of bindMounts) {
    const hostPath = _normalizeHostPath(mount.source);
    if (!hostPath) continue;
    if (RUNTIME_SOCKET_RE.test(hostPath)) {
      findings.push(_finding(
        RULES.dockerSocket,
        file,
        atText(mount.raw),
        where + ' bind-mounts the container runtime socket ' + hostPath,
      ));
      continue;
    }
    const sensitive = SENSITIVE_HOST_PATHS.find((candidate) => hostPath === candidate
      || (candidate !== '/' && hostPath.startsWith(candidate + '/')));
    if (sensitive) {
      findings.push(_finding(
        RULES.sensitiveHostMount,
        file,
        atText(mount.raw),
        where + ' bind-mounts the sensitive host path ' + hostPath,
      ));
    }
  }

  if (typeof service.network_mode === 'string' && service.network_mode.trim().toLowerCase() === 'host') {
    findings.push(_finding(RULES.hostNetwork, file, at('network_mode'), where + ' uses network_mode: host'));
  }

  if (typeof service.pid === 'string' && service.pid.trim().toLowerCase() === 'host') {
    findings.push(_finding(RULES.hostPid, file, at('pid'), where + ' uses pid: host'));
  }

  const dangerous = _capabilityNames(service).filter((cap) => DANGEROUS_CAPABILITIES.includes(cap));
  if (dangerous.length > 0) {
    findings.push(_finding(
      RULES.dangerousCapability,
      file,
      at('cap_add'),
      where + ' adds the capability ' + dangerous.join(', '),
    ));
  }

  for (const port of _publishedPorts(service)) {
    const unrestricted = port.hostIp === null || UNSPECIFIED_HOST_IPS.includes(port.hostIp.trim());
    if (!unrestricted || !_isDatastore(name, service, port.target)) continue;
    findings.push(_finding(
      RULES.exposedServicePort,
      file,
      atText(port.raw) || at('ports'),
      where + ' publishes port ' + port.raw + ' on every host interface',
    ));
  }

  for (const entry of _envEntries(service)) {
    if (!SECRET_KEY_RE.test(entry.key) || SECRET_KEY_EXEMPT_RE.test(entry.key)) continue;
    const value = entry.value.trim();
    if (!value || INTERPOLATION_ONLY_RE.test(value)) continue;
    findings.push(_finding(
      RULES.hardcodedPassword,
      file,
      atText(entry.key),
      where + ' hardcodes the credential ' + entry.key + ' (value redacted)',
    ));
  }

  const image = _imageTag(service.image);
  if (image.present && !image.pinned && (image.tag === null || image.tag === 'latest')) {
    findings.push(_finding(
      RULES.mutableImageTag,
      file,
      at('image'),
      where + ' uses the mutable image reference ' + service.image.trim(),
    ));
  }

  if (bindMounts.length > 0) {
    const user = service.user === undefined || service.user === null ? null : String(service.user).trim();
    if (user === null || ROOT_USER_RE.test(user)) {
      findings.push(_finding(
        RULES.rootUserWithHostMount,
        file,
        user === null ? anchor : at('user'),
        where + ' mounts host paths and runs as root (' + (user === null ? 'no user declared' : 'user: ' + user) + ')',
      ));
    }
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
  const services = _services(doc);
  if (services.length === 0) {
    warnings.push('no-services-declared');
    return { findings, warnings };
  }
  const state = { lines: content.split('\n'), file, findings };
  for (const { name, service } of services) _checkService(state, name, service);
  return { findings, warnings };
}

module.exports = {
  RULES,
  FILES,
  matches,
  check,
};
