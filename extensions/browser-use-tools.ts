import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { formatBrowserUseRun, runBrowserUseTask } from "../lib/browser-use-client.mjs";

export default function browserUseTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "browser_use_run",
    label: "Browser Use Run",
    description: "Run a safe Browser Use Cloud v3 task and save private evidence metadata locally. Reads BROWSER_USE_API_KEY from env or ~/.pi/agent/secrets/browser-use.env.",
    promptSnippet: "Run read-only/public Browser Use Cloud tasks with evidence metadata saved locally",
    promptGuidelines: [
      "Use browser_use_run only for approved Browser Use Cloud tasks where hosted autonomous browsing is more useful than raw Chrome DevTools MCP.",
      "Use browser_use_run for public/read-only MVP eval tasks first; do not use it for payments, irreversible mutations, credential entry, or unapproved stealth/proxy/CAPTCHA workflows.",
      "browser_use_run saves evidence metadata locally; never paste API keys, cookies, tokens, or private Browser Use URLs into Linear or Slack.",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "Natural-language browser task. Keep it explicit and safe." }),
      model: Type.Optional(Type.String({ description: "Browser Use model. Defaults to gemini-3-flash for cheap smoke tests; use claude-sonnet-4.6 for harder tasks." })),
      max_cost_usd: Type.Optional(Type.Number({ description: "Maximum Browser Use session cost in USD. Defaults to 0.50." })),
      timeout_ms: Type.Optional(Type.Number({ description: "Local wait timeout in milliseconds. Defaults to 180000." })),
      enable_recording: Type.Optional(Type.Boolean({ description: "Enable Browser Use recording. Defaults to true." })),
      proxy_country_code: Type.Optional(Type.String({ description: "Proxy country code, e.g. us/de/jp. Use 'none' to disable proxy. Defaults to none." })),
      output_dir: Type.Optional(Type.String({ description: "Private local directory for run metadata. Defaults to ~/.pi/agent/browser-use-runs." })),
    }),
    async execute(_toolCallId, params: any, signal) {
      const proxyCountryCode = params.proxy_country_code === undefined || params.proxy_country_code === "none" || params.proxy_country_code === "null"
        ? null
        : params.proxy_country_code;

      const run = await runBrowserUseTask({
        task: params.task,
        model: params.model,
        maxCostUsd: params.max_cost_usd ?? 0.5,
        timeoutMs: params.timeout_ms ?? 180_000,
        enableRecording: params.enable_recording ?? true,
        proxyCountryCode,
        outputDir: params.output_dir,
        keepAlive: false,
        enableSkills: false,
        signal,
      });

      return {
        content: [{ type: "text", text: formatBrowserUseRun(run) }],
        details: run,
      };
    },
  });
}
