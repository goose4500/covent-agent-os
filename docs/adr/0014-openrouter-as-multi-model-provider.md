# ADR 0014: OpenRouter as multi-model provider for flexible model access

Date: 2026-05-16
Status: accepted
Related: ADR 0013 (X post fetch tool, xAI/Twitter API distinction), ADR 0007 (Polaris assistant surface)

## Context

The Polaris bridge currently pins a single model per deployment: `PI_MOM_MODEL=openai-codex/gpt-5.5` with `PI_MOM_THINKING_LEVEL=high`. This works for the primary Pi session but creates friction whenever a specific turn warrants a different model — a cheaper/faster model for triage, a vision-capable model for image context, a reasoning-focused model for architecture decisions.

Switching models today requires a Railway env var change + redeploy, which is a multi-minute operation that blocks experimentation. It also means every subagent profile in `.agents/*.md` that pins a model (e.g., `google/gemini-3.1-flash-lite-preview` for scout-like profiles) must be reachable via a provider the Pi SDK already has auth for.

OpenRouter (`openrouter.ai`) is an API proxy that provides a single authenticated endpoint (`https://openrouter.ai/api/v1`) behind one API key and routes to 200+ upstream models including GPT-5.5, Claude 4, Gemini 2.5, Grok 3, DeepSeek V3, and others. The provider prefix in the Pi SDK becomes `openrouter/<model-id>`.

### Why OpenRouter rather than direct provider keys

1. **Single credential for the full model surface.** One `OPENROUTER_API_KEY` replaces the need to hold and rotate `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `XAI_API_KEY` separately on Railway. Key rotation risk is centralized to one secret.
2. **Model switching without redeploy.** Subagent profiles and prompt templates can reference `openrouter/google/gemini-2.5-flash` or `openrouter/x-ai/grok-3-mini` and the bridge resolves them without any env or code change.
3. **Spend visibility.** OpenRouter provides per-model and per-request cost breakdowns in a single dashboard, which is more useful than reconciling spend across four provider dashboards.
4. **Fallback routing.** OpenRouter supports `"route": "fallback"` and model aliases (e.g., `openrouter/auto`) that route to the best available model within a cost ceiling — useful for degraded-mode handling when a primary provider is down.

### What stays on direct provider auth

- **`openai-codex/gpt-5.5`** for Pi parent sessions — this routes through Andy's shared ChatGPT Max account (`PI_AUTH_JSON_B64` volume file), which is not billable per-token and cannot be replicated via OpenRouter. Keep `PI_MOM_MODEL=openai-codex/gpt-5.5` as the default parent model.
- **`google-gemini-cli`** and `google-antigravity` — OAuth-based Google Workspace credentials already in `auth.json`. Leave as-is; OpenRouter's Gemini routing is pay-per-token and would be redundant.
- **`xai` (Grok)** — Already in `auth.json`. Use OpenRouter for models not covered by the existing auth, not as a duplicate path.

## Decision

Add `OPENROUTER_API_KEY` as a first-class env var in the Railway `covent-pi-mom` service and in all env example files. The key is set; it becomes the credential used whenever a Pi model string is prefixed with `openrouter/`.

Do not change `PI_MOM_MODEL` — the parent session stays on `openai-codex/gpt-5.5` via the shared ChatGPT Max account. OpenRouter expands the model surface available to subagent profiles and tool-initiated model calls; it does not replace the primary model.

Redact `sk-or-v1-` prefixed strings via `lib/redaction.mjs` before any model output reaches Slack (follow-up, see below).

## Current state (2026-05-16)

- `OPENROUTER_API_KEY` set on Railway `covent-pi-mom` service.
- Added to `apps/pi-mom/.env.example` and `apps/pi-mom/.env.railway.example` as a documented optional var.
- Pi SDK model prefix for OpenRouter: `openrouter/<provider>/<model>` (e.g., `openrouter/google/gemini-2.5-pro`, `openrouter/x-ai/grok-3`, `openrouter/anthropic/claude-sonnet-4-5`).
- No subagent profiles updated yet — profiles currently use `google/gemini-3.1-flash-lite-preview` direct, which works via the existing Gemini auth. Update profiles to `openrouter/google/gemini-2.5-flash` in a follow-up when the direct Gemini path has coverage gaps.

## Trade-offs accepted

- **Additional latency.** OpenRouter adds one proxy hop. Median overhead is ~50ms; acceptable for all current use cases.
- **Per-token billing.** Unlike the shared ChatGPT Max account, OpenRouter charges per token. Monitor spend via `openrouter.ai/activity`.
- **Key exposure risk.** `OPENROUTER_API_KEY` was shared in a chat session; see follow-ups. The key format (`sk-or-v1-…`) is now added to the redaction pattern watchlist.

## Alternatives considered

**Per-provider keys on Railway.** More keys to rotate, more env noise, no cross-provider spend visibility. Rejected in favor of the single-key OpenRouter approach.

**Keep single-model deployment.** Zero additional cost but blocks model experimentation without redeployment. Rejected — model flexibility is a stated need for the distribution engineer role.

**Use OpenRouter for the parent Pi session too.** Would unify billing but breaks the shared-account ChatGPT Max pattern that Andy owns. Rejected until the shared-account auth is no longer load-bearing.

## Follow-ups

1. **Rotate `OPENROUTER_API_KEY`** — the key was pasted in a chat session and is now in conversation history. Generate a new key at `openrouter.ai/settings/keys` and update the Railway env var.
2. **Add `sk-or-v1-` to `lib/redaction.mjs`** — both the streaming-suffix pattern and the post-stream replacer. Also add `OPENROUTER_API_KEY` to the env-var name pattern. This is the same stash-recovery work noted in ADR 0012's Apify follow-up — open a single small PR covering both Apify and OpenRouter redaction gaps.
3. **Update scout subagent profiles** — evaluate swapping `google/gemini-3.1-flash-lite-preview` for `openrouter/google/gemini-2.5-flash` in `.agents/team-scout.md`, `.agents/scout-fast.md`, and `agents/linear-auditor.md`. Gemini 2.5 Flash is meaningfully faster and cheaper than 3.1 Flash Lite at current OpenRouter pricing.
4. **Set `PI_MOM_MODEL` and `PI_MOM_THINKING_LEVEL` explicitly on Railway.** Currently unset — service runs on in-code defaults. Pin them explicitly so a Pi SDK bump can't silently change the production model.
