---
name: obsidian-cli
description: 
---


# Obsidian CLI Master Skill

Two CLIs are available for vault operations. Always detect which is active before running commands.

## CLI Detection (Run First)

```bash
# Check which CLI is available
if [[ -f "/mnt/c/Program Files/Obsidian/Obsidian.com" ]]; then
  echo "Official CLI available — use: obsidian <cmd>"
else
  echo "Official CLI NOT available — use: notesmd-cli <cmd>"
fi
```

**Rule of thumb:**
- `obsidian` command = official CLI (requires Obsidian app running + Catalyst license)
- `notesmd-cli` / `nmd` = community CLI (always works, no app required)

### CRITICAL: Claude Code Shell Sessions — $OBSIDIAN_COM Not Set

The `obsidian` zsh function relies on `$OBSIDIAN_COM` being set (defined in `.zshrc`). Claude Code shell snapshots do **not** source `.zshrc`, so `$OBSIDIAN_COM` is empty and the function silently falls back to `notesmd-cli` even though the binary exists.

**Always prefix obsidian commands with the variable inline:**

```bash
OBSIDIAN_COM="/mnt/c/Program Files/Obsidian/Obsidian.com" obsidian <cmd>
```

Example:
```bash
OBSIDIAN_COM="/mnt/c/Program Files/Obsidian/Obsidian.com" obsidian daily:append content="- My note"
```

---

## Tool 1: Official Obsidian CLI (v1.12) — PREFERRED when available

**When to use:** Obsidian is open, Catalyst license obtained, `Obsidian.com` placed in install dir.
**Superpower:** Queries Obsidian's internal indexes — 6,000×–70,000× more token-efficient than file scanning.

### Installation Status

```
Obsidian.exe: ✅ /mnt/c/Program Files/Obsidian/Obsidian.exe
Obsidian.com: ✅ /mnt/c/Program Files/Obsidian/Obsidian.com (v1.12.4, ACTIVE)
```

**To complete setup:**
1. Buy Catalyst ($25): obsidian.md → Account → Catalyst → Insider tier
2. Enable insider builds: Obsidian Settings → General → Account → "Receive insider builds" → ON
3. Get badge: obsidian.md/account → Catalyst → "Get Discord badge" → join Obsidian Discord
4. Download `Obsidian.com` from `#insider-desktop-release` channel
5. Place `Obsidian.com` in: `C:\Users\Jfloy\AppData\Local\Programs\Obsidian\`
6. Enable CLI: Obsidian Settings → Command line interface → Toggle ON

**Critical WSL note:** Never run from admin terminal — causes silent failure. Use `Win+R → powershell`.

### Official CLI Commands

```bash
# Verify
obsidian version
obsidian help

# Vault info
obsidian vault
obsidian files total
obsidian tags all

# Search (uses Obsidian's pre-computed FTS index — not grep)
obsidian search "kubernetes"
obsidian search content "cold email"
obsidian search path "07_Solutions"
obsidian search --vault "Obsidian Vault" "topic"

# Backlinks & graph
obsidian backlinks "note-name"
obsidian orphans

# Daily notes
obsidian daily:prepend "- Note content"

# File CRUD
obsidian files list
obsidian files read "path/to/note"
obsidian files write "path/to/note" "content"

# Frontmatter / properties
obsidian properties read "note-name"
obsidian properties set "note-name" "key" "value"

# Tasks
obsidian tasks all
obsidian tasks pending

# Templates
obsidian templates list
obsidian templates apply "template-name" "target-note"

# Plugins
obsidian plugins list
obsidian plugins versions

# JavaScript execution inside Obsidian (KILLER FEATURE)
obsidian dev:eval "script.js"

# TUI mode (interactive navigator)
obsidian   # no args
```

### `dev:eval` Examples (JavaScript inside Obsidian)

```javascript
// Get all notes tagged #wholesaler
const files = app.vault.getMarkdownFiles()
  .filter(f => app.metadataCache.getFileCache(f)?.frontmatter?.tags?.includes('wholesaler'));
return files.map(f => f.path);

// Get all backlinks for a note
const cache = app.metadataCache.resolvedLinks;
const targetFile = "07_Solutions/developer-tools/obsidian-cli.md";
return Object.entries(cache)
  .filter(([src, links]) => targetFile in links)
  .map(([src]) => src);

// Find orphan notes (no incoming links)
const allFiles = app.vault.getMarkdownFiles().map(f => f.path);
const linked = new Set(Object.values(app.metadataCache.resolvedLinks).flatMap(Object.keys));
return allFiles.filter(f => !linked.has(f));
```

---

## Tool 2: NotesMD CLI (Community, Headless) — ALWAYS AVAILABLE

**Location:** `~/.local/bin/notesmd-cli` (also aliased as `nmd`)
**Version:** v0.3.1
**When to use:** Obsidian app not running, headless scripting, CI pipelines, quick vault ops.

### Default Vault

```
Name: Obsidian Vault
Path: /mnt/c/Users/Jfloy/OneDrive/Documents/Obsidian Vault
Open type: obsidian
```

### NotesMD CLI Commands

```bash
# Vault info
notesmd-cli print-default
notesmd-cli list                          # list root dirs
notesmd-cli list "07_Solutions"           # list specific folder (positional arg, no --path)

# Read/print notes
notesmd-cli print "note-name"
notesmd-cli print "07_Solutions/developer-tools/obsidian-cli"

# Search
notesmd-cli search                        # fuzzy interactive search
notesmd-cli search-content "cold email"   # grep-style content search

# Create notes
notesmd-cli create "New Note Name"
notesmd-cli create "07_Solutions/my-note" --content "# Title\n\ncontent here"

# Move/rename
notesmd-cli move "old-note" "new-note"

# Delete
notesmd-cli delete "note-name"

# Frontmatter operations
notesmd-cli frontmatter "note-name" --print
notesmd-cli frontmatter "note-name" --edit --key "status" --value "active"
notesmd-cli frontmatter "note-name" --delete --key "old-field"

# Open in Obsidian (GUI)
notesmd-cli open "note-name"

# Daily note
notesmd-cli daily

# Use specific vault (override default)
notesmd-cli list --vault "Other Vault"
```

---

## When to Use Which

| Task | Official CLI | NotesMD CLI | Native Tools |
|------|-------------|-------------|-------------|
| Search by tag/content | ✅ Best (index) | OK (slower) | ❌ Very slow |
| Backlink mapping | ✅ Best | ❌ Not supported | ⚠️ Via grep |
| Frontmatter queries | ✅ Best | ✅ Good | ⚠️ Via grep |
| Orphan detection | ✅ Best | ❌ Not supported | ❌ Extremely slow |
| Read note content | ✅ | ✅ | ✅ Read tool |
| Create/write notes | ✅ | ✅ | ✅ Write tool |
| Obsidian not running | ❌ | ✅ | ✅ |
| Headless/script | ❌ | ✅ | ✅ |

---

## Token Efficiency Reference (1,500-note vault)

| Operation | File Tools | NotesMD CLI | Official CLI |
|-----------|-----------|------------|-------------|
| Find tagged notes | ~1,200,000 tokens | ~50,000 tokens | ~200 tokens |
| Map backlinks | ~50,000 tokens | N/A | ~150 tokens |
| Full-text search | ~1,200,000 tokens | ~50,000 tokens | ~200 tokens |
| Orphan detection | ~7,000,000 tokens | N/A | ~100 tokens |

---

## Vault Reference

- **Vault path (WSL):** `/home/jfloyd/obsidian-vault` (symlink)
- **Vault path (Windows):** `C:\Users\Jfloy\OneDrive\Documents\Obsidian Vault`
- **Vault name:** `Obsidian Vault`
- **Official CLI note:** `07_Solutions/developer-tools/obsidian-cli.md`

## Critical Gotchas (discovered 2026-02-27)

| Gotcha | Fix |
|--------|-----|
| `eval` bare `return` fails | Wrap in IIFE: `(()=>{...})()` |
| `getBacklinksForFile()` returns `{data:[]}` | Use `resolvedLinks` traversal instead |
| `cachedRead()`/`read()` are async | Use `read file=<name>` CLI command for content |
| `tasks path=<folder>` doesn't work for folders | Use `format=json` + Python filtering |
| `unresolved verbose format=json` combo fails in WSL2 | Use without `verbose` or without `format=json` |
| `dev:screenshot path="/tmp/..."` fails | Use Windows path: `C:/Users/Jfloy/AppData/Local/Temp/` |
| `dev:console` returns error without debugger | Run `dev:debug on` first |
| `history:list` with `$OBSIDIAN_COM` var causes zsh colon error | Use literal path in that command |
| Claude Code shell: `$OBSIDIAN_COM` not set → falls back to notesmd-cli | Prefix every call: `OBSIDIAN_COM="/mnt/c/Program Files/Obsidian/Obsidian.com" obsidian <cmd>` |
| `prepend` inserts after frontmatter, not byte 0 | Expected behavior — frontmatter stays intact |
| `property:set type=list value="a,b,c"` | Comma-separated input → stores as YAML array |
| Obsidian Sync NOT configured | Only local File Recovery (`history:*`) is available |
| Template folder not configured | `templates` returns error — set via Settings → Templates |
| `base:views` requires file open first | Run `open file=<name>` before `base:views` |
| `file=` uses fuzzy wikilink resolution | Use `path=` in all automation scripts for reliability |

## Vault Intelligence (live data 2026-02-27)

- **240 files**, 39 folders, 5.6MB
- **Top hub note:** `hyper-automation-knowledge-index.md` (85 inbound links)
- **405 pending tasks**, 16 done across vault
- **23 broken wikilinks** — biggest gap: `10_Growth-Engine/referral-system` (5 refs)
- **54 orphan notes** — mostly `dump/Clippings/`
- **2 installed plugins:** Copilot v3.2.0, Local REST API v3.4.3
- **Top tags:** `#reference` (34), `#cold-email` (29), `#claude-code` (28)

## CLI Knowledge Base Notes (07_Solutions/obsidian-cli/)

- `knowledge-graph.md` — backlinks, orphans, resolvedLinks, hub detection
- `search-and-discovery.md` — FTS, tags, properties, path-scoped search
- `obsidian-bases.md` — Bases database layer, filter syntax, base:query
- `eval-api.md` — app object, metadataCache API, 14 eval snippets
- `task-management.md` — tasks commands, per-client tracking, standup bot
- `content-automation.md` — append, daily notes, property:set, create workflows
- `history-sync-devtools.md` — file recovery, dev tools, workspace navigation

## Related Notes

- [[obsidian-cli]] — detailed reference with benchmarks
- [[cli-vs-mcp-token-efficiency]] — token efficiency comparison

## Sources

- [Obsidian Help — Official CLI](https://help.obsidian.md/cli)
- [NotesMD CLI GitHub](https://github.com/Yakitrak/notesmd-cli)
- [Obsidian v1.12.4 Changelog](https://obsidian.md/changelog/2026-02-27-desktop-v1.12.4/)
- [Windows Setup Guide](https://zenn.dev/sora_biz/articles/obsidian-cli-setup-guide?locale=en)
