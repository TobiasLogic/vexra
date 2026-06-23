import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, basename, sep } from 'path';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import { config, CONFIG_DIR } from '../config.js';
import { IndexDB } from './db.js';
import { createEmbedder } from './embed.js';
import { detectLang, extractSymbols, extOf } from './languages.js';

const MAX_DEPTH = 12;
const MAX_CHUNK_CHARS = 6000;
const RRF_K = 60;
const SKIP_FILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'composer.lock', 'Cargo.lock', 'poetry.lock']);

function sha1(text) {
  return createHash('sha1').update(text).digest('hex');
}

function toPosix(p) {
  return p.split(sep).join('/');
}

// Reciprocal-rank fusion: combine several ranked id lists into one ranking.
// Each list contributes weight / (K + position); robust to incomparable scores
// (cosine distance vs BM25 rank vs exact hit) without normalising them.
function reciprocalRankFusion(lists, weights) {
  const scores = new Map();
  lists.forEach((list, li) => {
    const w = weights[li] ?? 1;
    list.forEach((item, pos) => {
      const prev = scores.get(item.id) || 0;
      scores.set(item.id, prev + w * (1 / (RRF_K + pos + 1)));
    });
  });
  return [...scores.entries()].sort((a, b) => b[1] - a[1]);
}

export class VexraIndexer {
  constructor({ root = process.cwd(), log, cfg, dbPath, embedder } = {}) {
    this.root = root;
    this.cfg = cfg || config.indexer || {};
    this.dbPath = dbPath || null;
    this._embedderOverride = embedder || null;
    this.log = typeof log === 'function' ? log : () => {};
    this.extensions = new Set((this.cfg.extensions || []).map((e) => e.toLowerCase()));
    this.ignored = new Set(this.cfg.ignored || []);
    this.chunkSize = Math.max(4, this.cfg.chunk_size || 40);
    this.chunkOverlap = Math.max(0, Math.min(this.chunkSize - 1, this.cfg.chunk_overlap ?? 8));
    this.maxFiles = this.cfg.max_files || 2000;
    this.maxFileBytes = this.cfg.max_file_bytes || 512 * 1024;
    this.db = null;
    this.embedder = null;
    this.watcher = null;
    this._debounce = new Map();
    this._indexing = false;
  }

  init() {
    const dir = this.cfg.db_dir || join(CONFIG_DIR, 'index');
    const file = `${basename(this.root)}-${sha1(this.root).slice(0, 12)}.db`;
    this.db = new IndexDB(this.dbPath || join(dir, file), {
      dim: this.cfg.embed_dim,
      model: this.cfg.embed_model,
    }).open();
    this.embedder = this._embedderOverride || createEmbedder({ log: this.log });
    if (!this.db.vecEnabled) {
      this.log(`indexer: sqlite-vec unavailable (${this.db.vecError}) — using keyword search only`);
    }
    return this;
  }

  get vectorSearch() {
    return Boolean(this.db?.vecEnabled && this.embedder?.available);
  }

  isIndexable(absPath) {
    if (SKIP_FILES.has(basename(absPath))) return false;
    if (!this.extensions.has(extOf(absPath))) return false;
    const rel = relative(this.root, absPath);
    if (rel.startsWith('..')) return false;
    return !rel.split(sep).some((seg) => this.ignored.has(seg) || (seg.startsWith('.') && seg !== '.'));
  }

  #walk(dir, depth, out) {
    if (depth > MAX_DEPTH || out.length >= this.maxFiles) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= this.maxFiles) break;
      if (entry.name.startsWith('.')) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (this.ignored.has(entry.name)) continue;
        this.#walk(abs, depth + 1, out);
      } else if (entry.isFile() && this.extensions.has(extOf(entry.name)) && !SKIP_FILES.has(entry.name)) {
        out.push(abs);
      }
    }
  }

  #chunkText(content) {
    const lines = content.split(/\r?\n/);
    const stride = Math.max(1, this.chunkSize - this.chunkOverlap);
    const chunks = [];
    for (let start = 0; start < lines.length; start += stride) {
      const end = Math.min(lines.length, start + this.chunkSize);
      let body = lines.slice(start, end).join('\n');
      if (body.trim() !== '') {
        if (body.length > MAX_CHUNK_CHARS) body = body.slice(0, MAX_CHUNK_CHARS);
        chunks.push({ startLine: start + 1, endLine: end, body });
      }
      if (end >= lines.length) break;
    }
    return chunks;
  }

  // Index a single file if its content hash changed. Embedding is deferred to
  // embedPending() so multiple files share embedding batches.
  #indexFile(absPath, stat) {
    let content;
    try {
      content = readFileSync(absPath, 'utf-8');
    } catch {
      return 'skip';
    }
    for (let i = 0; i < content.length && i < 8192; i++) {
      if (content.charCodeAt(i) === 0) return 'skip'; // binary file guard
    }

    const rel = toPosix(relative(this.root, absPath));
    const hash = sha1(content);
    const existing = this.db.getFile(rel);
    if (existing && existing.hash === hash) return 'unchanged';

    const chunks = this.#chunkText(content);
    this.db.replaceFile({
      path: rel,
      mtime: Math.floor(stat.mtimeMs),
      size: stat.size,
      hash,
      lang: detectLang(rel),
      symbols: JSON.stringify(extractSymbols(rel, content)),
      chunks,
    });
    return 'changed';
  }

  async embedPending() {
    if (!this.vectorSearch) return { embedded: 0 };
    this.embedder.resetWarning();
    let embedded = 0;
    const batchSize = this.cfg.embed_batch || 64;
    for (;;) {
      const batch = this.db.unembeddedChunks(batchSize);
      if (batch.length === 0) break;
      const vectors = await this.embedder.embed(batch.map((c) => c.body));
      if (!vectors) break; // embeddings unavailable this run; keep keyword search
      for (let i = 0; i < batch.length; i++) {
        try {
          this.db.setEmbedding(batch[i].id, vectors[i]);
          embedded++;
        } catch (err) {
          this.log(`indexer: vector store failed (${err.message}) — disabling vector search`);
          this.db.vecEnabled = false;
          return { embedded, error: err.message };
        }
      }
    }
    return { embedded };
  }

  // Full (incremental) index pass: scan, reindex changed files, prune deleted, embed.
  async index(root = this.root) {
    if (this._indexing) return this.db.stats();
    this._indexing = true;
    try {
      const files = [];
      this.#walk(root, 0, files);

      const seen = new Set();
      let changed = 0;
      for (const abs of files) {
        let stat;
        try {
          stat = statSync(abs);
        } catch {
          continue;
        }
        if (stat.size > this.maxFileBytes) continue;
        seen.add(toPosix(relative(this.root, abs)));
        if (this.#indexFile(abs, stat) === 'changed') changed++;
      }

      for (const rel of this.db.allPaths()) {
        if (!seen.has(rel)) this.db.deleteFileByPath(rel);
      }

      const { embedded } = await this.embedPending();
      return { ...this.db.stats(), changed, scanned: files.length, embedded };
    } finally {
      this._indexing = false;
    }
  }

  async updateFile(absPath) {
    if (!this.isIndexable(absPath)) return;
    let stat;
    try {
      stat = statSync(absPath);
    } catch {
      this.deleteFile(absPath);
      return;
    }
    if (!stat.isFile() || stat.size > this.maxFileBytes) {
      this.deleteFile(absPath);
      return;
    }
    if (this.#indexFile(absPath, stat) === 'changed') await this.embedPending();
  }

  deleteFile(absPath) {
    if (!this.db) return;
    const rel = toPosix(relative(this.root, absPath));
    if (rel.startsWith('..')) return;
    this.db.deleteFileByPath(rel);
  }

  // Hybrid retrieval: fuse semantic (vector), BM25 (FTS5) and exact-identifier
  // matches. Returns up to `limit` chunks ordered by fused relevance.
  async query(text, { limit = 8 } = {}) {
    if (!this.db || !text || !text.trim()) return [];
    const k = Math.max(limit * 4, 20);

    let vecList = [];
    if (this.vectorSearch) {
      const qv = await this.embedder.embedOne(text);
      if (qv) vecList = this.db.searchVec(qv, k);
    }
    const ftsList = this.db.searchFts(text, k);
    const exactList = this.db.searchExact(text, k);

    const fused = reciprocalRankFusion([vecList, ftsList, exactList], [1.0, 0.8, 0.5]);
    if (fused.length === 0) return [];

    const scoreById = new Map(fused);
    const topIds = fused.slice(0, limit).map(([id]) => id);
    return this.db.getChunksByIds(topIds).map((c) => ({
      path: c.path,
      startLine: c.startLine,
      endLine: c.endLine,
      body: c.body,
      score: scoreById.get(c.id) || 0,
    }));
  }

  // Formatted code context for injection into the model prompt, or '' if empty.
  async getContextBlock(text, { limit = 6, maxChars = 6000 } = {}) {
    const results = await this.query(text, { limit });
    if (results.length === 0) return '';
    const parts = [];
    let used = 0;
    for (const r of results) {
      const block = `// ${r.path}:${r.startLine}-${r.endLine}\n${r.body}`;
      if (used + block.length > maxChars && parts.length > 0) break;
      parts.push(block);
      used += block.length;
    }
    return parts.join('\n\n');
  }

  startWatch() {
    if (this.watcher) return this;
    let chokidar;
    try {
      chokidar = require('chokidar');
    } catch {
      return this; // optional dependency; watching simply disabled
    }
    this.watcher = chokidar.watch(this.root, {
      ignoreInitial: true,
      persistent: true,
      ignored: (p) => relative(this.root, p).split(sep).some((seg) => this.ignored.has(seg) || (seg.startsWith('.') && seg !== '.')),
    });
    const schedule = (fn, abs) => {
      clearTimeout(this._debounce.get(abs));
      this._debounce.set(abs, setTimeout(() => {
        this._debounce.delete(abs);
        Promise.resolve(fn(abs)).catch(() => {});
      }, 250));
    };
    this.watcher
      .on('add', (p) => schedule((a) => this.updateFile(a), p))
      .on('change', (p) => schedule((a) => this.updateFile(a), p))
      .on('unlink', (p) => this.deleteFile(p));
    return this;
  }

  async stopWatch() {
    for (const t of this._debounce.values()) clearTimeout(t);
    this._debounce.clear();
    if (this.watcher) {
      try { await this.watcher.close(); } catch {}
      this.watcher = null;
    }
  }

  close() {
    this.stopWatch();
    if (this.db) this.db.close();
  }
}
