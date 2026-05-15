import { redactSensitiveText } from "./redaction.mjs";
import { normalizeSlackMarkdown, slackSafeOneLine } from "./slack-format.mjs";

function extractErrorText(error) {
  if (!error) return "";
  const candidates = [
    error.message,
    error?.data?.error,
    error?.data?.response_metadata?.messages?.join(" "),
    typeof error === "string" ? error : "",
  ];
  const text = candidates.find((value) => typeof value === "string" && value.trim());
  if (text) return text;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function inferFailure(errorText = "") {
  const text = String(errorText || "");
  const lower = text.toLowerCase();
  const piTimeout = text.match(/Pi timed out after\s+([0-9]+)\s*ms/i);
  if (piTimeout) {
    const timeoutMs = Number(piTimeout[1]);
    const seconds = Number.isFinite(timeoutMs) ? Math.round(timeoutMs / 1000) : undefined;
    return {
      category: "timeout",
      explanation: seconds
        ? `Pi did not finish before the ${seconds}s bridge timeout.`
        : "Pi did not finish before the bridge timeout.",
      retry: "Retry with a narrower prompt or ask for a direct/non-browser fallback. For Browser Use, split broad navigation into smaller direct-URL checks.",
    };
  }

  const browserUse = /browser[ -]?use|BROWSER_USE_API_KEY|X-Browser-Use-API-Key|\bbu_[A-Za-z0-9._=-]+/i.test(text);
  const authish = /api[_ -]?key|auth(?:entication|orization)?|unauthori[sz]ed|forbidden|credential|token|401|403|login required|not authenticated/i.test(text);
  const browserSessionTimeout = /timed out waiting for Browser Use session|browser[ -]?use.*timed out|timed out.*browser[ -]?use/i.test(text);

  if (browserUse && browserSessionTimeout) {
    return {
      category: "timeout",
      explanation: "Browser Use did not finish before the local wait limit, so Pi could not return a completed result.",
      retry: "Retry with a smaller Browser Use task or provide direct URLs. As a fallback, ask Pi to answer with non-browser tools.",
    };
  }

  if (browserUse && authish) {
    return {
      category: "auth",
      explanation: "Browser Use authentication/configuration failed before the tool could return a result.",
      retry: "Retry after Browser Use configuration is checked, or ask Pi to proceed without Browser Use.",
    };
  }

  if (browserUse) {
    return {
      category: "tool",
      explanation: "Browser Use failed before returning a usable result.",
      retry: "Retry with a narrower task/direct URL, or ask Pi for a non-browser fallback.",
    };
  }

  if (authish) {
    return {
      category: "auth",
      explanation: "An integration rejected authentication or required credentials were unavailable.",
      retry: "Retry after the integration config is checked, or ask for a fallback that does not use that tool.",
    };
  }

  if (/\btool\b|extension|mcp|api\s+[0-9]{3}|linear|slack|fetch failed|network|econnreset|enotfound/i.test(lower)) {
    return {
      category: "tool",
      explanation: "A tool or external integration failed before Pi could complete the run.",
      retry: "Retry once; if it repeats, ask Pi to use a smaller scope or a fallback path without that tool.",
    };
  }

  return {
    category: "unknown",
    explanation: "Pi stopped before producing a final answer.",
    retry: "Retry once with a shorter prompt. If it repeats, use a narrower route or ask for a fallback summary.",
  };
}

export function buildPiFailureSummary({ error, requestId, redact = redactSensitiveText } = {}) {
  const rawText = extractErrorText(error);
  const redactedText = redact(rawText);
  const inferred = inferFailure(redactedText);
  const detail = slackSafeOneLine(redactedText, { max: 260 });
  return {
    requestId: requestId || "unknown",
    category: inferred.category,
    explanation: inferred.explanation,
    retry: inferred.retry,
    detail,
  };
}

export function formatPiFailureForSlack({ error, requestId, redact = redactSensitiveText } = {}) {
  const summary = buildPiFailureSummary({ error, requestId, redact });
  const detailLine = summary.detail ? `\n• details: ${summary.detail}` : "";
  return normalizeSlackMarkdown(
    `⚠️ *Pi run failed* (req: \`${summary.requestId}\`)\n` +
      `• category: \`${summary.category}\`\n` +
      `• what happened: ${summary.explanation}${detailLine}\n` +
      `• try next: ${summary.retry}`,
  );
}
