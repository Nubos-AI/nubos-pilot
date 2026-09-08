'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { FILES, parse } = require('./python.cjs');

function byName(packages, name) {
  return packages.find((p) => p.name === name);
}

test('PY-1 requirements.txt keeps exact pins and emits unpinned specifiers with a null version', () => {
  const content = [
    'flask==3.0.2',
    'urllib3===2.2.1',
    'requests>=2.31.0',
    'pydantic~=2.6',
    'boto3',
    'click<9',
    'numpy>=1.26,<2',
    'setuptools==70.*',
  ].join('\n');

  const { packages, warnings } = parse(content, { file: 'requirements.txt' });

  assert.deepEqual(warnings, []);
  assert.deepEqual(packages.map((p) => p.purl), [
    'pkg:pypi/flask@3.0.2',
    'pkg:pypi/urllib3@2.2.1',
    'pkg:pypi/requests',
    'pkg:pypi/pydantic',
    'pkg:pypi/boto3',
    'pkg:pypi/click',
    'pkg:pypi/numpy',
    'pkg:pypi/setuptools',
  ]);
  assert.equal(byName(packages, 'flask').version, '3.0.2');
  assert.equal(byName(packages, 'urllib3').version, '2.2.1');
  assert.equal(byName(packages, 'setuptools').version, null);
  for (const pkg of packages) {
    assert.equal(pkg.ecosystem, 'PyPI');
    assert.equal(pkg.scope, 'prod');
    assert.equal(pkg.direct, true);
    assert.equal(pkg.source, 'requirements.txt');
  }
});

test('PY-2 requirements.txt strips extras, environment markers and inline comments', () => {
  const content = [
    '# production pins',
    '',
    'celery[redis,auth]==5.3.6',
    'importlib-metadata==7.0.1 ; python_version < "3.10"',
    'gunicorn==21.2.0  # wsgi server',
    'uvicorn[standard]>=0.27 ; sys_platform != "win32"  # asgi',
    'Django == 5.0.3',
  ].join('\n');

  const { packages, warnings } = parse(content, { file: 'requirements.txt' });

  assert.deepEqual(warnings, []);
  assert.deepEqual(packages.map((p) => p.purl), [
    'pkg:pypi/celery@5.3.6',
    'pkg:pypi/importlib-metadata@7.0.1',
    'pkg:pypi/gunicorn@21.2.0',
    'pkg:pypi/uvicorn',
    'pkg:pypi/Django@5.0.3',
  ]);
  assert.equal(byName(packages, 'uvicorn').version, null);
  assert.equal(byName(packages, 'Django').key, 'django');
});

test('PY-3 requirements.txt skips options and warns on URL or VCS requirements', () => {
  const content = [
    '-r base.txt',
    '-c constraints.txt',
    '--index-url https://pypi.example.com/simple',
    '--extra-index-url https://pypi.org/simple',
    '-e .',
    'attrs==23.2.0',
    'git+https://github.com/psf/requests.git@v2.31.0#egg=requests',
    'https://files.pythonhosted.org/packages/ab/cd/wheel-1.0-py3-none-any.whl',
    './vendor/local-package',
    '-e git+ssh://git@github.com/acme/lib.git#egg=lib',
  ].join('\n');

  const { packages, warnings } = parse(content, { file: 'requirements.txt' });

  assert.deepEqual(packages.map((p) => p.purl), ['pkg:pypi/attrs@23.2.0']);
  assert.deepEqual(warnings, ['unsupported-requirement']);
});

test('PY-4 requirements.txt joins backslash continuations and drops --hash lines', () => {
  const content = [
    'cryptography==42.0.5 \\',
    '    --hash=sha256:0663585d02f76929792470451a5ba64424acc3cd5227b03921dab0e2f27b1709 \\',
    '    --hash=sha256:08a24a7070b2b6804c1940ff0f910ff728932a9d0e80e7814234269f9d46d069',
    'idna \\',
    '    >=3.6',
    'six==1.16.0',
  ].join('\n');

  const { packages, warnings } = parse(content, { file: 'requirements.txt' });

  assert.deepEqual(warnings, []);
  assert.deepEqual(packages.map((p) => p.purl), [
    'pkg:pypi/cryptography@42.0.5',
    'pkg:pypi/idna',
    'pkg:pypi/six@1.16.0',
  ]);
  assert.equal(byName(packages, 'idna').version, null);
});

test('PY-5 a dev-hinting requirements filename switches the scope to dev', () => {
  const content = 'pytest==8.1.1\n';

  const dashed = parse(content, { file: 'requirements-dev.txt' });
  const prefixed = parse(content, { file: 'dev-requirements.txt' });
  const nested = parse(content, { file: 'requirements/dev.txt' });
  const testing = parse(content, { file: 'requirements/test.txt' });
  const plain = parse(content, { file: 'requirements.txt' });
  const scoped = parse(content, { file: 'requirements/base.txt' });

  assert.equal(dashed.packages[0].scope, 'dev');
  assert.equal(prefixed.packages[0].scope, 'dev');
  assert.equal(nested.packages[0].scope, 'dev');
  assert.equal(testing.packages[0].scope, 'dev');
  assert.equal(plain.packages[0].scope, 'prod');
  assert.equal(scoped.packages[0].scope, 'prod');
  assert.equal(nested.packages[0].source, 'requirements/dev.txt');
});

test('PY-6 poetry.lock maps category, optional and the category-less 2.x shape', () => {
  const content = [
    '[[package]]',
    'name = "flask"',
    'version = "3.0.2"',
    'description = "A simple framework for building complex web applications."',
    'category = "main"',
    'optional = false',
    'python-versions = ">=3.8"',
    '',
    '[[package]]',
    'name = "pytest"',
    'version = "8.1.1"',
    'description = "pytest: simple powerful testing with Python"',
    'category = "dev"',
    'optional = false',
    'python-versions = ">=3.8"',
    '',
    '[[package]]',
    'name = "psycopg2-binary"',
    'version = "2.9.9"',
    'description = "psycopg2 - Python-PostgreSQL Database Adapter"',
    'category = "main"',
    'optional = true',
    'python-versions = ">=3.7"',
    '',
    '[[package]]',
    'name = "anyio"',
    'version = "4.3.0"',
    'description = "High level compatibility layer"',
    'optional = false',
    'python-versions = ">=3.8"',
    'files = [',
    '    {file = "anyio-4.3.0-py3-none-any.whl", hash = "sha256:048e05d0f6caeed70d731f3db756d35dcc1f35747c8c403364a8332c630441b8"},',
    ']',
    '',
  ].join('\n');

  const { packages, warnings } = parse(content, { file: 'poetry.lock' });

  assert.deepEqual(warnings, []);
  assert.deepEqual(packages.map((p) => p.purl), [
    'pkg:pypi/flask@3.0.2',
    'pkg:pypi/pytest@8.1.1',
    'pkg:pypi/psycopg2-binary@2.9.9',
    'pkg:pypi/anyio@4.3.0',
  ]);
  assert.equal(byName(packages, 'flask').scope, 'prod');
  assert.equal(byName(packages, 'pytest').scope, 'dev');
  assert.equal(byName(packages, 'psycopg2-binary').scope, 'optional');
  assert.equal(byName(packages, 'anyio').scope, 'unknown');
  assert.equal(packages.every((p) => p.direct === false), true);
});

test('PY-7 uv.lock keeps registry packages and skips the local project', () => {
  const content = [
    'version = 1',
    'requires-python = ">=3.11"',
    '',
    '[[package]]',
    'name = "my-app"',
    'version = "0.1.0"',
    'source = { editable = "." }',
    'dependencies = [',
    '    { name = "httpx" },',
    ']',
    '',
    '[[package]]',
    'name = "workspace-root"',
    'version = "0.0.0"',
    'source = { virtual = "." }',
    '',
    '[[package]]',
    'name = "httpx"',
    'version = "0.27.0"',
    'source = { registry = "https://pypi.org/simple" }',
    'sdist = { url = "https://files.pythonhosted.org/packages/httpx-0.27.0.tar.gz", hash = "sha256:aaa" }',
    '',
    '[[package]]',
    'name = "h11"',
    'version = "0.14.0"',
    'source = { registry = "https://pypi.org/simple" }',
    '',
  ].join('\n');

  const { packages, warnings } = parse(content, { file: 'uv.lock' });

  assert.deepEqual(packages.map((p) => p.purl), [
    'pkg:pypi/httpx@0.27.0',
    'pkg:pypi/h11@0.14.0',
  ]);
  assert.deepEqual(warnings, ['local-project']);
  for (const pkg of packages) {
    assert.equal(pkg.scope, 'unknown');
    assert.equal(pkg.direct, false);
    assert.equal(pkg.source, 'uv.lock');
  }
});

test('PY-8 Pipfile.lock strips the == prefix and separates default from develop', () => {
  const content = JSON.stringify({
    _meta: { hash: { sha256: 'abc' }, requires: { python_version: '3.12' } },
    default: {
      flask: { hashes: ['sha256:aaa'], index: 'pypi', version: '==3.0.2' },
      'sqlalchemy-utils': { hashes: ['sha256:bbb'], version: '===0.41.1' },
      httpx: { git: 'https://github.com/encode/httpx.git', ref: 'abc123' },
    },
    develop: {
      pytest: { hashes: ['sha256:ccc'], index: 'pypi', version: '==8.1.1' },
    },
  }, null, 2);

  const { packages, warnings } = parse(content, { file: 'Pipfile.lock' });

  assert.deepEqual(packages.map((p) => p.purl), [
    'pkg:pypi/flask@3.0.2',
    'pkg:pypi/sqlalchemy-utils@0.41.1',
    'pkg:pypi/httpx',
    'pkg:pypi/pytest@8.1.1',
  ]);
  assert.deepEqual(warnings, ['missing-version']);
  assert.equal(byName(packages, 'flask').scope, 'prod');
  assert.equal(byName(packages, 'httpx').scope, 'prod');
  assert.equal(byName(packages, 'pytest').scope, 'dev');
  assert.equal(packages.every((p) => p.direct === true), true);
});

test('PY-9 pyproject.toml reads PEP 621 dependencies and optional-dependency groups', () => {
  const content = [
    '[build-system]',
    'requires = ["hatchling"]',
    'build-backend = "hatchling.build"',
    '',
    '[project]',
    'name = "my-app"',
    'version = "0.1.0"',
    'requires-python = ">=3.11"',
    'dependencies = [',
    '    "flask>=3.0",',
    '    "sqlalchemy[asyncio]==2.0.29",',
    '    "typing-extensions",',
    ']',
    '',
    '[project.optional-dependencies]',
    'dev = ["ruff==0.3.4", "mypy>=1.9"]',
    'test = ["pytest>=8.1"]',
    'docs = ["mkdocs>=1.5"]',
    '',
  ].join('\n');

  const { packages, warnings } = parse(content, { file: 'pyproject.toml' });

  assert.deepEqual(warnings, []);
  assert.deepEqual(packages.map((p) => p.purl), [
    'pkg:pypi/flask',
    'pkg:pypi/sqlalchemy@2.0.29',
    'pkg:pypi/typing-extensions',
    'pkg:pypi/ruff@0.3.4',
    'pkg:pypi/mypy',
    'pkg:pypi/pytest',
    'pkg:pypi/mkdocs',
  ]);
  assert.equal(byName(packages, 'flask').version, null);
  assert.equal(byName(packages, 'flask').scope, 'prod');
  assert.equal(byName(packages, 'ruff').scope, 'dev');
  assert.equal(byName(packages, 'pytest').scope, 'dev');
  assert.equal(byName(packages, 'mkdocs').scope, 'optional');
  assert.equal(packages.every((p) => p.direct === true), true);
  assert.equal(byName(packages, 'hatchling'), undefined);
});

test('PY-10 pyproject.toml reads poetry string and inline-table values and drops the python entry', () => {
  const content = [
    '[tool.poetry]',
    'name = "my-app"',
    'version = "0.1.0"',
    '',
    '[tool.poetry.dependencies]',
    'python = "^3.11"',
    'flask = "^3.0"',
    'click = "8.1.7"',
    'requests = { version = "==2.31.0", extras = ["socks"] }',
    'psycopg2 = { version = "^2.9", optional = true }',
    'redis = { version = "*" }',
    '',
    '[tool.poetry.dev-dependencies]',
    'nose = "^1.3"',
    '',
    '[tool.poetry.group.dev.dependencies]',
    'pytest = "^8.1"',
    'ruff = "0.3.4"',
    '',
  ].join('\n');

  const { packages, warnings } = parse(content, { file: 'pyproject.toml' });

  assert.deepEqual(warnings, []);
  assert.deepEqual(packages.map((p) => p.purl), [
    'pkg:pypi/flask',
    'pkg:pypi/click@8.1.7',
    'pkg:pypi/requests@2.31.0',
    'pkg:pypi/psycopg2',
    'pkg:pypi/redis',
    'pkg:pypi/nose',
    'pkg:pypi/pytest',
    'pkg:pypi/ruff@0.3.4',
  ]);
  assert.equal(byName(packages, 'python'), undefined);
  assert.equal(byName(packages, 'flask').version, null);
  assert.equal(byName(packages, 'flask').scope, 'prod');
  assert.equal(byName(packages, 'psycopg2').scope, 'optional');
  assert.equal(byName(packages, 'nose').scope, 'dev');
  assert.equal(byName(packages, 'pytest').scope, 'dev');
  assert.equal(byName(packages, 'ruff').version, '0.3.4');
  assert.equal(packages.every((p) => p.direct === true), true);
});

test('PY-11 unknown basename reports unsupported-file', () => {
  assert.deepEqual(parse('flask==3.0.2', { file: 'Pipfile' }), { packages: [], warnings: ['unsupported-file'] });
  assert.deepEqual(parse('flask==3.0.2', { file: 'notes.md' }), { packages: [], warnings: ['unsupported-file'] });
  assert.deepEqual(parse('flask==3.0.2', {}), { packages: [], warnings: ['unsupported-file'] });
});

test('PY-12 malformed input warns instead of throwing', () => {
  const requirements = parse([
    'flask==3.0.2',
    '!!! not a requirement !!!',
    'weird=1.0',
  ].join('\n'), { file: 'requirements.txt' });
  assert.deepEqual(requirements.packages.map((p) => p.purl), ['pkg:pypi/flask@3.0.2', 'pkg:pypi/weird']);
  assert.deepEqual(requirements.warnings, ['malformed-requirement']);

  const pipfile = parse('{ not json', { file: 'Pipfile.lock' });
  assert.deepEqual(pipfile, { packages: [], warnings: ['invalid-json'] });
  assert.deepEqual(parse('[1, 2]', { file: 'Pipfile.lock' }), { packages: [], warnings: ['unexpected-lock-shape'] });

  const poetry = parse('nothing useful here', { file: 'poetry.lock' });
  assert.deepEqual(poetry, { packages: [], warnings: ['no-packages'] });

  const uv = parse('[[package]]\nversion = "1.0.0"\n', { file: 'uv.lock' });
  assert.deepEqual(uv, { packages: [], warnings: ['malformed-package'] });

  const pyproject = parse([
    '[project]',
    'dependencies = ["flask>=3.0", 42, "", "git+https://github.com/acme/lib.git"]',
  ].join('\n'), { file: 'pyproject.toml' });
  assert.deepEqual(pyproject.packages.map((p) => p.purl), ['pkg:pypi/flask']);
  assert.deepEqual(pyproject.warnings, ['malformed-dependency', 'unsupported-requirement']);

  assert.deepEqual(parse(undefined, { file: 'requirements.txt' }), { packages: [], warnings: [] });
});

test('PY-13 FILES is a frozen list of the handled basenames', () => {
  assert.deepEqual([...FILES], [
    'requirements.txt',
    'poetry.lock',
    'uv.lock',
    'Pipfile.lock',
    'pyproject.toml',
  ]);
  assert.equal(Object.isFrozen(FILES), true);
});
