import { createRequire } from 'module';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import * as sqliteVec from 'sqlite-vec';

const require = createRequire(import.meta.url);

// node:sqlite is a recent built-in (Node >= 22.5). Load it defensively via
// require so this module still evaluates on older runtimes — the indexer then
// self-disables at open() instead of crashing the whole CLI at import time.
let DatabaseSync = null;
let sqliteLoadError = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  sqliteLoadError = err;
}

const SCHEMA_VERSION = 1;

// Convert a numeric array / Float32Array into the little-endian byte blob vec0 expects.
export function vecBytes(arr) {
  const f32 = arr instanceof Float32Array ? arr : Float32Array.from(arr);
  return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
}

// Turn arbitrary user text into a safe FTS5 MATCH expression (OR of quoted terms).
function ftsQuery(text) {
  const terms = String(text || '').match(/[A-Za-z0-9_]+/g);
  if (!terms || terms.length === 0) return null;
  const seen = new Set();
  const uniq = [];
  for (const t of terms) {
    const lower = t.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    uniq.push(`"${t}"`);
    if (uniq.length >= 24) break;
  }
  return uniq.join(' OR ');
}

export class IndexDB {
  constructor(dbPath, { dim, model }) {
    this.dbPath = dbPath;
    this.dim = dim;
    this.model = model;
    this.db = null;
    this.vecEnabled = false;
    this.vecError = null;
  }

  open() {
    if (!DatabaseSync) {
      throw new Error(`node:sqlite unavailable (${sqliteLoadError?.message || 'requires Node >= 22.5'})`);
    }
    if (this.dbPath !== ':memory:') {
      try { mkdirSync(dirname(this.dbPath), { recursive: true }); } catch {}
    }
    this.db = new DatabaseSync(this.dbPath, { allowExtension: true });

    try {
      this.db.loadExtension(sqliteVec.getLoadablePath());
      this.db.prepare('SELECT vec_version()').get();
      this.vecEnabled = true;
    } catch (err) {
      this.vecEnabled = false;
      this.vecError = err.message;
    }
    // Harden: disallow further extension loading once vec is in.
    try { this.db.enableLoadExtension(false); } catch {}

    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');

    this.#createSchema();
    this.#migrate();
    return this;
  }

  #createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY,
        path TEXT UNIQUE NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        hash TEXT NOT NULL,
        lang TEXT,
        symbols TEXT,
        indexed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY,
        file_id INTEGER NOT NULL,
        path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        body TEXT NOT NULL,
        embedded INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(body, tokenize = 'unicode61');
    `);
    if (this.vecEnabled) {
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(embedding float[${this.dim}])`);
    }
  }

  // Wipe and rebuild when the embedding space changed (dim/model) or schema bumped,
  // since stored vectors are not comparable across models or dimensions.
  #migrate() {
    const ver = this.getMeta('schema_version');
    const dim = this.getMeta('embed_dim');
    const model = this.getMeta('embed_model');
    const stale =
      ver !== String(SCHEMA_VERSION) ||
      (this.vecEnabled && (dim !== String(this.dim) || model !== String(this.model)));

    if (stale && (ver !== null || dim !== null)) {
      this.reset();
    }
    this.setMeta('schema_version', String(SCHEMA_VERSION));
    this.setMeta('embed_dim', String(this.dim));
    this.setMeta('embed_model', String(this.model));
  }

  reset() {
    this.db.exec(`
      DROP TABLE IF EXISTS chunks_fts;
      DROP TABLE IF EXISTS chunks;
      DROP TABLE IF EXISTS files;
    `);
    if (this.vecEnabled) this.db.exec('DROP TABLE IF EXISTS chunks_vec');
    this.#createSchema();
  }

  getMeta(key) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  setMeta(key, value) {
    this.db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  transaction(fn) {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw err;
    }
  }

  getFile(path) {
    return this.db.prepare('SELECT id, mtime, size, hash, lang FROM files WHERE path = ?').get(path) || null;
  }

  allPaths() {
    return this.db.prepare('SELECT path FROM files').all().map((r) => r.path);
  }

  #chunkIdsForFile(fileId) {
    return this.db.prepare('SELECT id FROM chunks WHERE file_id = ?').all(fileId).map((r) => r.id);
  }

  #deleteChunkRows(ids) {
    if (ids.length === 0) return;
    const delChunk = this.db.prepare('DELETE FROM chunks WHERE id = ?');
    const delFts = this.db.prepare('DELETE FROM chunks_fts WHERE rowid = ?');
    const delVec = this.vecEnabled ? this.db.prepare('DELETE FROM chunks_vec WHERE rowid = ?') : null;
    for (const id of ids) {
      delChunk.run(id);
      delFts.run(id);
      if (delVec) delVec.run(BigInt(id));
    }
  }

  // Upsert file metadata and replace its chunks. Returns the freshly inserted
  // chunk rows ({ id, body }) so the caller can embed them.
  replaceFile({ path, mtime, size, hash, lang, symbols, chunks }) {
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT id FROM files WHERE path = ?').get(path);
      let fileId;
      if (existing) {
        fileId = existing.id;
        this.db.prepare('UPDATE files SET mtime = ?, size = ?, hash = ?, lang = ?, symbols = ?, indexed_at = ? WHERE id = ?')
          .run(mtime, size, hash, lang, symbols, Date.now(), fileId);
        this.#deleteChunkRows(this.#chunkIdsForFile(fileId));
      } else {
        const info = this.db.prepare('INSERT INTO files(path, mtime, size, hash, lang, symbols, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(path, mtime, size, hash, lang, symbols, Date.now());
        fileId = Number(info.lastInsertRowid);
      }

      const insChunk = this.db.prepare('INSERT INTO chunks(file_id, path, start_line, end_line, body) VALUES (?, ?, ?, ?, ?)');
      const insFts = this.db.prepare('INSERT INTO chunks_fts(rowid, body) VALUES (?, ?)');
      const inserted = [];
      for (const c of chunks) {
        const info = insChunk.run(fileId, path, c.startLine, c.endLine, c.body);
        const id = Number(info.lastInsertRowid);
        insFts.run(id, c.body);
        inserted.push({ id, body: c.body });
      }
      return inserted;
    });
  }

  deleteFileByPath(path) {
    return this.transaction(() => {
      const file = this.db.prepare('SELECT id FROM files WHERE path = ?').get(path);
      if (!file) return false;
      this.#deleteChunkRows(this.#chunkIdsForFile(file.id));
      this.db.prepare('DELETE FROM files WHERE id = ?').run(file.id);
      return true;
    });
  }

  setEmbedding(chunkId, vector) {
    if (!this.vecEnabled) return;
    this.db.prepare('INSERT INTO chunks_vec(rowid, embedding) VALUES (?, ?)').run(BigInt(chunkId), vecBytes(vector));
    this.db.prepare('UPDATE chunks SET embedded = 1 WHERE id = ?').run(chunkId);
  }

  searchVec(vector, k) {
    if (!this.vecEnabled) return [];
    return this.db
      .prepare('SELECT rowid AS id, distance FROM chunks_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?')
      .all(vecBytes(vector), k)
      .map((r) => ({ id: r.id, distance: r.distance }));
  }

  searchFts(text, k) {
    const q = ftsQuery(text);
    if (!q) return [];
    try {
      return this.db
        .prepare('SELECT rowid AS id, rank FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?')
        .all(q, k)
        .map((r) => ({ id: r.id, rank: r.rank }));
    } catch {
      return [];
    }
  }

  searchExact(text, k) {
    const all = String(text || '').match(/[A-Za-z0-9_]{3,}/g);
    if (!all || all.length === 0) return [];
    // Probe the most distinctive identifiers first (longest tokens), unioning
    // matches in priority order so the strongest exact hits rank highest.
    const tokens = [...new Set(all)].sort((a, b) => b.length - a.length).slice(0, 5);
    const stmt = this.db.prepare('SELECT id FROM chunks WHERE body LIKE ? ESCAPE \'\\\' LIMIT ?');
    const seen = new Set();
    const out = [];
    for (const t of tokens) {
      if (out.length >= k) break;
      const like = `%${t.replace(/[\\%_]/g, '\\$&')}%`;
      for (const r of stmt.all(like, k)) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        out.push({ id: r.id });
        if (out.length >= k) break;
      }
    }
    return out;
  }

  getChunksByIds(ids) {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT id, path, start_line AS startLine, end_line AS endLine, body FROM chunks WHERE id IN (${placeholders})`)
      .all(...ids);
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.map((id) => byId.get(id)).filter(Boolean);
  }

  unembeddedChunks(limit) {
    return this.db
      .prepare('SELECT id, body FROM chunks WHERE embedded = 0 LIMIT ?')
      .all(limit)
      .map((r) => ({ id: r.id, body: r.body }));
  }

  stats() {
    const files = this.db.prepare('SELECT COUNT(*) AS n FROM files').get().n;
    const chunks = this.db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n;
    const embedded = this.db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE embedded = 1').get().n;
    return { files, chunks, embedded, vecEnabled: this.vecEnabled };
  }

  close() {
    if (this.db) {
      try { this.db.close(); } catch {}
      this.db = null;
    }
  }
}
