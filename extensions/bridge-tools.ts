// Pi custom tools for bridge introspection.
//
// Two tools that surface bridge-side help and status text to the model
// so the agent can answer user questions like "what can you do?" or
// "are you healthy?" without the bridge having to short-circuit the
// turn with hardcoded keyword matching:
//
//   bridge_help     — return the bridge help text (commands, examples).
//   bridge_status   — return the bridge status text (mode, uptime,
//                     auth, model, allowed channels, Linear config).
//
// Both are backed by ctx.ui.bridgeHelp() / ctx.ui.bridgeStatus()
// closures the bridge supplies per-turn so the values reflect live
// state (uptime ticks, auth re-checks, etc.). On non-Slack surfaces
// (echo mode, unit tests) the closures return a sentinel string.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type AnyResult = {
  content: Array<{ type: "text"; text: string }>;
  details: any;
  isError?: boolean;
};

function errorResult(text: string): AnyResult {
  return { content: [{ type: "text", text }], details: undefined, isError: true };
}

function textResult(text: string, details?: any): AnyResult {
  return { content: [{ type: "text", text }], details };
}

type BridgeUI = {
  bridgeHelp?: () => string | Promise<string>;
  bridgeStatus?: () => string | Promise<string>;
};

function getBridgeUI(ctx: ExtensionContext | undefined): BridgeUI | undefined {
  const ui = ctx?.ui as unknown as BridgeUI | undefined;
  if (!ui) return undefined;
  return ui;
}

export default function bridgeTools(pi: ExtensionAPI) {
  // ---- bridge_help ---------------------------------------------------------
  pi.registerTool({
    name: "bridge_help",
    label: "Show bridge help",
    description:
      "Return the current bridge help text — what commands and tools the user can drive through this Slack app, with examples. Use when the user asks 'what can you do', 'help', 'how do I use this', or similar. Post the returned text back to the user verbatim (or summarize the highlights for short answers).",
    promptSnippet:
      "bridge_help: surface what the agent and bridge can do, with examples.",
    promptGuidelines: [
      "Call bridge_help when the user asks an open-ended 'what can you do?' or 'help me get started' question.",
      "Return the text to the user as a Slack message. Trim long sections if the user asked for a quick overview.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params: any, _signal, _onUpdate, ctx) {
      const ui = getBridgeUI(ctx);
      if (!ui?.bridgeHelp) {
        return errorResult("bridge_help unavailable in this context.");
      }
      try {
        const text = await ui.bridgeHelp();
        return textResult(text || "(no help text configured)");
      } catch (err: any) {
        return errorResult(`bridge_help failed: ${err?.message || String(err)}`);
      }
    },
  });

  // ---- bridge_status -------------------------------------------------------
  pi.registerTool({
    name: "bridge_status",
    label: "Show bridge status",
    description:
      "Return the current bridge status text — mode (echo/pi), uptime, Slack auth, allowed channels, Pi model + thinking level, Linear API key + target IDs, trace flag. Use when the user asks about the bot's health, configuration, or whether a specific integration is wired up. Returns live state on each call.",
    promptSnippet:
      "bridge_status: report live bridge health/config (mode, uptime, auth, model, integrations).",
    promptGuidelines: [
      "Call bridge_status when the user asks 'are you ok', 'are you running', 'what model are you using', 'is Linear configured', or similar.",
      "Post the returned text back to the user as-is, or pull the relevant single line.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params: any, _signal, _onUpdate, ctx) {
      const ui = getBridgeUI(ctx);
      if (!ui?.bridgeStatus) {
        return errorResult("bridge_status unavailable in this context.");
      }
      try {
        const text = await ui.bridgeStatus();
        return textResult(text || "(no status text configured)");
      } catch (err: any) {
        return errorResult(`bridge_status failed: ${err?.message || String(err)}`);
      }
    },
  });
}
