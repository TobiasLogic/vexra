import * as p from '@clack/prompts';
import { TextPrompt } from '@clack/core';
import chalk from 'chalk';
import boxen from 'boxen';
import { highlight } from 'cli-highlight';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join, resolve, relative } from 'path';
import { homedir } from 'os';
import { spawn } from 'child_process';
import { config, validateConfig, saveConfig } from './config.js';
import { streamChat } from './api.js';
import { runCommand, isDangerousCommand } from './executor.js';
import {
  createShimmer, shimmerText, createSpinner, createPulse,
  createGradientBar, createParticles, createMatrix, typewriter,
  fadeTransition, progressBar, animateCountUp,
} from './shimmer.js';
import { TOOL_DEFINITIONS, executeTool } from './tools.js';
import { unifiedDiff, diffForEdit, diffForLineEdit } from './diff.js';
import { resolveMentions } from './context.js';
import { fetchModels, formatModelList } from './models.js';
import { listSessions, saveSession, loadSession, deleteSession, sessionExists } from './sessions.js';
import { PROVIDERS, getProvider, getProviderChoices } from './providers.js';
import { initMcpServers, cleanupMcpServers, getMcpToolDefinitions, isMcpTool, executeMcpTool } from './mcp.js';
import { generateCodeMap } from './codemap.js';

const MAX_HISTORY_MESSAGES = 40;
const HISTORY_FILE = join(homedir(), '.ai-cli', 'history.json');
const MAX_AGENT_LOOPS = 10;
export let currentMode = 'build';

let sessionTokenUsage = { prompt: 0, completion: 0, total: 0 };
let sessionStartTime = Date.now();
let sessionMessageCount = 0;
let loaderStyle = 'braille';

const LOADER_STYLES = ['braille', 'dots', 'arc', 'circle', 'square', 'line', 'grow', 'shimmer', 'pulse', 'particles', 'matrix'];

function createLoader(label, style) {
  switch (style) {
    case 'shimmer': return createShimmer(label);
    case 'pulse': return createPulse(label, { color: [72, 224, 128] });
    case 'particles': return createParticles(label, { color: [0, 255, 255] });
    case 'matrix': return createMatrix(label);
    default: return createSpinner(label, { style: style || 'braille', color: [54, 208, 208] });
  }
}

function findProjectConfig() {
  const candidates = ['AGENTS.md', '.ai-cli.md', '.ai-cli.json'];
  let dir = process.cwd();
  const root = resolve('/');
  while (dir !== root) {
    for (const name of candidates) {
      const full = join(dir, name);
      if (existsSync(full)) return { path: full, dir, name };
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function getSystemPrompt() {
  let modePrompt = '';
  if (currentMode === 'architect') {
    modePrompt = `You are a senior software architect running in the user's terminal. Your job is to analyze the codebase, plan system designs, and propose architecture changes. Do NOT write functional code or modify implementation details directly. Focus on markdown documents, architectural diagrams, and high-level strategy.`;
  } else if (currentMode === 'ask') {
    modePrompt = `You are a senior mentor running in the user's terminal. The user will ask you questions. You should clarify requirements, explain concepts, and guide the user. Do NOT write code or edit files. Just explain and ask clarifying questions.`;
  } else {
    modePrompt = `You are a helpful AI coding assistant running directly in the user's terminal on ${process.platform}.\nYou can read files, write files, edit files, list directories, and run shell commands using the provided tools.`;
  }

  let prompt = `${modePrompt}
When you need to suggest a shell command, wrap it in a triple-backtick code block with the language tag "sh" like this:

\`\`\`sh
ls -la
\`\`\`

The user will be prompted to approve and execute the command. The output will be fed back to you.
Keep responses concise and clear. Use markdown formatting.

The current working directory is: ${process.cwd()}

### Code Map
Here is a fast index of the current project directory so you know where things are without needing to call list_dir blindly:

${generateCodeMap()}
`;

  const projectCfg = findProjectConfig();
  if (projectCfg && (projectCfg.name === 'AGENTS.md' || projectCfg.name === '.ai-cli.md')) {
    try {
      const content = readFileSync(projectCfg.path, 'utf-8');
      prompt += `\n\n--- Project Instructions (${projectCfg.name}) ---\n${content}`;
    } catch {}
  }

  return prompt;
}

function getProjectConfigOverrides() {
  const projectCfg = findProjectConfig();
  if (projectCfg && projectCfg.name === '.ai-cli.json') {
    try {
      return JSON.parse(readFileSync(projectCfg.path, 'utf-8'));
    } catch {}
  }
  return {};
}

const HL_THEME = {
  keyword:      chalk.blue,
  string:       chalk.green,
  number:       chalk.yellow,
  comment:      chalk.dim,
  default:      chalk.white,
  function:     chalk.magenta,
  class:        chalk.cyan,
  title:        chalk.bold,
  params:       chalk.italic,
  regexp:       chalk.red,
  built_in:     chalk.blueBright,
  type:         chalk.cyan,
  literal:      chalk.yellow,
  meta:         chalk.dim,
  tag:          chalk.blue,
  attr:         chalk.yellow,
  attribute:    chalk.yellow,
  doctag:       chalk.cyan,
  name:         chalk.white,
  selector:     chalk.magenta,
  symbol:       chalk.yellow,
  section:      chalk.bold,
  quote:        chalk.dim,
  template:     chalk.green,
  variable:     chalk.yellow,
  link:         chalk.cyan,
  emphasis:     chalk.italic,
  strong:       chalk.bold,
};

const LANG_MAP = {
  sh: 'bash', bash: 'bash', zsh: 'bash', shell: 'bash',
  js: 'javascript', ts: 'typescript', jsx: 'javascript', tsx: 'typescript',
  py: 'python', rb: 'ruby', rs: 'rust', go: 'go',
  yml: 'yaml', md: 'markdown',
};

function extractShBlocks(text) {
  const regex = /```(?:sh|bash|shell|zsh)\r?\n([\s\S]*?)\r?\n```/g;
  const blocks = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    blocks.push(match[1].trim());
  }
  return blocks;
}

function highlightCode(code, lang) {
  const mapped = LANG_MAP[lang] || lang || undefined;
  try {
    return highlight(code, { language: mapped, theme: HL_THEME });
  } catch {
    try {
      return highlight(code, { theme: HL_THEME });
    } catch {
      return chalk.white(code);
    }
  }
}

function formatFencedBlock(code, lang) {
  const highlighted = highlightCode(code.trimEnd(), lang);
  return `\n${highlighted}\n`;
}

function renderMarkdownInline(text) {
  let out = text;
  out = out.replace(/\*\*(.+?)\*\*/g, (_, t) => chalk.bold(t));
  out = out.replace(/__(.+?)__/g, (_, t) => chalk.bold(t));
  out = out.replace(/`([^`]+)`/g, (_, t) => chalk.cyan(t));
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => chalk.underline.blue(text) + chalk.dim(`(${url})`));
  return out;
}

function createStreamWriter() {
  let state = 'text';
  let blockLang = '';
  let blockBuf = '';

  function flushBlock() {
    if (!blockBuf) return;
    process.stdout.write(formatFencedBlock(blockBuf.trimEnd(), blockLang));
    blockBuf = '';
    blockLang = '';
  }

  return function write(raw) {
    let text = raw;

    while (text.length > 0) {
      if (state === 'text') {
        const idx = text.indexOf('```');
        if (idx === -1) {
          process.stdout.write(renderMarkdownInline(text));
          return;
        }

        process.stdout.write(renderMarkdownInline(text.slice(0, idx)));
        text = text.slice(idx + 3);
        const nl = text.indexOf('\n');

        if (nl === -1) {
          state = 'maybe-language';
          blockBuf = text;
          text = '';
        } else {
          blockLang = text.slice(0, nl).trim();
          text = text.slice(nl + 1);
          state = 'block';
        }
      } else if (state === 'maybe-language') {
        const nl = text.indexOf('\n');
        if (nl === -1) {
          blockBuf += text;
          text = '';
        } else if (blockBuf.trim() === '' && text.slice(0, nl).trim() === '') {
          blockLang = '';
          text = text.slice(nl + 1);
          state = 'block';
        } else {
          process.stdout.write('```' + blockBuf);
          blockBuf = '';
          state = 'text';
        }
      } else if (state === 'block') {
        blockBuf += text;
        text = '';

        const marker = '\n```';
        const idx = blockBuf.indexOf(marker);

        if (idx === -1) return;

        const code = blockBuf.slice(0, idx);
        let after = blockBuf.slice(idx + marker.length);

        blockBuf = code;
        flushBlock();

        blockLang = '';

        if (after.startsWith('\r')) after = after.slice(1);
        if (after.startsWith('\n')) after = after.slice(1);

        state = 'text';
        if (after) text = after;
      }
    }
  };
}

function boxOutput(label, content) {
  if (!content) return;
  const boxed = boxen(content, {
    padding: { top: 0, bottom: 0, left: 2, right: 1 },
    margin: 0,
    borderStyle: 'round',
    borderColor: 'cyan',
    dimBorder: true,
    title: label,
    titleAlignment: 'left',
  });
  console.log(boxed);
}

function buildCommandOutput(result) {
  let parts = [];
  if (result.stdout) parts.push(result.stdout);
  if (result.stderr) parts.push(chalk.red(result.stderr));
  if (result.killedByTimeout) {
    parts.push(chalk.yellow(`Timed out (exit code ${result.exitCode})`));
  } else if (result.exitCode !== 0 && !result.stderr) {
    parts.push(chalk.yellow(`Exit code: ${result.exitCode}`));
  }
  return parts.length ? parts.join('\n') : '(no output)';
}

function buildContextOutput(result) {
  let output = '';
  if (result.stdout) output += `stdout:\n${result.stdout}\n`;
  if (result.stderr) output += `stderr:\n${result.stderr}\n`;
  if (result.killedByTimeout) {
    output += `Timed out. Exit code: ${result.exitCode}\n`;
  } else if (result.exitCode !== 0 && !result.stderr) {
    output += `Exit code: ${result.exitCode}\n`;
  }
  return output.trim() || '(no output)';
}

async function pruneHistory(messages, opts) {
  const CHUNK_SIZE = 10;
  if (messages.length <= MAX_HISTORY_MESSAGES) return;

  const sysMsg = messages[0];
  let splitIdx = CHUNK_SIZE + 1;
  while (splitIdx < messages.length && messages[splitIdx].role === 'tool') {
    splitIdx++;
  }
  const evicted = messages.slice(1, splitIdx);
  const kept = messages.slice(splitIdx);

  process.stderr.write(chalk.dim(`\n[ai-cli] History reached limit. Summarizing ${evicted.length} oldest messages in background...\n`));

  try {
    const summaryPrompt = [
      { role: 'system', content: 'You are a highly efficient assistant. Summarize the following conversation log concisely, capturing all important context, decisions, and facts. Output ONLY the summary.' },
      { role: 'user', content: JSON.stringify(evicted) }
    ];

    let summaryText = '';
    for await (const chunk of streamChat(summaryPrompt, { ...opts, temperature: 0.3 })) {
      if (chunk.content) summaryText += chunk.content;
    }

    messages.length = 0;
    messages.push(sysMsg);
    messages.push({
      role: 'assistant',
      content: `[System Note: The following is a summary of the earliest parts of our conversation.]\n\n${summaryText.trim()}`
    });
    messages.push(...kept);
    process.stderr.write(chalk.dim(`[ai-cli] Summary generated and injected. (${summaryText.length} chars)\n`));
  } catch (err) {
    process.stderr.write(chalk.dim(`[ai-cli] Summarization failed, hard-dropping messages instead. (${err.message})\n`));
    messages.length = 0;
    messages.push(sysMsg, ...kept);
  }
}

function saveHistory(messages) {
  try {
    mkdirSync(join(homedir(), '.ai-cli'), { recursive: true });
    writeFileSync(HISTORY_FILE, JSON.stringify(messages, null, 2), 'utf-8');
  } catch {}
}

function loadHistory() {
  try {
    const parsed = JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'));
    if (Array.isArray(parsed) &&
        parsed.every(m => m && typeof m.role === 'string' && (typeof m.content === 'string' || Array.isArray(m.content)))) {
      return parsed;
    }
  } catch {}
  return null;
}

function buildInitialMessages() {
  return [{ role: 'system', content: getSystemPrompt() }];
}

function exportMarkdown(messages, file) {
  const lines = ['# ai-cli conversation', '', `Exported ${new Date().toISOString()}`, ''];
  for (const m of messages) {
    if (m.role === 'system') continue;
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    lines.push(m.role === 'user' ? '## You' : '## Assistant', '', content, '');
  }
  writeFileSync(file, lines.join('\n'), 'utf-8');
}

function renderGradientSeparator(width = 58) {
  let out = '';
  for (let i = 0; i < width; i++) {
    const t = i / width;
    const r = Math.round(54 + (180 - 54) * Math.sin(t * Math.PI));
    const g = Math.round(208 + (100 - 208) * Math.sin(t * Math.PI));
    const b = Math.round(208 + (255 - 208) * Math.sin(t * Math.PI));
    out += chalk.rgb(r, g, b)('─');
  }
  return out;
}

function runStreamingCommand(cmd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, { shell: true, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stdout.write(chalk.red(text));
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code || 0, signal: signal || null, killedByTimeout: false });
    });
  });
}

const COMMANDS = [
  ['/help', 'Show this help'],
  ['/sh <cmd>', 'Run a shell command directly'],
  ['/provider', 'Set up provider, API key, and model'],
  ['/model [id]', 'Show or switch the model'],
  ['/models', 'Browse and pick models interactively'],
  ['/temp [n]', 'Show or set temperature (0-2)'],
  ['/tokens [n]', 'Show or set max output tokens'],
  ['/mode [type]', 'Switch role: build, architect, ask'],
  ['/auto <prompt>', 'Run an autonomous agent loop'],
  ['/loader [style]', 'Show or set loader animation (braille, dots, arc, pulse, shimmer, ...)'],
  ['/save [file]', 'Export the conversation to a markdown file'],
  ['/retry', 'Regenerate the last response'],
  ['/reset', 'Clear the conversation and start fresh'],
  ['/resume', 'Reload the previous saved session'],
  ['/session <cmd>', 'Named sessions: list, save <name>, load <name>, delete <name>'],
  ['/editor', 'Open $EDITOR for multi-line input'],
  ['/history', 'Show conversation stats & token usage'],
  ['/clear', 'Clear the screen'],
  ['/animations', 'Preview all animation styles'],
  ['/shimmer', 'Preview the wave bar animation'],
  ['/exit', 'Quit (or press Ctrl+C)'],
];

function printHelp() {
  console.log();
  console.log('  ' + chalk.bold('Commands'));
  for (const [c, d] of COMMANDS) {
    console.log('  ' + chalk.hex('#36D0D0')(c.padEnd(20)) + chalk.gray(d));
  }
  console.log();
}

function printSessionStats() {
  const elapsed = Math.round((Date.now() - sessionStartTime) / 1000);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

  console.log();
  console.log(chalk.bold.hex('#36D0D0')('  Session Stats'));
  console.log(chalk.dim('  ─────────────────────────────'));
  console.log('  ' + chalk.gray('Duration:  ') + chalk.white(timeStr));
  console.log('  ' + chalk.gray('Messages:  ') + chalk.white(`${sessionMessageCount}`));
  if (sessionTokenUsage.total > 0) {
    console.log('  ' + chalk.gray('Tokens:    ') + chalk.white(`${sessionTokenUsage.total}`) +
      chalk.dim(` (${sessionTokenUsage.prompt} prompt + ${sessionTokenUsage.completion} completion)`));
  }
  console.log(chalk.dim('  ─────────────────────────────'));
  console.log();
}

async function goodbye() {
  printSessionStats();
  cleanupMcpServers();
  await fadeTransition('Goodbye.', { color: [54, 208, 208], direction: 'out' });
  process.exit(0);
}

async function printBanner(opts) {
  const cols = Math.min(process.stdout.columns || 60, 60);
  const innerW = cols - 2;
  console.log();
  console.log(chalk.dim('╭' + '─'.repeat(innerW) + '╮'));
  await shimmerText('ai-cli', {
    prefix: chalk.dim('│') + '  ',
    suffix: chalk.dim(' - TUI AI Assistant'),
  });
  console.log(
    chalk.dim('│') +
    '  ' + chalk.gray(`Model: ${opts.model}`)
  );
  console.log(
    chalk.dim('│') +
    '  ' + chalk.gray(`Temp: ${opts.temperature}   Max tokens: ${opts.maxTokens}`)
  );
  console.log(
    chalk.dim('│') +
    '  ' + chalk.gray('Type ') + chalk.hex('#36D0D0')('/help') +
    chalk.gray(' for commands  ·  Ctrl+C to exit')
  );
  console.log(chalk.dim('╰' + '─'.repeat(innerW) + '╯'));
  console.log();
}

async function runProviderSetup(opts) {
  console.log();
  await typewriter('Welcome to ai-cli!', { color: [54, 208, 208], bold: true, intervalMs: 30 });
  console.log(chalk.dim("  Let's set up your AI provider.\n"));

  const providerId = await p.select({
    message: 'Choose a provider',
    options: getProviderChoices(),
  });
  if (p.isCancel(providerId)) {
    console.log(chalk.dim('\n  Setup cancelled. Exiting.\n'));
    process.exit(0);
  }

  const provider = getProvider(providerId);
  let baseUrl = provider.baseUrl;
  let model = provider.defaultModel;

  if (providerId === 'custom') {
    const customUrl = await p.text({
      message: 'API base URL (OpenAI-compatible)',
      placeholder: 'https://your-api.com/v1',
      validate: (v) => {
        if (!v.trim()) return 'URL is required';
        try { new URL(v); } catch { return 'Must be a valid URL'; }
      },
    });
    if (p.isCancel(customUrl)) {
      console.log(chalk.dim('\n  Setup cancelled. Exiting.\n'));
      process.exit(0);
    }
    baseUrl = customUrl.trim().replace(/\/+$/, '');
  }

  if (provider.keyUrl) {
    console.log(chalk.dim(`  Get your key at: `) + chalk.underline.blue(provider.keyUrl));
  }

  const apiKey = await p.password({
    message: `Enter your ${provider.name} API key`,
    placeholder: provider.keyHint,
    validate: (v) => {
      if (!v.trim()) return 'API key is required';
      if (provider.keyPrefix && !v.trim().startsWith(provider.keyPrefix)) {
        return `Key should start with "${provider.keyPrefix}"`;
      }
    },
  });
  if (p.isCancel(apiKey)) {
    console.log(chalk.dim('\n  Setup cancelled. Exiting.\n'));
    process.exit(0);
  }

  opts.apiKey = apiKey.trim();
  opts.baseUrl = baseUrl;

  const spinner = createSpinner('Fetching models...', { style: 'dots', color: [54, 208, 208] });
  spinner.start();

  let models = [];
  try {
    models = await fetchModels(baseUrl, opts.apiKey);
    spinner.stop();
  } catch {
    spinner.stop();
    p.log.warn('Could not fetch models. You can set one manually.');
  }

  if (models.length > 0) {
    const choices = models.slice(0, 50).map(m => ({
      value: m.id,
      label: m.id,
      hint: m.contextLength ? `${(m.contextLength / 1000).toFixed(0)}k ctx` : '',
    }));

    const selected = await p.select({
      message: 'Pick a model',
      options: choices,
    });
    if (p.isCancel(selected)) {
      model = provider.defaultModel || models[0].id;
    } else {
      model = selected;
    }
  } else if (providerId === 'custom') {
    const customModel = await p.text({
      message: 'Model ID',
      placeholder: 'gpt-4o',
      validate: (v) => { if (!v.trim()) return 'Model ID is required'; },
    });
    if (p.isCancel(customModel)) {
      model = 'gpt-4o';
    } else {
      model = customModel.trim();
    }
  }

  opts.model = model;

  const saved = saveConfig({
    provider: providerId,
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    model: opts.model,
  });

  if (saved) {
    p.log.success(`Saved to ~/.ai-cli/config.json`);
  } else {
    p.log.warn('Could not save config file. Settings will only apply this session.');
  }

  console.log();
  p.log.success(`${chalk.bold(provider.name)} configured with ${chalk.bold.hex('#36D0D0')(model)}`);
  console.log();
}

export async function start(userOpts = {}) {
  const { resume = false, initialPrompt = '', headless = false, ...optOverrides } = userOpts;
  const projectOverrides = getProjectConfigOverrides();
  const opts = { ...config, ...projectOverrides, ...optOverrides };
  if (headless) opts.headless = true;

  if (!opts.apiKey && opts.provider !== 'ollama') {
    if (opts.headless) {
      console.error('Error: Headless mode requires an API key or Ollama provider.');
      process.exit(1);
    }
    await runProviderSetup(opts);
  }

  validateConfig(opts);

  sessionStartTime = Date.now();

  let isStreaming = false;

  process.on('SIGINT', async () => {
    if (isStreaming) return;
    printSessionStats();
    cleanupMcpServers();
    process.stdout.write('\x1b[?25h');
    process.exit(0);
  });

  await printBanner(opts);
  await initMcpServers(p);

  let messages = buildInitialMessages();
  let lastUserPromptIdx = null;

  if (resume) {
    const loaded = loadHistory();
    if (loaded && loaded.length > 1) {
      messages = loaded;
      p.log.success(`Resumed previous session (${loaded.length - 1} message(s)).`);
    } else {
      p.log.warn('No previous session to resume - starting fresh.');
    }
  }

  async function confirmRun(cmd, { alwaysAsk }) {
    if (opts.headless) return true;
    const reason = isDangerousCommand(cmd);
    if (!alwaysAsk && !reason) return true;

    const message = reason
      ? chalk.yellow(`⚠ ${reason} - run? `) + chalk.bold.hex('#36D0D0')(cmd)
      : `${chalk.bold('Run command?')} ${chalk.hex('#36D0D0')(cmd)}`;

    const ok = await p.confirm({ message, initialValue: !reason });
    if (p.isCancel(ok)) return false;
    return ok;
  }

  async function confirmToolUse(toolName, args) {
    if (opts.headless) return true;
    const label = chalk.hex('#36D0D0')(toolName);
    if (toolName === 'write_file') {
      console.log(chalk.dim(`\n  Tool: `) + label + chalk.dim(` → ${args.path}`));
      const ok = await p.confirm({ message: 'Write this file?', initialValue: true });
      if (p.isCancel(ok)) return false;
      return ok;
    }
    if (toolName === 'edit_file') {
      console.log(chalk.dim(`\n  Tool: `) + label + chalk.dim(` → ${args.path}`));
      try {
        const oldContent = readFileSync(resolve(process.cwd(), args.path), 'utf-8');
        const diff = diffForLineEdit(oldContent, args.start_line, args.end_line, args.content);
        console.log(diff);
      } catch {}
      const ok = await p.confirm({ message: 'Apply this edit?', initialValue: true });
      if (p.isCancel(ok)) return false;
      return ok;
    }
    if (toolName === 'multi_edit_file') {
      console.log(chalk.dim(`\n  Tool: `) + label + chalk.dim(` → ${args.path} (${args.edits?.length || 0} edits)`));
      try {
        const oldContent = readFileSync(resolve(process.cwd(), args.path), 'utf-8');
        for (const edit of args.edits || []) {
          const diff = diffForLineEdit(oldContent, edit.start_line, edit.end_line, edit.content);
          console.log(diff);
        }
      } catch {}
      const ok = await p.confirm({ message: 'Apply these edits?', initialValue: true });
      if (p.isCancel(ok)) return false;
      return ok;
    }
    if (toolName === 'run_shell') {
      return confirmRun(args.command, { alwaysAsk: true });
    }
    return true;
  }

  async function runShell(cmd, { fromUser }) {
    if (fromUser) {
      const ok = await confirmRun(cmd, { alwaysAsk: false });
      if (!ok) {
        console.log(chalk.dim('  Aborted.\n'));
        return;
      }
    }

    console.log(chalk.dim(`\n$ `) + chalk.hex('#36D0D0')(cmd) + '\n');
    if (fromUser) messages.push({ role: 'user', content: `Run shell command: ${cmd}` });

    let result;
    try {
      result = await runStreamingCommand(cmd);
    } catch (err) {
      p.log.error(chalk.red('Failed to start: ' + err.message));
      if (fromUser) messages.pop();
      return;
    }

    console.log();
    boxOutput(cmd, buildCommandOutput(result));
    console.log();

    messages.push({
      role: 'user',
      content: `Command output for "${cmd}":\n${buildContextOutput(result)}`,
    });

    if (fromUser) saveHistory(messages);
  }

  function accumulateToolCalls(existing, fragments) {
    for (const frag of fragments) {
      const idx = frag.index;
      if (!existing[idx]) {
        existing[idx] = { id: frag.id || '', type: 'function', function: { name: '', arguments: '' } };
      }
      if (frag.id) existing[idx].id = frag.id;
      if (frag.function?.name) existing[idx].function.name += frag.function.name;
      if (frag.function?.arguments) existing[idx].function.arguments += frag.function.arguments;
    }
    return existing;
  }

  async function streamAssistant({ truncateOnError }) {
    const spinner = createLoader('Thinking', loaderStyle);
    spinner.start();

    const writer = createStreamWriter();
    let fullResponse = '';
    let firstChunk = true;
    let toolCallFragments = [];
    let turnUsage = null;

    const controller = new AbortController();
    const allTools = [...TOOL_DEFINITIONS, ...getMcpToolDefinitions()];
    const streamOpts = { ...opts, signal: controller.signal, tools: allTools };

    function onSigint() {
      controller.abort();
    }
    process.once('SIGINT', onSigint);
    isStreaming = true;

    try {
      for await (const chunk of streamChat(messages, streamOpts)) {
        if (chunk._type === 'usage') {
          turnUsage = chunk;
          continue;
        }

        if (chunk.toolCalls) {
          toolCallFragments = accumulateToolCalls(toolCallFragments, chunk.toolCalls);
          if (firstChunk) {
            spinner.stop();
            if (typeof spinner.update === 'function') spinner.update('Using tools');
            spinner.start();
            firstChunk = false;
          }
          continue;
        }

        if (firstChunk) {
          spinner.stop();
          process.stdout.write('\r' + renderGradientSeparator() + '\n');
          firstChunk = false;
        }
        if (chunk.content) {
          fullResponse += chunk.content;
          writer(chunk.content);
        }
      }

      if (firstChunk && toolCallFragments.length === 0) {
        spinner.stop();
        console.log(chalk.dim('(empty response)'));
      }

      if (fullResponse) {
        process.stdout.write('\n' + renderGradientSeparator() + '\n');
        console.log();
      }
    } catch (err) {
      spinner.stop();
      if (err.name === 'AbortError') {
        p.log.message(chalk.yellow('Interrupted.'));
      } else {
        p.log.error(chalk.red(err.message));
      }
      if (truncateOnError != null) messages.splice(truncateOnError);
      return;
    } finally {
      spinner.stop();
      process.removeListener('SIGINT', onSigint);
      isStreaming = false;
    }

    if (turnUsage) {
      sessionTokenUsage.prompt += turnUsage.promptTokens;
      sessionTokenUsage.completion += turnUsage.completionTokens;
      sessionTokenUsage.total += turnUsage.totalTokens;
      console.log(chalk.dim(`  ${turnUsage.promptTokens} prompt · ${turnUsage.completionTokens} completion · ${turnUsage.totalTokens} total tokens`));
    }

    if (fullResponse.trim()) {
      messages.push({ role: 'assistant', content: fullResponse });
    }

    if (toolCallFragments.length > 0) {
      const toolCalls = toolCallFragments.filter(tc => tc && tc.function);
      const assistantMsg = {
        role: 'assistant',
        content: fullResponse || null,
        tool_calls: toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.function.name, arguments: tc.function.arguments },
        })),
      };

      if (!fullResponse.trim()) {
        messages.push(assistantMsg);
      } else {
        messages[messages.length - 1] = assistantMsg;
      }

      for (const tc of toolCalls) {
        let args;
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: 'Invalid arguments' }) });
          continue;
        }

        const approved = await confirmToolUse(tc.function.name, args);
        if (!approved) {
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: 'User rejected this action' }) });
          console.log(chalk.dim('  Skipped.\n'));
          continue;
        }

        let result;
        if (isMcpTool(tc.function.name)) {
          result = await executeMcpTool(tc.function.name, args);
        } else {
          result = await executeTool(tc.function.name, args);
        }
        
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });

        if (result.success || result.content || result.entries || result.output) {
          const summary = result.content
            ? result.content.slice(0, 200) + (result.content.length > 200 ? '...' : '')
            : result.entries
            ? result.entries.slice(0, 200)
            : result.output
            ? result.output.slice(0, 200)
            : JSON.stringify(result);
          console.log(chalk.dim(`  ${tc.function.name} → `) + chalk.green('ok') + chalk.dim(` ${summary.slice(0, 80)}`));
        } else if (result.error) {
          console.log(chalk.dim(`  ${tc.function.name} → `) + chalk.red(result.error));
        }
      }

      return 'continue';
    }

    let executedSh = false;
    for (const cmd of extractShBlocks(fullResponse)) {
      const ok = await confirmRun(cmd, { alwaysAsk: true });
      if (!ok) {
        console.log(chalk.dim('  Skipped.\n'));
        continue;
      }
      await runShell(cmd, { fromUser: false });
      executedSh = true;
    }

    await pruneHistory(messages, opts);
    saveHistory(messages);

    if (executedSh) return 'continue';
  }

  async function agentLoop({ truncateOnError, maxLoops = MAX_AGENT_LOOPS }) {
    for (let i = 0; i < maxLoops; i++) {
      const result = await streamAssistant({ truncateOnError });
      if (result !== 'continue') break;
    }
  }

  if (initialPrompt) {
    messages[0].content = getSystemPrompt();
    const { text, context, images } = resolveMentions(initialPrompt);
    const userMsg = { role: 'user', content: context ? `${text}\n${context}` : text };
    if (images.length > 0) userMsg.content = [{ type: 'text', text: userMsg.content }, ...images];
    messages.push(userMsg);
    await agentLoop({ truncateOnError: messages.length - 1 });
    if (opts.headless) {
      printSessionStats();
      cleanupMcpServers();
      process.exit(0);
    }
  }

  if (opts.headless) {
    console.error('Error: Headless mode requires an initial prompt.');
    process.exit(1);
  }

  while (true) {
    messages[0].content = getSystemPrompt();

    const modes = ['build', 'architect', 'ask'];
    const inputPrompt = new TextPrompt({
      render() {
        if (this.value === undefined) this.value = '';
        const indicatorColor = currentMode === 'architect' ? '#FF5555' : currentMode === 'ask' ? '#5555FF' : '#36D0D0';
        const indicator = chalk.bold.hex(indicatorColor)(`[${currentMode.toUpperCase()}]`);
        const prefix = chalk.hex('#48E080')('◆');
        const title = `${prefix} ${indicator} Ask something (Tab to switch mode), or /help ...\n`;
        return title + chalk.dim('│  ') + this.valueWithCursor;
      }
    });

    inputPrompt.on('key', (key) => {
      if (key === '\t') {
        const idx = modes.indexOf(currentMode);
        currentMode = modes[(idx + 1) % modes.length];
      }
    });

    const input = await inputPrompt.prompt();

    if (p.isCancel(input)) await goodbye();

    const trimmed = (input || '').trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('/')) {
      const space = trimmed.indexOf(' ');
      const name = (space === -1 ? trimmed.slice(1) : trimmed.slice(1, space)).toLowerCase();
      const arg = space === -1 ? '' : trimmed.slice(space + 1).trim();

      switch (name) {
        case 'help':
          printHelp();
          break;

        case 'provider':
          await runProviderSetup(opts);
          break;

        case 'exit':
        case 'quit':
          await goodbye();
          break;

        case 'clear':
          console.clear();
          await printBanner(opts);
          break;

        case 'mode': {
          if (!arg) {
            p.log.info(`Current mode: ${currentMode}`);
            console.log(chalk.dim('  Available modes: build, architect, ask'));
            break;
          }
          if (['build', 'architect', 'ask'].includes(arg)) {
            currentMode = arg;
            p.log.success(`Mode changed to: ${chalk.bold(arg)}`);
          } else {
            p.log.warn(`Unknown mode: ${arg}. Available: build, architect, ask`);
          }
          break;
        }

        case 'auto': {
          if (!arg) {
             p.log.warn('Usage: /auto <task description>');
             break;
          }
          const prevHeadless = opts.headless;
          opts.headless = true;
          messages[0].content = getSystemPrompt();
          const { text, context, images } = resolveMentions(arg);
          const userMsg = { role: 'user', content: context ? `${text}\n${context}` : text };
          if (images.length > 0) userMsg.content = [{ type: 'text', text: userMsg.content }, ...images];
          messages.push(userMsg);
          await agentLoop({ truncateOnError: messages.length - 1, maxLoops: 100 });
          opts.headless = prevHeadless;
          p.log.success('Auto task completed.');
          break;
        }

        case 'reset':
          messages = buildInitialMessages();
          lastUserPromptIdx = null;
          sessionTokenUsage = { prompt: 0, completion: 0, total: 0 };
          sessionMessageCount = 0;
          sessionStartTime = Date.now();
          saveHistory(messages);
          p.log.success('Conversation reset.');
          break;

        case 'resume': {
          const loaded = loadHistory();
          if (loaded && loaded.length > 1) {
            messages = loaded;
            lastUserPromptIdx = null;
            p.log.success(`Loaded ${loaded.length - 1} message(s) from the previous session.`);
          } else {
            p.log.warn('No previous session to resume.');
          }
          break;
        }

        case 'model':
          if (!arg) p.log.info(`Model: ${opts.model}`);
          else {
            opts.model = arg;
            p.log.success(`Model → ${chalk.bold.hex('#36D0D0')(arg)}`);
            console.log(chalk.dim(`  (next response will use ${arg})`));
          }
          break;

        case 'models': {
          const spinner = createSpinner('Fetching models...', { style: 'dots', color: [180, 100, 255] });
          spinner.start();
          try {
            const models = await fetchModels(opts.baseUrl, opts.apiKey);
            spinner.stop();
            if (models.length === 0) {
              p.log.warn('No models returned.');
              break;
            }
            const choices = models.slice(0, 50).map(m => ({
              value: m.id,
              label: m.id,
              hint: m.contextLength ? `${(m.contextLength / 1000).toFixed(0)}k ctx` : '',
            }));
            const selected = await p.select({
              message: 'Select a model',
              options: choices,
            });
            if (p.isCancel(selected)) break;
            opts.model = selected;
            p.log.success(`Model → ${chalk.bold.hex('#36D0D0')(selected)}`);
            console.log(chalk.dim(`  (next response will use ${selected})`));
          } catch (err) {
            spinner.stop();
            p.log.error(`Failed to fetch models: ${err.message}`);
          }
          break;
        }

        case 'temp':
        case 'temperature': {
          if (!arg) { p.log.info(`Temperature: ${opts.temperature}`); break; }
          const n = Number(arg);
          if (isNaN(n) || n < 0 || n > 2) { p.log.warn('Temperature must be between 0 and 2.'); break; }
          opts.temperature = n;
          p.log.success(`Temperature set to ${n}`);
          break;
        }

        case 'tokens':
        case 'maxtokens': {
          if (!arg) { p.log.info(`Max tokens: ${opts.maxTokens}`); break; }
          const n = parseInt(arg, 10);
          if (isNaN(n) || n < 1) { p.log.warn('Max tokens must be a positive integer.'); break; }
          opts.maxTokens = n;
          p.log.success(`Max tokens set to ${n}`);
          break;
        }

        case 'loader': {
          if (!arg) {
            p.log.info(`Loader: ${chalk.bold.hex('#36D0D0')(loaderStyle)}`);
            console.log(chalk.dim(`  Available: ${LOADER_STYLES.join(', ')}`));
            break;
          }
          const style = arg.toLowerCase();
          if (!LOADER_STYLES.includes(style)) {
            p.log.warn(`Unknown loader style: ${style}`);
            console.log(chalk.dim(`  Available: ${LOADER_STYLES.join(', ')}`));
            break;
          }
          loaderStyle = style;
          p.log.success(`Loader set to ${chalk.bold.hex('#36D0D0')(style)}`);
          const preview = createLoader('Preview', style);
          preview.start();
          await new Promise(r => setTimeout(r, 2000));
          preview.stop();
          console.log();
          break;
        }

        case 'save': {
          const file = arg || `ai-cli-${new Date().toISOString().replace(/[:.]/g, '-')}.md`;
          try {
            exportMarkdown(messages, file);
            p.log.success(`Saved conversation to ${file}`);
          } catch (err) {
            p.log.error(`Failed to save: ${err.message}`);
          }
          break;
        }

        case 'history': {
          const count = messages.filter(m => m.role !== 'system').length;
          p.log.info(`${count} message(s) in context. Autosaved to ${HISTORY_FILE}`);
          if (sessionTokenUsage.total > 0) {
            console.log(chalk.dim(`  Session tokens: ${sessionTokenUsage.prompt} prompt + ${sessionTokenUsage.completion} completion = ${sessionTokenUsage.total} total`));
          }
          break;
        }

        case 'retry':
          if (lastUserPromptIdx == null || lastUserPromptIdx >= messages.length) {
            p.log.warn('Nothing to retry yet.');
            break;
          }
          messages.splice(lastUserPromptIdx + 1);
          await agentLoop({ truncateOnError: null });
          break;

        case 'sh':
          if (!arg) { p.log.warn('No command provided after /sh.'); break; }
          await runShell(arg, { fromUser: true });
          break;

        case 'editor': {
          const editor = process.env.EDITOR || 'vi';
          const tmpFile = join(homedir(), '.ai-cli', 'editor-tmp.md');
          mkdirSync(join(homedir(), '.ai-cli'), { recursive: true });
          writeFileSync(tmpFile, '', 'utf-8');
          console.log(chalk.dim(`  Opening ${editor}...`));
          await new Promise((resolve) => {
            const child = spawn(editor, [tmpFile], { stdio: 'inherit' });
            child.on('close', resolve);
          });
          try {
            const content = readFileSync(tmpFile, 'utf-8').trim();
            if (content) {
              console.log(chalk.dim(`  Got ${content.length} chars from editor.`));
              lastUserPromptIdx = messages.length;
              sessionMessageCount++;
              const { text: cleanText, context, images } = resolveMentions(content);
              
              let messageContent;
              if (images && images.length > 0) {
                messageContent = [
                  { type: 'text', text: cleanText + context },
                  ...images
                ];
              } else {
                messageContent = cleanText + context;
              }
              
              messages.push({ role: 'user', content: messageContent });
              await agentLoop({ truncateOnError: lastUserPromptIdx });
            } else {
              p.log.warn('Editor returned empty content.');
            }
          } catch (err) {
            p.log.error(`Failed to read editor output: ${err.message}`);
          }
          break;
        }

        case 'session': {
          const parts = arg.split(/\s+/);
          const subCmd = (parts[0] || '').toLowerCase();
          const subArg = parts.slice(1).join(' ');

          switch (subCmd) {
            case 'list':
            case 'ls': {
              const sessions = listSessions();
              if (sessions.length === 0) {
                p.log.info('No saved sessions.');
              } else {
                console.log(chalk.bold('\n  Saved Sessions'));
                for (const s of sessions) {
                  console.log('  ' + chalk.hex('#36D0D0')(s.name) + chalk.dim(` (${s.modified.toLocaleDateString()})`));
                }
                console.log();
              }
              break;
            }
            case 'save': {
              if (!subArg) { p.log.warn('Usage: /session save <name>'); break; }
              saveSession(subArg, messages);
              p.log.success(`Session saved as "${subArg}"`);
              break;
            }
            case 'load': {
              if (!subArg) { p.log.warn('Usage: /session load <name>'); break; }
              const loaded = loadSession(subArg);
              if (loaded) {
                messages = loaded;
                lastUserPromptIdx = null;
                p.log.success(`Loaded session "${subArg}" (${loaded.length} messages)`);
              } else {
                p.log.warn(`Session "${subArg}" not found.`);
              }
              break;
            }
            case 'delete':
            case 'rm': {
              if (!subArg) { p.log.warn('Usage: /session delete <name>'); break; }
              if (deleteSession(subArg)) {
                p.log.success(`Deleted session "${subArg}"`);
              } else {
                p.log.warn(`Session "${subArg}" not found.`);
              }
              break;
            }
            default:
              p.log.warn('Usage: /session [list|save|load|delete] [name]');
          }
          break;
        }

        case 'shimmer': {
          const preview = createShimmer('Preview');
          preview.start();
          await new Promise(r => setTimeout(r, 2500));
          preview.stop();
          console.log(chalk.dim('  (wave bar animation)\n'));
          break;
        }

        case 'animations': {
          console.log(chalk.bold.hex('#36D0D0')('\n  Animation Showcase\n'));

          console.log(chalk.dim('  1. Braille Spinner:'));
          const s1 = createSpinner('Processing data...', { style: 'braille', color: [54, 208, 208] });
          s1.start();
          await new Promise(r => setTimeout(r, 1500));
          s1.stop('Done processing');

          console.log(chalk.dim('  2. Dots Spinner:'));
          const s2 = createSpinner('Loading modules...', { style: 'dots', color: [180, 100, 255] });
          s2.start();
          await new Promise(r => setTimeout(r, 1500));
          s2.stop('Modules loaded');

          console.log(chalk.dim('  3. Rainbow Spinner:'));
          const s3 = createSpinner('Syncing...', { style: 'arc', rainbow: true });
          s3.start();
          await new Promise(r => setTimeout(r, 1500));
          s3.stop('Synced');

          console.log(chalk.dim('  4. Pulse Bar:'));
          const p1 = createPulse('Analyzing', { color: [255, 100, 180], width: 30 });
          p1.start();
          await new Promise(r => setTimeout(r, 1500));
          p1.stop();
          console.log();

          console.log(chalk.dim('  5. Gradient Bar:'));
          const g1 = createGradientBar('Rendering', { width: 35 });
          g1.start();
          await new Promise(r => setTimeout(r, 1500));
          g1.stop();
          console.log();

          console.log(chalk.dim('  6. Particles:'));
          const pt = createParticles('Floating', { color: [0, 255, 255], width: 32 });
          pt.start();
          await new Promise(r => setTimeout(r, 1500));
          pt.stop();
          console.log();

          console.log(chalk.dim('  7. Matrix Rain:'));
          const mx = createMatrix('Decrypting', { width: 28 });
          mx.start();
          await new Promise(r => setTimeout(r, 1500));
          mx.stop();
          console.log();

          console.log(chalk.dim('  8. Wave Bar (original):'));
          const wb = createShimmer('Classic', { width: 24 });
          wb.start();
          await new Promise(r => setTimeout(r, 1500));
          wb.stop();
          console.log();

          console.log(chalk.dim('  9. Typewriter:'));
          process.stdout.write('  ');
          await typewriter('Hello from ai-cli!', { color: [54, 208, 208], bold: true, intervalMs: 40 });

          console.log(chalk.dim('  10. Fade Transition:'));
          process.stdout.write('  ');
          await fadeTransition('Fading in...', { color: [180, 100, 255], direction: 'in' });

          console.log(chalk.dim('  11. Progress Bar:'));
          process.stdout.write('  ');
          for (let i = 0; i <= 20; i++) {
            await progressBar(i, 20, { width: 25, label: 'uploading' });
            await new Promise(r => setTimeout(r, 60));
          }
          process.stdout.write('\n');

          console.log(chalk.dim('  12. Count Up:'));
          process.stdout.write('  ');
          await animateCountUp(0, 1337, { color: [72, 224, 128], prefix: 'Score: ', suffix: ' pts' });

          console.log(chalk.bold.hex('#36D0D0')('  All animations complete!\n'));
          break;
        }

        default:
          p.log.warn(`Unknown command: /${name}. Type /help for the list.`);
          break;
      }
      continue;
    }

    lastUserPromptIdx = messages.length;
    sessionMessageCount++;
    const { text: cleanText, context, images } = resolveMentions(trimmed);
    
    let messageContent;
    if (images && images.length > 0) {
      messageContent = [
        { type: 'text', text: cleanText + context },
        ...images
      ];
    } else {
      messageContent = cleanText + context;
    }
    
    messages.push({ role: 'user', content: messageContent });
    await agentLoop({ truncateOnError: lastUserPromptIdx });
  }
}
