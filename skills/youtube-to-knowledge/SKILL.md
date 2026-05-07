---
name: youtube-to-knowledge
description: Lightweight YouTube-to-notes workflow. Use when the user wants to learn from a YouTube video, summarize it, extract implementation ideas, or save useful takeaways into the Obsidian vault. Keep it simple: fetch transcript/content, identify actionable ideas, connect only to obviously relevant notes, and avoid large research pipelines unless explicitly requested.
---

# YouTube to Knowledge

## Purpose

Turn a video into useful notes or implementation ideas without overbuilding a knowledge graph.

## Default workflow

1. **Fetch the video content**
   Use the available content/transcript extraction tool. Pass the user's specific question as the prompt when available.

2. **Identify the intent**
   - Summary only?
   - Implementation ideas?
   - Save to vault?
   - Compare against current project/repo work?

3. **Extract the useful parts**
   Focus on:
   - Core thesis
   - Concrete tactics
   - Examples worth copying
   - Warnings / anti-patterns
   - Open questions

4. **Connect lightly**
   Search the vault only for directly relevant terms. Do not run a broad synthesis unless asked.

5. **Write or report**
   If saving to the vault, create a concise note with source URL and date.

## Note template

```md
---
type: video-note
source: "YouTube URL"
created: YYYY-MM-DD
tags: []
---

# Video Title

## Why this matters

## Key ideas

## Useful tactics

## Application to current work

## Links
```

## Guardrails

- Do not launch a multi-agent research process by default.
- Do not create many new notes from one video unless the user asks.
- Do not force old vault categories onto new notes.
- Prefer actionable takeaways over exhaustive transcript summaries.
