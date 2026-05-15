# Covent Apify MCP setup for Pi

Pi is wired to Apify's hosted MCP endpoint (`https://mcp.apify.com`) through `pi-mcp-adapter`, with a narrow whitelist of four read-only Actors so credits and surface area stay bounded.

## Whitelisted Actors

The repo `.mcp.json` pins the apify server URL to `?tools=` plus these four Actors. The Apify MCP server only exposes the Actors named in the query string; everything else is unreachable from Pi until the whitelist is changed in a tracked commit.

| Actor | Purpose | Notes on cost / inputs |
|---|---|---|
| `xtdata/twitter-x-scraper` | X/Twitter post + profile scraping | Per-result pricing; cap `maxItems` in every call. |
| `automation-lab/youtube-transcript` | YouTube transcript extraction (captions, no audio download) | Free-tier eligible for most public videos. Returns raw transcript text. |
| `benthepythondev/spotify-podcast-scraper` | Spotify episode metadata + audio URL discovery | Returns metadata and a direct MP3 URL; does **not** transcribe. |
| `vittuhy/audio-and-video-transcript` | Whisper-based transcription of arbitrary audio/video URLs | Caller must pass an `openaiApiKey` field in the Actor input (per-Actor secret, separate from the MCP bearer). |

The Spotify → transcript pipeline is two hops: call `benthepythondev/spotify-podcast-scraper` first to get the `audio_url`, then pass that URL to `vittuhy/audio-and-video-transcript`. Always pre-check episode length before sending to Whisper — long episodes burn OpenAI credits fast.

## Token provisioning

Apify's MCP accepts a personal API token over `auth: "bearer"`. We use a token, not OAuth, to avoid an interactive `/mcp-auth apify` step on every cold-boot Railway container.

1. In Apify Console → **Settings → Integrations → API & Integrations**, create a token labeled `covent-pi-mom` (so it can be revoked independently of personal tokens).
2. Grant the token the default scope — Apify tokens don't have per-Actor ACLs, so treat this as full-account access and keep it out of any shared surface.
3. Store the value as `APIFY_TOKEN`:
   - **Railway**: `railway variables --service covent-pi-mom --set APIFY_TOKEN=apify_api_...` — never paste the literal token into chat, git, logs, or screenshots.
   - **Local dev**: a per-launch wrapper that pulls from 1Password / `op` / macOS Keychain, or an untracked `.env.local` (`0600`) sourced only by the Pi launch wrapper. Never commit it.
4. Rotate the token on a 90-day cadence (or immediately on any suspected exposure). Revocation is one click in Apify Console.

Apify's free tier ships with $5/month of credits; this is enough for a few hundred Twitter scrapes or a dozen Whisper transcriptions of short clips, but a single long podcast can blow through it. Set a hard usage cap in Apify Console (**Billing → Usage limit**) before pointing prod traffic at it.

## How the wiring works

`pi-mcp-adapter` reads MCP server configs from, in precedence order:

1. `~/.config/mcp/mcp.json` (user-global)
2. `${PI_AGENT_DIR}/mcp.json` (Pi global override — Railway target, seeded from `PI_MCP_JSON_B64` on cold boot)
3. `.mcp.json` at the repo root (project shared — **where the apify entry lives**)
4. `.pi/mcp.json` (Pi project override; gitignored)

For local dev the repo `.mcp.json` is sufficient — the adapter picks it up directly. For Railway, the active config is whatever `PI_MCP_JSON_B64` seeds into `${PI_AGENT_DIR}/mcp.json`; that file shadows the repo `.mcp.json`. If you set `PI_MCP_JSON_B64`, you must include the apify server entry in that base64 blob, otherwise it disappears in prod.

The canonical entry is:

```json
{
  "mcpServers": {
    "apify": {
      "url": "https://mcp.apify.com?tools=xtdata/twitter-x-scraper,automation-lab/youtube-transcript,benthepythondev/spotify-podcast-scraper,vittuhy/audio-and-video-transcript",
      "auth": "bearer",
      "bearerTokenEnv": "APIFY_TOKEN",
      "lifecycle": "lazy"
    }
  }
}
```

`lifecycle: "lazy"` means the adapter only opens the streaming-HTTP connection on the first Apify tool call, so runs that don't use Apify pay no startup cost and don't even need `APIFY_TOKEN` to be set.

## Local preflight

After setting `APIFY_TOKEN` and pulling the repo `.mcp.json`, restart Pi if it was already running (the adapter reads the config at session start). Quick sanity check that the bearer is reachable:

```bash
curl -sS -X POST https://mcp.apify.com \
  -H "Authorization: Bearer $APIFY_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | head -c 400
```

A 200 with a JSON-RPC envelope listing four `tools/*` entries means the whitelist is live. A 401 means the token is wrong; a 200 with an empty tools list means the `?tools=` query string was dropped (most often by an over-eager URL rewriter).

## Railway rollout

1. Confirm the apify entry is present in the base64 blob you're about to push: `printf %s "$PI_MCP_JSON_B64" | base64 -d | jq '.mcpServers | keys'` should include `"apify"` alongside `"slack"`.
2. `railway variables --service covent-pi-mom --set APIFY_TOKEN=...` and `--set PI_MCP_JSON_B64=...` (the latter only if you're regenerating it; otherwise leave the existing value alone).
3. Trigger a deploy by merging to `main` — do **not** `railway up` from a local checkout.
4. After deploy, confirm Pi can resolve the server: from a Slack thread, `@covent_pi list mcp servers` (or whatever the registered diagnostic surface is on the day you read this) should include `apify` with status `lazy / not yet connected`.

## Guardrails

- **Do not** broaden the `?tools=` whitelist via env-var overrides at runtime. The whitelist is part of the URL, so any change must land in a tracked commit and pass review.
- **Do not** wire any Apify Actor with side effects (anything that posts, uploads, or modifies state) into the whitelist without an explicit threat-model review. Today's four are all read/extract Actors.
- **Cap Actor inputs.** Every call should pass `maxItems`, `maxResults`, or the Actor's equivalent cap. The MCP layer cannot enforce this — the agent and skill prompts must.
- **Watch credits.** Apify's usage dashboard is the source of truth; set up the email alert at 80% of the monthly cap so we catch runaway scrapes before they exhaust the budget.
- **Whisper input secret.** The `vittuhy/audio-and-video-transcript` Actor expects an OpenAI key inside its per-call input, **not** as an MCP bearer. Pass `OPENAI_API_KEY` through from env into the Actor input at call time — never hard-code it into a skill manifest or commit it alongside fixtures.
