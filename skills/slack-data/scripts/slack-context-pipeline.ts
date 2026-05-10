#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type RawSlackMessage = {
  ts?: string;
  channel?: string;
  channel_id?: string;
  user?: string;
  username?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  permalink?: string;
  iso_time?: string;
  thread_replies?: RawSlackMessage[];
};

export type RawSlackExport = {
  source?: string;
  channel_id?: string;
  exported_at?: string;
  oldest?: string;
  latest?: string;
  messages?: RawSlackMessage[];
};

export type Message = {
  id: string;
  channel_id: string;
  ts: string;
  iso_time: string | null;
  user: string | null;
  text: string;
  thread_ts: string;
  is_reply: boolean;
  reply_count: number;
  permalink: string;
};

export type Thread = {
  id: string;
  channel_id: string;
  thread_ts: string;
  message_count: number;
  reply_count: number;
  participants: string[];
  permalink: string;
};

export type SourceMap = {
  generated_at: string;
  workspace_url?: string;
  counts: { messages: number; threads: number; with_permalink: number };
  messages: Array<Pick<Message, "id" | "channel_id" | "ts" | "iso_time" | "user" | "thread_ts" | "is_reply" | "permalink">>;
  by_id: Record<string, string>;
  by_thread: Record<string, string[]>;
};

export type PipelineResult = {
  messages: Message[];
  threads: Thread[];
  sourceMap: SourceMap;
  contextPack: string;
  summary: Record<string, unknown>;
};

export const HELP_TEXT = `Build local Slack context artifacts from an export JSON.

Options:
  --in <raw-export.json>       Input JSON from export-slack-history.mjs
  --out-dir <dir>              Output artifact directory
  --goal <text>                Goal for the context pack
  --workspace-url <url>        Optional https://workspace.slack.com for permalinks
  --max-messages <n>           Timeline message limit (default 30)
  -h, --help                   Show this help`;

export function slackTsToIso(ts?: string): string | null {
  const seconds = Number(String(ts ?? "").split(".")[0]);
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;
}

export function slackPermalink(workspaceUrl: string | undefined, channel: string, ts: string): string {
  if (workspaceUrl && /^https:\/\/[A-Za-z0-9.-]+\.slack\.com\/?$/.test(workspaceUrl)) {
    const [seconds, fraction = ""] = ts.split(".");
    return `${workspaceUrl.replace(/\/+$/, "")}/archives/${encodeURIComponent(channel)}/p${seconds}${fraction.padEnd(6, "0")}`;
  }
  return `slack://${channel}/p${ts.replace(".", "")}`;
}

export function redact(text: string): string {
  return text
    .replace(/\bxox(?:[abprs]|app)-[A-Za-z0-9-]+\b/g, "[REDACTED_TOKEN]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer [REDACTED_TOKEN]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^\s"',}]+/gi, (match) => `${match.split(/[:=]/)[0]}=[REDACTED_TOKEN]`);
}

export function snippet(value: unknown, max = 140): string {
  const compact = redact(String(value ?? ""))
    .replace(/<([^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<([^>]+)>/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 1).trimEnd()}…`;
}

export function normalizeExport(raw: RawSlackExport, workspaceUrl?: string): Message[] {
  const messages: Message[] = [];
  const seen = new Set<string>();
  const parents = Array.isArray(raw.messages) ? raw.messages : [];

  const add = (m: RawSlackMessage, parent?: Message) => {
    if (!m.ts) return;
    const channel = m.channel_id || m.channel || parent?.channel_id || raw.channel_id || "unknown-channel";
    const threadTs = m.thread_ts || parent?.thread_ts || m.ts;
    const id = `${channel}:${m.ts}`;
    if (seen.has(id)) return;
    seen.add(id);
    messages.push({
      id,
      channel_id: channel,
      ts: m.ts,
      iso_time: m.iso_time || slackTsToIso(m.ts),
      user: m.user || m.username || null,
      text: typeof m.text === "string" ? m.text : "",
      thread_ts: threadTs,
      is_reply: m.ts !== threadTs,
      reply_count: m.ts === threadTs ? (m.reply_count ?? m.thread_replies?.filter((r) => r.ts !== m.ts).length ?? 0) : 0,
      permalink: m.permalink || slackPermalink(workspaceUrl, channel, m.ts),
    });
  };

  for (const parent of parents) {
    add(parent);
    const root = messages.find((m) => m.ts === parent.ts && m.channel_id === (parent.channel_id || parent.channel || raw.channel_id || "unknown-channel"));
    for (const reply of parent.thread_replies || []) if (reply.ts !== parent.ts) add(reply, root);
  }

  return messages.sort((a, b) => Number(a.ts) - Number(b.ts) || a.id.localeCompare(b.id));
}

export function buildThreads(messages: Message[]): Thread[] {
  const groups = new Map<string, Message[]>();
  for (const message of messages) {
    const key = `${message.channel_id}:${message.thread_ts}`;
    groups.set(key, [...(groups.get(key) || []), message]);
  }
  return [...groups.entries()].map(([id, group]) => {
    const sorted = group.sort((a, b) => Number(a.ts) - Number(b.ts));
    const root = sorted.find((m) => !m.is_reply) || sorted[0];
    return {
      id,
      channel_id: root.channel_id,
      thread_ts: root.thread_ts,
      message_count: sorted.length,
      reply_count: sorted.filter((m) => m.is_reply).length,
      participants: [...new Set(sorted.map((m) => m.user).filter(Boolean) as string[])].sort(),
      permalink: root.permalink,
    };
  }).sort((a, b) => Number(a.thread_ts) - Number(b.thread_ts));
}

export function buildSourceMap(messages: Message[], threads: Thread[], workspaceUrl?: string): SourceMap {
  const by_thread: Record<string, string[]> = {};
  const by_id: Record<string, string> = {};
  for (const message of messages) {
    by_id[message.id] = message.permalink;
    const key = `${message.channel_id}:${message.thread_ts}`;
    by_thread[key] = [...(by_thread[key] || []), message.id];
  }
  return {
    generated_at: new Date().toISOString(),
    ...(workspaceUrl ? { workspace_url: workspaceUrl } : {}),
    counts: { messages: messages.length, threads: threads.length, with_permalink: messages.filter((m) => m.permalink).length },
    messages: messages.map(({ id, channel_id, ts, iso_time, user, thread_ts, is_reply, permalink }) => ({ id, channel_id, ts, iso_time, user, thread_ts, is_reply, permalink })),
    by_id,
    by_thread,
  };
}

export function buildContextPack(messages: Message[], threads: Thread[], goal: string, maxMessages = 30): string {
  const participants = new Map<string, number>();
  for (const message of messages) if (message.user) participants.set(message.user, (participants.get(message.user) || 0) + 1);
  const recent = messages.slice(-Math.max(1, maxMessages));
  return [
    "# Slack Context Pack",
    "",
    "## Goal",
    snippet(goal, 300) || "(unspecified)",
    "",
    "## Counts",
    `- Messages: ${messages.length}`,
    `- Threads: ${threads.length}`,
    `- Channels: ${new Set(messages.map((m) => m.channel_id)).size}`,
    "",
    "## Participants",
    ...([...participants.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([user, count]) => `- ${user}: ${count}`) || ["- None"]),
    "",
    "## Active Threads",
    ...(threads.slice(0, 12).map((t) => `- [${t.id}](${t.permalink}) (${t.message_count} messages); participants: ${t.participants.join(", ") || "unknown"}`) || ["- None"]),
    "",
    "## Compact Timeline",
    ...(recent.map((m) => `- ${m.iso_time || m.ts} — ${m.user || "unknown"} — ${snippet(m.text, 120) || "(no text)"} ([${m.id}](${m.permalink}))`) || ["- None"]),
    "",
    "## Source Map",
    "See `source-map.json` for message IDs, timestamps, thread IDs, and permalinks. Raw Slack text is intentionally omitted from the source map.",
    "",
  ].join("\n");
}

export function toJsonl(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : "");
}

export function runPipeline(raw: RawSlackExport, options: { goal: string; workspaceUrl?: string; maxMessages?: number }): PipelineResult {
  const messages = normalizeExport(raw, options.workspaceUrl);
  const threads = buildThreads(messages);
  const sourceMap = buildSourceMap(messages, threads, options.workspaceUrl);
  const contextPack = buildContextPack(messages, threads, options.goal, options.maxMessages);
  const summary = { source: raw.source || "slack-export", exported_at: raw.exported_at || null, channel_id: raw.channel_id || null, oldest: raw.oldest || null, latest: raw.latest || null, message_count: messages.length, thread_count: threads.length };
  return { messages, threads, sourceMap, contextPack, summary };
}

export function parseArgs(argv: string[]): { inPath: string; outDir: string; goal: string; workspaceUrl?: string; maxMessages?: number; help?: boolean } {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { inPath: "", outDir: "", goal: "", help: true };
    const value = argv[i + 1];
    if (!arg.startsWith("--") || !value || value.startsWith("--")) throw new Error(`Invalid or missing value for ${arg}`);
    args.set(arg, value);
    i += 1;
  }
  const inPath = args.get("--in");
  const outDir = args.get("--out-dir");
  const goal = args.get("--goal");
  if (!inPath || !outDir || !goal) throw new Error("Required: --in <raw-export.json> --out-dir <dir> --goal <text>");
  const maxRaw = args.get("--max-messages");
  const maxMessages = maxRaw ? Number(maxRaw) : undefined;
  if (maxRaw && (!Number.isInteger(maxMessages) || maxMessages < 1)) throw new Error("--max-messages must be a positive integer");
  return { inPath, outDir, goal, workspaceUrl: args.get("--workspace-url"), maxMessages };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) return void console.log(HELP_TEXT);
  const raw = JSON.parse(await readFile(args.inPath, "utf8")) as RawSlackExport;
  const result = runPipeline(raw, args);
  await mkdir(join(args.outDir, "normalized"), { recursive: true });
  await writeFile(join(args.outDir, "normalized/messages.jsonl"), toJsonl(result.messages));
  await writeFile(join(args.outDir, "normalized/threads.jsonl"), toJsonl(result.threads));
  await writeFile(join(args.outDir, "source-map.json"), `${JSON.stringify(result.sourceMap, null, 2)}\n`);
  await writeFile(join(args.outDir, "summary.json"), `${JSON.stringify(result.summary, null, 2)}\n`);
  await writeFile(join(args.outDir, "context-pack.md"), result.contextPack);
  console.log(args.outDir);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
