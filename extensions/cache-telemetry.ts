/**
 * Cache Telemetry Extension
 *
 * Surfaces prompt-cache token counts so we can verify caching is actually
 * working (especially after flipping PI_CACHE_RETENTION=long).
 *
 * Emits one JSON line per assistant message in the same `[pi-mom-trace]`
 * format used by apps/pi-mom/index.mjs:trace(), so existing log tooling
 * picks it up without changes:
 *
 *   [pi-mom-trace] {"ts":"...","event":"cache.usage","sessionId":"...",
 *                   "provider":"openai-codex","modelId":"gpt-5.5",
 *                   "input":12,"output":408,"cacheRead":4096,"cacheWrite":0,
 *                   "totalTokens":4516,"costUSD":0.0021}
 *
 * Gating:
 * - PI_MOM_TRACE !== "false" (default on) — same gate as the bridge's trace()
 * - PI_MOM_CACHE_TRACE_VERBOSE=true adds two extra events:
 *   - cache.system_prompt: SHA-1 of the assembled system prompt (per-turn).
 *     Lets us confirm the prefix is byte-stable across turns. If this hash
 *     changes between turns of the same Slack thread, no amount of
 *     cache_control will help — something upstream is invalidating.
 *   - cache.response: HTTP status + provider-specific cache headers.
 */

import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TRACE_ENABLED = process.env.PI_MOM_TRACE !== "false";
const VERBOSE = process.env.PI_MOM_CACHE_TRACE_VERBOSE === "true";

function emit(event: string, data: Record<string, unknown>) {
	if (!TRACE_ENABLED) return;
	const entry = { ts: new Date().toISOString(), event, ...data };
	console.log(`[pi-mom-trace] ${JSON.stringify(entry)}`);
}

export default function (pi: ExtensionAPI) {
	pi.on("message_end", (event, ctx) => {
		const msg = event.message as { role?: string; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost?: { total?: number } } };
		if (msg?.role !== "assistant" || !msg.usage) return;
		const u = msg.usage;
		emit("cache.usage", {
			sessionId: ctx.sessionManager.getSessionId(),
			provider: ctx.model?.provider,
			modelId: ctx.model?.id,
			input: u.input,
			output: u.output,
			cacheRead: u.cacheRead,
			cacheWrite: u.cacheWrite,
			totalTokens: u.totalTokens,
			hitRatio: u.input + u.cacheRead > 0 ? u.cacheRead / (u.input + u.cacheRead) : 0,
			costUSD: u.cost?.total,
		});
	});

	if (!VERBOSE) return;

	pi.on("before_agent_start", (event, ctx) => {
		const sp = event.systemPrompt || "";
		emit("cache.system_prompt", {
			sessionId: ctx.sessionManager.getSessionId(),
			bytes: Buffer.byteLength(sp, "utf8"),
			sha1: createHash("sha1").update(sp).digest("hex"),
		});
	});

	pi.on("after_provider_response", (event, ctx) => {
		const h = event.headers || {};
		emit("cache.response", {
			sessionId: ctx.sessionManager.getSessionId(),
			provider: ctx.model?.provider,
			status: event.status,
			cfCache: h["cf-cache-status"],
			openaiCache: h["x-openai-cache-status"] ?? h["openai-cache-status"],
			anthropicCache: h["anthropic-cache-status"],
		});
	});
}
