import * as acorn from 'acorn';

// extension (without dot) -> language label. Used for metadata + deciding which
// parser, if any, can extract symbols. A missing entry is fine: the file is
// still chunked and embedded, just without symbol metadata.
const EXT_LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  py: 'python', php: 'php', rb: 'ruby', rs: 'rust', go: 'go', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  cs: 'csharp', swift: 'swift', kt: 'kotlin', scala: 'scala',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', md: 'markdown', html: 'html', css: 'css',
};

// Languages we can currently parse with acorn. Everything else degrades to
// chunk+embed with no symbols (see roadmap for the tree-sitter expansion).
const ACORN_LANGS = new Set(['javascript', 'typescript']);

export function extOf(path) {
  const m = String(path).match(/\.([^.\\/]+)$/);
  return m ? m[1].toLowerCase() : '';
}

export function detectLang(path) {
  return EXT_LANG[extOf(path)] || null;
}

// Best-effort symbol extraction. Returns ["fn name", "class name", ...].
// acorn cannot parse TypeScript type syntax or JSX; those files simply throw and
// we return [] — a normal, expected degradation, not an error.
export function extractSymbols(path, code) {
  const lang = detectLang(path);
  if (!ACORN_LANGS.has(lang)) return [];

  let ast;
  try {
    ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true });
  } catch {
    return [];
  }

  const symbols = [];
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node.type === 'FunctionDeclaration' && node.id) {
      symbols.push(`fn ${node.id.name}`);
    } else if (node.type === 'ClassDeclaration' && node.id) {
      symbols.push(`class ${node.id.name}`);
    } else if (
      node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.init &&
      (node.init.type === 'ArrowFunctionExpression' || node.init.type === 'FunctionExpression')
    ) {
      symbols.push(`fn ${node.id.name}`);
    }
    for (const key in node) {
      if (key === 'parent') continue;
      const value = node[key];
      if (value && typeof value === 'object') walk(value);
    }
  })(ast);

  return [...new Set(symbols)];
}
