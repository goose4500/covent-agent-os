import assert from "node:assert/strict";
import {
  buildPiRuntimeContextDiagnostic,
  formatPiRuntimeContextDiagnostic,
  normalizeCompactionSettings,
  parsePiModelId,
  resolvePiModelId,
  resolvePiThinkingLevel,
} from "./lib/pi-runtime-diagnostics.mjs";

assert.deepEqual(parsePiModelId("openai-codex/gpt-5.5"), {
  modelId: "openai-codex/gpt-5.5",
  provider: "openai-codex",
  id: "gpt-5.5",
});

assert.equal(resolvePiModelId({}), "openai-codex/gpt-5.5");
assert.equal(resolvePiModelId({ PI_MOM_MODEL: "openai/gpt-5.5-pro" }), "openai/gpt-5.5-pro");
assert.equal(resolvePiThinkingLevel({}), "high");
assert.equal(resolvePiThinkingLevel({ PI_MOM_THINKING_LEVEL: "medium" }), "medium");

assert.deepEqual(normalizeCompactionSettings({}), {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
});

{
  const diagnostic = buildPiRuntimeContextDiagnostic({
    modelId: "openai-codex/gpt-5.5",
    thinkingLevel: "high",
    model: { contextWindow: 272000, maxTokens: 128000 },
    compactionSettings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
  });

  assert.equal(diagnostic.modelFound, true);
  assert.equal(diagnostic.contextWindow, 272000);
  assert.equal(diagnostic.maxTokens, 128000);
  assert.equal(diagnostic.compaction.autoCompactionThreshold, 255616);

  const lines = formatPiRuntimeContextDiagnostic(diagnostic).map((line) => line.message);
  assert.ok(lines.some((line) => line.includes("Pi SDK model resolved: openai-codex/gpt-5.5")));
  assert.ok(lines.some((line) => line.includes("contextWindow=272000, maxTokens=128000")));
  assert.ok(lines.some((line) => line.includes("threshold=255616 tokens")));
}

{
  const diagnostic = buildPiRuntimeContextDiagnostic({
    modelId: "openai-codex/gpt-5.5",
    model: { contextWindow: 272000, maxTokens: 128000 },
    compactionSettings: { enabled: false, reserveTokens: 16384, keepRecentTokens: 20000 },
  });

  assert.equal(diagnostic.compaction.autoCompactionThreshold, undefined);
  assert.ok(formatPiRuntimeContextDiagnostic(diagnostic).some((line) => line.level === "warn" && line.message.includes("disabled")));
}

{
  const diagnostic = buildPiRuntimeContextDiagnostic({ modelId: "missing/model", model: undefined });
  const lines = formatPiRuntimeContextDiagnostic(diagnostic);
  assert.equal(diagnostic.modelFound, false);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].level, "error");
  assert.ok(lines[0].message.includes("Pi SDK model not found: missing/model"));
}

console.log("ok pi runtime diagnostics");
