---
name: mcp-to-cli
description: Convert an MCP server, OpenAPI spec, or REST API into a fast, standalone local Python CLI. Make sure to use this skill whenever the user asks to "make a CLI for this MCP", "bypass MCP", "turn this API into a CLI", "create a terminal wrapper", or "generate a git repo for this tool" so they can operate directly from the shell.
---

# MCP to CLI Converter

You help the user convert a heavy or constrained MCP server (or raw OpenAPI spec) into a fast, standalone, `uv`-backed Python CLI packaged in a pristine GitHub repository.

## The Philosophy
MCPs are great for AI, but humans often want direct terminal control without AI overhead. A good CLI provides:
1. **Raw API parity:** 1:1 mapping of REST endpoints to CLI commands (the escape hatch).
2. **Workflow helpers:** High-level, opinionated commands for common daily tasks (e.g., `workflow task-create`).
3. **Schema Awareness:** Local config aliases so humans type recognizable names instead of raw UUIDs.
4. **Safety & Env:** `--dry-run` support and zero-dependency `.env` loading.

## Step-by-Step Process

### 1. Analyze the Source
- If targeting an existing MCP, look at `~/.claude.json` to find the server configuration and environment variables.
- Locate the OpenAPI spec, SDK docs, or server source code.
- Identify Auth mechanisms (Bearer tokens, API keys) and Base URLs.
- Map out the core endpoints, data structures, and pagination schemas.

### 2. Generate the CLI Script
Create a single-file Python script (`<name>_cli.py`) using `uv` inline metadata.
- **Header:** `#!/usr/bin/env -S uv run --script`
- **Dependencies:** `httpx>=0.27.0` (and standard library `argparse`, `json`, `os`, `sys`).
- **Core functions:** Implement `load_dotenv_files()`, `request()` (must intercept and print if `--dry-run` is true), and `load_config()`.
- **CLI Structure:**
  - `request`: A raw HTTP escape hatch.
  - Resource groups: Subparsers matching the API (e.g., `users`, `pages`, `search`).
  - `workflow`: Subparsers for multi-step or opinionated human actions.
  - `schema` / `inspect`: Commands for auto-detecting fields and inspecting remote schema.
  - `shortcuts`: Commands to list local config aliases.

### 3. Scaffold the Project
Create a dedicated directory and populate it:
- `README.md`: Document setup, global flags, raw commands, workflows, and payload examples.
- `.env.example`: Template for required tokens.
- `<name>.config.example.json`: Example for workspace shortcuts/aliases.
- `install.sh`: Bash script to create an executable wrapper in `~/.local/bin/`.
- `Justfile` or `Makefile`: Recipes for testing, installation, and help.
- `examples/`: Directory with 2-3 `.json` payload files for testing `--body-file` arguments.
- `.gitignore`: Ignore `.env`, `.venv`, `__pycache__`, and local `.json` config files.

### 4. Git & GitHub
- Initialize the repo: `git init && git add . && git commit -m "Initial commit"`
- Create the remote: `gh repo create <org>/<name> --private --source=. --push`

### 5. Validate
- Run `uv run <name>_cli.py --help`
- Run a `--dry-run` workflow command using a generated payload.
- Run a live read-only command (if safe and a token is available in `.claude.json`).
