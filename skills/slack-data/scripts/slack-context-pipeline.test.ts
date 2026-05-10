import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContextPack, main, normalizeExport, runPipeline, type RawSlackExport } from "./slack-context-pipeline.ts";

describe("slack-context-pipeline", () => {
  const raw: RawSlackExport = {
    source: "fixture",
    channel_id: "C123",
    exported_at: "2026-01-01T00:00:00.000Z",
    oldest: "1700000000.000000",
    latest: "1700000300.000000",
    messages: [
      {
        ts: "1700000000.000000",
        thread_ts: "1700000000.000000",
        user: "U1",
        text: "Launch plan starts here",
        reply_count: 1,
        thread_replies: [
          { ts: "1700000000.000000", user: "U1", text: "duplicate root" },
          { ts: "1700000060.000000", thread_ts: "1700000000.000000", user: "U2", text: "Use source refs" },
        ],
      },
      { ts: "1700000300.000000", user: "U3", text: "token xoxb-SYNTHETIC-SECRET must redact" },
    ],
  };

  test("normalizes parents and replies", () => {
    const messages = normalizeExport(raw, "https://example.slack.com");
    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({ id: "C123:1700000000.000000", is_reply: false, reply_count: 1 });
    expect(messages[1]).toMatchObject({ id: "C123:1700000060.000000", is_reply: true, thread_ts: "1700000000.000000" });
    expect(messages[0].permalink).toBe("https://example.slack.com/archives/C123/p1700000000000000");
  });

  test("builds text-free source map and redacted context pack", () => {
    const result = runPipeline(raw, { goal: "Prime agent", workspaceUrl: "https://example.slack.com" });
    expect(result.threads).toHaveLength(2);
    expect(JSON.stringify(result.sourceMap)).not.toContain("Launch plan starts here");
    expect(result.contextPack).toContain("[REDACTED_TOKEN]");
    expect(result.summary).toMatchObject({ source: "fixture", message_count: 3, thread_count: 2 });
  });

  test("truncates context snippets", () => {
    const pack = buildContextPack([{ ...normalizeExport(raw)[0], text: "x".repeat(200) }], [], "goal", 1);
    expect(pack).toContain("…");
  });

  test("CLI writes expected artifact directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "slack-context-pipeline-"));
    const input = join(dir, "raw.json");
    const outDir = join(dir, "out");
    await writeFile(input, JSON.stringify(raw));
    await main(["--in", input, "--out-dir", outDir, "--goal", "Prime agent", "--workspace-url", "https://example.slack.com"]);

    const messages = await readFile(join(outDir, "normalized/messages.jsonl"), "utf8");
    const sourceMap = await readFile(join(outDir, "source-map.json"), "utf8");
    const pack = await readFile(join(outDir, "context-pack.md"), "utf8");
    expect(messages.trim().split("\n")).toHaveLength(3);
    expect(sourceMap).not.toContain("Launch plan starts here");
    expect(pack).toContain("# Slack Context Pack");
  });
});
