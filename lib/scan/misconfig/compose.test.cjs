'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { RULES, FILES, matches, check } = require('./compose.cjs');
const { idInRange, SEVERITIES } = require('../finding.cjs');

const FILE = 'docker-compose.yml';

function run(yaml) {
  return check(yaml, { file: FILE });
}

function ids(findings) {
  return findings.map((f) => f.id);
}

function titles(findings) {
  return findings.map((f) => f.title).join(' | ');
}

function compose(serviceLines) {
  return ['services:', '  app:', '    image: registry.example.com/app:1.4.2']
    .concat(serviceLines || [])
    .join('\n');
}

test('COMPOSE-1 every rule id is unique, in the misconfig range and inside NPS-0600..0629', () => {
  const entries = Object.values(RULES);
  assert.ok(entries.length > 0);
  const seen = new Set();
  for (const rule of entries) {
    assert.ok(idInRange(rule.id, 'misconfig'), rule.id + ' must be a misconfig id');
    const n = Number(rule.id.slice(4));
    assert.ok(n >= 600 && n <= 629, rule.id + ' must fall in the compose sub-block');
    assert.ok(!seen.has(rule.id), rule.id + ' is duplicated');
    seen.add(rule.id);
    assert.ok(SEVERITIES.includes(rule.severity));
    assert.match(rule.rule_name, /^compose_[a-z_]+$/);
    assert.ok(rule.reminder.length > 40);
  }
});

test('COMPOSE-2 matches accepts compose filenames and rejects other YAML', () => {
  assert.equal(matches('docker-compose.yml'), true);
  assert.equal(matches('docker-compose.yaml'), true);
  assert.equal(matches('docker-compose.override.yml'), true);
  assert.equal(matches('deploy/compose.prod.yaml'), true);
  assert.equal(matches('infra/docker/docker-compose.test.yml'), true);
  assert.equal(matches('compose.yml'), true);
  assert.equal(matches('k8s/deployment.yaml'), false);
  assert.equal(matches('my-docker-compose.yml'), false);
  assert.equal(matches('docker-compose.json'), false);
  assert.equal(matches('composer.lock'), false);
  assert.equal(matches(null), false);
  assert.ok(FILES.length >= 4);
});

test('COMPOSE-3 a privileged service is critical and carries its line', () => {
  const yaml = compose(['    privileged: true']);
  const { findings } = run(yaml);
  const hit = findings.find((f) => f.id === RULES.privileged.id);
  assert.ok(hit, titles(findings));
  assert.equal(hit.severity, 'critical');
  assert.equal(hit.scanner, 'misconfig');
  assert.equal(hit.file, FILE);
  assert.equal(hit.line, 4);
  assert.match(hit.title, /service "app"/);

  assert.ok(!ids(run(compose(['    privileged: false'])).findings).includes(RULES.privileged.id));
});

test('COMPOSE-4 mounting the docker socket is critical, a project bind mount is not', () => {
  const socket = compose(['    volumes:', '      - /var/run/docker.sock:/var/run/docker.sock']);
  const hit = run(socket).findings.find((f) => f.id === RULES.dockerSocket.id);
  assert.ok(hit, titles(run(socket).findings));
  assert.equal(hit.severity, 'critical');
  assert.equal(hit.line, 5);

  const longSyntax = compose([
    '    volumes:',
    '      - type: bind',
    '        source: /run/containerd/containerd.sock',
    '        target: /run/containerd/containerd.sock',
  ]);
  assert.ok(ids(run(longSyntax).findings).includes(RULES.dockerSocket.id));

  const project = compose(['    volumes:', '      - ./src:/app/src:ro']);
  const projectIds = ids(run(project).findings);
  assert.ok(!projectIds.includes(RULES.dockerSocket.id));
  assert.ok(!projectIds.includes(RULES.sensitiveHostMount.id));

  const named = compose(['    volumes:', '      - appdata:/var/lib/app']);
  assert.ok(!ids(run(named).findings).includes(RULES.sensitiveHostMount.id));
});

test('COMPOSE-5 sensitive host paths are high, an unrelated absolute path is not', () => {
  for (const path of ['/', '/etc', '/proc', '/sys', '/etc/ssh']) {
    const yaml = compose(['    volumes:', '      - ' + path + ':/host' + (path === '/' ? '' : path) + ':ro']);
    const hit = run(yaml).findings.find((f) => f.id === RULES.sensitiveHostMount.id);
    assert.ok(hit, path + ' should be sensitive; got ' + titles(run(yaml).findings));
    assert.equal(hit.severity, 'high');
  }
  const benign = compose(['    volumes:', '      - /srv/uploads:/data/uploads']);
  assert.ok(!ids(run(benign).findings).includes(RULES.sensitiveHostMount.id));
});

test('COMPOSE-6 network_mode host and pid host are reported, bridge and container: are not', () => {
  const yaml = compose(['    network_mode: host', '    pid: host']);
  const { findings } = run(yaml);
  const network = findings.find((f) => f.id === RULES.hostNetwork.id);
  const pid = findings.find((f) => f.id === RULES.hostPid.id);
  assert.ok(network && pid, titles(findings));
  assert.equal(network.line, 4);
  assert.equal(pid.line, 5);
  assert.equal(network.severity, 'high');
  assert.equal(pid.severity, 'high');

  const scoped = compose(['    network_mode: bridge', '    pid: container:sidecar']);
  const scopedIds = ids(run(scoped).findings);
  assert.ok(!scopedIds.includes(RULES.hostNetwork.id));
  assert.ok(!scopedIds.includes(RULES.hostPid.id));
});

test('COMPOSE-7 dangerous cap_add entries fire, benign ones do not', () => {
  const yaml = compose(['    cap_add:', '      - SYS_ADMIN', '      - CAP_NET_RAW']);
  const hit = run(yaml).findings.find((f) => f.id === RULES.dangerousCapability.id);
  assert.ok(hit);
  assert.equal(hit.severity, 'high');
  assert.match(hit.title, /SYS_ADMIN, NET_RAW/);
  assert.equal(hit.line, 4);

  const benign = compose(['    cap_add:', '      - NET_BIND_SERVICE', '    cap_drop:', '      - ALL']);
  assert.ok(!ids(run(benign).findings).includes(RULES.dangerousCapability.id));
});

test('COMPOSE-8 a datastore port published on every interface is high, a loopback binding is clean', () => {
  const exposed = [
    'services:',
    '  db:',
    '    image: postgres:16.2',
    '    ports:',
    '      - "5432:5432"',
  ].join('\n');
  const hit = run(exposed).findings.find((f) => f.id === RULES.exposedServicePort.id);
  assert.ok(hit, titles(run(exposed).findings));
  assert.equal(hit.severity, 'high');
  assert.equal(hit.line, 5);

  const explicitWildcard = exposed.replace('"5432:5432"', '"0.0.0.0:5432:5432"');
  assert.ok(ids(run(explicitWildcard).findings).includes(RULES.exposedServicePort.id));

  const loopback = exposed.replace('"5432:5432"', '"127.0.0.1:5432:5432"');
  assert.ok(!ids(run(loopback).findings).includes(RULES.exposedServicePort.id));

  const longSyntax = [
    'services:',
    '  cache:',
    '    image: redis:7.2',
    '    ports:',
    '      - target: 6379',
    '        published: 6379',
    '        host_ip: 127.0.0.1',
  ].join('\n');
  assert.ok(!ids(run(longSyntax).findings).includes(RULES.exposedServicePort.id));

  const numericShorthand = exposed.replace('- "5432:5432"', '- 27017');
  assert.ok(ids(run(numericShorthand).findings).includes(RULES.exposedServicePort.id));

  const internalOnly = exposed.replace('    ports:\n      - "5432:5432"', '    expose:\n      - "5432"');
  assert.ok(!ids(run(internalOnly).findings).includes(RULES.exposedServicePort.id));

  const webPort = [
    'services:',
    '  web:',
    '    image: nginx:1.25',
    '    ports:',
    '      - "8080:80"',
  ].join('\n');
  assert.ok(!ids(run(webPort).findings).includes(RULES.exposedServicePort.id), 'a web port is not a datastore');
});

test('COMPOSE-9 a hardcoded password is high and the value never reaches the finding', () => {
  const secret = 'sup3r-s3cret-pw';
  const mapForm = [
    'services:',
    '  db:',
    '    image: postgres:16.2',
    '    environment:',
    '      POSTGRES_USER: app',
    '      POSTGRES_PASSWORD: ' + secret,
  ].join('\n');
  const { findings } = run(mapForm);
  const hit = findings.find((f) => f.id === RULES.hardcodedPassword.id);
  assert.ok(hit, titles(findings));
  assert.equal(hit.severity, 'high');
  assert.equal(hit.line, 6);
  assert.match(hit.title, /POSTGRES_PASSWORD/);
  assert.ok(!JSON.stringify(hit).includes(secret), 'the secret value must be redacted');
  assert.ok(!JSON.stringify(findings).includes(secret));

  const listForm = [
    'services:',
    '  db:',
    '    image: postgres:16.2',
    '    environment:',
    '      - MYSQL_ROOT_PASSWORD=' + secret,
  ].join('\n');
  const listHit = run(listForm).findings.find((f) => f.id === RULES.hardcodedPassword.id);
  assert.ok(listHit);
  assert.ok(!JSON.stringify(listHit).includes(secret));

  const interpolated = mapForm.replace(secret, '${POSTGRES_PASSWORD}');
  assert.ok(!ids(run(interpolated).findings).includes(RULES.hardcodedPassword.id));

  const passthrough = [
    'services:',
    '  db:',
    '    image: postgres:16.2',
    '    environment:',
    '      - POSTGRES_PASSWORD',
  ].join('\n');
  assert.ok(!ids(run(passthrough).findings).includes(RULES.hardcodedPassword.id));

  const fileRef = mapForm.replace('POSTGRES_PASSWORD: ' + secret, 'POSTGRES_PASSWORD_FILE: /run/secrets/pw');
  assert.ok(!ids(run(fileRef).findings).includes(RULES.hardcodedPassword.id));
});

test('COMPOSE-10 mutable image references are reported, pinned ones are not', () => {
  const yaml = [
    'services:',
    '  a:',
    '    image: nginx:latest',
    '  b:',
    '    image: redis',
    '  c:',
    '    image: registry.example.com:5000/team/app:2.1.0',
    '  d:',
    '    image: ghcr.io/org/app@sha256:' + 'c'.repeat(64),
    '  e:',
    '    build: ./service',
  ].join('\n');
  const hits = run(yaml).findings.filter((f) => f.id === RULES.mutableImageTag.id);
  assert.equal(hits.length, 2, titles(hits));
  assert.deepEqual(hits.map((f) => f.line), [3, 5]);
  assert.equal(hits[0].severity, 'medium');
});

test('COMPOSE-11 root or absent user with a bind mount is a low advisory', () => {
  const absent = compose(['    volumes:', '      - ./data:/data']);
  const hit = run(absent).findings.find((f) => f.id === RULES.rootUserWithHostMount.id);
  assert.ok(hit, titles(run(absent).findings));
  assert.equal(hit.severity, 'low');
  assert.match(hit.title, /no user declared/);

  const explicitRoot = compose(['    user: root', '    volumes:', '      - ./data:/data']);
  const rootHit = run(explicitRoot).findings.find((f) => f.id === RULES.rootUserWithHostMount.id);
  assert.ok(rootHit);
  assert.equal(rootHit.line, 4);

  const zeroUid = compose(['    user: "0:0"', '    volumes:', '      - ./data:/data']);
  assert.ok(ids(run(zeroUid).findings).includes(RULES.rootUserWithHostMount.id));

  const nonRoot = compose(['    user: "1000:1000"', '    volumes:', '      - ./data:/data']);
  assert.ok(!ids(run(nonRoot).findings).includes(RULES.rootUserWithHostMount.id));

  const noMount = compose(['    command: serve']);
  assert.ok(!ids(run(noMount).findings).includes(RULES.rootUserWithHostMount.id));
});

test('COMPOSE-12 malformed YAML warns instead of throwing', () => {
  const { findings, warnings } = run('services:\n  app:\n\timage: nginx');
  assert.deepEqual(findings, []);
  assert.deepEqual(warnings, ['yaml-parse-failed']);
  for (const warning of warnings) assert.match(warning, /^[a-z0-9]+(-[a-z0-9]+)*$/);
});

test('COMPOSE-13 empty, non-mapping and service-less documents warn without findings', () => {
  assert.deepEqual(run(''), { findings: [], warnings: ['empty-document'] });
  assert.deepEqual(run('- a\n- b'), { findings: [], warnings: ['unexpected-document-shape'] });
  assert.deepEqual(run('name: stack\n'), { findings: [], warnings: ['no-services-declared'] });
  assert.deepEqual(check(undefined, { file: FILE }), { findings: [], warnings: ['invalid-input'] });
});

test('COMPOSE-14 a hardened stack produces no findings', () => {
  const yaml = [
    'services:',
    '  web:',
    '    image: registry.example.com/web:1.8.3',
    '    user: "10001:10001"',
    '    read_only: true',
    '    cap_drop:',
    '      - ALL',
    '    ports:',
    '      - "127.0.0.1:8080:8080"',
    '    environment:',
    '      DATABASE_PASSWORD: ${DATABASE_PASSWORD}',
    '  db:',
    '    image: postgres:16.2',
    '    environment:',
    '      POSTGRES_PASSWORD_FILE: /run/secrets/db_password',
    '    secrets:',
    '      - db_password',
    '    volumes:',
    '      - pgdata:/var/lib/postgresql/data',
    'volumes:',
    '  pgdata: {}',
    'secrets:',
    '  db_password:',
    '    file: ./secrets/db_password.txt',
  ].join('\n');
  const { findings, warnings } = run(yaml);
  assert.deepEqual(findings, [], titles(findings));
  assert.deepEqual(warnings, []);
});

test('COMPOSE-15 findings from several services are attributed to the right service and line', () => {
  const yaml = [
    'services:',
    '  proxy:',
    '    image: traefik:v3.0',
    '    volumes:',
    '      - /var/run/docker.sock:/var/run/docker.sock:ro',
    '  runner:',
    '    image: builder:latest',
    '    privileged: true',
  ].join('\n');
  const { findings } = run(yaml);
  const socket = findings.find((f) => f.id === RULES.dockerSocket.id);
  const privileged = findings.find((f) => f.id === RULES.privileged.id);
  assert.match(socket.title, /service "proxy"/);
  assert.equal(socket.line, 5);
  assert.match(privileged.title, /service "runner"/);
  assert.equal(privileged.line, 8);
});
