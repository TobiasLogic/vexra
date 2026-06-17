function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const e = new Error('Aborted'); e.name = 'AbortError'; return reject(e);
    }
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        const e = new Error('Aborted'); e.name = 'AbortError'; reject(e);
      }, { once: true });
    }
  });
}

function backoffMs(attempt) {
  return Math.min(8000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
}

function parseRetryAfter(header) {
  if (!header) return null;
  const secs = Number(header);
  if (!isNaN(secs)) return Math.min(30000, Math.max(0, secs * 1000));
  const when = Date.parse(header);
  if (!isNaN(when)) return Math.min(30000, Math.max(0, when - Date.now()));
  return null;
}

async function fetchWithRetry(url, options, { maxRetries, signal }) {
  let attempt = 0;
  while (true) {
    let res;
    try {
      res = await fetch(url, options);
    } catch (err) {
      if (err.name === 'AbortError' || attempt >= maxRetries) throw err;
      attempt++;
      await sleep(backoffMs(attempt), signal);
      continue;
    }
    if (res.ok) return res;
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < maxRetries) {
      const wait = parseRetryAfter(res.headers.get('retry-after'));
      attempt++;
      try { await res.text(); } catch {}
      await sleep(wait ?? backoffMs(attempt), signal);
      continue;
    }
    return res;
  }
}

export function parseSSELine(line) {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('data:')) return { type: 'skip' };
  const data = trimmed.slice(5).trim();
  if (data === '[DONE]') return { type: 'done' };
  try {
    const parsed = JSON.parse(data);
    const choice = parsed.choices?.[0];
    const usage = parsed.usage || null;

    if (usage) {
      return {
        type: 'usage',
        value: {
          promptTokens: usage.prompt_tokens || 0,
          completionTokens: usage.completion_tokens || 0,
          totalTokens: usage.total_tokens || 0,
        },
      };
    }

    if (!choice) return { type: 'skip' };

    const delta = choice.delta || {};
    const toolCalls = delta.tool_calls;

    return {
      type: 'event',
      value: {
        content: delta.content || '',
        role: delta.role || null,
        finish: choice.finish_reason || null,
        toolCalls: toolCalls || null,
      },
    };
  } catch {
    return { type: 'error' };
  }
}

export async function* streamChat(messages, opts = {}) {
  const {
    apiKey,
    baseUrl = 'https://openrouter.ai/api/v1',
    model = 'openai/gpt-4o',
    temperature = 0.7,
    maxTokens = 4096,
    signal,
    referer,
    title,
    maxRetries = 3,
    tools = null,
  } = opts;

  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  if (referer) headers['HTTP-Referer'] = referer;
  if (title) headers['X-Title'] = title;

  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: true,
    stream_options: { include_usage: true },
    // OpenRouter prompt caching
    provider: {
      allow_fallbacks: false
    }
  };

  // Add explicit caching for Anthropic models via OpenRouter
  // We apply cache_control to the system prompt and the second-to-last message (to cache the chat history).
  if (messages.length > 0) {
    // Clone messages to avoid mutating the caller's array
    body.messages = messages.map(msg => ({ ...msg }));
    
    // 1. Cache the system message (usually contains large instructions/context)
    if (body.messages[0].role === 'system') {
      if (typeof body.messages[0].content === 'string') {
        body.messages[0].content = [
          { type: 'text', text: body.messages[0].content, cache_control: { type: 'ephemeral' } }
        ];
      } else if (Array.isArray(body.messages[0].content)) {
        const lastBlock = body.messages[0].content[body.messages[0].content.length - 1];
        if (lastBlock) lastBlock.cache_control = { type: 'ephemeral' };
      }
    }

    // 2. Cache the history right before the latest turn (if there are enough messages)
    const lastCacheableIndex = body.messages.length - 3;
    if (lastCacheableIndex > 0) {
      const msg = body.messages[lastCacheableIndex];
      if (typeof msg.content === 'string') {
        msg.content = [
          { type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }
        ];
      } else if (Array.isArray(msg.content)) {
        const lastBlock = msg.content[msg.content.length - 1];
        if (lastBlock) lastBlock.cache_control = { type: 'ephemeral' };
      }
    }
  }

  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  const res = await fetchWithRetry(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  }, { maxRetries, signal });

  if (!res.ok) {
    let errBody;
    try {
      const json = await res.json();
      errBody = json.error?.message || JSON.stringify(json);
    } catch {
      errBody = await res.text();
    }
    throw new Error(`OpenRouter API error (${res.status}): ${errBody}`);
  }

  if (!res.body) {
    throw new Error('OpenRouter returned an empty response body.');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let parseErrorCount = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += value ? decoder.decode(value, { stream: true }) : decoder.decode();

      let nlIdx;
      while ((nlIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nlIdx);
        buffer = buffer.slice(nlIdx + 1);
        const r = parseSSELine(line);
        if (r.type === 'done') return;
        if (r.type === 'event') yield r.value;
        else if (r.type === 'usage') yield { ...r.value, _type: 'usage' };
        else if (r.type === 'error') {
          parseErrorCount++;
          process.stderr.write(`\n[ai-cli: warn] malformed SSE chunk received\n`);
        }
      }

      if (done) {
        const r = parseSSELine(buffer);
        if (r.type === 'event') yield r.value;
        else if (r.type === 'usage') yield { ...r.value, _type: 'usage' };
        else if (r.type === 'error') parseErrorCount++;
        break;
      }
    }
  } finally {
    try { await reader.cancel(); } catch {}
    if (parseErrorCount > 0) {
      process.stderr.write(`\n[ai-cli: warn] ${parseErrorCount} malformed SSE chunk(s) were dropped from the response.\n`);
    }
    reader.releaseLock();
  }
}
