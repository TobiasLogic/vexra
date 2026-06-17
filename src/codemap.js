import { readdirSync, statSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import * as acorn from 'acorn';

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.cache']);
const IGNORE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.woff', '.ttf', '.eot', '.mp4', '.mp3', '.pdf', '.zip']);

export function generateCodeMap(dir = process.cwd(), prefix = '') {
  let output = '';
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    // Sort directories first, then files alphabetically
    entries.sort((a, b) => {
      if (a.isDirectory() === b.isDirectory()) {
        return a.name.localeCompare(b.name);
      }
      return a.isDirectory() ? -1 : 1;
    });

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.name.startsWith('.')) continue; // skip hidden

      const isLast = i === entries.length - 1;
      const marker = isLast ? '└── ' : '├── ';
      const nextPrefix = prefix + (isLast ? '    ' : '│   ');

      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue;
        output += `${prefix}${marker}${e.name}/\n`;
        output += generateCodeMap(join(dir, e.name), nextPrefix);
      } else {
        const ext = e.name.substring(e.name.lastIndexOf('.')).toLowerCase();
        if (IGNORE_EXTS.has(ext)) continue;
        
        let fileNote = '';
        if (e.name === 'package.json') {
          try {
             const pkg = JSON.parse(readFileSync(join(dir, e.name), 'utf-8'));
             if (pkg.description) fileNote = ` - ${pkg.description}`;
          } catch {}
        } else if (ext === '.js' || ext === '.mjs' || ext === '.ts') {
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
              // Deduplicate and limit to 5 symbols to keep the map compact
              const unique = Array.from(new Set(symbols)).slice(0, 5);
              fileNote = ` [${unique.join(', ')}${symbols.length > 5 ? ', ...' : ''}]`;
            }
          } catch (err) {}
        }
        
        output += `${prefix}${marker}${e.name}${fileNote}\n`;
      }
    }
  } catch (err) {
    output += `${prefix}└── [Error reading directory]\n`;
  }
  return output;
}
