import { config } from '../config.js';

// Models that honour OpenAI's `dimensions` truncation parameter.
const SUPPORTS_DIMENSIONS = /text-embedding-3/;

// Embedding client speaking the OpenAI-compatible POST /embeddings protocol.
// Works against OpenRouter, OpenAI, or a local Ollama server (/v1). Failures are
// soft: embed() returns null and logs at most once so the indexer can fall back
// to BM25 + exact search instead of crashing the session.
export function createEmbedder(opts = {}) {
  const ix = config.indexer || {};
  const provider = opts.provider || ix.embed_provider || 'openrouter';
  const model = opts.model || ix.embed_model;
  const dim = opts.dim || ix.embed_dim;
  const batchSize = Math.max(1, opts.batch || ix.embed_batch || 64);
  const apiKey = opts.apiKey ?? config.apiKey;

  let baseUrl = opts.baseUrl || ix.embed_base_url || '';
  if (!baseUrl) baseUrl = provider === 'ollama' ? 'http://localhost:11434/v1' : config.baseUrl;
  baseUrl = String(baseUrl || '').replace(/\/+$/, '');

  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const needsKey = provider !== 'ollama';

  let warned = false;
  function warnOnce(msg) {
    if (warned) return;
    warned = true;
    log(msg);
  }

  function headers() {
    const h = { 'Content-Type': 'application/json' };
    if (apiKey) h.Authorization = `Bearer ${apiKey}`;
    if (provider === 'openrouter') {
      if (config.referer) h['HTTP-Referer'] = config.referer;
      if (config.title) h['X-Title'] = config.title;
    }
    return h;
  }

  async function embedBatch(texts) {
    const body = { model, input: texts };
    if (dim && SUPPORTS_DIMENSIONS.test(model)) body.dimensions = dim;

    const res = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`HTTP ${res.status} ${res.statusText} ${detail}`.trim());
    }
    const json = await res.json();
    const data = Array.isArray(json?.data) ? json.data : [];
    // Preserve request order regardless of how the provider sorts results.
    data.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return data.map((d) => d.embedding);
  }

  return {
    provider,
    model,
    dim,
    endpoint: `${baseUrl}/embeddings`,
    get available() {
      return Boolean(baseUrl) && (!needsKey || Boolean(apiKey));
    },
    resetWarning() {
      warned = false;
    },
    describe() {
      return `${provider}:${model} (${dim}d)`;
    },

    // Returns an array of vectors (number[][]) aligned to `texts`, or null if
    // embeddings are unavailable. Empty input yields an empty array.
    async embed(texts) {
      if (!Array.isArray(texts) || texts.length === 0) return [];
      if (!this.available) {
        warnOnce(needsKey
          ? 'indexer: embeddings disabled (no API key) — using keyword search only'
          : 'indexer: embeddings disabled (no endpoint) — using keyword search only');
        return null;
      }
      const out = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        const slice = texts.slice(i, i + batchSize);
        try {
          const vecs = await embedBatch(slice);
          if (vecs.length !== slice.length) {
            warnOnce(`indexer: embedding count mismatch (${vecs.length}/${slice.length}) — using keyword search only`);
            return null;
          }
          out.push(...vecs);
        } catch (err) {
          warnOnce(`indexer: embedding request failed (${err.message}) — using keyword search only`);
          return null;
        }
      }
      return out;
    },

    async embedOne(text) {
      const vecs = await this.embed([text]);
      return vecs && vecs.length ? vecs[0] : null;
    },
  };
}
