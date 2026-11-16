const fs = require('node:fs');
const path = require('node:path');
const { projectStateDir, NubosPilotError } = require('./core.cjs');

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
const PACKAGE_TEMPLATES_DIR = path.resolve(__dirname, '..', 'templates');

function templatesDir(cwd) {
  return path.join(projectStateDir(cwd), 'templates');
}

function resolveInDir(dir, name) {
  const filePath = path.resolve(dir, name + '.md');
  const dirWithSep = dir.endsWith(path.sep) ? dir : dir + path.sep;
  if (!filePath.startsWith(dirWithSep)) {
    throw new NubosPilotError(
      'template-not-found',
      `Template name "${name}" escapes templates directory`,
      { template: name, path: filePath },
    );
  }
  return filePath;
}

function loadTemplate(name, vars, cwd = process.cwd()) {
  const localPath = resolveInDir(templatesDir(cwd), name);
  const packagePath = resolveInDir(PACKAGE_TEMPLATES_DIR, name);

  let filePath = null;
  if (fs.existsSync(localPath)) filePath = localPath;
  else if (fs.existsSync(packagePath)) filePath = packagePath;

  if (filePath === null) {
    throw new NubosPilotError(
      'template-not-found',
      `Template "${name}" not found in project overlay (${localPath}) or package templates (${packagePath})`,
      { template: name, path: localPath, packagePath },
    );
  }

  const raw = fs.readFileSync(filePath, 'utf-8');

  return raw.replace(PLACEHOLDER_RE, (_match, key) => {
    if (!(key in vars)) {
      throw new NubosPilotError(
        'template-unresolved-var',
        `Undefined placeholder {{${key}}} in template "${name}"`,
        { template: name, variable: key, available: Object.keys(vars) },
      );
    }
    return String(vars[key]);
  });
}

function listTemplates(cwd = process.cwd()) {
  const dir = templatesDir(cwd);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -3))
    .sort();
}

module.exports = { loadTemplate, listTemplates };
