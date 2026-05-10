export function redactSensitiveText(text = "") {
  return text
    .replace(/xox[baprs]-[A-Za-z0-9-]+/g, "xox[REDACTED]")
    .replace(/xapp-[A-Za-z0-9-]+/g, "xapp-[REDACTED]")
    .replace(/xoxe[.-][A-Za-z0-9.-]+/g, "xoxe[REDACTED]")
    .replace(/sk-proj-[A-Za-z0-9_-]+/g, "sk-proj-[REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-[REDACTED]")
    .replace(/Authorization:\s*Bearer\s+[^\s'"`]+/gi, "Authorization: Bearer [REDACTED]")
    .replace(/Authorization:\s+lin_api_[^\s'"`]+/gi, "Authorization: lin_api_[REDACTED]")
    .replace(/lin_api_[A-Za-z0-9_-]+/g, "lin_api_[REDACTED]")
    .replace(/slackauthticket\s+[A-Za-z0-9._-]+/gi, "slackauthticket [REDACTED]")
    .replace(/((?:SLACK|OPENAI|LINEAR)_[A-Z0-9_]*(?:TOKEN|SECRET|KEY)[A-Z0-9_]*\s*=\s*)(['"]?)[^\s'"]+/gi, "$1$2[REDACTED]");
}

export function cleanTerminalSequences(text = "") {
  return text
    // Strip OSC terminal notifications like: ESC ] 777 ; notify ; ... BEL
    .replace(/\][^]*(?:|\\)/g, "")
    // Strip common ANSI escape sequences.
    .replace(/\[[0-?]*[ -/]*[@-~]/g, "");
}

export function cleanPiOutput(text = "") {
  return redactSensitiveText(cleanTerminalSequences(text));
}

export function stripTerminalSequences(text) {
  return cleanPiOutput(text).trim();
}
