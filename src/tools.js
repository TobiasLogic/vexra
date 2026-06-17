import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'fs';
import { resolve, relative, join } from 'path';
import { runCommand, spawnBackgroundTask, BACKGROUND_TASKS } from './executor.js';
import * as p from '@clack/prompts';

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
      name: 'spawn_background_task',
      description: 'Spawn a background shell task. Returns a task ID to interact with it later.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to execute in the background' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'manage_task',
      description: 'Manage background tasks. Actions: list, status, kill.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'status', 'kill'], description: 'The action to perform' },
          task_id: { type: 'string', description: 'Task ID (required for status or kill)' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'invoke_subagent',
      description: 'Invokes a subagent (an autonomous copy of the AI) to work on a task in the background. Returns a conversation ID that you can track via manage_task.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'A clear, actionable task description for the subagent.' },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'manage_workspace',
      description: 'Manage Git worktrees to create isolated parallel branches for experimenting without breaking main files.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'list', 'remove'], description: 'Action to perform' },
          path: { type: 'string', description: 'Relative path for the new worktree (for create) or path to remove (for remove)' },
          branch: { type: 'string', description: 'Branch name for the new worktree (for create)' }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ask_question',
      description: 'Ask the user a multiple-choice question to clarify intent or get design feedback. Halts execution until the user responds in the terminal.',
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                question: { type: 'string', description: 'The question to ask' },
                options: { type: 'array', items: { type: 'string' }, description: 'Array of string options' },
                is_multi_select: { type: 'boolean', description: 'If true, user can select multiple options' }
              },
              required: ['question', 'options']
            }
          }
        },
        required: ['questions']
      }
    }
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

async function execSpawnBackgroundTask(args) {
  try {
    const id = spawnBackgroundTask(args.command);
    return { success: true, task_id: id, message: `Task started in background: ${args.command}` };
  } catch (err) {
    return { error: `Failed to spawn task: ${err.message}` };
  }
}

async function execManageTask(args) {
  if (args.action === 'list') {
    if (BACKGROUND_TASKS.size === 0) return { output: 'No background tasks.' };
    let out = '';
    for (const [id, task] of BACKGROUND_TASKS.entries()) {
      out += `[${id}] ${task.status} (pid: ${task.pid}) - ${task.cmd}\n`;
    }
    return { output: out.trim() };
  }
  
  if (!args.task_id) return { error: `task_id is required for action '${args.action}'` };
  const task = BACKGROUND_TASKS.get(args.task_id);
  if (!task) return { error: `Task not found: ${args.task_id}` };

  if (args.action === 'status') {
    return {
      task_id: task.id,
      cmd: task.cmd,
      status: task.status,
      exitCode: task.exitCode,
      stdout: truncateOutput(task.stdout, 5000),
      stderr: truncateOutput(task.stderr, 5000),
    };
  }
  
  if (args.action === 'kill') {
    if (task.status === 'running') {
      task.child.kill();
      task.status = 'killed';
      return { success: true, message: `Sent kill signal to task ${task.id}` };
    }
    return { error: `Task ${task.id} is already ${task.status}` };
  }
  
  return { error: `Unknown action: ${args.action}` };
}

async function execInvokeSubagent(args) {
  try {
    const cliPath = resolvePath('cli.js');
    // Escape quotes properly for shell
    const safePrompt = args.prompt.replace(/"/g, '\\"');
    const cmd = `node "${cliPath}" --headless "${safePrompt}"`;
    const id = spawnBackgroundTask(cmd);
    return { success: true, conversation_id: id, message: `Subagent spawned as task ${id}. Use manage_task status to check its output.` };
  } catch (err) {
    return { error: `Failed to invoke subagent: ${err.message}` };
  }
}

async function execManageWorkspace(args) {
  try {
    if (args.action === 'create') {
      if (!args.path || !args.branch) return { error: 'path and branch required for create' };
      await runCommand(`git worktree add -b ${args.branch} ${args.path}`);
      return { success: true, message: `Created new worktree at ${args.path} on branch ${args.branch}` };
    }
    if (args.action === 'list') {
      const res = await runCommand(`git worktree list`);
      return { output: res.stdout };
    }
    if (args.action === 'remove') {
      if (!args.path) return { error: 'path required for remove' };
      await runCommand(`git worktree remove -f ${args.path}`);
      return { success: true, message: `Removed worktree at ${args.path}` };
    }
  } catch (err) {
    return { error: `Git worktree failed: ${err.message}` };
  }
}

async function execAskQuestion(args) {
  try {
    const answers = [];
    for (const q of args.questions) {
      if (q.is_multi_select) {
        const selected = await p.multiselect({
          message: q.question,
          options: q.options.map(opt => ({ value: opt, label: opt })),
          required: false
        });
        if (p.isCancel(selected)) return { error: 'User cancelled the question.' };
        answers.push({ question: q.question, answer: selected });
      } else {
        const selected = await p.select({
          message: q.question,
          options: q.options.map(opt => ({ value: opt, label: opt }))
        });
        if (p.isCancel(selected)) return { error: 'User cancelled the question.' };
        answers.push({ question: q.question, answer: selected });
      }
    }
    return { success: true, answers };
  } catch (err) {
    return { error: `Failed to ask question: ${err.message}` };
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
  spawn_background_task: execSpawnBackgroundTask,
  manage_task: execManageTask,
  invoke_subagent: execInvokeSubagent,
  manage_workspace: execManageWorkspace,
  ask_question: execAskQuestion,
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
