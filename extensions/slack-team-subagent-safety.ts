// Runtime guard for the Slack `team:` route's generic `subagent` tool.
//
// The route prompt asks the model to use only curated foreground/read-only
// presets, but the underlying pi-subagents tool is intentionally powerful.
// This extension enforces the Slack contract at tool-call time so prompt
// injection cannot turn `team:` into arbitrary subagent management, async
// background jobs, worktrees, write-capable agents, or user-scope agents.

import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";

const TEAM_AGENTS = new Set(["team-scout", "team-planner", "team-reviewer-readonly"]);
const ALLOWED_SINGLE_AGENTS = new Set(["team-scout", "team-reviewer-readonly", "team-planner"]);

function block(reason: string) {
  return { block: true, reason };
}

function asInput(event: Pick<ToolCallEvent, "toolName" | "input">): Record<string, unknown> {
  return event.input && typeof event.input === "object"
    ? event.input as Record<string, unknown>
    : {};
}

function hasAny(input: Record<string, unknown>, keys: string[]): string | undefined {
  return keys.find((key) => input[key] !== undefined);
}

function unknownKeyReason(input: Record<string, unknown>, allowed: Set<string>): string | undefined {
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) return `Slack team: subagent parameter ${key} is not allowed`;
  }
  return undefined;
}

function executionPostureReason(input: Record<string, unknown>): string | undefined {
  if (input.async !== false) return "Slack team: subagents must explicitly set async: false";
  if (input.agentScope !== "project") return "Slack team: subagents must explicitly use agentScope: project";
  if (input.context !== "fresh") return "Slack team: subagents must explicitly use fresh context";
  return undefined;
}

function validateDoctor(input: Record<string, unknown>) {
  const unknown = unknownKeyReason(input, new Set(["action"]));
  if (unknown) return block(unknown);
  return undefined;
}

function validateSingle(input: Record<string, unknown>) {
  const unknown = unknownKeyReason(input, new Set(["agent", "task", "agentScope", "context", "async"]));
  if (unknown) return block(unknown);
  const unsafe = executionPostureReason(input);
  if (unsafe) return block(unsafe);
  if (input.tasks !== undefined || input.chain !== undefined) {
    return block("single team subagent calls cannot include tasks/chain");
  }
  if (typeof input.agent !== "string" || !ALLOWED_SINGLE_AGENTS.has(input.agent)) {
    return block(`Slack team: can only run project team agents (${[...ALLOWED_SINGLE_AGENTS].join(", ")})`);
  }
  return undefined;
}

function validateChainStep(step: unknown, index: number, expectedAgent: string) {
  if (!step || typeof step !== "object" || Array.isArray(step)) {
    return `chain step ${index} must be an object`;
  }
  const item = step as Record<string, unknown>;
  if (item.parallel !== undefined) return `chain step ${index} cannot use parallel fan-out`;
  if (item.agent !== expectedAgent) return `chain step ${index} must use ${expectedAgent}`;
  const unknown = unknownKeyReason(item, new Set(["agent", "task"]));
  if (unknown) return `chain step ${index}: ${unknown}`;
  return undefined;
}

function validateChain(input: Record<string, unknown>) {
  const unknown = unknownKeyReason(input, new Set(["chain", "task", "agentScope", "context", "async", "clarify"]));
  if (unknown) return block(unknown);
  const unsafe = executionPostureReason(input);
  if (unsafe) return block(unsafe);
  if (input.clarify !== false) return block("Slack team: chain subagent calls must explicitly set clarify: false");
  if (input.agent !== undefined || input.tasks !== undefined) {
    return block("chain team subagent calls cannot include agent/tasks");
  }
  const chain = input.chain;
  if (!Array.isArray(chain) || chain.length !== 2) {
    return block("Slack team: plan must be exactly a two-step team-scout -> team-planner chain");
  }
  const first = validateChainStep(chain[0], 0, "team-scout");
  if (first) return block(first);
  const second = validateChainStep(chain[1], 1, "team-planner");
  if (second) return block(second);
  return undefined;
}

export function applySlackTeamSubagentSafetyToToolCall(event: Pick<ToolCallEvent, "toolName" | "input">) {
  if (event.toolName !== "subagent") return undefined;
  const input = asInput(event);

  if (input.action !== undefined) {
    if (input.action !== "doctor") {
      return block("Slack team: only subagent action allowed is doctor");
    }
    return validateDoctor(input);
  }

  const managementKey = hasAny(input, ["chainName", "config", "id", "runId", "dir", "index", "message"]);
  if (managementKey) return block(`Slack team: subagent management/control parameter ${managementKey} is not allowed`);

  if (input.chain !== undefined) return validateChain(input);
  if (input.tasks !== undefined) return block("Slack team: parallel subagent tasks are not allowed");
  if (input.agent !== undefined) return validateSingle(input);

  return block("Slack team: subagent call must be doctor, a single approved team agent, or the team-scout -> team-planner chain");
}

export function slackTeamSubagentSafetyExtension(pi: ExtensionAPI) {
  pi.on("tool_call", (event) => applySlackTeamSubagentSafetyToToolCall(event));
}

export default slackTeamSubagentSafetyExtension;
