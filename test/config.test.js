import { describe, it, expect } from 'vitest';
import { config, validateConfig } from '../src/config.js';

describe('config.js', () => {
  it('should have default values', () => {
    expect(config).toHaveProperty('temperature');
    expect(config).toHaveProperty('maxTokens');
  });

  it('should validate config', () => {
    expect(() => validateConfig({ model: 'gpt-4', provider: 'openai', apiKey: 'test', temperature: 1.0, maxTokens: 4000 })).not.toThrow();
  });
});
