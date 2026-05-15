// Shared best-effort redaction for text that may be mirrored into Slack.
// Keep this conservative: prefer hiding likely credentials over preserving
// exact strings in chat/canvas surfaces.

function findSuspiciousStreamingSuffixIndex(text) {
  const windowStart = Math.max(0, text.length - 512);
  const suffix = text.slice(windowStart);
  const patterns = [
    /(?:x|xo|xox[baprs]?|xapp-?|xoxe[.-]?|sk(?:-pro?j?)?|-pro?j?-[A-Za-z0-9._-]*|gh[pousr]?_?|AIza[0-9A-Za-z_-]*|lin(?:_api?)?_?|bu_?)[A-Za-z0-9._=-]*$/i,
    /(?:PI_AUTH_JSON_B64|[A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|COOKIE|AUTH_JSON_B64)[A-Z0-9_]*)\s*[:=]\s*['"]?[^\s'"]*$/i,
    /["'](?:access_token|refresh_token|id_token|client_secret|api_key|password|secret|token)["']\s*:\s*["'][^"']*$/i,
    /\b(?:access_token|refresh_token|id_token|client_secret|api_key|password|secret|token)\b\s*:\s*['"]?[^\s,'"}]*$/i,
  ];
  let best = -1;
  for (const pattern of patterns) {
    const match = suffix.match(pattern);
    if (match?.index !== undefined) {
      const idx = windowStart + match.index;
      if (best === -1 || idx < best) best = idx;
    }
  }
  return best;
}

export function createStreamingRedactor({ redact = (text) => String(text || "") } = {}) {
  let carry = "";
  return {
    push(chunk = "") {
      const combined = carry + String(chunk || "");
      const redacted = redact(combined);
      const holdIndex = findSuspiciousStreamingSuffixIndex(redacted);
      if (holdIndex >= 0) {
        carry = redacted.slice(holdIndex);
        return redacted.slice(0, holdIndex);
      }
      carry = "";
      return redacted;
    },
    flush() {
      const out = redact(carry);
      carry = "";
      return out;
    },
  };
}

export function redactSensitiveText(text = "") {
  return String(text || "")
    .replace(/xox[baprs]-[A-Za-z0-9-]+/g, "xox[REDACTED]")
    .replace(/xapp-[A-Za-z0-9-]+/g, "xapp-[REDACTED]")
    .replace(/xoxe[.-][A-Za-z0-9.-]+/g, "xoxe[REDACTED]")
    .replace(/sk-proj-[A-Za-z0-9_-]+/g, "sk-proj-[REDACTED]")
    .replace(/sk-(?!proj-)[A-Za-z0-9_-]+/g, "sk-[REDACTED]")
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, "gh[REDACTED]")
    .replace(/bu_[A-Za-z0-9._=-]+/g, "bu_[REDACTED]")
    .replace(/(X-Browser-Use-API-Key["':\s]+)[^"'\s,}]+/gi, "$1[REDACTED]")
    .replace(/(apiKey=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/Authorization:\s*Bearer\s+[^\s'"`]+/gi, "Authorization: Bearer [REDACTED]")
    .replace(/Authorization:\s+lin_api_[^\s'"`]+/gi, "Authorization: lin_api_[REDACTED]")
    .replace(/lin_api_[A-Za-z0-9_-]+/g, "lin_api_[REDACTED]")
    .replace(/((?:PI_AUTH_JSON_B64|[A-Z0-9_]*AUTH_JSON_B64)\s*=\s*)(['"]?)[^\s'"]+/gi, "$1$2[REDACTED]")
    .replace(/(["'](?:access_token|refresh_token|id_token|client_secret|api_key|password|secret|token)["']\s*:\s*["'])[^"']+(["'])/gi, "$1[REDACTED]$2")
    .replace(/(\b(?:access_token|refresh_token|id_token|client_secret|api_key|password|secret|token)\b\s*:\s*)(['"]?)[^\s,'"}]+/gi, "$1$2[REDACTED]")
    .replace(/slackauthticket\s+[A-Za-z0-9._-]+/gi, "slackauthticket [REDACTED]")
    .replace(/((?:SLACK|OPENAI|LINEAR)_[A-Z0-9_]*(?:TOKEN|SECRET|KEY)[A-Z0-9_]*\s*=\s*)(['"]?)[^\s'"]+/gi, "$1$2[REDACTED]")
    .replace(/\b((?:[A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|COOKIE)[A-Z0-9_]*|api[_-]?key|access[_-]?token|auth[_-]?token|password|secret|cookie)\s*=\s*)(['"]?)[^\s'"]+/g, "$1$2[REDACTED]")
    .replace(/(^|\n)(\s*(?:cookie|set-cookie):\s*)[^\n]+/gi, "$1$2[REDACTED]");
}
