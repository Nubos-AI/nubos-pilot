'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STACKS = Object.freeze([
  {
    id: 'node',
    manifests: ['package.json'],
    lockfiles: ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb'],
    scriptManifest: 'package.json',
    scriptField: 'scripts',
    commands: ['node', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno'],
    linters: ['eslint', 'prettier', 'biome'],
    typecheckers: ['tsc'],
    testRunners: ['jest', 'vitest', 'playwright', 'cypress'],
  },
  {
    id: 'php',
    manifests: ['composer.json'],
    lockfiles: ['composer.lock'],
    scriptManifest: 'composer.json',
    scriptField: 'scripts',
    commands: ['php', 'composer', 'artisan'],
    linters: ['pint', 'phpstan', 'psalm'],
    typecheckers: ['phpstan', 'psalm'],
    testRunners: ['phpunit', 'pest'],
  },
  {
    id: 'python',
    manifests: ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile'],
    lockfiles: ['poetry.lock', 'Pipfile.lock', 'uv.lock'],
    commands: ['python', 'python3', 'pip', 'uv', 'poetry', 'rye', 'pdm', 'hatch'],
    linters: ['ruff'],
    typecheckers: ['mypy'],
    testRunners: ['pytest', 'tox', 'nox'],
  },
  {
    id: 'go',
    manifests: ['go.mod'],
    lockfiles: ['go.sum'],
    commands: ['go', 'gofmt'],
    linters: ['golangci-lint'],
    typecheckers: [],
    testRunners: ['go'],
  },
  {
    id: 'rust',
    manifests: ['Cargo.toml'],
    lockfiles: ['Cargo.lock'],
    commands: ['cargo', 'rustc'],
    linters: ['clippy', 'rustfmt'],
    typecheckers: [],
    testRunners: ['cargo'],
  },
  {
    id: 'ruby',
    manifests: ['Gemfile', 'Rakefile'],
    lockfiles: ['Gemfile.lock'],
    commands: ['ruby', 'bundle', 'rake'],
    linters: ['rubocop'],
    typecheckers: [],
    testRunners: ['rspec'],
  },
  {
    id: 'java',
    manifests: ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'],
    lockfiles: [],
    commands: ['mvn', 'gradle', 'gradlew', 'java', 'kotlin', 'kotlinc'],
    linters: ['ktlint', 'detekt'],
    typecheckers: [],
    testRunners: ['mvn', 'gradle'],
  },
  {
    id: 'dotnet',
    manifests: ['global.json'],
    lockfiles: ['packages.lock.json'],
    commands: ['dotnet'],
    linters: [],
    typecheckers: [],
    testRunners: ['dotnet'],
  },
  {
    id: 'elixir',
    manifests: ['mix.exs', 'rebar.config'],
    lockfiles: ['mix.lock'],
    commands: ['elixir', 'mix', 'rebar3'],
    linters: [],
    typecheckers: [],
    testRunners: ['mix'],
  },
  {
    id: 'dart',
    manifests: ['pubspec.yaml'],
    lockfiles: ['pubspec.lock'],
    commands: ['dart', 'flutter'],
    linters: [],
    typecheckers: [],
    testRunners: ['dart', 'flutter'],
  },
  {
    id: 'swift',
    manifests: ['Package.swift'],
    lockfiles: ['Package.resolved'],
    commands: ['swift', 'xcodebuild'],
    linters: ['swiftlint', 'swiftformat'],
    typecheckers: [],
    testRunners: ['swift'],
  },
]);

const RUNNERS = Object.freeze([
  { id: 'make', manifests: ['Makefile', 'GNUmakefile'], commands: ['make'] },
  { id: 'just', manifests: ['justfile', 'Justfile', '.justfile'], commands: ['just'] },
  { id: 'task', manifests: ['Taskfile.yml', 'Taskfile.yaml'], commands: ['task'] },
  { id: 'mise', manifests: ['.mise.toml', 'mise.toml'], commands: ['mise'] },
  { id: 'moon', manifests: ['.moon/workspace.yml'], commands: ['moon'] },
  { id: 'bazel', manifests: ['WORKSPACE', 'WORKSPACE.bazel', 'MODULE.bazel'], commands: ['bazel'] },
  { id: 'cmake', manifests: ['CMakeLists.txt'], commands: ['cmake', 'ninja'] },
  { id: 'earthly', manifests: ['Earthfile'], commands: ['earthly'] },
  { id: 'nx', manifests: ['nx.json'], commands: ['nx'] },
  { id: 'turbo', manifests: ['turbo.json'], commands: ['turbo'] },
  { id: 'docker', manifests: ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'], commands: ['docker', 'docker-compose', 'podman'] },
  { id: 'terraform', manifests: ['main.tf', 'terraform.tf'], commands: ['terraform'] },
]);

const VERSION_FILES = Object.freeze([
  '.nvmrc', '.node-version', '.tool-versions', '.python-version', '.ruby-version',
]);

function manifestFiles() {
  const out = new Set(VERSION_FILES);
  for (const s of STACKS) {
    for (const m of s.manifests) out.add(m);
    for (const l of s.lockfiles) out.add(l);
  }
  for (const r of RUNNERS) {
    for (const m of r.manifests) out.add(path.basename(m));
  }
  return out;
}

function knownCommands() {
  const out = new Set();
  for (const s of STACKS) {
    for (const key of ['commands', 'linters', 'typecheckers', 'testRunners']) {
      for (const c of s[key]) out.add(c);
    }
  }
  for (const r of RUNNERS) {
    for (const c of r.commands) out.add(c);
  }
  return out;
}

function _exists(cwd, rel) {
  try { return fs.existsSync(path.join(cwd, rel)); }
  catch { return false; }
}

function _readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
  catch { return null; }
}

function _scriptsOf(cwd, stack) {
  if (!stack.scriptManifest) return new Set();
  const obj = _readJsonSafe(path.join(cwd, stack.scriptManifest));
  const field = obj && obj[stack.scriptField];
  if (!field || typeof field !== 'object') return new Set();
  return new Set(Object.keys(field));
}

function detectStack(cwd) {
  const root = cwd || process.cwd();
  const detected = [];
  for (const s of STACKS) {
    const manifest = s.manifests.find((m) => _exists(root, m));
    if (!manifest) continue;
    detected.push({
      id: s.id,
      manifest,
      scripts: Array.from(_scriptsOf(root, s)).sort(),
      linters: s.linters.slice(),
      typecheckers: s.typecheckers.slice(),
      testRunners: s.testRunners.slice(),
    });
  }
  const runners = RUNNERS
    .filter((r) => r.manifests.some((m) => _exists(root, m)))
    .map((r) => ({ id: r.id, commands: r.commands.slice() }));
  return { stacks: detected, runners, ids: detected.map((d) => d.id) };
}

function lintCommands(cwd) {
  const out = [];
  for (const s of detectStack(cwd).stacks) {
    for (const c of s.linters) if (!out.includes(c)) out.push(c);
    for (const c of s.typecheckers) if (!out.includes(c)) out.push(c);
  }
  return out;
}

function scriptsByManifest(cwd) {
  const root = cwd || process.cwd();
  const out = {};
  for (const s of STACKS) {
    if (!s.scriptManifest) continue;
    out[s.id] = _scriptsOf(root, s);
  }
  return out;
}

module.exports = {
  STACKS,
  RUNNERS,
  VERSION_FILES,
  manifestFiles,
  knownCommands,
  detectStack,
  lintCommands,
  scriptsByManifest,
};
