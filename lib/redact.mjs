/**
 * Shared secret-redaction patterns.
 *
 * Used by:
 *   - apps/pi-mom/index.mjs           (Pi stdout, Slack-bound text, error messages)
 *   - extensions/slack-mcp-guard.ts   (Slack MCP arg previews)
 *   - lib/browser-use-client.mjs      (Browser Use API responses + errors)
 *
 * Adding a new pattern here updates every callsite.
 */

const PATTERNS = [
  // Slack tokens — preserve the prefix so logs stay debuggable.
  [/xox[baprs]-[A-Za-z0-9-]+/g, "xox[REDACTED]"],
  [/xapp-[A-Za-z0-9-]+/g, "xapp-[REDACTED]"],
  [/xoxe[.-][A-Za-z0-9.-]+/g, "xoxe[REDACTED]"],

  // OpenAI keys.
  [/sk-proj-[A-Za-z0-9_-]+/g, "sk-proj-[REDACTED]"],
  [/sk-[A-Za-z0-9_-]+/g, "sk-[REDACTED]"],

  // Linear keys.
  [/lin_api_[A-Za-z0-9_-]+/g, "lin_api_[REDACTED]"],

  // Browser Use keys.
  [/bu_[A-Za-z0-9._\-=]+/g, "bu_[REDACTED]"],

  // Authorization headers (specific before generic Bearer).
  [/Authorization:\s*Bearer\s+[^\s'"`]+/gi, "Authorization: Bearer [REDACTED]"],
  [/Authorization:\s+lin_api_[^\s'"`]+/gi, "Authorization: lin_api_[REDACTED]"],
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]"],

  // Slack auth ticket.
  [/slackauthticket\s+[A-Za-z0-9._-]+/gi, "slackauthticket [REDACTED]"],

  // Env-var assignments for known providers.
  [/((?:SLACK|OPENAI|LINEAR|BROWSER_USE)_[A-Z0-9_]*(?:TOKEN|SECRET|KEY)[A-Z0-9_]*\s*=\s*)(['"]?)[^\s'"]+/gi, "$1$2[REDACTED]"],

  // JSON-style "secret_name": "value".
  [/(["']?(?:client[_-]?secret|api[_-]?key|password|access[_-]?token|refresh[_-]?token|bearer[_-]?token|token)["']?\s*:\s*["'])([^"'\n]+)(["'])/gi, "$1[REDACTED_SECRET]$3"],

  // Bare key=value.
  [/((?:client[_-]?secret|api[_-]?key|password|access[_-]?token|refresh[_-]?token|bearer[_-]?token|token)\s*=\s*)[^\s&]+/gi, "$1[REDACTED_SECRET]"],

  // Browser Use query-string and header forms.
  [/(apiKey=)[^&\s]+/gi, "$1[REDACTED]"],
  [/(X-Browser-Use-API-Key["':\s]+)[^"'\s,}]+/gi, "$1[REDACTED]"],
];

export function redactSensitiveText(text = "") {
  let out = String(text ?? "");
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
