import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { CONFIG_DIR } from './config.js';

const SESSIONS_DIR = join(CONFIG_DIR, 'sessions');

function ensureDir() {
  mkdirSync(SESSIONS_DIR, { recursive: true });
}

export function listSessions() {
  ensureDir();
  try {
    return readdirSync(SESSIONS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const name = f.replace(/\.json$/, '');
        const stat = statSync(join(SESSIONS_DIR, f));
        return { name, modified: stat.mtime, size: stat.size };
      })
      .sort((a, b) => b.modified - a.modified);
  } catch {
    return [];
  }
}

export function saveSession(name, messages) {
  ensureDir();
  const path = join(SESSIONS_DIR, `${name}.json`);
  writeFileSync(path, JSON.stringify(messages, null, 2), 'utf-8');
  return path;
}

export function loadSession(name) {
  const path = join(SESSIONS_DIR, `${name}.json`);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (Array.isArray(parsed) && parsed.every(m => m && typeof m.role === 'string')) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function deleteSession(name) {
  const path = join(SESSIONS_DIR, `${name}.json`);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

export function sessionExists(name) {
  return existsSync(join(SESSIONS_DIR, `${name}.json`));
}
