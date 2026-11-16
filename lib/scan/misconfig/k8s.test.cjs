'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { RULES, matches, check } = require('./k8s.cjs');
const { idInRange, SEVERITIES } = require('../finding.cjs');

const FILE = 'deploy/k8s/app.yaml';

function run(yaml) {
  return check(yaml, { file: FILE });
}

function ids(findings) {
  return findings.map((f) => f.id);
}

function titles(findings) {
  return findings.map((f) => f.title).join(' | ');
}

function pod(containerLines, podLines) {
  return [
    'apiVersion: v1',
    'kind: Pod',
    'metadata:',
    '  name: sample',
    'spec:',
  ]
    .concat(podLines || [])
    .concat(['  containers:', '    - name: app', '      image: registry.example.com/app:1.4.2'])
    .concat(containerLines || [])
    .join('\n');
}

const HARDENED = [
  'apiVersion: apps/v1',
  'kind: Deployment',
  'metadata:',
  '  name: web',
  'spec:',
  '  template:',
  '    spec:',
  '      containers:',
  '        - name: app',
  '          image: registry.example.com/app@sha256:'.concat('a'.repeat(64)),
  '          securityContext:',
  '            privileged: false',
  '            allowPrivilegeEscalation: false',
  '            runAsNonRoot: true',
  '            runAsUser: 1000',
  '            readOnlyRootFilesystem: true',
  '            capabilities:',
  '              drop: [ALL]',
  '          resources:',
  '            limits:',
  '              cpu: 500m',
  '              memory: 256Mi',
].join('\n');

test('K8S-1 every rule id is unique, in the misconfig range and inside NPS-0550..0599', () => {
  const entries = Object.values(RULES);
  assert.ok(entries.length > 0);
  const seen = new Set();
  for (const rule of entries) {
    assert.ok(idInRange(rule.id, 'misconfig'), rule.id + ' must be a misconfig id');
    const n = Number(rule.id.slice(4));
    assert.ok(n >= 550 && n <= 599, rule.id + ' must fall in the k8s sub-block');
    assert.ok(!seen.has(rule.id), rule.id + ' is duplicated');
    seen.add(rule.id);
    assert.ok(SEVERITIES.includes(rule.severity));
    assert.match(rule.rule_name, /^k8s_[a-z_]+$/);
    assert.ok(rule.reminder.length > 40);
  }
});

test('K8S-2 matches keys off a parsed document carrying apiVersion and kind', () => {
  assert.equal(matches('anywhere/thing.yaml', { apiVersion: 'v1', kind: 'Pod' }), true);
  assert.equal(matches('x.yaml', { apiVersion: 'v1' }), false);
  assert.equal(matches('x.yaml', { kind: 'Pod' }), false);
  assert.equal(matches('x.yaml', { services: {} }), false);
  assert.equal(matches('x.yaml', [{ a: 1 }, { apiVersion: 'v1', kind: 'Service' }]), true);
  assert.equal(matches('x.yaml', [{ a: 1 }]), false);
  assert.equal(matches('charts/templates/deploy.yml'), true);
  assert.equal(matches('src/index.js'), false);
  assert.equal(matches(null), false);
});

test('K8S-3 a privileged container is critical and carries the privileged line', () => {
  const yaml = pod(['      securityContext:', '        privileged: true']);
  const { findings } = run(yaml);
  const hit = findings.find((f) => f.id === RULES.privilegedContainer.id);
  assert.ok(hit, titles(findings));
  assert.equal(hit.severity, 'critical');
  assert.equal(hit.file, FILE);
  assert.equal(hit.scanner, 'misconfig');
  assert.equal(hit.line, 10);
  assert.match(hit.title, /Pod "sample" container "app"/);
});

test('K8S-4 allowPrivilegeEscalation true is high, absent is low, false is clean', () => {
  const explicit = pod(['      securityContext:', '        allowPrivilegeEscalation: true']);
  const hit = run(explicit).findings.find((f) => f.id === RULES.privilegeEscalation.id);
  assert.ok(hit);
  assert.equal(hit.severity, 'high');
  assert.equal(hit.line, 10);

  const absent = run(pod()).findings.find((f) => f.id === RULES.privilegeEscalationDefault.id);
  assert.ok(absent, 'absent allowPrivilegeEscalation is an advisory');
  assert.equal(absent.severity, 'low');

  const disabled = pod(['      securityContext:', '        allowPrivilegeEscalation: false']);
  const disabledIds = ids(run(disabled).findings);
  assert.ok(!disabledIds.includes(RULES.privilegeEscalation.id));
  assert.ok(!disabledIds.includes(RULES.privilegeEscalationDefault.id));
});

test('K8S-5 runAsUser 0 and runAsNonRoot false are root, inherited from the pod spec too', () => {
  const containerRoot = pod(['      securityContext:', '        runAsUser: 0']);
  const hit = run(containerRoot).findings.find((f) => f.id === RULES.runAsRoot.id);
  assert.ok(hit);
  assert.equal(hit.severity, 'high');
  assert.match(hit.title, /runAsUser: 0/);

  const podLevel = pod([], ['  securityContext:', '    runAsNonRoot: false']);
  assert.ok(ids(run(podLevel).findings).includes(RULES.runAsRoot.id), 'pod level applies to the container');

  const nonRoot = pod(['      securityContext:', '        runAsNonRoot: true', '        runAsUser: 1000']);
  assert.ok(!ids(run(nonRoot).findings).includes(RULES.runAsRoot.id));
});

test('K8S-6 each shared host namespace is reported, false values are not', () => {
  const shared = pod([], ['  hostNetwork: true', '  hostPID: true', '  hostIPC: true']);
  const hits = run(shared).findings.filter((f) => f.id === RULES.hostNamespace.id);
  assert.equal(hits.length, 3);
  assert.deepEqual(hits.map((f) => f.line), [6, 7, 8]);
  for (const hit of hits) assert.equal(hit.severity, 'high');

  const isolated = pod([], ['  hostNetwork: false', '  hostPID: false']);
  assert.ok(!ids(run(isolated).findings).includes(RULES.hostNamespace.id));
});

test('K8S-7 the runtime socket and host root are critical, other host paths high, emptyDir clean', () => {
  const sock = pod([], [
    '  volumes:',
    '    - name: sock',
    '      hostPath:',
    '        path: /var/run/docker.sock',
  ]);
  const sockHit = run(sock).findings.find((f) => f.id === RULES.hostPathCritical.id);
  assert.ok(sockHit, titles(run(sock).findings));
  assert.equal(sockHit.severity, 'critical');
  assert.equal(sockHit.line, 9);

  const root = pod([], ['  volumes:', '    - name: r', '      hostPath:', '        path: /']);
  assert.ok(ids(run(root).findings).includes(RULES.hostPathCritical.id));

  const logs = pod([], ['  volumes:', '    - name: l', '      hostPath:', '        path: /var/log']);
  const logHit = run(logs).findings.find((f) => f.id === RULES.hostPath.id);
  assert.ok(logHit);
  assert.equal(logHit.severity, 'high');

  const ephemeral = pod([], ['  volumes:', '    - name: cache', '      emptyDir: {}']);
  const ephemeralIds = ids(run(ephemeral).findings);
  assert.ok(!ephemeralIds.includes(RULES.hostPath.id));
  assert.ok(!ephemeralIds.includes(RULES.hostPathCritical.id));
});

test('K8S-8 missing cpu or memory limits is reported, complete limits are clean', () => {
  const none = run(pod()).findings.find((f) => f.id === RULES.missingResourceLimits.id);
  assert.ok(none);
  assert.equal(none.severity, 'medium');
  assert.match(none.title, /no cpu or memory limit/);

  const partial = pod(['      resources:', '        limits:', '          memory: 128Mi']);
  const partialHit = run(partial).findings.find((f) => f.id === RULES.missingResourceLimits.id);
  assert.ok(partialHit);
  assert.match(partialHit.title, /no cpu limit/);

  const complete = pod([
    '      resources:', '        limits:', '          cpu: 250m', '          memory: 128Mi',
  ]);
  assert.ok(!ids(run(complete).findings).includes(RULES.missingResourceLimits.id));
});

test('K8S-9 dangerous added capabilities fire, benign ones do not', () => {
  const dangerous = pod([
    '      securityContext:',
    '        capabilities:',
    '          add: ["NET_ADMIN", "CAP_SYS_ADMIN"]',
  ]);
  const hit = run(dangerous).findings.find((f) => f.id === RULES.dangerousCapability.id);
  assert.ok(hit);
  assert.equal(hit.severity, 'high');
  assert.match(hit.title, /NET_ADMIN, SYS_ADMIN/);
  assert.equal(hit.line, 11);

  const benign = pod([
    '      securityContext:',
    '        capabilities:',
    '          add: [NET_BIND_SERVICE]',
    '          drop: [ALL]',
  ]);
  assert.ok(!ids(run(benign).findings).includes(RULES.dangerousCapability.id));
});

test('K8S-10 a writable root filesystem is a low advisory unless it is read-only', () => {
  const hit = run(pod()).findings.find((f) => f.id === RULES.writableRootFilesystem.id);
  assert.ok(hit);
  assert.equal(hit.severity, 'low');

  const readOnly = pod(['      securityContext:', '        readOnlyRootFilesystem: true']);
  assert.ok(!ids(run(readOnly).findings).includes(RULES.writableRootFilesystem.id));
});

test('K8S-11 mutable image references are reported, tags and digests are not', () => {
  const latest = [
    'apiVersion: v1',
    'kind: Pod',
    'metadata:',
    '  name: p',
    'spec:',
    '  containers:',
    '    - name: a',
    '      image: nginx:latest',
    '    - name: b',
    '      image: redis',
    '    - name: c',
    '      image: registry.example.com:5000/team/app:2.1.0',
    '    - name: d',
    '      image: ghcr.io/org/app@sha256:' + 'b'.repeat(64),
  ].join('\n');
  const hits = run(latest).findings.filter((f) => f.id === RULES.mutableImageTag.id);
  assert.equal(hits.length, 2, titles(hits));
  assert.deepEqual(hits.map((f) => f.line), [8, 10]);
  assert.equal(hits[0].severity, 'medium');
});

test('K8S-12 a ServiceAccount without automountServiceAccountToken false is a low advisory', () => {
  const open = [
    'apiVersion: v1',
    'kind: ServiceAccount',
    'metadata:',
    '  name: runner',
  ].join('\n');
  const hit = run(open).findings.find((f) => f.id === RULES.automountServiceAccountToken.id);
  assert.ok(hit);
  assert.equal(hit.severity, 'low');

  const disabled = open + '\nautomountServiceAccountToken: false';
  assert.deepEqual(run(disabled).findings, []);
});

test('K8S-13 a Role granting * verbs on * resources is high, scoped rules are clean', () => {
  const wildcard = [
    'apiVersion: rbac.authorization.k8s.io/v1',
    'kind: ClusterRole',
    'metadata:',
    '  name: everything',
    'rules:',
    '  - apiGroups: ["*"]',
    '    resources: ["*"]',
    '    verbs: ["*"]',
  ].join('\n');
  const hit = run(wildcard).findings.find((f) => f.id === RULES.wildcardRbac.id);
  assert.ok(hit);
  assert.equal(hit.severity, 'high');
  assert.equal(hit.line, 5);

  const scoped = wildcard
    .replace('resources: ["*"]', 'resources: ["pods"]')
    .replace('verbs: ["*"]', 'verbs: ["get", "list"]');
  assert.deepEqual(run(scoped).findings, []);

  const verbsOnly = wildcard.replace('resources: ["*"]', 'resources: ["secrets"]');
  assert.deepEqual(run(verbsOnly).findings, []);
});

test('K8S-14 multi-document files are checked per document with file-absolute lines', () => {
  const yaml = [
    HARDENED,
    '---',
    'apiVersion: v1',
    'kind: ConfigMap',
    'metadata:',
    '  name: settings',
    'data:',
    '  KEY: value',
    '---',
    'apiVersion: v1',
    'kind: Pod',
    'metadata:',
    '  name: risky',
    'spec:',
    '  hostPID: true',
    '  containers:',
    '    - name: tool',
    '      image: busybox:latest',
    '      securityContext:',
    '        privileged: true',
  ].join('\n');
  const { findings, warnings } = run(yaml);
  assert.deepEqual(warnings, []);
  const hostPid = findings.find((f) => f.id === RULES.hostNamespace.id);
  assert.ok(hostPid, titles(findings));
  assert.equal(hostPid.line, 36);
  const privileged = findings.find((f) => f.id === RULES.privilegedContainer.id);
  assert.equal(privileged.line, 41);
  assert.ok(findings.every((f) => f.title.includes('risky')), 'the hardened doc and ConfigMap add nothing');
});

test('K8S-15 a malformed document warns without aborting the other documents', () => {
  const yaml = [
    'apiVersion: v1',
    'kind: Pod',
    'metadata:',
    '  name: broken',
    'spec:',
    '  containers:',
    '\tbad: indentation',
    '---',
    'apiVersion: v1',
    'kind: Pod',
    'metadata:',
    '  name: second',
    'spec:',
    '  containers:',
    '    - name: app',
    '      image: app:latest',
    '      securityContext:',
    '        privileged: true',
  ].join('\n');
  const { findings, warnings } = run(yaml);
  assert.deepEqual(warnings, ['yaml-parse-failed']);
  const privileged = findings.find((f) => f.id === RULES.privilegedContainer.id);
  assert.ok(privileged, 'the second document is still checked');
  assert.equal(privileged.line, 18);
  assert.ok(findings.every((f) => f.title.includes('second')));
});

test('K8S-16 nested workloads cover template, jobTemplate, initContainers and ephemeralContainers', () => {
  const cronJob = [
    'apiVersion: batch/v1',
    'kind: CronJob',
    'metadata:',
    '  name: nightly',
    'spec:',
    '  schedule: "0 3 * * *"',
    '  jobTemplate:',
    '    spec:',
    '      template:',
    '        spec:',
    '          initContainers:',
    '            - name: warmup',
    '              image: warm:1.0',
    '              securityContext:',
    '                privileged: true',
    '          containers:',
    '            - name: batch',
    '              image: batch:1.0',
    '          ephemeralContainers:',
    '            - name: debug',
    '              image: debug:1.0',
    '              securityContext:',
    '                runAsUser: 0',
  ].join('\n');
  const { findings } = run(cronJob);
  assert.ok(findings.some((f) => f.id === RULES.privilegedContainer.id && f.title.includes('warmup')));
  assert.ok(findings.some((f) => f.id === RULES.runAsRoot.id && f.title.includes('debug')));
  assert.ok(findings.some((f) => f.id === RULES.missingResourceLimits.id && f.title.includes('batch')));
  assert.ok(findings.every((f) => f.title.startsWith('CronJob "nightly"')));
});

test('K8S-17 a hardened Deployment is clean and non-workload kinds are skipped silently', () => {
  const hardened = run(HARDENED);
  assert.deepEqual(hardened.findings, [], titles(hardened.findings));
  assert.deepEqual(hardened.warnings, []);

  const service = [
    'apiVersion: v1',
    'kind: Service',
    'metadata:',
    '  name: web',
    'spec:',
    '  ports:',
    '    - port: 80',
  ].join('\n');
  assert.deepEqual(run(service), { findings: [], warnings: [] });

  const workloadWithoutContainers = [
    'apiVersion: apps/v1',
    'kind: Deployment',
    'metadata:',
    '  name: web',
    'spec:',
    '  replicas: 0',
  ].join('\n');
  assert.deepEqual(run(workloadWithoutContainers), {
    findings: [],
    warnings: ['no-pod-spec-found'],
  });
});

test('K8S-18 the safeYamlParse size and alias caps propagate instead of degrading to a warning', () => {
  const filler = 'apiVersion: v1\nkind: ConfigMap\ndata:\n  k: ' + 'x'.repeat(4096) + '\n---\n';
  const oversized = filler.repeat(Math.ceil((1024 * 1024) / filler.length) + 1);
  assert.throws(() => run(oversized), (err) => err.code === 'yaml-too-large');

  let bomb = 'apiVersion: v1\nkind: Pod\nspec:\n  anchor: &a [1, 2, 3]\n  containers:\n';
  for (let i = 0; i < 200; i += 1) bomb += '    - *a\n';
  assert.throws(() => run(bomb), (err) => /alias/i.test(err.message));
});

test('K8S-19 malformed single documents and empty input warn instead of throwing', () => {
  assert.deepEqual(run('kind: Pod\n\tbad: 1').warnings, ['yaml-parse-failed']);
  assert.deepEqual(run(''), { findings: [], warnings: ['empty-document'] });
  assert.deepEqual(check(42, { file: FILE }), { findings: [], warnings: ['invalid-input'] });
  assert.deepEqual(run('- just\n- a list').warnings, ['unexpected-document-shape']);
});
