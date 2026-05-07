---
name: uv-scripts
description: 
---


# UV Inline Dependency Scripts

## Why this pattern matters

Most Python scripts die in one of two ways: they rot because nobody remembers which virtualenv they belong to, or they never get shared because setup instructions are a paragraph long. UV inline scripts solve both problems by embedding everything the script needs — dependencies, Python version, metadata — inside the script itself.

The result: a single file that anyone (or any agent) can run with `uv run script.py` and it just works. No venv, no requirements.txt, no setup. The file IS the tool.

This isn't just convenient — it unlocks a composable personal toolkit pattern where each script is a building block you can chain, alias, and reuse across every project.

## The foundational pattern

### PEP 723 inline metadata

Dependencies live in a special comment block at the top of the script:

```python
# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "httpx",
#     "beautifulsoup4",
# ]
# ///
```

UV reads this block, creates an ephemeral environment with exactly these packages, runs the script, and tears it down. No side effects on the system. The cache makes repeat runs instant.

### The shebang that makes it a real CLI tool

```python
#!/usr/bin/env -S uv run --script
```

This line turns any `.py` file into a directly executable command. After `chmod +x`, it behaves identically to a compiled binary — users don't even need to know it's Python.

The `-S` flag passes the rest of the line as arguments to `env`, which is needed because shebangs normally only accept one argument. This is the standard portable way to do it.

### The ~/.local/bin install pattern

Drop the executable script into `~/.local/bin/` (which is on PATH for most Linux/macOS setups) and it becomes a global command:

```bash
# "Install" a UV script as a CLI tool
cp my-tool.py ~/.local/bin/my-tool
chmod +x ~/.local/bin/my-tool

# Now it works everywhere
my-tool --help
```

No package publishing, no pip install, no brew formula. The script IS the distribution.

## Anatomy of a well-built UV script

```python
#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "httpx",
#     "rich",
# ]
# ///
"""One-line description of what this does."""

import argparse
import sys

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="What the tool does")
    p.add_argument("input", help="The primary input")
    p.add_argument("--out", "-o", help="Output location (default: auto)")
    p.add_argument("--flag", action="store_true", help="Toggle a behavior")
    return p.parse_args()

def main() -> None:
    args = parse_args()
    # ... core logic ...

if __name__ == "__main__":
    main()
```

Key properties:
- **Self-documenting**: docstring + argparse `--help` tell you everything
- **Portable**: works on any machine with `uv` installed, nothing else needed
- **Safe defaults**: auto-generates output paths, never silently overwrites
- **Composable**: reads from args/stdin, writes to files/stdout — chains with pipes and `&&`

## Composable patterns this unlocks

### Pattern 1: Personal CLI toolkit

Each tool does one thing well. They compose at the shell level:

```bash
# Scrape docs, then use another tool to summarize them
scrape-docs https://fastapi.tiangolo.com/reference/ --out fastapi-ref
summarize-docs ./fastapi-ref --format outline > fastapi-cheatsheet.md
```

Because each tool is a single file with inline deps, there are zero conflicts — one tool can use `httpx` while another uses `requests`, each in its own ephemeral env.

### Pattern 2: Project-local scripts

Keep UV scripts in a project's `scripts/` directory for project-specific automation:

```
my-project/
├── scripts/
│   ├── seed-db.py        # uv run scripts/seed-db.py
│   ├── generate-types.py # uv run scripts/generate-types.py
│   └── deploy.py         # uv run scripts/deploy.py
├── src/
└── ...
```

These check into git and any contributor can run them immediately — no "first install the dev dependencies" step.

### Pattern 3: Pipeline composition

UV scripts can call other UV scripts. A pipeline orchestrator can shell out to specialized tools:

```python
subprocess.run(["scrape-docs", url, "--out", work_dir], check=True)
subprocess.run(["process-markdown", work_dir, "--format", "jsonl"], check=True)
```

Each step is independently testable, replaceable, and has its own deps.

### Pattern 4: Agent tool creation

When building tools for AI agents (MCP servers, Claude Code skills, n8n workflows), UV scripts are ideal because:
- The agent can `uv run` them without environment setup
- Dependencies are explicit and auditable in the script header
- Scripts are single-file, easy to read/modify/debug
- No state leaks between runs

## Hardening checklist

When building UV scripts that will be reused, verify these from first principles:

1. **Path safety** — if user input becomes part of a file path, resolve it and verify it stays within the expected directory. `Path.resolve()` + startswith check.
2. **Sensible defaults** — auto-generate output names from input when `--out` isn't specified. Never require the user to think about where to put output.
3. **Idempotency** — warn (don't crash) if output already exists. Add `--force` for intentional overwrites.
4. **Graceful failure** — catch network errors, missing files, bad input per-item rather than crashing the whole run. Report what was skipped at the end.
5. **Rate limiting** — any tool that makes network requests should have a `--delay` flag, defaulting to 0 but available when needed.
6. **No silent data loss** — if a step could lose data (overwrite, delete), confirm or warn.
7. **Identity checks** — test boolean logic correctly (`not x.startswith()` not `x.startswith() is False`).

## Jake's existing UV tools

These are installed globally at `~/.local/bin/`. Run any with `--help` for full usage. Some have dedicated skills with deeper docs — check the skills list.

- **`scrape-docs`** — Recursively crawl a docs site into organized markdown files. `scrape-docs <url> [--out <dir>] [--prefix <path>] [--depth <n>]`
- **`gemini`** — Unified Gemini API CLI: text, image, and video generation. See the `gemini-cli` skill for full docs.
- **`yt`** — Pull a YouTube transcript and optionally send it to Gemini with a prompt. `yt <video_id> summarize this`
- **`ask`** — Send any file or folder to Gemini (code, PDF, images, CSV, JSON, text). `ask report.pdf what are the key findings`
- **`recall`** — Semantic memory layer: search all past tool interactions + vault by meaning. `recall webhook retry pattern`
- **`seed-vault`** — Batch-embed Obsidian vault notes into vector DB with dedup. `seed-vault` (re-run after vault changes)

For how these tools compose as a system (shared embedding layer, when to use what), see the `personal-toolkit` skill.

## When building new UV scripts

1. Start with the shebang + inline metadata block
2. Use `argparse` for CLI args — even if there's only one argument today, it makes `--help` work and future flags are trivial to add
3. Put the script in `~/.local/bin/` if it's a general-purpose tool, or in the project's `scripts/` if it's project-specific
4. Test the `--help` output reads clearly — that's the documentation
5. Default to creating output in a new directory rather than polluting the current one
6. Consider what happens when the tool is run twice — will it crash, overwrite, or handle it gracefully?
