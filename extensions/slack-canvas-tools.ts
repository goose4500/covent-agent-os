// Pi custom tools for model-driven Slack canvas creation.
//
// Two tools the model can call mid-turn when it judges that a piece of
// long-form output (spec, summary, plan, doc) belongs in a Slack canvas
// rather than crammed into the chat thread:
//
//   slack_canvas_start   — open a standalone Slack canvas in the current
//                          thread's workspace, post the link to the
//                          thread, and from that point on every text
//                          delta the agent emits mirrors into the canvas
//                          (debounced at 3s / 1.5KB to stay under Slack
//                          Tier 3 rate limits).
//   slack_canvas_finish  — flush the buffer and do a single `replace`
//                          pass with the cleaned final markdown so the
//                          canvas reads as one cohesive doc, then detach
//                          the canvas-sink from the live event fan.
//
// Streaming model: the canvas mirrors the agent's text deltas
// automatically between start and finish. The agent does not need to
// pass canvas content as an argument — it just writes its normal
// output. This matches today's hardcoded `spec:` route behavior but
// puts the decision in the model's hands.
//
// Both tools pre-flight ctx.ui.{startCanvas,stopCanvas} and return an
// `isError` result if invoked outside a Slack-bound Pi turn (e.g. unit
// tests, echo mode, non-Slack surfaces).

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

type CanvasStartResult = {
  ok: boolean;
  error?: string;
  canvasId?: string;
  url?: string;
};

type CanvasStopResult = {
  ok: boolean;
  error?: string;
  canvasId?: string;
  url?: string;
  streamedChars?: number;
};

type SlackCanvasUI = {
  startCanvas?: (opts: {
    title: string;
    initialText?: string;
    postLinkToThread?: boolean;
  }) => Promise<CanvasStartResult>;
  stopCanvas?: (opts?: { finalMarkdown?: string }) => Promise<CanvasStopResult>;
};

function getSlackCanvasUI(ctx: ExtensionContext | undefined): SlackCanvasUI | undefined {
  const ui = ctx?.ui as unknown as SlackCanvasUI | undefined;
  if (!ui) return undefined;
  return ui;
}

const NOT_SLACK_BOUND_HINT =
  "Tell the user it requires being invoked from a Slack thread; produce the deliverable as inline markdown in the chat reply instead.";

export default function slackCanvasTools(pi: ExtensionAPI) {
  // ---- slack_canvas_start --------------------------------------------------
  pi.registerTool({
    name: "slack_canvas_start",
    label: "Open Slack canvas",
    description:
      "Open a Slack canvas (a long-form scrollable document) in the current Slack thread's workspace. The link is posted to the thread automatically. From the moment this returns, every subsequent text token you emit is mirrored into the canvas in real time, debounced for Slack rate limits. Call this BEFORE writing long-form deliverables (specs, PRDs, summaries, plans, RFCs, post-mortems) so the user gets a clean shareable doc instead of a wall of chat messages. When you are done writing, call slack_canvas_finish to seal the doc with one clean final replace pass.",
    promptSnippet:
      "slack_canvas_start: open a Slack canvas for long-form output; text deltas mirror in until slack_canvas_finish.",
    promptGuidelines: [
      "Call slack_canvas_start at the top of your output when the deliverable is longer than ~10 short lines of markdown, or when the user asked for a spec/PRD/summary/agenda/plan/doc/report.",
      "Choose a short, descriptive `title` — it becomes the canvas filename in Slack and the link label in the thread.",
      "After this call returns, just write your output normally; do not pass the body as a tool argument. The canvas-sink mirrors your text deltas automatically.",
      "Always pair with slack_canvas_finish at the end. If you forget, the turn-end cleanup will auto-finalize, but the result will be missing the agent's final cleaned text.",
      "Do not open multiple canvases in a single turn — finish one before starting another.",
    ],
    parameters: Type.Object({
      title: Type.String({
        description: "Canvas title (filename in Slack, link label in thread). Keep it short and descriptive. Max 80 chars.",
        minLength: 1,
        maxLength: 80,
      }),
      initial_text: Type.Optional(Type.String({
        description: "Optional initial markdown to seed the canvas before streaming begins. Default is a placeholder ('_Starting…_'). Leave empty unless you want a custom heading.",
        maxLength: 2000,
      })),
    }),
    async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
      const ui = getSlackCanvasUI(ctx);
      if (!ui?.startCanvas) {
        return errorResult(`slack_canvas_start requires a Slack-bound Pi turn. ${NOT_SLACK_BOUND_HINT}`);
      }
      try {
        const res = await ui.startCanvas({
          title: params.title,
          initialText: params.initial_text,
        });
        if (!res?.ok) {
          const reason = res?.error || "unknown";
          return errorResult(`slack_canvas_start failed: ${reason}. ${NOT_SLACK_BOUND_HINT}`);
        }
        return textResult(
          `Canvas opened. Write your deliverable now — text will stream into the canvas. Call slack_canvas_finish when done.\n\ncanvas_id: ${res.canvasId || "?"}\nurl: ${res.url || "(no url)"}`,
          { canvasId: res.canvasId, url: res.url },
        );
      } catch (err: any) {
        return errorResult(`slack_canvas_start failed: ${err?.message || String(err)}`);
      }
    },
  });

  // ---- slack_canvas_finish -------------------------------------------------
  pi.registerTool({
    name: "slack_canvas_finish",
    label: "Finalize Slack canvas",
    description:
      "Seal the currently-open Slack canvas: flush any buffered text and do a single `replace` pass so the doc reads as one cohesive piece instead of N streaming fragments. After this returns, subsequent text tokens are NOT mirrored to the canvas (they go to the chat thread only). Always call this at the end of a long-form deliverable you opened with slack_canvas_start.",
    promptSnippet:
      "slack_canvas_finish: seal the open Slack canvas after you've finished writing the deliverable.",
    promptGuidelines: [
      "Call slack_canvas_finish at the end of every deliverable opened with slack_canvas_start.",
      "Optional `final_markdown` lets you override the streamed content with a curated final version. Usually unnecessary — the canvas already has your full output.",
      "If you didn't call slack_canvas_start in this turn, this tool returns an error — that's expected, ignore and continue.",
    ],
    parameters: Type.Object({
      final_markdown: Type.Optional(Type.String({
        description: "Optional curated final markdown to replace the streamed content with. Leave empty to use the streamed accumulator (recommended).",
        maxLength: 50000,
      })),
    }),
    async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
      const ui = getSlackCanvasUI(ctx);
      if (!ui?.stopCanvas) {
        return errorResult(`slack_canvas_finish requires a Slack-bound Pi turn. ${NOT_SLACK_BOUND_HINT}`);
      }
      try {
        const res = await ui.stopCanvas({ finalMarkdown: params.final_markdown });
        if (!res?.ok) {
          const reason = res?.error || "unknown";
          // no_active_canvas is benign — the agent didn't open one. Don't
          // treat as a hard error.
          if (reason === "no_active_canvas") {
            return textResult("No canvas was open in this turn; nothing to finalize.");
          }
          return errorResult(`slack_canvas_finish failed: ${reason}`);
        }
        return textResult(
          `Canvas finalized.\n\ncanvas_id: ${res.canvasId || "?"}\nurl: ${res.url || "(no url)"}\nstreamed_chars: ${res.streamedChars || 0}`,
          { canvasId: res.canvasId, url: res.url, streamedChars: res.streamedChars },
        );
      } catch (err: any) {
        return errorResult(`slack_canvas_finish failed: ${err?.message || String(err)}`);
      }
    },
  });
}
