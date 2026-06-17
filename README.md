# Vexra
**The All-Seeing CLI Agent**

Vexra is a powerful, terminal-native AI coding assistant designed to live inside your workflow. It functions autonomously right in your terminal, providing deep codebase context, intelligent tool execution, and CI/CD-ready headless task automation.

![Vexra Demo](https://img.shields.io/badge/Vexra-CLI_Agent-36D0D0?style=for-the-badge)

## Features

- **AST Repo Mapping:** Vexra doesn't just read file names; it uses `acorn` to instantly parse the AST of your JavaScript/TypeScript files, generating a lightning-fast map of where every function and class is defined.
- **Dynamic Modes:** Press `Tab` during input to switch between different agent personalities:
  - `[BUILD]`: Full access to write code and execute commands (Default).
  - `[ARCHITECT]`: System design and analysis restricted to high-level markdown proposals.
  - `[ASK]`: Mentor mode. It answers questions and clarifies concepts without writing code.
- **Autonomous Task Loop (`/auto`):** Type `/auto <prompt>` to kick off an autonomous, self-correcting 100-loop cycle. Great for letting the agent fix a massive bug while you grab coffee.
- **Headless & CI/CD Ready:** Pass the `--headless` flag to run Vexra silently in CI/CD pipelines. It auto-approves all tool usages and exits securely when the goal is met.
- **Auto-Linter Feedback:** When editing `.js` or `.ts` files, Vexra intercepts syntax errors locally (`node --check`) and automatically fixes them before human review.
- **Model Context Protocol (MCP):** Connect external data sources and tools natively via MCP.
- **Model Agnostic:** Out-of-the-box support for OpenRouter, OpenAI, Anthropic, Gemini, Groq, DeepSeek, xAI, and natively connects to local **Ollama** models!

## Installation

You can install Vexra globally via NPM.

### From Source / GitHub
If you have cloned the repository locally:
```bash
npm install -g .
```

If you are installing directly from GitHub:
```bash
npm install -g git+https://github.com/TobiasLogic/vexra.git
```

## Usage

Start Vexra anywhere in your terminal by running:

```bash
vexra
```

### Headless Automation
Pass an initial prompt and the `--headless` flag to bypass interactive prompts and run autonomously:
```bash
vexra "Fix the broken tests in src/api.test.js" --headless
```

### Interactive Commands
Inside the Vexra TUI, you have access to a suite of slash commands:
- `/help` - Show all commands
- `/auto <prompt>` - Run an autonomous agent loop
- `/mode <type>` - Switch role (build, architect, ask)
- `/provider` - Set up provider, API key, and model
- `/models` - Browse and pick models interactively
- `/sh <cmd>` - Run a shell command directly
- `/reset` - Clear the conversation and start fresh
- `/save [file]` - Export the conversation to a markdown file

## Configuration

Configuration and chat history are saved in your home directory at `~/.ai-cli/config.json`.
You can add project-specific overrides by creating an `.ai-cli.json` file in the root of your workspace!

---
*Built for terminal power users.*
