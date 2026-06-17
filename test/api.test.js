import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseSSELine, parseRetryAfter, backoffMs, fetchWithRetry } from '../src/api.js';

describe('parseSSELine', () => {
  it('skips empty lines', () => {
    expect(parseSSELine('')).toEqual({ type: 'skip' });
    expect(parseSSELine('   ')).toEqual({ type: 'skip' });
  });

  it('skips non-data lines', () => {
    expect(parseSSELine('event: message')).toEqual({ type: 'skip' });
  });

  it('handles [DONE]', () => {
    expect(parseSSELine('data: [DONE]')).toEqual({ type: 'done' });
  });

  it('parses valid event data', () => {
    const chunk = JSON.stringify({
      choices: [{ delta: { content: 'hello' } }]
    });
    expect(parseSSELine(`data: ${chunk}`)).toEqual({
      type: 'event',
      value: {
        content: 'hello',
        role: null,
        finish: null,
        toolCalls: null,
      }
    });
  });

  it('parses valid usage data', () => {
    const chunk = JSON.stringify({
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30
      }
    });
    expect(parseSSELine(`data: ${chunk}`)).toEqual({
      type: 'usage',
      value: {
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30
      }
    });
  });

  it('handles JSON parse errors', () => {
    expect(parseSSELine('data: { bad json')).toEqual({ type: 'error' });
  });
});

describe('parseRetryAfter', () => {
  it('returns null for a missing header', () => {
    expect(parseRetryAfter(null)).toBe(null);
    expect(parseRetryAfter(undefined)).toBe(null);
    expect(parseRetryAfter('')).toBe(null);
  });

  it('parses numeric seconds into milliseconds', () => {
    expect(parseRetryAfter('5')).toBe(5000);
    expect(parseRetryAfter('0')).toBe(0);
  });

  it('clamps to a 30s ceiling and a 0 floor', () => {
    expect(parseRetryAfter('100')).toBe(30000);
    expect(parseRetryAfter('-3')).toBe(0);
  });

  it('parses HTTP-date values relative to now', () => {
    expect(parseRetryAfter(new Date(Date.now() - 10000).toUTCString())).toBe(0);
    expect(parseRetryAfter(new Date(Date.now() + 3600000).toUTCString())).toBe(30000);
  });

  it('returns null for unparseable values', () => {
    expect(parseRetryAfter('not-a-date')).toBe(null);
  });
});

describe('backoffMs', () => {
  it('grows exponentially and caps at 8s with jitter pinned to 0', () => {
    const r = vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(backoffMs(1)).toBe(500);
    expect(backoffMs(2)).toBe(1000);
    expect(backoffMs(3)).toBe(2000);
    expect(backoffMs(20)).toBe(8000);
    r.mockRestore();
  });

  it('adds bounded jitter under 250ms', () => {
    for (let i = 0; i < 50; i++) {
      const v = backoffMs(1);
      expect(v).toBeGreaterThanOrEqual(500);
      expect(v).toBeLessThan(750);
    }
  });
});

describe('fetchWithRetry', () => {
  function resp({ ok = true, status = 200, retryAfter = null } = {}) {
    return {
      ok,
      status,
      headers: { get: (h) => (h.toLowerCase() === 'retry-after' ? retryAfter : null) },
      text: async () => '',
      json: async () => ({}),
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('returns immediately on a successful response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(resp({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await fetchWithRetry('http://x', {}, { maxRetries: 3 });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry 4xx responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(resp({ ok: false, status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await fetchWithRetry('http://x', {}, { maxRetries: 3 });
    expect(res.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a 503 then succeeds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(resp({ ok: false, status: 503, retryAfter: '0' }))
      .mockResolvedValueOnce(resp({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await fetchWithRetry('http://x', {}, { maxRetries: 3 });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a 429 then succeeds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(resp({ ok: false, status: 429, retryAfter: '0' }))
      .mockResolvedValueOnce(resp({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await fetchWithRetry('http://x', {}, { maxRetries: 3 });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after maxRetries and returns the last response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(resp({ ok: false, status: 503, retryAfter: '0' }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await fetchWithRetry('http://x', {}, { maxRetries: 2 });
    expect(res.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries network errors then throws after maxRetries', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    vi.stubGlobal('fetch', fetchMock);
    const promise = fetchWithRetry('http://x', {}, { maxRetries: 2 });
    const assertion = expect(promise).rejects.toThrow('ECONNRESET');
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry an aborted request', async () => {
    const err = new Error('Aborted');
    err.name = 'AbortError';
    const fetchMock = vi.fn().mockRejectedValue(err);
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchWithRetry('http://x', {}, { maxRetries: 3 })).rejects.toThrow('Aborted');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
