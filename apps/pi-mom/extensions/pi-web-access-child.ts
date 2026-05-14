// Child-subagent entrypoint for pi-web-access.
//
// pi-subagents passes explicit `--extension` paths from agent frontmatter.
// This wrapper lives under apps/pi-mom so the app-pinned pi-web-access
// dependency resolves without relying on global/user package discovery. The Pi
// SDK loader still supplies @mariozechner compatibility aliases for the
// official extension package.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import webAccess from "pi-web-access/index.ts";
import { webAccessSafetyExtension } from "../../../extensions/pi-web-access-safety.ts";

const DISABLED_WEB_TOOLS = ["web_search", "get_search_content", "code_search"];

function webAccessEnabled(env = process.env): boolean {
  return String(env.PI_MOM_WEB_ACCESS_ENABLED || "").toLowerCase() === "true";
}

function registerDisabledWebToolStubs(pi: ExtensionAPI) {
  for (const name of DISABLED_WEB_TOOLS) {
    pi.registerTool({
      name,
      label: `${name} disabled`,
      description: `${name} is disabled because PI_MOM_WEB_ACCESS_ENABLED is not true in this environment.`,
      parameters: Type.Object({}, { additionalProperties: true }),
      async execute() {
        return {
          content: [{ type: "text", text: `${name} is disabled. Set PI_MOM_WEB_ACCESS_ENABLED=true to enable bounded public web access.` }],
          details: { disabled: true, env: "PI_MOM_WEB_ACCESS_ENABLED" },
          isError: true,
        };
      },
    });
  }
}

export default async function piWebAccessChild(pi: ExtensionAPI) {
  if (!webAccessEnabled()) {
    registerDisabledWebToolStubs(pi);
    return;
  }
  await webAccess(pi);
  webAccessSafetyExtension(pi);
}
