import assert from "node:assert/strict";
import { estimateTokens, estimatePromptSize } from "./lib/token-estimator.mjs";

// Case 1: empty string → 0 tokens.
{
  assert.equal(estimateTokens(""), 0, "empty string is 0 tokens");
}

// Case 2: "hello world" is 11 chars → ceil(11/4) = 3 tokens.
{
  assert.equal(estimateTokens("hello world"), 3, "11 chars → 3 tokens");
}

// Case 3: null/undefined are tolerated and yield 0 (no throw).
{
  assert.equal(estimateTokens(null), 0, "null is 0 tokens");
  assert.equal(estimateTokens(undefined), 0, "undefined is 0 tokens");
}

// Case 4: estimatePromptSize, T0 (no summary), 10 messages, 2 attachments.
{
  const header = "thread context (msg_count: 10)";
  const rawTail = Array.from({ length: 10 }, (_, i) => ({
    user: `U${i}`,
    text: `message body number ${i}`,
  }));
  const attachments = [
    { file_id: "F1", mimetype: "image/png", description: "a chart" },
    { file_id: "F2", mimetype: "image/jpeg", description: "a screenshot" },
  ];

  const out = estimatePromptSize({
    header,
    summaryBlock: null,
    rawTail,
    attachments,
  });

  assert.equal(out.tier, "T0", "no summary → T0");
  assert.equal(out.has_summary, false, "has_summary false when no summaryBlock");
  assert.equal(out.msg_count, 10, "msg_count from rawTail.length");
  assert.equal(out.file_count, 2, "file_count from attachments.length");
  assert.ok(typeof out.tokens_est === "number", "tokens_est is a number");
  assert.ok(out.tokens_est > 0, "tokens_est is positive for non-empty input");
}

// Case 5: estimatePromptSize, T1 (with summary), 25 messages, 5 attachments.
{
  const header = "thread context (msg_count: 25)";
  const summaryBlock = "Summary: the team discussed onboarding and shipping plans.";
  const rawTail = Array.from({ length: 25 }, (_, i) => ({
    user: `U${i}`,
    text: `recent message ${i}`,
  }));
  const attachments = Array.from({ length: 5 }, (_, i) => ({
    file_id: `F${i}`,
    mimetype: "image/png",
    description: `image ${i}`,
  }));

  const out = estimatePromptSize({
    header,
    summaryBlock,
    rawTail,
    attachments,
  });

  assert.equal(out.tier, "T1", "summaryBlock present → T1");
  assert.equal(out.has_summary, true, "has_summary true when summaryBlock present");
  assert.equal(out.msg_count, 25, "msg_count from rawTail.length");
  assert.equal(out.file_count, 5, "file_count from attachments.length");
  assert.ok(typeof out.tokens_est === "number", "tokens_est is a number");
  assert.ok(out.tokens_est > 0, "tokens_est is positive");
}

// Case 6: estimatePromptSize is pure — same input → identical output.
{
  const input = {
    header: "thread context (msg_count: 3)",
    summaryBlock: "a brief summary",
    rawTail: [
      { user: "U1", text: "one" },
      { user: "U2", text: "two" },
      { user: "U3", text: "three" },
    ],
    attachments: [{ file_id: "F1", mimetype: "image/png", description: "x" }],
  };
  const a = estimatePromptSize(input);
  const b = estimatePromptSize(input);
  assert.deepEqual(a, b, "pure: same input → same output");
}

// Case 7: msg_count fallback — rawTail as string + explicit msgCount.
{
  const out = estimatePromptSize({
    header: "no count here",
    summaryBlock: null,
    rawTail: "rendered-string-form-of-messages",
    attachments: null,
    msgCount: 7,
  });
  assert.equal(out.msg_count, 7, "msg_count falls back to explicit msgCount");
  assert.equal(out.file_count, 0, "file_count is 0 when attachments not an array");
  assert.equal(out.tier, "T0", "no summary → T0");
}

// Case 8: msg_count derived from header substring when no array & no msgCount.
{
  const out = estimatePromptSize({
    header: "context window — 42 messages — truncated",
    summaryBlock: null,
    rawTail: "string-tail",
    attachments: null,
  });
  assert.equal(out.msg_count, 42, "msg_count parsed from header substring");
}

// Case 9: all-undefined input is tolerated.
{
  const out = estimatePromptSize();
  assert.equal(out.tokens_est, 0);
  assert.equal(out.msg_count, 0);
  assert.equal(out.file_count, 0);
  assert.equal(out.has_summary, false);
  assert.equal(out.tier, "T0");
}

console.log("token-estimator tests passed");
