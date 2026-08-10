const BEGIN = '<!-- nubos-pilot:begin v1 -->';
const END = '<!-- nubos-pilot:end -->';
const RE = /<!-- nubos-pilot:begin[^>]*-->[\s\S]*?<!-- nubos-pilot:end -->/;

function rewriteBlock(content, innerMd) {
  const safe = content == null ? '' : String(content);
  const inner = innerMd == null ? '' : String(innerMd);
  const block =
    BEGIN +
    '\n<!-- do not edit manually — managed by npx nubos-pilot -->\n' +
    inner +
    '\n' +
    END;
  if (RE.test(safe)) return safe.replace(RE, block);
  const sep =
    safe.length === 0 || safe.endsWith('\n\n')
      ? ''
      : safe.endsWith('\n')
        ? '\n'
        : '\n\n';
  return safe + sep + block + '\n';
}

function stripBlock(content) {
  const safe = content == null ? '' : String(content);
  const stripped = safe.replace(RE, '');
  return stripped.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

module.exports = { rewriteBlock, stripBlock, BEGIN, END };
