// Safety guardrails for pi-web-access when exposed through Covent Slack routes.
//
// The official pi-web-access extension is still loaded from the app dependency
// via DefaultResourceLoader.additionalExtensionPaths. This companion extension
// does not register web tools; it only constrains tool calls before execution.

import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";

const WEB_SEARCH_TOOL = "web_search";
const CODE_SEARCH_TOOL = "code_search";
const FETCH_CONTENT_TOOL = "fetch_content";

const SECRET_PATTERNS = [
  /xox[baprs]-[A-Za-z0-9-]+/i,
  /sk-[A-Za-z0-9_-]{16,}/i,
  /gh[pousr]_[A-Za-z0-9_]{16,}/i,
  /AIza[0-9A-Za-z_-]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password)\s*[:=]\s*[^\s]+/i,
  /\b(?:PI_AUTH_JSON_B64|[A-Z0-9_]*AUTH_JSON_B64)\s*=\s*[^\s]+/i,
  /["'](?:access_token|refresh_token|id_token|client_secret|api_key)["']\s*:\s*["'][^"']+["']/i,
];

const BLOCKED_HOST_SUFFIXES = [
  ".local",
  ".localhost",
  ".internal",
  ".intranet",
  ".corp",
  ".lan",
];

function envFlag(env: Record<string, string | undefined>, key: string): boolean {
  return String(env[key] || "").toLowerCase() === "true" || env[key] === "1";
}

export function webAccessBrowserWorkflowAllowedFromEnv(env = process.env): boolean {
  return envFlag(env, "PI_MOM_WEB_ACCESS_ALLOW_BROWSER_WORKFLOW");
}

export function webAccessPrivateFetchAllowedFromEnv(env = process.env): boolean {
  return envFlag(env, "PI_MOM_WEB_ACCESS_ALLOW_PRIVATE_FETCH");
}

export function containsSecretLikeText(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().replace(/^\[|\]$/g, "").toLowerCase();
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((part) => Number(part));
  if (nums.some((n, i) => !Number.isInteger(n) || n < 0 || n > 255 || String(n) !== parts[i])) return false;
  const [a, b] = nums;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateIpv6(hostname: string): boolean {
  if (!hostname.includes(":")) return false;
  const value = hostname.toLowerCase();
  return (
    value === "::1" ||
    value === "0:0:0:0:0:0:0:1" ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    value.startsWith("fe8") ||
    value.startsWith("fe9") ||
    value.startsWith("fea") ||
    value.startsWith("feb") ||
    value === "::" ||
    value.startsWith("::ffff:127.") ||
    value.startsWith("::ffff:10.") ||
    /^::ffff:172\.(1[6-9]|2[0-9]|3[0-1])\./.test(value) ||
    value.startsWith("::ffff:192.168.") ||
    value.startsWith("::ffff:169.254.")
  );
}

function isBlockedHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (!host) return true;
  if (host === "localhost" || host === "metadata.google.internal") return true;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  if (isPrivateIpv4(host) || isPrivateIpv6(host)) return true;
  // Treat single-label names as intranet by default. Public Slack use should
  // fetch fully qualified http(s) URLs only.
  if (!host.includes(".") && !host.includes(":")) return true;
  return false;
}

export function unsafeWebFetchReason(value: unknown, { allowPrivate = false } = {}): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return "URL must be a non-empty string";
  const raw = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return "Only fully qualified public http(s) URLs are allowed";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "Only public http(s) URLs are allowed; file/local paths are blocked";
  }
  if (!allowPrivate && isBlockedHostname(parsed.hostname)) {
    return `Local, private-network, metadata, or intranet host is blocked: ${parsed.hostname}`;
  }
  return undefined;
}

function collectFetchTextInputs(input: Record<string, unknown>): string[] {
  const values: string[] = [];
  if (typeof input.prompt === "string") values.push(input.prompt);
  if (typeof input.model === "string") values.push(input.model);
  return values;
}

function collectUrlInputs(input: Record<string, unknown>): string[] {
  const urls: string[] = [];
  if (typeof input.url === "string") urls.push(input.url);
  if (Array.isArray(input.urls)) {
    for (const url of input.urls) {
      if (typeof url === "string") urls.push(url);
    }
  }
  return urls;
}

function collectSearchInputs(input: Record<string, unknown>): string[] {
  const queries: string[] = [];
  if (typeof input.query === "string") queries.push(input.query);
  if (Array.isArray(input.queries)) {
    for (const query of input.queries) {
      if (typeof query === "string") queries.push(query);
    }
  }
  if (Array.isArray(input.domainFilter)) {
    for (const domain of input.domainFilter) {
      if (typeof domain === "string") queries.push(domain);
    }
  }
  return queries;
}

function domainFilterBlockReason(input: Record<string, unknown>, allowPrivate: boolean): string | undefined {
  if (!Array.isArray(input.domainFilter)) return undefined;
  for (const rawDomain of input.domainFilter) {
    if (typeof rawDomain !== "string") continue;
    const domain = rawDomain.trim().replace(/^-+/, "");
    if (!domain) continue;
    if (allowPrivate) continue;
    if (isBlockedHostname(domain)) return `Blocked private/intranet domain filter: ${rawDomain}`;
  }
  return undefined;
}

export function applyWebAccessSafetyToToolCall(
  event: Pick<ToolCallEvent, "toolName" | "input">,
  env = process.env,
): { block?: boolean; reason?: string } | undefined {
  const input = event.input && typeof event.input === "object"
    ? event.input as Record<string, unknown>
    : {};

  if (event.toolName === WEB_SEARCH_TOOL) {
    if (!webAccessBrowserWorkflowAllowedFromEnv(env)) {
      input.workflow = "none";
    }
    if (collectSearchInputs(input).some(containsSecretLikeText)) {
      return { block: true, reason: "Blocked web_search because the query/domain filter appears to contain a secret or credential." };
    }
    const domainReason = domainFilterBlockReason(input, webAccessPrivateFetchAllowedFromEnv(env));
    if (domainReason) return { block: true, reason: domainReason };
    return undefined;
  }

  if (event.toolName === CODE_SEARCH_TOOL) {
    if (collectSearchInputs(input).some(containsSecretLikeText)) {
      return { block: true, reason: "Blocked code_search because the query appears to contain a secret or credential." };
    }
    return undefined;
  }

  if (event.toolName === FETCH_CONTENT_TOOL) {
    const allowPrivate = webAccessPrivateFetchAllowedFromEnv(env);
    for (const url of collectUrlInputs(input)) {
      const reason = unsafeWebFetchReason(url, { allowPrivate });
      if (reason) return { block: true, reason: `Blocked fetch_content for ${JSON.stringify(url)}: ${reason}.` };
    }
    if ([...collectUrlInputs(input), ...collectFetchTextInputs(input)].some(containsSecretLikeText)) {
      return { block: true, reason: "Blocked fetch_content because a URL or prompt appears to contain a secret or credential." };
    }
  }

  return undefined;
}

export function webAccessSafetyExtension(pi: ExtensionAPI) {
  pi.on("tool_call", (event) => applyWebAccessSafetyToToolCall(event));
}

export default webAccessSafetyExtension;
