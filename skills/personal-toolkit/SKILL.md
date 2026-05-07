---
name: personal-toolkit
description: 
---


# Jake's Personal CLI Toolkit

A system of self-contained UV scripts at `~/.local/bin/` that share a semantic memory
layer in Postgres (Neon). Every tool logs to JSONL and embeds its interactions into a
shared vector space, making all past work searchable by meaning.

## The Tools

Run any tool with `--help` for full flag reference. This skill covers **when and how** to use them together.

| Tool | What it does | Default model |
|---|---|---|
| `gemini` | Text, image, and video generation from the terminal | `pro` (text), `flash-image`, `veo-fast` |
| `ask` | Send any file or folder to Gemini with a question | `flash-lite` |
| `yt` | Pull YouTube transcript → Gemini analysis | `flash-lite` |
| `scrape-docs` | Recursively crawl a docs site into markdown | n/a |
| `recall` | Semantic search across all past interactions + vault | n/a |
| `seed-vault` | Batch-embed Obsidian vault notes into the vector DB | n/a |

See the `gemini-cli` skill for detailed model selection guidance (Pro vs Flash Lite vs image vs video).

## The Shared Memory Layer

Every `ask`, `yt`, and `gemini` call automatically:
1. Logs to `~/.local/share/gemini/history.jsonl` (JSONL — append-only structured log)
2. Embeds the prompt+response into Postgres via `recall --store` (768-dim vectors via `gemini-embedding-2-preview`)
3. For `ask`: also saves the full interaction to Obsidian at `dump/ask/` and links from the daily note

This means `recall` searches across everything — vault notes, past `ask` analyses, `yt` video summaries, `gemini` conversations — ranked by semantic similarity.

### Multimodal Embeddings

The system uses `gemini-embedding-2-preview` which natively embeds text, images, audio, video, and PDFs into the same vector space. When `ask` processes an image or a folder containing images, the images are embedded natively (not as text descriptions). This means you can search for an image by describing what it contains.

## How to Use `recall` (Semantic Search)

```bash
recall webhook retry pattern              # search by meaning
recall --source vault GHL automation       # filter to vault notes only
recall --source ask authentication flow    # filter to past ask interactions
recall --source yt product strategy        # filter to YouTube analyses
recall --limit 10 cold email sequences     # more results
recall --json search terms                 # structured output for scripts
recall --stats                             # show database size and breakdown
```

**When to use recall as an agent:**
- Before starting any task, check if Jake has already explored this topic: `recall <topic>`
- When Jake asks "what do I know about X" or "didn't I already look at this" — use recall
- When you need context from a previous session — recall surfaces it by meaning
- When building something new, check for prior art: `recall <what you're about to build>`

## How to Use `ask`

```bash
ask file.py what does this do              # single file
ask ./src what security issues exist       # whole folder (recursive, mixed content)
ask report.pdf extract the key terms       # PDF
ask screenshot.png what error is this      # image
ask ./project                              # auto-summarize (no prompt needed)
ask file.py explain this --no-save         # skip Obsidian save for throwaway questions
ask file.py explain this -m pro            # use Pro model for complex analysis
```

**Folder mode details:**
- Scans recursively, skips `.git`/`node_modules`/etc.
- Text files get a manifest + concatenated content (500KB budget)
- Images (up to 6) are sent inline to Gemini for visual analysis
- Each media file gets its own native multimodal embedding
- README files are prioritized first for project context

## How to Use `yt`

```bash
yt VIDEO_ID summarize the key points       # video ID + prompt (no quotes needed)
yt VIDEO_ID -m pro deep analysis            # use Pro for complex reasoning
yt VIDEO_ID                                 # just print raw transcript (no AI)
```

**Important:** Always pass the 11-character video ID, not the full URL. The `?` and `&` in YouTube URLs break in zsh. Copy the ID from after `v=` in the URL.

## How to Use `seed-vault`

```bash
seed-vault                    # embed new + changed vault notes only (deduped)
seed-vault --dry-run          # preview what would change
seed-vault --dir Knowledge    # only process one directory
seed-vault --force            # re-embed everything, ignore hashes
```

Run this after refactoring the Obsidian vault. It detects new notes, changed notes (via content hash), and deleted notes — only re-embeds what changed.

## Composable Patterns

The tools chain naturally because they follow Unix conventions (args in, text out):

```bash
# Scrape docs, then ask about them
scrape-docs https://api.example.com/docs --out api-docs
ask ./api-docs what authentication methods are supported

# Analyze a YouTube video, then search for related vault knowledge
yt VIDEO_ID extract all the frameworks mentioned
recall frameworks for sales automation

# Search recall, pipe results to gemini for synthesis
recall --json GHL webhook patterns | gemini "synthesize these into a decision framework"
```

## Infrastructure

- **Vector DB:** Neon Postgres with pgvector (`embeddings` table, 768-dim vectors)
- **Embedding model:** `gemini-embedding-2-preview` (multimodal — text, images, audio, video, PDF in same space)
- **JSONL log:** `~/.local/share/gemini/history.jsonl`
- **Obsidian vault:** `/home/jfloyd/obsidian-vault` (ask interactions saved to `dump/ask/`)
- **API key:** `GEMINI_API_KEY` in `~/.secrets`
- **DB connection:** `NEON_DATABASE_URL` in `~/.secrets`
