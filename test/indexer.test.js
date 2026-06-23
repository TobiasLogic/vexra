import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { VexraIndexer } from '../src/indexer/index.js';
import { IndexDB } from '../src/indexer/db.js';
import { detectLang, extractSymbols } from '../src/indexer/languages.js';
import { createEmbedder } from '../src/indexer/embed.js';

// Deterministic offline embedder: bag-of-words hashed into `dim` buckets.
function fakeEmbedder(dim = 16) {
  const vec = (text) => {
    const v = new Array(dim).fill(0);
    for (const w of String(text).toLowerCase().match(/[a-z0-9_]+/g) || []) {
      let h = 0;
      for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0;
      v[h % dim] += 1;
    }
    return v;
  };
  return {
    available: true,
    dim,
    resetWarning() {},
    describe: () => 'fake',
    async embed(texts) { return texts.map(vec); },
    async embedOne(t) { return vec(t); },
  };
}

const unavailableEmbedder = {
  available: false,
  resetWarning() {},
  async embed() { return null; },
  async embedOne() { return null; },
};

const TEST_CFG = {
  enabled: true,
  embed_dim: 16,
  embed_batch: 8,
  chunk_size: 6,
  chunk_overlap: 2,
  max_files: 100,
  max_file_bytes: 100000,
  ignored: ['node_modules', '.git'],
  extensions: ['js', 'py'],
};

const tmpDirs = [];
function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'vexra-idx-'));
  tmpDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}
function makeIndexer(dir, embedder = fakeEmbedder(16)) {
  return new VexraIndexer({ root: dir, cfg: TEST_CFG, dbPath: ':memory:', embedder }).init();
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

describe('languages', () => {
  it('detects languages by extension', () => {
    expect(detectLang('a/b/foo.js')).toBe('javascript');
    expect(detectLang('foo.py')).toBe('python');
    expect(detectLang('foo.unknownext')).toBe(null);
  });

  it('extracts JS function and class symbols', () => {
    const syms = extractSymbols('x.js', 'function foo() {}\nconst bar = () => 1;\nclass Baz {}\n');
    expect(syms).toContain('fn foo');
    expect(syms).toContain('fn bar');
    expect(syms).toContain('class Baz');
  });

  it('returns [] for languages without a parser (graceful skip)', () => {
    expect(extractSymbols('x.py', 'def alpha():\n    pass\n')).toEqual([]);
  });

  it('returns [] when source cannot be parsed', () => {
    expect(extractSymbols('x.js', 'function (((( broken')).toEqual([]);
  });
});

describe('IndexDB', () => {
  it('round-trips vector, BM25 and exact search', () => {
    const db = new IndexDB(':memory:', { dim: 4, model: 'test' }).open();
    expect(db.vecEnabled).toBe(true);
    const rows = db.replaceFile({
      path: 'a.js', mtime: 1, size: 1, hash: 'h', lang: 'javascript', symbols: '[]',
      chunks: [
        { startLine: 1, endLine: 2, body: 'quickBrownFox jumps' },
        { startLine: 3, endLine: 4, body: 'const lazyDog = 1' },
      ],
    });
    db.setEmbedding(rows[0].id, [1, 0, 0, 0]);
    db.setEmbedding(rows[1].id, [0, 1, 0, 0]);

    expect(db.searchVec([0.9, 0.1, 0, 0], 1)[0].id).toBe(rows[0].id);
    expect(db.searchFts('quickBrownFox', 5).map((r) => r.id)).toContain(rows[0].id);
    expect(db.searchExact('find the lazyDog token', 5).map((r) => r.id)).toContain(rows[1].id);
    db.close();
  });

  it('replaces a file\'s chunks and prunes stale FTS/vector rows', () => {
    const db = new IndexDB(':memory:', { dim: 4, model: 'test' }).open();
    db.replaceFile({ path: 'a.js', mtime: 1, size: 1, hash: 'h1', lang: 'javascript', symbols: '[]',
      chunks: [{ startLine: 1, endLine: 1, body: 'oldUniqueToken' }] });
    db.replaceFile({ path: 'a.js', mtime: 2, size: 1, hash: 'h2', lang: 'javascript', symbols: '[]',
      chunks: [{ startLine: 1, endLine: 1, body: 'newUniqueToken' }] });
    expect(db.searchFts('oldUniqueToken', 5)).toHaveLength(0);
    expect(db.searchFts('newUniqueToken', 5)).toHaveLength(1);
    expect(db.stats().chunks).toBe(1);
    db.close();
  });
});

describe('VexraIndexer', () => {
  it('indexes a tree, embeds chunks, and skips ignored dirs', async () => {
    const dir = fixture({
      'foo.js': 'function uniqueWidgetIdentifier() {\n  return 42;\n}\n',
      'sub/bar.py': 'def alpha_helper():\n    return "beta"\n',
      'node_modules/dep.js': 'export const shouldBeIgnored = true;\n',
    });
    const ix = makeIndexer(dir);
    const stats = await ix.index();

    expect(stats.files).toBe(2);
    expect(stats.chunks).toBeGreaterThan(0);
    expect(stats.embedded).toBe(stats.chunks);
    expect(ix.db.allPaths()).toEqual(expect.arrayContaining(['foo.js', 'sub/bar.py']));
    expect(ix.db.allPaths()).not.toContain('node_modules/dep.js');
    ix.close();
  });

  it('finds a distinctive identifier via hybrid query', async () => {
    const dir = fixture({ 'foo.js': 'function uniqueWidgetIdentifier() { return 1; }\n', 'other.js': 'const x = 1;\n' });
    const ix = makeIndexer(dir);
    await ix.index();
    const results = await ix.query('where is uniqueWidgetIdentifier defined', { limit: 5 });
    expect(results[0].path).toBe('foo.js');
    expect(results[0].body).toContain('uniqueWidgetIdentifier');
    ix.close();
  });

  it('covers the matched line within a chunk\'s range', async () => {
    const lines = Array.from({ length: 12 }, (_, i) => `const v${i} = ${i};`);
    lines[9] = 'const needleToken = 99;';
    const dir = fixture({ 'big.js': lines.join('\n') + '\n' });
    const ix = makeIndexer(dir);
    await ix.index();
    const [hit] = await ix.query('needleToken', { limit: 3 });
    expect(hit).toBeTruthy();
    expect(hit.startLine).toBeLessThanOrEqual(10);
    expect(hit.endLine).toBeGreaterThanOrEqual(10);
    ix.close();
  });

  it('reflects incremental edits and deletions', async () => {
    const dir = fixture({ 'foo.js': 'function originalSymbol() {}\n' });
    const ix = makeIndexer(dir);
    await ix.index();
    const before = await ix.query('originalSymbol', { limit: 3 });
    expect(before[0].body).toContain('originalSymbol');

    writeFileSync(join(dir, 'foo.js'), 'function replacementSymbol() {}\n');
    await ix.updateFile(join(dir, 'foo.js'));
    // Vector NN always returns the remaining chunk; the meaningful check is that
    // the old content was pruned — no surfaced chunk still holds the old symbol.
    const afterOld = await ix.query('originalSymbol', { limit: 3 });
    expect(afterOld.every((r) => !r.body.includes('originalSymbol'))).toBe(true);
    const afterNew = await ix.query('replacementSymbol', { limit: 3 });
    expect(afterNew[0].body).toContain('replacementSymbol');

    rmSync(join(dir, 'foo.js'));
    await ix.updateFile(join(dir, 'foo.js'));
    expect(ix.db.stats().files).toBe(0);
    ix.close();
  });

  it('falls back to keyword search when embeddings are unavailable', async () => {
    const dir = fixture({ 'foo.js': 'function keywordOnlyToken() {}\n' });
    const ix = makeIndexer(dir, unavailableEmbedder);
    const stats = await ix.index();

    expect(ix.vectorSearch).toBe(false);
    expect(stats.embedded).toBe(0);
    const results = await ix.query('keywordOnlyToken', { limit: 3 });
    expect(results.map((r) => r.path)).toContain('foo.js');
    ix.close();
  });
});

describe('embed (graceful failure)', () => {
  it('reports unavailable and returns null without a key', async () => {
    const calls = [];
    const embedder = createEmbedder({ provider: 'openrouter', apiKey: '', baseUrl: 'https://example.invalid', log: (m) => calls.push(m) });
    expect(embedder.available).toBe(false);
    expect(await embedder.embed(['hello'])).toBe(null);
    expect(calls.length).toBe(1); // logged exactly once
    expect(await embedder.embed(['again'])).toBe(null);
    expect(calls.length).toBe(1);
  });

  it('returns [] for empty input', async () => {
    const embedder = createEmbedder({ provider: 'openrouter', apiKey: 'x', baseUrl: 'https://example.invalid' });
    expect(await embedder.embed([])).toEqual([]);
  });
});
