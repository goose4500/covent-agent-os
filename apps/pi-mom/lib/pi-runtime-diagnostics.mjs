const DEFAULT_PI_MOM_MODEL = "openai-codex/gpt-5.5";
const DEFAULT_PI_MOM_THINKING_LEVEL = "high";
const DEFAULT_COMPACTION_SETTINGS = Object.freeze({
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
});

export function resolvePiModelId(env = process.env) {
  return env.PI_MOM_MODEL || DEFAULT_PI_MOM_MODEL;
}

export function resolvePiThinkingLevel(env = process.env) {
  return env.PI_MOM_THINKING_LEVEL || DEFAULT_PI_MOM_THINKING_LEVEL;
}

export function parsePiModelId(modelId = DEFAULT_PI_MOM_MODEL) {
  const slash = String(modelId || "").indexOf("/");
  return {
    modelId,
    provider: slash >= 0 ? modelId.slice(0, slash) : modelId,
    id: slash >= 0 ? modelId.slice(slash + 1) : "",
  };
}

export function normalizeCompactionSettings(settings = {}) {
  return {
    enabled: settings.enabled ?? DEFAULT_COMPACTION_SETTINGS.enabled,
    reserveTokens: settings.reserveTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens,
    keepRecentTokens: settings.keepRecentTokens ?? DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
  };
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function buildPiRuntimeContextDiagnostic({
  modelId = DEFAULT_PI_MOM_MODEL,
  thinkingLevel = DEFAULT_PI_MOM_THINKING_LEVEL,
  model,
  compactionSettings,
} = {}) {
  const parsed = parsePiModelId(modelId);
  const settings = normalizeCompactionSettings(compactionSettings);
  const contextWindow = finiteNumber(model?.contextWindow);
  const maxTokens = finiteNumber(model?.maxTokens);
  const autoCompactionThreshold =
    settings.enabled && contextWindow !== undefined
      ? Math.max(0, contextWindow - settings.reserveTokens)
      : undefined;

  return {
    modelId,
    provider: parsed.provider,
    id: parsed.id,
    thinkingLevel,
    modelFound: Boolean(model),
    contextWindow,
    maxTokens,
    compaction: {
      ...settings,
      thresholdFormula: "contextWindow - reserveTokens",
      autoCompactionThreshold,
    },
  };
}

export function formatPiRuntimeContextDiagnostic(diagnostic) {
  const lines = [];
  if (!diagnostic.modelFound) {
    lines.push({ level: "error", message: `Pi SDK model not found: ${diagnostic.modelId}. Provider key missing or model id wrong?` });
    return lines;
  }

  lines.push({
    level: "ok",
    message: `Pi SDK model resolved: ${diagnostic.modelId} (thinking: ${diagnostic.thinkingLevel})`,
  });

  const contextWindow = diagnostic.contextWindow ?? "unknown";
  const maxTokens = diagnostic.maxTokens ?? "unknown";
  lines.push({
    level: diagnostic.contextWindow === undefined ? "warn" : "ok",
    message: `Pi model metadata: contextWindow=${contextWindow}, maxTokens=${maxTokens}`,
  });

  const { enabled, reserveTokens, keepRecentTokens, autoCompactionThreshold } = diagnostic.compaction;
  if (!enabled) {
    lines.push({
      level: "warn",
      message: `Pi auto-compaction: disabled; reserveTokens=${reserveTokens}; keepRecentTokens=${keepRecentTokens}`,
    });
  } else if (autoCompactionThreshold === undefined) {
    lines.push({
      level: "warn",
      message: `Pi auto-compaction: enabled; threshold unknown because contextWindow metadata is missing; reserveTokens=${reserveTokens}; keepRecentTokens=${keepRecentTokens}`,
    });
  } else {
    lines.push({
      level: "ok",
      message: `Pi auto-compaction: enabled; threshold=${autoCompactionThreshold} tokens (${diagnostic.compaction.thresholdFormula}); reserveTokens=${reserveTokens}; keepRecentTokens=${keepRecentTokens}`,
    });
  }

  return lines;
}
