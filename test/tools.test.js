import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { executeTool } from '../src/tools.js';

describe('tools.js path containment guards', () => {
  const created = [];
  afterEach(() => {
    for (const f of created.splice(0)) {
      try { if (existsSync(f)) unlinkSync(f); } catch {}
    }
  });

  it('read_file refuses paths outside the project directory', async () => {
    expect((await executeTool('read_file', { path: '../../etc/passwd' })).error).toMatch(/Refusing to read outside/);
    expect((await executeTool('read_file', { path: '/etc/passwd' })).error).toMatch(/Refusing to read outside/);
  });

  it('read_file still reads an in-project file', async () => {
    const res = await executeTool('read_file', { path: 'package.json' });
    expect(res.content).toContain('"name": "vexra"');
  });

  it('list_dir refuses paths outside the project directory', async () => {
    expect((await executeTool('list_dir', { path: '../../' })).error).toMatch(/Refusing to list outside/);
    expect((await executeTool('list_dir', { path: '/etc' })).error).toMatch(/Refusing to list outside/);
  });

  it('list_dir still lists the project directory', async () => {
    const res = await executeTool('list_dir', { path: '.' });
    expect(res.error).toBeUndefined();
    expect(typeof res.entries).toBe('string');
  });

  it('write_file refuses paths outside the project directory and writes nothing', async () => {
    expect((await executeTool('write_file', { path: '../../tmp/vexra_guard.txt', content: 'x' })).error).toMatch(/Refusing to write outside/);
    expect((await executeTool('write_file', { path: '/tmp/vexra_guard.txt', content: 'x' })).error).toMatch(/Refusing to write outside/);
    expect(existsSync('/tmp/vexra_guard.txt')).toBe(false);
  });

  it('edit_file and multi_edit_file refuse paths outside the project directory', async () => {
    expect((await executeTool('edit_file', { path: '../../tmp/vexra_guard.txt', start_line: 1, end_line: 1, content: 'x' })).error).toMatch(/Refusing to write outside/);
    expect((await executeTool('multi_edit_file', { path: '/etc/passwd', edits: [{ start_line: 1, end_line: 1, content: 'x' }] })).error).toMatch(/Refusing to write outside/);
  });

  it('write_file still writes inside the project directory', async () => {
    const rel = 'vexra_test_artifact.txt';
    created.push(join(process.cwd(), rel));
    const res = await executeTool('write_file', { path: rel, content: 'hello' });
    expect(res.success).toBe(true);
    expect(existsSync(join(process.cwd(), rel))).toBe(true);
  });
});

describe('tools.js grep_search', () => {
  it('finds a real match in the source tree', async () => {
    const res = await executeTool('grep_search', { pattern: 'executeTool', path: 'src' });
    expect(res.output).toMatch(/tools\.js/);
  });

  it('passes the pattern as a literal argument and never invokes a shell', async () => {
    const sentinel = '/tmp/vexra_grep_pwned';
    try { if (existsSync(sentinel)) unlinkSync(sentinel); } catch {}
    await executeTool('grep_search', { pattern: `nomatch"; touch ${sentinel}; echo "` });
    expect(existsSync(sentinel)).toBe(false);
  });
});
