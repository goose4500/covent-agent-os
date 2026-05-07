import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * Global Linear safety guard for Pi's MCP adapter.
 *
 * - Allows Linear reads/searches normally.
 * - Requires an interactive confirmation before likely Linear mutations.
 * - Blocks likely Linear mutations in non-interactive mode.
 */
export default function (pi: ExtensionAPI) {
  const mutationPattern = /(^|[_-])(create|update|delete|remove|archive|unarchive|assign|delegate|move|transition|set|add|attach|detach|link|unlink|mark|subscribe|unsubscribe|favorite|unfavorite)([_-]|$)/i;

  pi.on("tool_call", async (event, ctx) => {
    const input = (event.input ?? {}) as Record<string, unknown>;

    const proxiedMcpCall = event.toolName === "mcp" && typeof input.tool === "string";
    const directLinearCall = event.toolName.startsWith("linear_");

    if (!proxiedMcpCall && !directLinearCall) return undefined;

    const proxiedTool = proxiedMcpCall ? String(input.tool) : undefined;
    const server = typeof input.server === "string" ? input.server : undefined;
    const toolName = proxiedTool ?? event.toolName;

    const isLinear = directLinearCall || server === "linear" || toolName.startsWith("linear_");
    if (!isLinear) return undefined;

    // Search/list/describe/status/connect are not mutations. If a proxied tool call
    // gets here, only gate names that look mutation-like.
    if (!mutationPattern.test(toolName)) return undefined;

    const argsText = typeof input.args === "string" ? input.args : JSON.stringify(input, null, 2);
    const preview = argsText && argsText.length > 1200 ? `${argsText.slice(0, 1200)}…` : argsText;

    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `Linear mutation blocked in non-interactive mode: ${toolName}`,
      };
    }

    const ok = await ctx.ui.confirm(
      "Confirm Linear mutation",
      `About to call Linear MCP tool:\n\n${toolName}\n\nArguments:\n${preview || "{}"}\n\nAllow this Linear write?`,
    );

    if (!ok) {
      return { block: true, reason: "Linear mutation blocked by user" };
    }

    return undefined;
  });
}
