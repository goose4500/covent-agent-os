import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Global Linear safety guard for Pi's MCP adapter.
 *
 * - Allows Linear reads/searches normally.
 * - Requires an interactive confirmation before likely Linear mutations.
 * - Blocks likely Linear mutations in non-interactive mode.
 */
export default function (pi: ExtensionAPI) {
  const mutationPattern = /(^|[_-])(create|update|delete|remove|archive|unarchive|assign|delegate|move|transition|set|add|attach|detach|link|unlink|mark|subscribe|unsubscribe|favorite|unfavorite)([_-]|$)/i;
  // Generic GraphQL tool (`linear_graphql`) — the tool name alone never
  // matches a mutation verb. Peek inside the `query` arg and gate when the
  // document declares a GraphQL mutation. `\bmutation\b` is sufficient given
  // we control the call site and don't need to parse the GraphQL AST.
  const graphqlMutationPattern = /\bmutation\b/i;

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

    // For the generic linear_graphql tool, gate when the query string itself
    // contains a `mutation` document. Skip otherwise (read-only query).
    if (event.toolName === "linear_graphql") {
      const query = typeof input.query === "string" ? input.query : "";
      if (!graphqlMutationPattern.test(query)) return undefined;
    } else if (!mutationPattern.test(toolName)) {
      // Search/list/describe/status/connect are not mutations. If a proxied
      // tool call gets here, only gate names that look mutation-like.
      return undefined;
    }

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
