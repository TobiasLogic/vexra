import { describe, it, expect } from 'vitest';
import { resolveMentions } from '../src/context.js';

describe('context.js', () => {
  it('should resolve @file mentions', () => {
    const result = resolveMentions('Look at @package.json');
    expect(result.context).toContain('vexra');
  });
});
