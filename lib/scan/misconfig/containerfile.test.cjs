'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { RULES, FILES, matches, check } = require('./containerfile.cjs');
const { idInRange, SEVERITIES } = require('../finding.cjs');
const { NubosPilotError } = require('../../core.cjs');

function ids(findings) {
  return findings.map((f) => f.id);
}

function byRule(findings, rule) {
  return findings.filter((f) => f.id === rule.id);
}

function run(lines, opts) {
  return check(lines.join('\n'), opts || { file: 'Dockerfile' });
}

test('CF-1 matches accepts container buildfile names and rejects everything else', () => {
  for (const accepted of [
    'Dockerfile',
    'Dockerfile.prod',
    'build/Dockerfile.ci',
    'api.Dockerfile',
    'Containerfile',
    'ops/Containerfile.base',
    'dockerfile',
  ]) {
    assert.equal(matches(accepted), true, accepted + ' should match');
  }
  for (const rejected of [
    'docker-compose.yml',
    '.dockerignore',
    'README.md',
    'Dockerfile/nested.txt',
    'src/dockerfilehelper.js',
    '',
    null,
  ]) {
    assert.equal(matches(rejected), false, String(rejected) + ' should not match');
  }
  assert.ok(FILES.includes('Dockerfile'));
});

test('CF-2 builder stage as root with an unprivileged final stage produces no root finding', () => {
  const { findings } = run([
    'FROM node:20.11.0@sha256:aaaa AS builder',
    'USER root',
    'RUN npm ci',
    '',
    'FROM gcr.io/distroless/nodejs20@sha256:bbbb',
    'COPY --from=builder /app /app',
    'USER app',
    'CMD ["/app/server.js"]',
  ]);
  assert.deepEqual(byRule(findings, RULES.RUNS_AS_ROOT), []);
  assert.deepEqual(findings, [], 'fully pinned, non-root image is clean: ' + ids(findings).join(','));
});

test('CF-3 unprivileged builder with a root final stage is flagged', () => {
  const { findings } = run([
    'FROM node:20.11.0@sha256:aaaa AS builder',
    'USER app',
    'RUN npm ci',
    '',
    'FROM node:20.11.0@sha256:aaaa',
    'COPY --from=builder /app /app',
    'USER root',
    'CMD ["node", "/app/server.js"]',
  ]);
  const root = byRule(findings, RULES.RUNS_AS_ROOT);
  assert.equal(root.length, 1);
  assert.equal(root[0].line, 7);
  assert.equal(root[0].severity, 'medium');
  assert.match(root[0].title, /USER root/);
});

test('CF-4 a missing USER and a numeric root USER both count as root', () => {
  const missing = run([
    'FROM alpine:3.19.1@sha256:aaaa',
    'RUN apk add --no-cache curl',
    'CMD ["/bin/sh"]',
  ]).findings;
  assert.equal(byRule(missing, RULES.RUNS_AS_ROOT).length, 1);
  assert.equal(byRule(missing, RULES.RUNS_AS_ROOT)[0].line, 1);

  const numeric = run([
    'FROM alpine:3.19.1@sha256:aaaa',
    'USER 0:0',
  ]).findings;
  assert.equal(byRule(numeric, RULES.RUNS_AS_ROOT).length, 1);

  const named = run([
    'FROM alpine:3.19.1@sha256:aaaa',
    'USER 10001:10001',
  ]).findings;
  assert.deepEqual(byRule(named, RULES.RUNS_AS_ROOT), []);
});

test('CF-5 the final stage inherits USER from the stage it is built FROM', () => {
  const { findings } = run([
    'FROM node:20.11.0@sha256:aaaa AS builder',
    'USER app',
    'RUN npm ci',
    'FROM builder',
    'CMD ["node", "server.js"]',
  ]);
  assert.deepEqual(byRule(findings, RULES.RUNS_AS_ROOT), []);
});

test('CF-6 a FROM referencing an earlier stage is not treated as a mutable image', () => {
  const { findings } = run([
    'FROM golang:1.22.0@sha256:aaaa AS builder',
    'RUN go build -o /app/server ./cmd/server',
    'FROM builder AS test',
    'RUN go test ./...',
    'FROM gcr.io/distroless/static@sha256:bbbb',
    'COPY --from=builder /app/server /server',
    'USER nonroot',
    'ENTRYPOINT ["/server"]',
  ]);
  assert.deepEqual(byRule(findings, RULES.MUTABLE_BASE_IMAGE), []);
  assert.deepEqual(byRule(findings, RULES.UNPINNED_BASE_IMAGE), []);
});

test('CF-7 base image pinning is graded latest/untagged medium, tagged-only low, digest clean', () => {
  const untagged = run(['FROM ubuntu', 'USER app']).findings;
  assert.equal(byRule(untagged, RULES.MUTABLE_BASE_IMAGE).length, 1);
  assert.equal(byRule(untagged, RULES.MUTABLE_BASE_IMAGE)[0].severity, 'medium');

  const latest = run(['FROM ubuntu:latest', 'USER app']).findings;
  assert.equal(byRule(latest, RULES.MUTABLE_BASE_IMAGE).length, 1);
  assert.match(byRule(latest, RULES.MUTABLE_BASE_IMAGE)[0].title, /moving base image/);

  const tagged = run(['FROM ubuntu:24.04', 'USER app']).findings;
  assert.deepEqual(byRule(tagged, RULES.MUTABLE_BASE_IMAGE), []);
  assert.equal(byRule(tagged, RULES.UNPINNED_BASE_IMAGE).length, 1);
  assert.equal(byRule(tagged, RULES.UNPINNED_BASE_IMAGE)[0].severity, 'low');

  const pinned = run(['FROM ubuntu:24.04@sha256:aaaa', 'USER app']).findings;
  assert.deepEqual(byRule(pinned, RULES.UNPINNED_BASE_IMAGE), []);

  const scratch = run(['FROM scratch', 'COPY server /server', 'USER 65532']).findings;
  assert.deepEqual(scratch, []);

  const registryPort = run(['FROM registry.internal:5000/base@sha256:aaaa', 'USER app']).findings;
  assert.deepEqual(registryPort, []);
});

test('CF-8 a literal ENV secret is flagged and its value never reaches the finding', () => {
  const { findings } = run([
    'FROM alpine:3.19.1@sha256:aaaa',
    'ENV DB_PASSWORD=hunter2-super-secret',
    'USER app',
  ]);
  const secrets = byRule(findings, RULES.BUILD_SECRET);
  assert.equal(secrets.length, 1);
  assert.equal(secrets[0].severity, 'high');
  assert.equal(secrets[0].line, 2);
  assert.match(secrets[0].title, /DB_PASSWORD/);
  assert.ok(
    !JSON.stringify(findings).includes('hunter2-super-secret'),
    'the secret value must be redacted out of the finding',
  );
});

test('CF-9 secret detection covers ARG and quoted multi-pair ENV, and skips non-literals', () => {
  const positive = run([
    'FROM alpine:3.19.1@sha256:aaaa',
    'ARG GITHUB_TOKEN=ghp_exampleexampleexample',
    'ENV APP_ENV=prod API_KEY="ak_live_exampleexample"',
    'USER app',
  ]).findings;
  const secrets = byRule(positive, RULES.BUILD_SECRET);
  assert.equal(secrets.length, 2);
  assert.ok(!JSON.stringify(secrets).includes('ghp_exampleexampleexample'));
  assert.ok(!JSON.stringify(secrets).includes('ak_live_exampleexample'));

  const nearMiss = run([
    'FROM alpine:3.19.1@sha256:aaaa',
    'ARG GITHUB_TOKEN',
    'ENV DB_PASSWORD_FILE=/run/secrets/db_password',
    'ENV DB_PASSWORD=${DB_PASSWORD}',
    'ENV API_KEY_HEADER=X-Api-Key',
    'USER app',
  ]).findings;
  assert.deepEqual(byRule(nearMiss, RULES.BUILD_SECRET), []);
});

test('CF-10 a RUN spanning line continuations still resolves curl piped into a shell', () => {
  const { findings } = run([
    'FROM debian:12.4@sha256:aaaa',
    'RUN set -eux; \\',
    '    curl -fsSL https://get.example.com/install.sh \\',
    '    | sh',
    'USER app',
  ]);
  const piped = byRule(findings, RULES.REMOTE_SCRIPT_TO_SHELL);
  assert.equal(piped.length, 1);
  assert.equal(piped[0].severity, 'high');
  assert.equal(piped[0].line, 2, 'the finding points at the first line of the logical instruction');
});

test('CF-11 a verified download without a pipe into a shell is not flagged', () => {
  const { findings } = run([
    'FROM debian:12.4@sha256:aaaa',
    'RUN curl -fsSL -o /tmp/install.sh https://get.example.com/install.sh \\',
    ' && echo "abc123  /tmp/install.sh" | sha256sum -c - \\',
    ' && sh /tmp/install.sh',
    'USER app',
  ]);
  assert.deepEqual(byRule(findings, RULES.REMOTE_SCRIPT_TO_SHELL), []);
  const orGuard = run([
    'FROM debian:12.4@sha256:aaaa',
    'RUN wget -q https://example.com/x.tgz || sh /fallback.sh',
    'USER app',
  ]).findings;
  assert.deepEqual(byRule(orGuard, RULES.REMOTE_SCRIPT_TO_SHELL), []);
});

test('CF-12 ADD of a URL is medium, ADD of a local archive is low, COPY is clean', () => {
  const url = run([
    'FROM alpine:3.19.1@sha256:aaaa',
    'ADD https://example.com/app.tar.gz /opt/app.tar.gz',
    'USER app',
  ]).findings;
  assert.equal(byRule(url, RULES.ADD_REMOTE_URL).length, 1);
  assert.equal(byRule(url, RULES.ADD_REMOTE_URL)[0].severity, 'medium');
  assert.deepEqual(byRule(url, RULES.ADD_INSTEAD_OF_COPY), []);

  const archive = run([
    'FROM alpine:3.19.1@sha256:aaaa',
    'ADD dist/app.tar.gz /opt/',
    'USER app',
  ]).findings;
  assert.equal(byRule(archive, RULES.ADD_INSTEAD_OF_COPY).length, 1);
  assert.equal(byRule(archive, RULES.ADD_INSTEAD_OF_COPY)[0].severity, 'low');

  const copied = run([
    'FROM alpine:3.19.1@sha256:aaaa',
    'COPY dist/app.tar.gz /opt/',
    'USER app',
  ]).findings;
  assert.deepEqual(copied, []);
});

test('CF-13 apt-get hygiene fires on a sloppy install and stays quiet on a clean one', () => {
  const sloppy = run([
    'FROM debian:12.4@sha256:aaaa',
    'RUN apt-get update && apt-get install -y git',
    'USER app',
  ]).findings;
  const hygiene = byRule(sloppy, RULES.APT_HYGIENE);
  assert.equal(hygiene.length, 1);
  assert.match(hygiene[0].title, /--no-install-recommends and rm -rf/);

  const clean = run([
    'FROM debian:12.4@sha256:aaaa',
    'RUN apt-get update \\',
    ' && apt-get install -y --no-install-recommends git \\',
    ' && rm -rf /var/lib/apt/lists/*',
    'USER app',
  ]).findings;
  assert.deepEqual(byRule(clean, RULES.APT_HYGIENE), []);

  const partial = run([
    'FROM debian:12.4@sha256:aaaa',
    'RUN apt-get install -y --no-install-recommends git',
    'USER app',
  ]).findings;
  assert.equal(byRule(partial, RULES.APT_HYGIENE).length, 1);
  assert.match(byRule(partial, RULES.APT_HYGIENE)[0].title, /^apt-get install without rm -rf/);
});

test('CF-14 sudo, privileged builds and Docker socket mounts are flagged; lookalikes are not', () => {
  const flagged = run([
    'FROM debian:12.4@sha256:aaaa',
    'RUN sudo chown -R app /srv',
    'RUN --mount=type=bind,src=/var/run/docker.sock,target=/var/run/docker.sock docker ps',
    'RUN --privileged mount -t tmpfs none /mnt',
    'USER app',
  ]).findings;
  assert.equal(byRule(flagged, RULES.SUDO_IN_BUILD).length, 1);
  assert.equal(byRule(flagged, RULES.SUDO_IN_BUILD)[0].severity, 'low');
  assert.equal(byRule(flagged, RULES.PRIVILEGED_BUILD).length, 2);
  assert.equal(byRule(flagged, RULES.PRIVILEGED_BUILD)[0].severity, 'high');

  const lookalike = run([
    'FROM debian:12.4@sha256:aaaa',
    'RUN echo "no sudoers file here" > /etc/motd',
    'USER app',
  ]).findings;
  assert.deepEqual(byRule(lookalike, RULES.SUDO_IN_BUILD), []);
  assert.deepEqual(byRule(lookalike, RULES.PRIVILEGED_BUILD), []);
});

test('CF-15 chmod 777 is flagged and a narrow mode is not', () => {
  const wide = run([
    'FROM alpine:3.19.1@sha256:aaaa',
    'RUN chmod -R 0777 /srv/data',
    'USER app',
  ]).findings;
  assert.equal(byRule(wide, RULES.WORLD_WRITABLE_CHMOD).length, 1);
  assert.equal(byRule(wide, RULES.WORLD_WRITABLE_CHMOD)[0].severity, 'medium');

  const narrow = run([
    'FROM alpine:3.19.1@sha256:aaaa',
    'RUN chmod 0750 /srv/data',
    'USER app',
  ]).findings;
  assert.deepEqual(byRule(narrow, RULES.WORLD_WRITABLE_CHMOD), []);
});

test('CF-16 comments, blank lines and lowercase instructions parse the same', () => {
  const { findings } = run([
    '# syntax=docker/dockerfile:1',
    '',
    'from ubuntu:latest',
    '# a comment inside a continuation is ignored',
    'run apt-get update && \\',
    '# still the same instruction',
    '    apt-get install -y git',
    'user root',
  ]);
  assert.ok(ids(findings).includes(RULES.MUTABLE_BASE_IMAGE.id));
  assert.ok(ids(findings).includes(RULES.APT_HYGIENE.id));
  assert.equal(byRule(findings, RULES.RUNS_AS_ROOT).length, 1);
  assert.equal(byRule(findings, RULES.APT_HYGIENE)[0].line, 5);
});

test('CF-17 every rule id is unique, inside NPS-0630..0669 and carries a valid severity', () => {
  const seen = new Set();
  for (const rule of Object.values(RULES)) {
    assert.equal(idInRange(rule.id, 'misconfig'), true, rule.id + ' must be a misconfig id');
    const n = Number(rule.id.slice(4));
    assert.ok(n >= 630 && n <= 669, rule.id + ' must sit in the containerfile sub-block');
    assert.equal(seen.has(rule.id), false, 'duplicate rule id ' + rule.id);
    seen.add(rule.id);
    assert.ok(SEVERITIES.includes(rule.severity), rule.id + ' severity');
    assert.ok(rule.rule_name && rule.category && rule.reminder, rule.id + ' metadata');
  }
  assert.equal(seen.size, Object.keys(RULES).length);
});

test('CF-18 findings carry the misconfig scanner and the reported file', () => {
  const { findings } = check('FROM ubuntu:latest\n', { file: 'services/api/Dockerfile' });
  assert.ok(findings.length > 0);
  for (const f of findings) {
    assert.equal(f.scanner, 'misconfig');
    assert.equal(f.source, 'builtin');
    assert.equal(f.file, 'services/api/Dockerfile');
  }
});

test('CF-19 empty and header-only input warns instead of reporting', () => {
  const empty = check('', { file: 'Dockerfile' });
  assert.deepEqual(empty.findings, []);
  assert.ok(empty.warnings.includes('no-from-instruction'));

  const nullish = check(null, { file: 'Dockerfile' });
  assert.deepEqual(nullish.findings, []);

  const interpolated = check('FROM ${BASE_IMAGE}\nUSER ${APP_USER}\n', { file: 'Dockerfile' });
  assert.deepEqual(interpolated.findings, []);
  assert.ok(interpolated.warnings.includes('unresolved-base-image'));
  assert.ok(interpolated.warnings.includes('unresolved-user'));
});

test('CF-20 non-string content warns instead of throwing so a hook scan cannot abort', () => {
  for (const bad of [{ not: 'a string' }, 42, [], true]) {
    const result = check(bad, { file: 'Dockerfile' });
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.warnings, ['invalid-input'], 'input: ' + JSON.stringify(bad));
  }
});
