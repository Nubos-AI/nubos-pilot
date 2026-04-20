const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const d = require('./codebase-docs.cjs');

const _sandboxes = [];

function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-cbd-'));
  _sandboxes.push(dir);
  return dir;
}

function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

afterEach(() => {
  while (_sandboxes.length) {
    const dir = _sandboxes.pop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('CD-1: languageForExt maps known extensions', () => {
  assert.equal(d.languageForExt('.js'), 'javascript');
  assert.equal(d.languageForExt('.ts'), 'typescript');
  assert.equal(d.languageForExt('.py'), 'python');
  assert.equal(d.languageForExt('.rs'), 'rust');
  assert.equal(d.languageForExt('.go'), 'go');
  assert.equal(d.languageForExt('.xyz'), 'unknown');
});

test('CD-2: isCodeExt excludes docs and data', () => {
  assert.equal(d.isCodeExt('.js'), true);
  assert.equal(d.isCodeExt('.py'), true);
  assert.equal(d.isCodeExt('.md'), false);
  assert.equal(d.isCodeExt('.json'), false);
  assert.equal(d.isCodeExt('.css'), false);
});

test('CD-3: groupFilesIntoModules clusters by directory', () => {
  const files = [
    { path: 'src/auth/login.js', ext: '.js' },
    { path: 'src/auth/session.js', ext: '.js' },
    { path: 'src/billing/invoice.js', ext: '.js' },
    { path: 'README.md', ext: '.md' },
  ];
  const modules = d.groupFilesIntoModules(files);
  assert.equal(modules.length, 2);
  const auth = modules.find((m) => m.directory === 'src/auth');
  assert.equal(auth.file_count, 2);
  assert.equal(auth.primary_language, 'javascript');
  const billing = modules.find((m) => m.directory === 'src/billing');
  assert.deepEqual(billing.source_paths, ['src/billing/invoice.js']);
});

test('CD-4: groupFilesIntoModules detects mixed-language module', () => {
  const files = [
    { path: 'services/api/main.py', ext: '.py' },
    { path: 'services/api/helper.py', ext: '.py' },
    { path: 'services/api/tool.go', ext: '.go' },
  ];
  const modules = d.groupFilesIntoModules(files);
  assert.equal(modules.length, 1);
  assert.equal(modules[0].primary_language, 'python');
  assert.equal(modules[0].language_distribution.python, 2);
  assert.equal(modules[0].language_distribution.go, 1);
});

test('CD-5: extractSymbols — javascript', () => {
  const root = makeSandbox();
  write(root, 'x.js', [
    'export function login(user) {}',
    'export class Session {}',
    'export const TOKEN = 1;',
    'module.exports.helper = () => {};',
    'function internalOnly() {}',
  ].join('\n'));
  const syms = d.extractSymbols(path.join(root, 'x.js'), 'javascript');
  assert.ok(syms.includes('login'));
  assert.ok(syms.includes('Session'));
  assert.ok(syms.includes('TOKEN'));
  assert.ok(syms.includes('helper'));
  assert.ok(!syms.includes('internalOnly'));
});

test('CD-6: extractSymbols — python', () => {
  const root = makeSandbox();
  write(root, 'x.py', [
    'import os',
    'def greet(name):',
    '    pass',
    'class Auth:',
    '    def _private(self): pass',
    'async def fetch(): pass',
  ].join('\n'));
  const syms = d.extractSymbols(path.join(root, 'x.py'), 'python');
  assert.ok(syms.includes('greet'));
  assert.ok(syms.includes('Auth'));
  assert.ok(syms.includes('fetch'));
});

test('CD-7: extractSymbols — go exports only uppercase', () => {
  const root = makeSandbox();
  write(root, 'x.go', [
    'package main',
    'func Start() {}',
    'func internal() {}',
    'type User struct {}',
    'type privateType int',
  ].join('\n'));
  const syms = d.extractSymbols(path.join(root, 'x.go'), 'go');
  assert.ok(syms.includes('Start'));
  assert.ok(syms.includes('User'));
  assert.ok(!syms.includes('internal'));
  assert.ok(!syms.includes('privateType'));
});

test('CD-8: extractDeps — javascript imports and requires', () => {
  const root = makeSandbox();
  write(root, 'x.js', [
    'import { readFile } from "node:fs";',
    'import lodash from "lodash";',
    'const path = require("node:path");',
    'const local = require("./local");',
  ].join('\n'));
  const deps = d.extractDeps(path.join(root, 'x.js'), 'javascript');
  assert.ok(deps.includes('node:fs'));
  assert.ok(deps.includes('lodash'));
  assert.ok(deps.includes('node:path'));
  assert.ok(deps.includes('./local'));
});

test('CD-9: extractDeps — go import block', () => {
  const root = makeSandbox();
  write(root, 'x.go', [
    'package main',
    'import (',
    '  "fmt"',
    '  "net/http"',
    ')',
    'import "os"',
  ].join('\n'));
  const deps = d.extractDeps(path.join(root, 'x.go'), 'go');
  assert.ok(deps.includes('fmt'));
  assert.ok(deps.includes('net/http'));
  assert.ok(deps.includes('os'));
});

test('CD-10: buildModuleFacts aggregates symbols and splits internal vs external deps', () => {
  const root = makeSandbox();
  write(root, 'src/auth/login.js', [
    'import { db } from "../db";',
    'import bcrypt from "bcrypt";',
    'export function login() {}',
  ].join('\n'));
  write(root, 'src/auth/session.js', [
    'import { cache } from "../cache";',
    'export class Session {}',
  ].join('\n'));
  const files = [
    { path: 'src/auth/login.js', ext: '.js' },
    { path: 'src/auth/session.js', ext: '.js' },
  ];
  const modules = d.groupFilesIntoModules(files);
  const facts = d.buildModuleFacts(modules[0], root);
  assert.ok(facts.symbols.includes('login'));
  assert.ok(facts.symbols.includes('Session'));
  assert.ok(facts.internal_deps.includes('../db'));
  assert.ok(facts.internal_deps.includes('../cache'));
  assert.ok(facts.external_deps.includes('bcrypt'));
  assert.equal(facts.file_count, 2);
});

test('CD-11: buildDocumenterPrompt includes facts JSON and output schema', () => {
  const facts = {
    id: 'src-auth',
    name: 'src/auth',
    directory: 'src/auth',
    primary_language: 'javascript',
    file_count: 2,
    source_paths: ['src/auth/login.js'],
    symbols: ['login'],
    internal_deps: [],
    external_deps: ['bcrypt'],
    files: [],
  };
  const prompt = d.buildDocumenterPrompt(facts);
  assert.ok(prompt.includes('np-codebase-documenter'));
  assert.ok(prompt.includes('"key_concepts"'));
  assert.ok(prompt.includes('"gotchas"'));
  assert.ok(prompt.includes('"id": "src-auth"'));
});

test('CD-12: renderModuleDoc produces frontmatter + body with prose', () => {
  const facts = {
    id: 'src-auth',
    name: 'src/auth',
    directory: 'src/auth',
    primary_language: 'javascript',
    file_count: 1,
    source_paths: ['src/auth/login.js'],
    symbols: ['login'],
    internal_deps: [],
    external_deps: ['bcrypt'],
    files: [{ path: 'src/auth/login.js', language: 'javascript', symbols: ['login'], deps: ['bcrypt'] }],
  };
  const prose = {
    description: 'Handles user login flow',
    purpose: 'Authenticates users via bcrypt hashes.',
    key_concepts: ['Passwords hashed before compare'],
    public_api: '`login(credentials)` returns session token.',
    invariants: ['No plaintext passwords stored'],
    gotchas: ['bcrypt cost must match production'],
  };
  const md = d.renderModuleDoc(facts, prose, { 'src/auth/login.js': 'sha256:abc' });
  assert.ok(md.startsWith('---\n'));
  assert.ok(md.includes('name: src/auth'));
  assert.ok(md.includes('kind: module'));
  assert.ok(md.includes('description: Handles user login flow'));
  assert.ok(md.includes('symbols:\n  - login'));
  assert.ok(md.includes('bcrypt'));
  assert.ok(md.includes('## Purpose'));
  assert.ok(md.includes('Authenticates users'));
  assert.ok(md.includes('## Gotchas'));
  assert.ok(md.includes('## Files'));
  assert.ok(md.includes('src/auth/login.js: sha256:abc'));
});

test('CD-13: renderModuleDoc gracefully handles missing prose', () => {
  const facts = {
    id: 'lib',
    name: 'lib',
    directory: 'lib',
    primary_language: 'javascript',
    file_count: 1,
    source_paths: ['lib/x.js'],
    symbols: [],
    internal_deps: [],
    external_deps: [],
    files: [{ path: 'lib/x.js', language: 'javascript', symbols: [], deps: [] }],
  };
  const md = d.renderModuleDoc(facts, null, {});
  assert.ok(md.includes('_TBD'));
  assert.ok(md.includes('## Files'));
});

test('CD-14: buildIndexDoc lists modules with counts', () => {
  const modules = [
    { id: 'src-auth', directory: 'src/auth', primary_language: 'javascript', file_count: 2 },
    { id: 'src-billing', directory: 'src/billing', primary_language: 'javascript', file_count: 1 },
  ];
  const md = d.buildIndexDoc(modules, { project_name: 'Demo' });
  assert.ok(md.includes('# Codebase Index'));
  assert.ok(md.includes('**Project:** Demo'));
  assert.ok(md.includes('src-auth.md'));
  assert.ok(md.includes('2 files'));
  assert.ok(md.includes('1 file'));
  assert.ok(md.includes('Dev-Agents MUST read'));
});
