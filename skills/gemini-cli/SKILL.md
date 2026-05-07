---
name: gemini-cli
description: 
---


# Gemini CLI

A single command (`gemini`) that wraps Google's Gemini API for text, image, and video generation. Installed at `~/.local/bin/gemini`. Requires `GEMINI_API_KEY` env var (stored in `~/.secrets`).

## Quick reference

```bash
# Text (default subcommand — bare prompt works)
gemini "Explain quantum entanglement"
gemini "Be brief" -m flash-lite
gemini "Translate to Spanish" -s "You are a translator"
echo "long document..." | gemini -
gemini "Count to 5" --no-stream

# Images
gemini image "A cyberpunk city at sunset" --aspect 16:9
gemini image "A logo for Goose Tech" --size 2K -m pro-image
gemini image "Make the sky purple" -i photo.jpg          # editing

# Video (polls until done, downloads .mp4)
gemini video "Drone shot over a mountain lake at dawn"
gemini video "Product rotating on pedestal" -i product.png --duration 8

# Info
gemini models           # show aliases
gemini models -v        # also list all models from API
```

## Models

| Alias | Full model ID | Use for |
|---|---|---|
| `pro` | gemini-3.1-pro-preview | Complex reasoning, coding, long context (default for text) |
| `flash-lite` | gemini-3.1-flash-lite-preview | Fast + cheap, good for simple tasks |
| `flash-image` | gemini-3.1-flash-image-preview | Image generation + editing (default for image) |
| `pro-image` | gemini-3-pro-image-preview | Higher quality images, 4K support |
| `veo` | veo-3.1-generate-preview | Best video quality, slower |
| `veo-fast` | veo-3.1-fast-generate-preview | Faster video generation (default for video) |

Pass any alias or a full model ID to `--model` / `-m`. To use a model not in this table, pass the full ID directly (e.g., `-m gemini-2.5-flash`).

## When to use which model

- **Quick questions, summaries, simple tasks** → `flash-lite` (cheapest, fastest)
- **Complex reasoning, code generation, analysis** → `pro` (default, most capable)
- **Fast image generation** → `flash-image` (default for images)
- **High-quality / 4K images** → `pro-image`
- **Quick video clips** → `veo-fast` (default for video)
- **Cinematic quality video** → `veo`

## Flags

### Text
| Flag | Description |
|---|---|
| `-m`, `--model` | Model alias or full ID |
| `-s`, `--system` | System instruction |
| `-t`, `--temperature` | Temperature 0-2 |
| `--max-tokens` | Max output tokens |
| `--no-stream` | Disable streaming (default: streams) |
| `-v`, `--verbose` | Show token usage |

### Image
| Flag | Description |
|---|---|
| `-m`, `--model` | Model alias or full ID |
| `-i`, `--input` | Input image for editing |
| `-o`, `--out` | Output directory (default: cwd) |
| `--aspect` | Aspect ratio: `1:1`, `16:9`, `4:3`, `9:16` |
| `--size` | Image size: `512`, `1K`, `2K`, `4K` |

### Video
| Flag | Description |
|---|---|
| `-m`, `--model` | Model alias or full ID |
| `-i`, `--input` | Reference image |
| `-o`, `--out` | Output directory (default: cwd) |
| `--aspect` | Aspect ratio: `16:9`, `9:16`, `1:1` |
| `--duration` | Duration in seconds |
| `--resolution` | `720p` or `1080p` |

## Composable patterns

The `gemini` CLI reads from stdin and writes to stdout/files, so it chains naturally:

```bash
# Summarize a file
cat README.md | gemini - -s "Summarize this in 3 bullets"

# Generate an image then use it as a video reference
gemini image "Mountain landscape" -o /tmp/ref
gemini video "Camera slowly panning across landscape" -i /tmp/ref/gemini-image-1.jpg

# Batch process
for topic in "quantum physics" "black holes" "dark matter"; do
  gemini "Write a one-paragraph explainer on: $topic" --no-stream >> explainers.md
done
```

## API details (for extending or debugging)

The tool hits these endpoints:
- **Text**: `POST /v1beta/models/{model}:generateContent` (or `:streamGenerateContent?alt=sse`)
- **Image**: `POST /v1beta/models/{model}:generateContent` with `responseModalities: ["TEXT", "IMAGE"]`
- **Video**: `POST /v1beta/models/{model}:predictLongRunning` → poll operation → download

Base URL: `https://generativelanguage.googleapis.com/v1beta`
Auth: `x-goog-api-key` header with `GEMINI_API_KEY`

The tool source is at `~/.local/bin/gemini` — a self-contained UV script (httpx + rich). Read it directly if you need to modify behavior or add new models.
