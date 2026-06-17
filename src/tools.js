import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'fs';
import { resolve, relative, join } from 'path';
import { runCommand } from './executor.js';
import * as cheerio from 'cheerio';

const MAX_READ_SIZE = 100 * 1024;
const MAX_OUTPUT_SIZE = 50 * 1024;

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file at the given path. Returns the file content as text.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (relative or absolute)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file. Creates the file if it does not exist, overwrites if it does.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (relative or absolute)' },
          content: { type: 'string', description: 'The content to write to the file' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Edit a file by replacing a specific line range with new content.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (relative or absolute)' },
          start_line: { type: 'number', description: '1-indexed start line (inclusive)' },
          end_line: { type: 'number', description: '1-indexed end line (inclusive)' },
          content: { type: 'string', description: 'The replacement content string' },
        },
        required: ['path', 'start_line', 'end_line', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'multi_edit_file',
      description: 'Edit a file by replacing multiple specific line ranges with new content. Useful for non-contiguous edits.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (relative or absolute)' },
          edits: {
            type: 'array',
            description: 'List of edits to apply. Edits must be sorted in descending order of line numbers to avoid offset issues.',
            items: {
              type: 'object',
              properties: {
                start_line: { type: 'number', description: '1-indexed start line (inclusive)' },
                end_line: { type: 'number', description: '1-indexed end line (inclusive)' },
                content: { type: 'string', description: 'The replacement content string' }
              },
              required: ['start_line', 'end_line', 'content']
            }
          }
        },
        required: ['path', 'edits'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List the contents of a directory. Returns file and directory names with type indicators.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path (relative or absolute). Defaults to cwd.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_shell',
      description: 'Execute a shell command and return its output. Use for builds, tests, git operations, etc.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to execute' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch the text content of a webpage via its URL. Useful for reading documentation or looking up error messages.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The full URL to fetch (e.g., https://example.com)' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_status',
      description: 'Run git status and return the working tree status.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_diff',
      description: 'Run git diff to see unstaged changes.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep_search',
      description: 'Search for a pattern in files using grep (or ripgrep if available).',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'The search pattern' },
          path: { type: 'string', description: 'Directory to search in (default: cwd)' },
        },
        required: ['pattern'],
      },
    },
  },
];

function resolvePath(p) {
  return resolve(process.cwd(), p);
}

function truncateOutput(text, maxLen = MAX_OUTPUT_SIZE) {
  if (text.length <= maxLen) return text;
  const startLen = Math.floor(maxLen * 0.2);
  const endLen = maxLen - startLen;
  return text.slice(0, startLen) + `\n\n... [truncated, ${text.length - maxLen} chars omitted] ...\n\n` + text.slice(-endLen);
}

async function checkSyntax(fullPath) {
  if (fullPath.endsWith('.js') || fullPath.endsWith('.mjs') || fullPath.endsWith('.cjs')) {
    try {
      const result = await runCommand(`node --check "${fullPath}"`);
      if (result.exitCode !== 0) return `Syntax error introduced:\n${result.stderr}`;
    } catch (err) {}
  }
  return null;
}

async function execReadFile(args) {
  const fullPath = resolvePath(args.path);
  if (!existsSync(fullPath)) return { error: `File not found: ${args.path}` };
  try {
    const stat = statSync(fullPath);
    if (stat.size > MAX_READ_SIZE) {
      const content = readFileSync(fullPath, 'utf-8').slice(0, MAX_READ_SIZE);
      return { content: content + `\n... [truncated at ${MAX_READ_SIZE} bytes, total ${stat.size}]` };
    }
    return { content: readFileSync(fullPath, 'utf-8') };
  } catch (err) {
    return { error: `Failed to read ${args.path}: ${err.message}` };
  }
}

async function execWriteFile(args) {
  const fullPath = resolvePath(args.path);
  try {
    writeFileSync(fullPath, args.content, 'utf-8');
    const syntaxError = await checkSyntax(fullPath);
    if (syntaxError) return { error: syntaxError };
    return { success: true, path: args.path, bytes: args.content.length };
  } catch (err) {
    return { error: `Failed to write ${args.path}: ${err.message}` };
  }
}

async function execEditFile(args) {
  const fullPath = resolvePath(args.path);
  if (!existsSync(fullPath)) return { error: `File not found: ${args.path}` };
  try {
    const lines = readFileSync(fullPath, 'utf-8').split('\n');
    const start = args.start_line - 1;
    const end = args.end_line;
    if (start < 0 || start >= lines.length || end < start) {
      return { error: `Invalid line range: 1-indexed ${args.start_line} to ${args.end_line}` };
    }
    const newLines = args.content.split('\n');
    if (newLines[newLines.length - 1] === '') newLines.pop();
    lines.splice(start, end - start, ...newLines);
    writeFileSync(fullPath, lines.join('\n'), 'utf-8');
    const syntaxError = await checkSyntax(fullPath);
    if (syntaxError) return { error: syntaxError };
    return { success: true, path: args.path, linesReplaced: end - start, linesAdded: newLines.length };
  } catch (err) {
    return { error: `Failed to edit ${args.path}: ${err.message}` };
  }
}

async function execMultiEditFile(args) {
  const fullPath = resolvePath(args.path);
  if (!existsSync(fullPath)) return { error: `File not found: ${args.path}` };
  try {
    const lines = readFileSync(fullPath, 'utf-8').split('\n');
    
    // Sort edits in descending order of start_line to avoid index shifting issues
    const sortedEdits = [...args.edits].sort((a, b) => b.start_line - a.start_line);
    
    let totalLinesReplaced = 0;
    let totalLinesAdded = 0;

    for (const edit of sortedEdits) {
      const start = edit.start_line - 1;
      const end = edit.end_line;
      if (start < 0 || start >= lines.length || end < start) {
        return { error: `Invalid line range: 1-indexed ${edit.start_line} to ${edit.end_line}` };
      }
      const newLines = edit.content.split('\n');
      if (newLines[newLines.length - 1] === '') newLines.pop();
      lines.splice(start, end - start, ...newLines);
      
      totalLinesReplaced += (end - start);
      totalLinesAdded += newLines.length;
    }

    writeFileSync(fullPath, lines.join('\n'), 'utf-8');
    const syntaxError = await checkSyntax(fullPath);
    if (syntaxError) return { error: syntaxError };
    
    return { success: true, path: args.path, editsApplied: sortedEdits.length, linesReplaced: totalLinesReplaced, linesAdded: totalLinesAdded };
  } catch (err) {
    return { error: `Failed to multi-edit ${args.path}: ${err.message}` };
  }
}

async function execListDir(args) {
  const dirPath = resolvePath(args.path || '.');
  if (!existsSync(dirPath)) return { error: `Directory not found: ${args.path || '.'}` };
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    const lines = entries.map(e => {
      const type = e.isDirectory() ? 'dir ' : 'file';
      return `${type}  ${e.name}`;
    });
    return { entries: lines.join('\n') || '(empty directory)' };
  } catch (err) {
    return { error: `Failed to list ${args.path || '.'}: ${err.message}` };
  }
}

async function execRunShell(args) {
  try {
    const result = await runCommand(args.command);
    let output = '';
    if (result.stdout) output += result.stdout;
    if (result.stderr) output += (output ? '\n' : '') + `[stderr] ${result.stderr}`;
    if (result.exitCode !== 0) output += `\n[exit code: ${result.exitCode}]`;
    return { output: truncateOutput(output || '(no output)') };
  } catch (err) {
    return { error: `Command failed: ${err.message}` };
  }
}

async function execWebFetch(args) {
  try {
    const res = await fetch(`https://r.jina.ai/${args.url}`, {
      headers: { 'User-Agent': 'ai-cli/1.0.0 (https://github.com/openchat/ai-cli)' }
    });
    if (!res.ok) return { error: `HTTP ${res.status}: ${res.statusText}` };
    const text = await res.text();
    return { content: truncateOutput(text) };
  } catch (err) {
    return { error: `Fetch failed: ${err.message}` };
  }
}

async function execGitStatus(args) {
  try {
    const result = await runCommand('git status -s');
    return { output: truncateOutput(result.stdout || '(no changes)') };
  } catch (err) {
    return { error: `git status failed: ${err.message}` };
  }
}

async function execGitDiff(args) {
  try {
    const result = await runCommand('git diff');
    return { output: truncateOutput(result.stdout || '(no unstaged changes)') };
  } catch (err) {
    return { error: `git diff failed: ${err.message}` };
  }
}

async function execGrepSearch(args) {
  try {
    const dir = resolvePath(args.path || '.');
    const cmd = `rg -n "${args.pattern}" "${dir}" 2>/dev/null || git grep -n "${args.pattern}" 2>/dev/null || grep -rn "${args.pattern}" "${dir}"`;
    const result = await runCommand(cmd);
    return { output: truncateOutput(result.stdout || '(no matches found)') };
  } catch (err) {
    return { error: `grep failed: ${err.message}` };
  }
}

const EXECUTORS = {
  read_file: execReadFile,
  write_file: execWriteFile,
  edit_file: execEditFile,
  multi_edit_file: execMultiEditFile,
  list_dir: execListDir,
  run_shell: execRunShell,
  web_fetch: execWebFetch,
  git_status: execGitStatus,
  git_diff: execGitDiff,
  grep_search: execGrepSearch,
};

export async function executeTool(name, args) {
  const executor = EXECUTORS[name];
  if (!executor) return { error: `Unknown tool: ${name}` };
  return executor(args);
}

export function getToolNames() {
  return Object.keys(EXECUTORS);
}
