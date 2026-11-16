const { extractFrontmatter } = require('../frontmatter.cjs');
const { NubosPilotError } = require('../core.cjs');

const DEFAULT_RUNTIME = 'codex';

const FRONTMATTER_RE = /^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/;
const PERMISSION_MODE_LINE_RE = /^[ \t]*permissionMode[ \t]*:.*(?:\r?\n|$)/m;

function _stripPermissionMode(frontmatterBody) {
  return frontmatterBody.replace(PERMISSION_MODE_LINE_RE, '');
}

function _resolveNotice(runtime) {
  const { getAdapter } = require('../runtime/index.cjs');
  const adapter = getAdapter(runtime);
  if (typeof adapter.runtimeNotice !== 'string' || adapter.runtimeNotice.length === 0) {
    throw new NubosPilotError(
      'agents-md-missing-notice',
      'Adapter for ' + runtime + ' has no runtimeNotice export',
      { runtime },
    );
  }
  return adapter.runtimeNotice;
}

function generateAgentsMd(claudeMdContent, runtime) {
  if (typeof claudeMdContent !== 'string') {
    throw new NubosPilotError(
      'agents-md-invalid-input',
      'generateAgentsMd expects a string',
      { got: typeof claudeMdContent },
    );
  }

  const rt = runtime || DEFAULT_RUNTIME;
  const runtimeNotice = _resolveNotice(rt);

  try {
    extractFrontmatter(claudeMdContent);
  } catch (err) {
    throw new NubosPilotError(
      'agents-md-invalid-input',
      'generateAgentsMd could not parse frontmatter',
      { cause: err && err.code ? err.code : String(err) },
    );
  }

  const fmMatch = claudeMdContent.match(FRONTMATTER_RE);

  if (fmMatch) {
    const openDelim = fmMatch[1];
    const innerYaml = fmMatch[2];
    const closeDelim = fmMatch[3];
    const body = claudeMdContent.slice(fmMatch[0].length);

    const stripped = _stripPermissionMode(innerYaml);
    const trimmedInner = stripped.replace(/(?:\r?\n)+$/, '');

    let rebuilt;
    if (trimmedInner.trim() === '') {
      rebuilt = '';
    } else {
      rebuilt = openDelim + trimmedInner + closeDelim;
    }

    const separator = rebuilt.length === 0
      ? ''
      : (rebuilt.endsWith('\n') ? '' : '\n');
    const bodyPrefix = body.startsWith('\n') ? '' : '\n';
    return rebuilt + separator + runtimeNotice + '\n' + bodyPrefix + body;
  }

  const bodyPrefix = claudeMdContent.startsWith('\n') ? '' : '\n';
  return runtimeNotice + '\n' + bodyPrefix + claudeMdContent;
}

module.exports = { generateAgentsMd };
