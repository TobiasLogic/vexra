#!/usr/bin/env node
const [major] = process.versions.node.split('.').map(Number);
if (major < 18) {
  console.error('Error: ai-cli requires Node.js 18 or higher (current: %s).', process.version);
  process.exit(1);
}

import { program } from 'commander';
import { start } from './src/repl.js';

program
  .name('ai-cli')
  .description('TUI-based CLI AI assistant with OpenRouter integration')
  .argument('[prompt]', 'Optional initial prompt (for headless mode)')
  .option('-m, --model <name>', 'OpenRouter model ID')
  .option('-t, --temperature <n>', 'Temperature (0-2)', parseFloat)
  .option('--max-tokens <n>', 'Max output tokens', parseInt)
  .option('-c, --continue', 'Resume the previous saved session')
  .option('--headless', 'Run in headless mode (no prompts, auto-approve)')
  .parse();

const opts = program.opts();
const args = program.args;

const overrides = {};
if (opts.model) overrides.model = opts.model;
if (opts.temperature !== undefined) overrides.temperature = opts.temperature;
if (opts.maxTokens !== undefined) overrides.maxTokens = opts.maxTokens;
if (opts.continue) overrides.resume = true;
if (opts.headless) overrides.headless = true;
if (args[0]) overrides.initialPrompt = args[0];

start(overrides);
