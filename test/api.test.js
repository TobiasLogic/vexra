import { describe, it, expect } from 'vitest';
import { parseSSELine } from '../src/api.js';

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
