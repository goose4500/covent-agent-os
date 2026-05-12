import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MCP_CONFIG_PATH = join(homedir(), ".pi", "agent", "mcp.json");
const SERVER_NAME = "chrome-devtools";
const WINDOWS_CHROME_USER_DATA_DIR = "/mnt/c/Users/Jfloy/AppData/Local/Google/Chrome/User Data";
const CHROME_USER_DATA_DIR =
  process.env.PI_CHROME_USER_DATA_DIR ??
  (existsSync(WINDOWS_CHROME_USER_DATA_DIR)
    ? WINDOWS_CHROME_USER_DATA_DIR
    : existsSync(join(homedir(), ".config", "chromium"))
      ? join(homedir(), ".config", "chromium")
      : join(homedir(), ".config", "google-chrome"));

const CORE_DIRECT_TOOLS = [
  "list_pages",
  "select_page",
  "new_page",
  "navigate_page",
  "close_page",
  "wait_for",
  "take_snapshot",
  "take_screenshot",
  "click",
  "click_at",
  "hover",
  "type_text",
  "fill",
  "fill_form",
  "press_key",
  "handle_dialog",
  "upload_file",
  "list_console_messages",
  "get_console_message",
  "list_network_requests",
  "get_network_request",
  "evaluate_script",
  "performance_start_trace",
  "performance_stop_trace",
  "performance_analyze_insight",
  "lighthouse_audit",
];

function desiredChromeServer() {
  return {
    command: "npx",
    args: [
      "-y",
      "chrome-devtools-mcp@latest",
      "--autoConnect",
      `--user-data-dir=${CHROME_USER_DATA_DIR}`,
      "--experimental-vision",
      "--no-usage-statistics",
      "--no-performance-crux",
      "--redact-network-headers=true",
    ],
    lifecycle: "lazy",
    idleTimeout: 30,
    directTools: true,
    debug: false,
  };
}

async function readJsonFile(path: string): Promise<any> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error: any) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

async function upsertChromeMcpConfig(): Promise<{ changed: boolean; path: string }> {
  await mkdir(dirname(MCP_CONFIG_PATH), { recursive: true });

  return withFileMutationQueue(MCP_CONFIG_PATH, async () => {
    const config = await readJsonFile(MCP_CONFIG_PATH);
    config.settings ??= {};
    config.settings.toolPrefix ??= "server";
    config.settings.idleTimeout ??= 10;
    config.settings.directTools ??= false;
    config.mcpServers ??= {};

    const nextServer = desiredChromeServer();
    const current = config.mcpServers[SERVER_NAME];
    const changed = JSON.stringify(current) !== JSON.stringify(nextServer);
    if (changed) {
      config.mcpServers[SERVER_NAME] = nextServer;
      await writeFile(MCP_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    }
    return { changed, path: MCP_CONFIG_PATH };
  });
}

async function commandOutput(pi: ExtensionAPI, command: string, timeout = 5000): Promise<string> {
  const result = await pi.exec("bash", ["-lc", command], { timeout });
  const stdout = result.stdout?.trim() ?? "";
  const stderr = result.stderr?.trim() ?? "";
  return [stdout, stderr].filter(Boolean).join("\n").trim();
}

async function buildStatus(pi: ExtensionAPI): Promise<string> {
  const config = await readJsonFile(MCP_CONFIG_PATH);
  const server = config?.mcpServers?.[SERVER_NAME];
  const chromeVersion = await commandOutput(
    pi,
    "(google-chrome --version || google-chrome-stable --version || chromium --version || chromium-browser --version) 2>/dev/null | head -1 || true",
  );
  const runningChrome = await commandOutput(
    pi,
    "ps -eo pid,command | grep -Ei '[c]hrome|[c]hromium' | head -8 || true",
  );

  const lines = [
    "Pi Chrome Access",
    "================",
    `MCP config: ${MCP_CONFIG_PATH}`,
    `chrome-devtools server configured: ${server ? "yes" : "no"}`,
    `mode: real-profile attach via chrome-devtools-mcp --autoConnect`,
    `profile dir: ${CHROME_USER_DATA_DIR}`,
    `direct tools requested: ${Array.isArray(server?.directTools) ? server.directTools.length : server?.directTools ? "all" : "no"}`,
    `Chrome/Chromium version: ${chromeVersion || "not found"}`,
    "",
    "Real-profile attach requirements:",
    "1. Keep your normal Chrome/Chromium profile open.",
    `2. Open chrome://inspect/#remote-debugging in that same profile (${CHROME_USER_DATA_DIR}).`,
    "3. Enable/allow remote debugging for this browser instance when Chrome asks.",
    "4. In Pi, use mcp({ connect: \"chrome-devtools\" }) or search/call chrome_devtools_* tools.",
    "5. If Chrome shows a permission dialog, click Allow.",
    "",
    "Running browser processes:",
    runningChrome || "(none detected from this shell)",
  ];

  return lines.join("\n");
}

async function openRemoteDebuggingPage(pi: ExtensionAPI) {
  const cmd = `
set -e
URL='chrome://inspect/#remote-debugging'
if command -v google-chrome >/dev/null 2>&1; then
  nohup google-chrome "$URL" >/tmp/pi-chrome-access-open.log 2>&1 &
elif command -v google-chrome-stable >/dev/null 2>&1; then
  nohup google-chrome-stable "$URL" >/tmp/pi-chrome-access-open.log 2>&1 &
elif command -v chromium >/dev/null 2>&1; then
  nohup chromium "$URL" >/tmp/pi-chrome-access-open.log 2>&1 &
elif command -v chromium-browser >/dev/null 2>&1; then
  nohup chromium-browser "$URL" >/tmp/pi-chrome-access-open.log 2>&1 &
elif command -v xdg-open >/dev/null 2>&1; then
  nohup xdg-open "$URL" >/tmp/pi-chrome-access-open.log 2>&1 &
else
  echo 'No Chrome/Chromium launcher found.' >&2
  exit 1
fi
`;
  return pi.exec("bash", ["-lc", cmd], { timeout: 5000 });
}

function chromePromptAppendix() {
  return `

Chrome browser agency is configured through the Pi MCP adapter server \`${SERVER_NAME}\`, using Chrome DevTools MCP in real-profile autoConnect mode against user data dir \`${CHROME_USER_DATA_DIR}\`.
- Use the MCP gateway when browser access helps: first mcp({ search: "chrome_devtools snapshot screenshot navigate click type console network" }) if tool names are unknown, then call the relevant chrome_devtools_* tools.
- If not connected, call mcp({ connect: "${SERVER_NAME}" }). If Chrome asks for permission, tell the user to click Allow in the visible browser.
- Prefer take_snapshot before click/type/fill; use take_screenshot for visual confirmation; use console/network tools for debugging.
- The user wants high-agency visible browser automation in their real Chrome profile. Act decisively, but avoid needless credential/cookie/header exfiltration; keep actions visible and reversible when possible.
`;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("chrome-access", {
    description: "Show Pi Chrome real-profile access status and setup steps",
    handler: async (_args, _ctx) => {
      const status = await buildStatus(pi);
      pi.sendMessage({
        customType: "pi-chrome-access",
        content: status,
        display: true,
      });
    },
  });

  pi.registerCommand("chrome-open-debug-setup", {
    description: "Open chrome://inspect/#remote-debugging in Chrome for real-profile autoConnect",
    handler: async (_args, ctx) => {
      await openRemoteDebuggingPage(pi);
      ctx.ui.notify("Opened chrome://inspect/#remote-debugging. Enable/allow remote debugging in Chrome, then retry the MCP connect.", "info");
    },
  });

  pi.registerTool({
    name: "chrome_access_status",
    label: "Chrome Access Status",
    description: "Check Pi Chrome access configuration, Chrome version, and real-profile attach setup steps.",
    promptSnippet: "Check Chrome DevTools MCP real-profile access status and setup requirements",
    promptGuidelines: [
      "Use chrome_access_status when Chrome browser automation is requested but the Chrome MCP connection status is unclear.",
    ],
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [{ type: "text", text: await buildStatus(pi) }],
        details: { configPath: MCP_CONFIG_PATH, serverName: SERVER_NAME },
      };
    },
  });

  pi.registerTool({
    name: "chrome_access_install_config",
    label: "Install Chrome MCP Config",
    description: "Install or refresh the global Pi MCP server config for real-profile Chrome DevTools MCP autoConnect.",
    promptSnippet: "Install or refresh Chrome DevTools MCP config for real-profile browser access",
    promptGuidelines: [
      "Use chrome_access_install_config when the chrome-devtools MCP server is missing or stale.",
    ],
    parameters: Type.Object({}),
    async execute() {
      const result = await upsertChromeMcpConfig();
      return {
        content: [
          {
            type: "text",
            text: `${result.changed ? "Installed/updated" : "Already current"} Chrome MCP config at ${result.path}. Reload/restart Pi or run /mcp reconnect chrome-devtools if needed.`,
          },
        ],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "chrome_open_debug_setup",
    label: "Open Chrome Debug Setup",
    description: "Open chrome://inspect/#remote-debugging in the user's visible Chrome profile so they can allow real-profile autoConnect.",
    promptSnippet: "Open Chrome's remote-debugging consent page for real-profile MCP attach",
    promptGuidelines: [
      "Use chrome_open_debug_setup when Chrome DevTools MCP autoConnect needs the user to enable or allow remote debugging in the visible browser.",
    ],
    parameters: Type.Object({}),
    async execute() {
      const result = await openRemoteDebuggingPage(pi);
      return {
        content: [
          {
            type: "text",
            text: "Opened chrome://inspect/#remote-debugging. In Chrome, enable/allow remote debugging for this browser instance, then call mcp({ connect: \"chrome-devtools\" }).",
          },
        ],
        details: { stdout: result.stdout, stderr: result.stderr, code: result.code },
      };
    },
  });

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    const config = await readJsonFile(MCP_CONFIG_PATH);
    const configured = Boolean(config?.mcpServers?.[SERVER_NAME]);
    ctx.ui.setStatus("chrome", configured ? "Chrome: real-profile MCP" : "Chrome: run chrome_access_install_config");
  });

  pi.on("before_agent_start", async (event) => {
    if (!existsSync(MCP_CONFIG_PATH)) return undefined;
    const config = await readJsonFile(MCP_CONFIG_PATH);
    if (!config?.mcpServers?.[SERVER_NAME]) return undefined;
    return { systemPrompt: event.systemPrompt + chromePromptAppendix() };
  });
}
