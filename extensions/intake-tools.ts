// Pi custom tool for spec-intake. ONE tool, model-invoked via the Pi SDK
// tool surface:
//
//   intake_propose_issues  — submit the structured list of proposed Linear
//                            issues derived from a PRD/spec text. Each
//                            proposal is a tracer-bullet vertical slice that
//                            cuts through every layer end-to-end.
//
// Unlike linear-tools.ts which talks to a remote GraphQL API, this tool's
// "side effect" is local: it deposits the cleaned proposals array into a
// per-request capture map keyed by requestId. The orchestrator sets
// process.env._PI_INTAKE_REQUEST_ID before each runTurn, the tool reads it
// when it runs, and the orchestrator harvests captureMap.get(requestId)
// after the agent run ends to post per-issue approval cards.
//
// Env contract:
//   _PI_INTAKE_REQUEST_ID  required at execute() time. Set by the
//                          orchestrator before each runTurn so concurrent
//                          intake turns don't collide in the capture map.
//
// Error model:
//   - Missing requestId → AgentToolResult { isError: true } with a clear
//     text reason. Same shape as linear-tools.ts errorResult helper.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface IntakeProposal {
  title: string;
  description: string;
  priority?: number;          // 0=none, 1=urgent, 2=high, 3=medium, 4=low
  suggested_team_id?: string;
  suggested_project_id?: string;
  confidence?: number;        // 0..1
  blocked_by?: string[];      // titles or temp-ids of other proposals
}

// Capture map keyed by requestId. The orchestrator sets
// process.env._PI_INTAKE_REQUEST_ID before each runTurn; the tool reads it
// when it runs and writes proposals[] there. Exported for tests + the
// orchestrator's harvest call.
export const intakeProposalCapture: Map<string, IntakeProposal[]> = new Map();

// Reset helper for tests.
export function _resetIntakeProposalCaptureForTests(): void {
  intakeProposalCapture.clear();
}

export interface IntakeToolsOptions {
  env?: Record<string, string | undefined>;
  captureMap?: Map<string, IntakeProposal[]>;
}

type AnyResult = {
  content: Array<{ type: "text"; text: string }>;
  details: any;
  isError?: boolean;
};

function errorResult(text: string): AnyResult {
  return {
    content: [{ type: "text", text }],
    details: undefined,
    isError: true,
  };
}

function clampTitle(title: string): string {
  const oneLine = String(title || "").replace(/\s+/g, " ").trim();
  if (!oneLine) return "";
  return oneLine.length <= 240 ? oneLine : `${oneLine.slice(0, 237)}...`;
}

export function createIntakeToolsFactory({
  env = process.env,
  captureMap = intakeProposalCapture,
}: IntakeToolsOptions = {}) {
  return function intakeTools(pi: ExtensionAPI) {
    // ---- intake_propose_issues -----------------------------------------
    pi.registerTool({
      name: "intake_propose_issues",
      label: "Propose Linear issues from spec intake",
      description:
        "Submit your final list of proposed Linear issues derived from the extracted PRD spec text. Each entry is a tracer-bullet vertical slice that cuts through every layer end-to-end. Call this tool EXACTLY ONCE per intake turn — multiple calls in the same turn overwrite the previous list. After this tool returns, write a single short summary line; do not emit free-text JSON of the proposals.",
      promptSnippet:
        "intake_propose_issues: emit the structured proposal list at the end of an intake turn.",
      promptGuidelines: [
        "Output ALL proposed issues in ONE call to intake_propose_issues; never call it twice in the same turn.",
        "Each proposal is a vertical slice — narrow but complete end-to-end behavior.",
        "Prefer many thin slices over a few thick ones.",
        "Use the provided default team_id/project_id unless the spec text strongly implies a different team.",
        "blocked_by lists OTHER proposals' titles when there's a hard dependency.",
      ],
      parameters: Type.Object({
        issues: Type.Array(
          Type.Object({
            title: Type.String({
              minLength: 1,
              maxLength: 240,
              description:
                "Concise vertical-slice title (single line; clamped to 240 chars).",
            }),
            description: Type.String({
              minLength: 1,
              maxLength: 12000,
              description:
                "Issue description in Markdown. Include problem, context, proposed solution, acceptance criteria for this slice.",
            }),
            priority: Type.Optional(
              Type.Number({
                minimum: 0,
                maximum: 4,
                description:
                  "Linear priority: 0=none, 1=urgent, 2=high, 3=medium, 4=low.",
              }),
            ),
            suggested_team_id: Type.Optional(
              Type.String({
                minLength: 1,
                maxLength: 64,
                description:
                  "Linear team id to route this issue to. Defaults to the configured intake team.",
              }),
            ),
            suggested_project_id: Type.Optional(
              Type.String({
                minLength: 1,
                maxLength: 64,
                description:
                  "Linear project id to attach this issue to. Defaults to the configured intake project.",
              }),
            ),
            confidence: Type.Optional(
              Type.Number({
                minimum: 0,
                maximum: 1,
                description:
                  "Model confidence (0..1) that this slice is correctly scoped and derived from the spec.",
              }),
            ),
            blocked_by: Type.Optional(
              Type.Array(
                Type.String({ maxLength: 240 }),
                {
                  maxItems: 25,
                  description:
                    "Titles or temp-ids of OTHER proposals in this same list that must land first.",
                },
              ),
            ),
          }),
          {
            minItems: 1,
            maxItems: 50,
            description:
              "Full list of proposed Linear issues for this intake turn. Emitted exactly once.",
          },
        ),
      }),
      async execute(_toolCallId, params: any, _signal) {
        const requestId = String(env._PI_INTAKE_REQUEST_ID || "").trim();
        if (!requestId) {
          return errorResult(
            "_PI_INTAKE_REQUEST_ID is not set in the bot environment; cannot capture proposed issues. The orchestrator must set this env var before each intake turn.",
          );
        }

        const rawIssues: any[] = Array.isArray(params?.issues) ? params.issues : [];
        const cleaned: IntakeProposal[] = [];
        for (const raw of rawIssues) {
          if (!raw || typeof raw !== "object") continue;
          const title = clampTitle(raw.title);
          if (!title) continue; // silently drop empty-title entries
          const description = String(raw.description || "").trim();
          if (!description) continue;
          const proposal: IntakeProposal = { title, description };
          if (typeof raw.priority === "number") proposal.priority = raw.priority;
          if (typeof raw.suggested_team_id === "string" && raw.suggested_team_id.trim()) {
            proposal.suggested_team_id = raw.suggested_team_id.trim();
          }
          if (typeof raw.suggested_project_id === "string" && raw.suggested_project_id.trim()) {
            proposal.suggested_project_id = raw.suggested_project_id.trim();
          }
          if (typeof raw.confidence === "number") proposal.confidence = raw.confidence;
          if (Array.isArray(raw.blocked_by)) {
            const blocked = raw.blocked_by
              .map((b: unknown) => String(b || "").trim())
              .filter((b: string) => b.length > 0);
            if (blocked.length > 0) proposal.blocked_by = blocked;
          }
          cleaned.push(proposal);
        }

        // Overwrite (no append/merge). Multiple calls in the same turn
        // replace the previous list.
        captureMap.set(requestId, cleaned);

        const n = cleaned.length;
        return {
          content: [
            {
              type: "text",
              text: `Captured ${n} proposed issue(s) for request ${requestId}. The orchestrator will post per-issue approval cards.`,
            },
          ],
          details: { requestId, count: n },
        };
      },
    });
  };
}

// Default export uses real process.env + the module-level capture map so
// pi-sdk-runner can pass the factory straight into
// DefaultResourceLoader.extensionFactories without configuration.
export default createIntakeToolsFactory();
