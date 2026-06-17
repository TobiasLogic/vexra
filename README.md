# Vexra

**The All-Seeing CLI Agent**

![Vexra](https://img.shields.io/badge/Vexra-The_All--Seeing_CLI-36D0D0?style=for-the-badge)
![Node](https://img.shields.io/badge/node-%3E%3D18-48E080?style=for-the-badge&logo=node.js&logoColor=white)
![Platform](https://img.shields.io/badge/platform-macOS_·_Linux_·_Windows-5555FF?style=for-the-badge)

Vexra is a terminal-native AI coding assistant that lives inside your workflow. It maps your
codebase, runs tools, edits files, executes commands, and can drive long autonomous tasks, all
from a fast, animated TUI. Bring your own model from OpenRouter, OpenAI, Anthropic, Gemini,
Groq, DeepSeek, xAI, or a local Ollama.

---

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Usage](#usage)
- [Slash Commands](#slash-commands)
- [Attaching Context with `@`](#attaching-context-with-)
- [Supported Providers](#supported-providers)
- [Configuration](#configuration)
- [Safety](#safety)
- [Updating & Uninstalling](#updating--uninstalling)
- [License](#license)

---

## Features

- **AST repo mapping:** parses the AST of your JS/TS files with `acorn` to build a fast index of
  where every function and class lives, so the agent knows your layout without blindly listing
  directories.
- **Dynamic modes:** press `Tab` while typing to cycle agent personalities.
  - `[BUILD]`: full access to write code and run commands (default).
  - `[ARCHITECT]`: high-level design and analysis; markdown proposals only.
  - `[ASK]`: mentor mode; explains and clarifies without touching files.
- **Autonomous task loop:** `/auto <prompt>` kicks off a self-correcting, multi-step run that
  keeps going until the goal is met. Good for unattended bug-fixing.
- **Headless and CI-ready:** `--headless` runs non-interactively, auto-approves tool use, and
  exits when done. Drop it into pipelines or spawn it as a subagent.
- **Rich tool suite:** read/write/edit/multi-edit files, list dirs, grep, run shell, git
  status/diff, fetch web pages, manage background tasks, spin up git worktrees, and ask you
  multiple-choice questions mid-task.
- **`@`-mention context:** pull file contents, globs, and images straight into your prompt
  (`@src/api.js`, `@src/*.js`, `@screenshot.png`).
- **Multimodal:** attach images via `@` to vision-capable models.
- **Sessions and history:** auto-saved history with on-the-fly summarization when context
  grows, plus named sessions you can save, load, and delete.
- **Prompt caching:** automatically applies cache breakpoints for Anthropic-style models to cut
  token costs on long chats.
- **Built-in guardrails:** destructive shell commands (`rm -rf`, `git push --force`, fork bombs,
  disk writes, and more) require explicit confirmation before they run.
- **Model Context Protocol (MCP):** connect external data sources and tools natively.
- **Tasteful animations:** shimmer waves, gradient bars, particles, matrix rain, and more; pick
  your loader with `/loader`. Cleanly degrades to plain text when piped or non-TTY.

---

## Requirements

- **Node.js 18 or newer** (Node 20+ recommended)
- An API key from a [supported provider](#supported-providers), or a local
  [Ollama](https://ollama.com) install (no key needed)

---

## Installation

> **Canonical source is GitHub.** All commands below install the exact code in this repo. The
> package name is `vexra`, so it runs as `vexra` and uninstalls by name no matter how you
> installed it.

### Try it instantly, no install

Run the latest straight from GitHub without adding anything global:

```bash
# npm
npx github:TobiasLogic/vexra

# pnpm
pnpm dlx github:TobiasLogic/vexra
```

### Global install

Pick your package manager:

```bash
# npm
npm install -g github:TobiasLogic/vexra

# pnpm
pnpm add -g github:TobiasLogic/vexra

# yarn
yarn global add github:TobiasLogic/vexra

# bun
bun add -g github:TobiasLogic/vexra
```

Then run `vexra` from anywhere.

> If `vexra` isn't found after install, make sure your package manager's global bin is on your
> `PATH` (`npm bin -g`, `pnpm bin -g`, `~/.yarn/bin`, or `~/.bun/bin`).

### From source

```bash
git clone https://github.com/TobiasLogic/vexra.git
cd vexra
npm install
npm install -g .        # installs the `vexra` command globally
```

Prefer not to install globally? Run it in place:

```bash
node cli.js             # from inside the cloned repo
```

### For contributors (live-linked)

```bash
git clone https://github.com/TobiasLogic/vexra.git
cd vexra
npm install
npm link                # symlinks `vexra` to your working tree
npm test                # run the test suite (vitest)
```

---

## Quick Start

```bash
vexra
```

On first launch Vexra walks you through picking a provider, pasting an API key, and choosing a
model, then drops you into the chat. Type a request, hit Enter, and approve any file edits or
commands the agent proposes.

```text
◆ [BUILD] Ask something (Tab to switch mode), or /help ...
│  add a --json flag to the export command
```

---

## Usage

```text
vexra [prompt] [options]

Arguments:
  prompt                  Optional initial prompt (used for headless / one-shot runs)

Options:
  -m, --model <name>      Model ID to use for this run
  -t, --temperature <n>   Sampling temperature (0-2)
      --max-tokens <n>    Max output tokens
  -c, --continue          Resume the previous saved session
      --headless          Run non-interactively and auto-approve tool use
  -h, --help              Show help
```

### Headless automation

Pass a prompt plus `--headless` to run autonomously, which is ideal for CI or scripting:

```bash
vexra "Fix the failing tests in test/api.test.js" --headless
vexra -m anthropic/claude-sonnet-4 "Summarize TODOs across the repo" --headless
```

### Resume where you left off

```bash
vexra --continue
```

---

## Slash Commands

Inside the TUI:

| Command | Description |
| --- | --- |
| `/help` | Show all commands |
| `/sh <cmd>` | Run a shell command directly |
| `/provider` | Set up provider, API key, and model |
| `/model [id]` | Show or switch the model |
| `/models` | Browse and pick models interactively |
| `/temp [n]` | Show or set temperature (0-2) |
| `/tokens [n]` | Show or set max output tokens |
| `/mode [type]` | Switch role: `build`, `architect`, `ask` |
| `/auto <prompt>` | Run an autonomous agent loop |
| `/loader [style]` | Show or set the loader animation |
| `/save [file]` | Export the conversation to markdown |
| `/retry` | Regenerate the last response |
| `/reset` | Clear the conversation and start fresh |
| `/resume` | Reload the previous saved session |
| `/session <cmd>` | Named sessions: `list`, `save <name>`, `load <name>`, `delete <name>` |
| `/editor` | Open `$EDITOR` for multi-line input |
| `/history` | Show conversation stats & token usage |
| `/clear` | Clear the screen |
| `/animations` | Preview all animation styles |
| `/shimmer` | Preview the wave-bar animation |
| `/exit` | Quit (or press Ctrl+C) |

---

## Attaching Context with `@`

Reference files, globs, or images right in your prompt and Vexra inlines them automatically:

```text
explain the retry logic in @src/api.js
why do these differ? @src/config.js @test/config.test.js
match this design @mockup.png
refactor everything under @src/*.js
```

Images (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`) are sent as vision input to capable models.
Large files are truncated and a total context cap keeps requests lean.

---

## Supported Providers

Configure any of these with `/provider` (or `--model` / config file). The default model is shown
for reference.

| Provider | Default model | Get a key |
| --- | --- | --- |
| **OpenRouter** | `openai/gpt-4o` | https://openrouter.ai/keys |
| **OpenAI** | `gpt-4o` | https://platform.openai.com/api-keys |
| **Anthropic** | `claude-sonnet-4-20250514` | https://console.anthropic.com/settings/keys |
| **Google (Gemini)** | `gemini-2.5-flash` | https://aistudio.google.com/apikey |
| **Groq** | `llama-3.3-70b-versatile` | https://console.groq.com/keys |
| **DeepSeek** | `deepseek-chat` | https://platform.deepseek.com/api_keys |
| **xAI (Grok)** | `grok-3-latest` | https://console.x.ai |
| **Ollama (local)** | `llama3` | No key needed; runs at `http://127.0.0.1:11434` |
| **Custom** | _your choice_ | Any OpenAI-compatible endpoint |

---

## Configuration

Vexra stores its config and history under `~/.ai-cli/`:

| Path | Purpose |
| --- | --- |
| `~/.ai-cli/config.json` | Saved provider, API key, model, and defaults |
| `~/.ai-cli/history.json` | Auto-saved conversation history |
| `~/.ai-cli/sessions/` | Named sessions from `/session save` |

### Per-project settings

Drop one of these in your project (Vexra searches upward from your working directory):

- **`AGENTS.md`** or **`.ai-cli.md`**: freeform instructions injected into the system prompt
  (project conventions, do's and don'ts, architecture notes).
- **`.ai-cli.json`**: JSON overrides for `model`, `temperature`, `maxTokens`, and similar.

### Environment variables

These override the config file for the current shell:

| Variable | Description |
| --- | --- |
| `OPENROUTER_API_KEY` | API key (used for whichever provider is active) |
| `OPENROUTER_BASE_URL` | API base URL |
| `OPENROUTER_MODEL` | Model ID |
| `OPENROUTER_TEMPERATURE` | Temperature (0-2) |
| `OPENROUTER_MAX_TOKENS` | Max output tokens |

When running **from source**, a `.env` file in the repo root is loaded automatically.

---

## Safety

Vexra asks before applying file writes and edits, and before running shell commands the agent
proposes. A built-in screen flags genuinely destructive operations: recursive force-deletes,
`git push --force` / `reset --hard` / `clean -f`, piping remote scripts into a shell, raw disk
writes, `mkfs`, fork bombs, and power-state changes. Those always require explicit confirmation.
In `--headless` and `/auto` mode tool use is auto-approved, so point those at trusted tasks.

---

## Updating & Uninstalling

**Update** (GitHub install): re-run your install command, for example:

```bash
npm install -g github:TobiasLogic/vexra
```

**Update** (from source):

```bash
git pull && npm install -g .
```

**Uninstall** by package name, regardless of how you installed:

```bash
npm uninstall -g vexra
# or: pnpm rm -g vexra
# or: yarn global remove vexra
# or: bun remove -g vexra
```

---

## License

No license is currently specified for this project. Please contact the author before
redistributing or using it beyond evaluation.

---

*Built for terminal power users.*
