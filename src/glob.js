import { readdirSync, statSync } from 'fs';
import { resolve, join, relative } from 'path';

export function simpleGlob(pattern, cwd = process.cwd()) {
  const results = [];
  const parts = pattern.split('/');
  walkDir(cwd, parts, 0, results);
  return results;
}

function walkDir(dir, parts, partIdx, results) {
  if (partIdx >= parts.length) return;

  const part = parts[partIdx];
  const isLast = partIdx === parts.length - 1;

  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.startsWith('.') && !part.startsWith('.')) continue;

    const fullPath = join(dir, entry);

    if (part === '**') {
      if (isLast) {
        results.push(fullPath);
      } else {
        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            walkDir(fullPath, parts, partIdx, results);
            walkDir(fullPath, parts, partIdx + 1, results);
          }
        } catch {}
      }
      continue;
    }

    if (matchPattern(entry, part)) {
      if (isLast) {
        results.push(fullPath);
      } else {
        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            walkDir(fullPath, parts, partIdx + 1, results);
          }
        } catch {}
      }
    }
  }
}

function matchPattern(str, pattern) {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return str === pattern;
  const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  return regex.test(str);
}
