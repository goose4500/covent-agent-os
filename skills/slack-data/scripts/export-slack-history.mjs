#!/usr/bin/env node
/**
 * Export Slack DM/channel history to JSON for local analysis.
 *
 * Requirements:
 *   - Node 18+ for global fetch
 *   - Slack token in env, default: SLACK_BOT_TOKEN or SLACK_USER_TOKEN
 *   - Token scopes must allow reading the target surface, e.g. im:history/mpim:history/channels:history/groups:history
 *
 * Example:
 *   SLACK_BOT_TOKEN=xoxb-... node export-slack-history.mjs \
 *     --channel C0123456789 --hours 72 --out ./slack-history.json
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

function parseArgs(argv) {
  const args = {
    channel: null,
    hours: 72,
    out: './slack-dm-export.json',
    limit: 200,
    includeThreads: true,
    responseMetadata: true,
    tokenEnv: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--channel') args.channel = next();
    else if (arg === '--hours') args.hours = Number(next());
    else if (arg === '--oldest') args.oldest = next();
    else if (arg === '--latest') args.latest = next();
    else if (arg === '--out') args.out = next();
    else if (arg === '--limit') args.limit = Number(next());
    else if (arg === '--token-env') args.tokenEnv = next();
    else if (arg === '--no-threads') args.includeThreads = false;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown arg: ${arg}`);
    }
  }

  if (!args.channel) throw new Error('Missing --channel');
  if (!Number.isFinite(args.limit) || args.limit < 1 || args.limit > 1000) {
    throw new Error('--limit must be between 1 and 1000');
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  args.latest ??= String(nowSeconds);
  args.oldest ??= String(nowSeconds - Math.floor(args.hours * 60 * 60));

  return args;
}

function printHelp() {
  console.log(`Export Slack DM/channel history to JSON.\n\nOptions:\n  --channel <id>       Slack channel/DM ID. Required.\n  --hours <n>          Lookback window if --oldest omitted. Default: 72\n  --oldest <ts>        Slack timestamp lower bound, e.g. 1778190349\n  --latest <ts>        Slack timestamp upper bound. Default: now\n  --out <path>         Output JSON path. Default: ./slack-dm-export.json\n  --limit <n>          Page size. Default: 200\n  --token-env <name>   Env var containing token. Default: SLACK_BOT_TOKEN then SLACK_USER_TOKEN\n  --no-threads         Do not fetch thread replies\n`);
}

function getToken(tokenEnv) {
  if (tokenEnv) return process.env[tokenEnv];
  return process.env.SLACK_BOT_TOKEN || process.env.SLACK_USER_TOKEN;
}

function slackTsToIso(ts) {
  const seconds = Number(String(ts).split('.')[0]);
  if (!Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000).toISOString();
}

async function slackApi(method, params, token) {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const retryAfter = res.headers.get('retry-after');
  if (res.status === 429 && retryAfter) {
    const waitMs = (Number(retryAfter) + 1) * 1000;
    console.warn(`Rate limited on ${method}; waiting ${waitMs}ms`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, waitMs));
    return slackApi(method, params, token);
  }

  const data = await res.json();
  if (!data.ok) {
    throw new Error(`${method} failed: ${data.error || res.statusText}`);
  }
  return data;
}

async function fetchHistory({ channel, oldest, latest, limit }, token) {
  const messages = [];
  let cursor;

  do {
    const page = await slackApi('conversations.history', {
      channel,
      oldest,
      latest,
      limit,
      cursor,
      inclusive: true,
    }, token);

    messages.push(...(page.messages || []));
    cursor = page.response_metadata?.next_cursor || '';
    console.error(`Fetched ${messages.length} messages...`);
  } while (cursor);

  return messages;
}

async function fetchThreadReplies({ channel, ts }, token) {
  const replies = [];
  let cursor;

  do {
    const page = await slackApi('conversations.replies', {
      channel,
      ts,
      limit: 200,
      cursor,
    }, token);
    replies.push(...(page.messages || []));
    cursor = page.response_metadata?.next_cursor || '';
  } while (cursor);

  return replies;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = getToken(args.tokenEnv);
  if (!token) {
    throw new Error('Missing Slack token. Set SLACK_BOT_TOKEN or SLACK_USER_TOKEN, or pass --token-env <name>.');
  }

  const rawMessages = await fetchHistory(args, token);
  const sorted = rawMessages
    .slice()
    .sort((a, b) => Number(a.ts) - Number(b.ts));

  const messages = [];
  for (const message of sorted) {
    const enriched = {
      ...message,
      iso_time: slackTsToIso(message.ts),
    };

    if (args.includeThreads && message.reply_count && message.thread_ts === message.ts) {
      const replies = await fetchThreadReplies({ channel: args.channel, ts: message.ts }, token);
      enriched.thread_replies = replies
        .filter((reply) => reply.ts !== message.ts)
        .map((reply) => ({ ...reply, iso_time: slackTsToIso(reply.ts) }));
      console.error(`Fetched ${enriched.thread_replies.length} replies for thread ${message.ts}`);
    }

    messages.push(enriched);
  }

  const exportData = {
    exported_at: new Date().toISOString(),
    source: 'slack.conversations.history',
    channel_id: args.channel,
    oldest: args.oldest,
    oldest_iso: slackTsToIso(args.oldest),
    latest: args.latest,
    latest_iso: slackTsToIso(args.latest),
    include_threads: args.includeThreads,
    message_count: messages.length,
    messages,
  };

  const outPath = resolve(args.out);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(exportData, null, 2));
  console.log(outPath);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
