// node-compat: no Bun APIs — Pi's jiti loader runs extensions under Node
/**
 * action-router
 *
 * Reads `apps/pi-mom/control-plane/registry.yaml` and, when a session prompt
 * includes Action metadata, gates tools via `pi.setActiveTools(...)` and
 * augments the system prompt with the Action's prompt suffix.
 *
 * Activation: the Slack dispatcher (apps/pi-mom/index.mjs) resolves the Action
 * name from the inbound message, then calls `session.prompt(text, { metadata: { action } })`.
 * This extension reads `event.metadata?.action` in `before_agent_start` and
 * applies the Action's tools list and prompt suffix from the registry.
 *
 * If `event.metadata?.action` is absent (e.g. CLI use, ad-hoc Pi sessions),
 * this extension is a no-op and Pi runs with the host's default tool set.
 *
 * Registry shape (only the fields this extension reads):
 *   actions:
 *     - key: <action-name>
 *       status: active | planned
 *       tools: [read, write, slack_post, ...]    # optional, default = all
 *       systemPromptSuffix: |                    # optional, appended verbatim
 *         <text appended to event.systemPrompt>
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface ActionEntry {
  key: string;
  status?: string;
  tools?: string[];
  systemPromptSuffix?: string;
}

interface RegistryShape {
  actions?: ActionEntry[];
}

export interface ActionRouterOptions {
  registryPath?: string;
}

function loadRegistry(registryPath: string): Map<string, ActionEntry> {
  if (!existsSync(registryPath)) return new Map();

  // yaml is a runtime dep of apps/pi-mom and is hoisted to the workspace root.
  // Use dynamic require via createRequire to avoid hoisting concerns.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { parse } = require("yaml") as { parse: (s: string) => RegistryShape };
  const raw = readFileSync(registryPath, "utf8");
  const parsed = parse(raw);
  const actions = parsed?.actions ?? [];

  const map = new Map<string, ActionEntry>();
  for (const entry of actions) {
    if (entry?.key) map.set(entry.key, entry);
  }
  return map;
}

export function buildExtension(opts: ActionRouterOptions = {}) {
  const registryPath =
    opts.registryPath ??
    resolve(process.cwd(), "apps/pi-mom/control-plane/registry.yaml");

  const registry = loadRegistry(registryPath);

  return function extension(pi: ExtensionAPI) {
    pi.on("before_agent_start", async (event: unknown) => {
      const ev = event as {
        metadata?: { action?: string };
        systemPrompt?: string;
      };
      const actionKey = ev?.metadata?.action;
      if (!actionKey) return undefined;

      const action = registry.get(actionKey);
      if (!action) {
        // Unknown action — surface as a no-op rather than throwing; logging
        // happens upstream in the Slack dispatcher.
        return undefined;
      }

      if (Array.isArray(action.tools) && action.tools.length > 0) {
        const setActive = (pi as unknown as {
          setActiveTools?: (tools: string[]) => void;
        }).setActiveTools;
        if (typeof setActive === "function") {
          setActive.call(pi, action.tools);
        }
      }

      if (action.systemPromptSuffix && ev.systemPrompt !== undefined) {
        return {
          systemPrompt: `${ev.systemPrompt}\n\n${action.systemPromptSuffix}`,
        };
      }

      return undefined;
    });
  };
}

// Default export — Pi calls this at load. Dormant when no registry exists,
// matching the pattern from packages/pi-ext-covent-aws/src/index.ts.
export default function (pi: ExtensionAPI) {
  return buildExtension()(pi);
}
