import { describe, it, expect } from 'vitest';
import { unifiedDiff, diffForEdit, diffForLineEdit } from '../src/diff.js';

describe('diff.js', () => {
  it('should generate a unified diff', () => {
    const oldStr = 'const a = 1;\nconst b = 2;\n';
    const newStr = 'const a = 1;\nconst b = 3;\n';
    const diff = unifiedDiff(oldStr, newStr);
    expect(diff).toContain('-const b = 2;');
    expect(diff).toContain('+const b = 3;');
  });

  it('should replace by string', () => {
    const oldStr = 'function foo() { return 1; }';
    const diff = diffForEdit(oldStr, 'return 1', 'return 2');
    expect(diff).toContain('-function foo() { return 1; }');
    expect(diff).toContain('+function foo() { return 2; }');
  });

  it('should replace by line', () => {
    const oldStr = 'line 1\nline 2\nline 3';
    const diff = diffForLineEdit(oldStr, 2, 2, 'line 2 changed');
    expect(diff).toContain('-line 2');
    expect(diff).toContain('+line 2 changed');
  });
});
