import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import * as acorn from 'acorn';

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.cache', 'out', 'target', 'vendor', 'venv', '__pycache__', 'Pods']);
const IGNORE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.woff', '.ttf', '.eot', '.mp4', '.mp3', '.pdf', '.zip']);

const MAX_DEPTH = 8;
const MAX_FILES = 500;
const MAX_CHARS = 20000;

let cache = null;
let cacheKey = '';
let cacheTime = 0;
const CACHE_TTL = 10000;

export function generateCodeMap(dir = process.cwd()) {
  const now = Date.now();
  if (cache !== null && cacheKey === dir && now - cacheTime < CACHE_TTL) {
    return cache;
  }
  const state = { files: 0, chars: 0, truncated: false };
  const body = walkDir(dir, '', 0, state);
  cache = state.truncated ? body + '... (map truncated)\n' : body;
  cacheKey = dir;
  cacheTime = now;
  return cache;
}

export function invalidateCodeMap() {
  cache = null;
}

function walkDir(dir, prefix, depth, state) {
  if (depth > MAX_DEPTH || state.chars >= MAX_CHARS) {
    state.truncated = true;
    return '';
  }

  let output = '';
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    entries.sort((a, b) => {
      if (a.isDirectory() === b.isDirectory()) {
        return a.name.localeCompare(b.name);
      }
      return a.isDirectory() ? -1 : 1;
    });

    for (let i = 0; i < entries.length; i++) {
      if (state.chars >= MAX_CHARS) {
        state.truncated = true;
        break;
      }

      const e = entries[i];
      if (e.name.startsWith('.')) continue;

      const isLast = i === entries.length - 1;
      const marker = isLast ? '└── ' : '├── ';
      const nextPrefix = prefix + (isLast ? '    ' : '│   ');

      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue;
        const line = `${prefix}${marker}${e.name}/\n`;
        output += line;
        state.chars += line.length;
        output += walkDir(join(dir, e.name), nextPrefix, depth + 1, state);
      } else {
        const ext = e.name.substring(e.name.lastIndexOf('.')).toLowerCase();
        if (IGNORE_EXTS.has(ext)) continue;

        let fileNote = '';
        if (e.name === 'package.json') {
          try {
            const pkg = JSON.parse(readFileSync(join(dir, e.name), 'utf-8'));
            if (pkg.description) fileNote = ` - ${pkg.description}`;
          } catch {}
        } else if ((ext === '.js' || ext === '.mjs' || ext === '.ts') && state.files < MAX_FILES) {
          state.files++;
          try {
            const code = readFileSync(join(dir, e.name), 'utf-8');
            const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
            const symbols = [];
            function walk(node) {
              if (!node || typeof node !== 'object') return;
              if (Array.isArray(node)) { node.forEach(walk); return; }
              if (node.type === 'FunctionDeclaration' && node.id) {
                symbols.push(`fn ${node.id.name}`);
              } else if (node.type === 'ClassDeclaration' && node.id) {
                symbols.push(`class ${node.id.name}`);
              } else if (node.type === 'VariableDeclarator' && node.init &&
                         (node.init.type === 'ArrowFunctionExpression' || node.init.type === 'FunctionExpression')) {
                if (node.id && node.id.type === 'Identifier') symbols.push(`fn ${node.id.name}`);
              }
              for (const key in node) {
                if (key !== 'parent' && typeof node[key] === 'object') walk(node[key]);
              }
            }
            walk(ast);
            if (symbols.length > 0) {
              const unique = Array.from(new Set(symbols)).slice(0, 5);
              fileNote = ` [${unique.join(', ')}${symbols.length > 5 ? ', ...' : ''}]`;
            }
          } catch (err) {}
        }

        const line = `${prefix}${marker}${e.name}${fileNote}\n`;
        output += line;
        state.chars += line.length;
      }
    }
  } catch (err) {
    output += `${prefix}└── [Error reading directory]\n`;
  }
  return output;
}
