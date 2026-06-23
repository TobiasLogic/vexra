# Vexra semantic indexer — roadmap

Status of the code-aware retrieval layer under `src/indexer/`, and the work
intentionally deferred so the high-value subset could ship first.

## Shipped (current)

- **Hybrid retrieval** — vector (sqlite-vec / `vec0`, L2) + BM25 (FTS5) + exact
  identifier (`LIKE`), fused with Reciprocal Rank Fusion (RRF, K=60, weights
  1.0 / 0.8 / 0.5). See [`index.js`](index.js) `query()`.
- **Storage** — `node:sqlite` (`DatabaseSync`) with the sqlite-vec loadable
  extension. Schema versioned; wipes and rebuilds on embed-dim / model / schema
  change. See [`db.js`](db.js).
- **Embeddings** — OpenAI-compatible `POST /embeddings`, batched, order-preserving,
  `dimensions` param for `text-embedding-3*`. Provider defaults to OpenRouter.
  See [`embed.js`](embed.js).
- **Incremental indexing** — content-hash change detection, prune-on-delete,
  chokidar watch (debounced) wired through [`instance.js`](instance.js) so
  `tools.js` write/edit/multi_edit refresh the index after mutations.
- **Per-turn retrieval injection** — `getContextBlock()` folded transiently into
  the system prompt in `repl.js` (not persisted to history).
- **Graceful degradation everywhere** — no API key → keyword search only;
  sqlite-vec missing → BM25 + exact; `node:sqlite` missing (Node < 22.5) → the
  indexer self-disables and the CLI still starts; binary/over-size/lockfiles
  skipped; embedding failure logs once and falls back.

## Deferred — symbol extraction via tree-sitter

Today [`languages.js`](languages.js) uses **acorn**, which only parses the
JavaScript family — and real TS/TSX/JSX syntax throws, so those fall back to
`[]` (no symbols). Symbols are also stored (`files.symbols`) but **not yet used
as a retrieval lane**; they only ride along as metadata.

Migrate to tree-sitter (WASM via `web-tree-sitter`, or native `tree-sitter`
bindings) for language-agnostic, error-tolerant symbol extraction and AST-aware
chunk boundaries.

### Grammar matrix

| Language     | Grammar pkg                    | Capture node types                                  | Status today        |
| ------------ | ------------------------------ | --------------------------------------------------- | ------------------- |
| JavaScript   | `tree-sitter-javascript`       | function/class/method/arrow, exports                | acorn (partial)     |
| TypeScript   | `tree-sitter-typescript` (ts)  | + interface, type alias, enum, decorators           | acorn fails → `[]`  |
| TSX / JSX    | `tree-sitter-typescript` (tsx) | + JSX components                                     | acorn fails → `[]`  |
| Python       | `tree-sitter-python`           | `function_definition`, `class_definition`           | none → `[]`         |
| Go           | `tree-sitter-go`               | `function_declaration`, `method_declaration`, type  | none → `[]`         |
| Rust         | `tree-sitter-rust`             | `fn`, `struct`, `enum`, `trait`, `impl`             | none → `[]`         |
| Java         | `tree-sitter-java`             | class, interface, method, enum                      | none → `[]`         |
| C / C++      | `tree-sitter-c` / `-cpp`       | function/struct/class definitions                   | none → `[]`         |
| Ruby         | `tree-sitter-ruby`             | `method`, `class`, `module`                          | none → `[]`         |
| PHP          | `tree-sitter-php`              | function, class, method                             | none → `[]`         |
| C#           | `tree-sitter-c-sharp`          | class, method, interface, record                    | none → `[]`         |

`detectLang()` already maps these extensions; only the parser is missing.

### Plan

1. Add a `extractSymbolsTreeSitter(path, source)` that loads the grammar for the
   detected language and runs a query capturing the node types above; return
   `{ kind, name, startLine, endLine }`.
2. Keep the `try/catch → []` contract so an unparsable file never breaks indexing.
3. Use symbol spans for **AST-aware chunking** (function/class boundaries) instead
   of the current fixed line window in `#chunkText`.
4. Add a **symbol-name search lane** to the RRF fusion in `query()` so an exact
   function/class name outranks incidental body matches.
5. Lazy-load grammars (only the languages actually present in the tree) to keep
   startup cheap.

## Other future work

- **Reranking** — optional cross-encoder / LLM rerank pass over the fused top-k
  before injection.
- **Token-aware chunking** — replace the 6000-char cap with a tokenizer budget.
- **`.gitignore` awareness** — honor repo ignore rules in addition to
  `config.indexer.ignored` + dotfile skipping.
- **Provider coverage** — the Ollama (`/v1`) and OpenAI-direct paths are coded
  but only OpenRouter is exercised end-to-end; verify and add to tests.
- **Multi-root / monorepo** — single root today; support workspace roots.
- **Stale-vector GC** — vacuum `chunks_vec` on large churn; currently relies on
  per-file replace + dim/model wipe.
