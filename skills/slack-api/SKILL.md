---
name: slack-api
description: >-
  Use when the assistant needs to call the Slack Web API directly via the
  in-process `slack_api` tool — posting a thread reply, reading messages,
  looking up a user by email, searching Slack history, adding reactions, or
  any other Slack read/write that doesn't go through the Slack MCP server.
  Covers auth (bot vs user token), the {ok:bool} response convention,
  rate-limit etiquette, mutation safety, and idempotency for thread posts.
---
# Slack Web API (`slack_api` tool)

Use this skill whenever you need to read or write Slack from inside Pi via
the native `slack_api` custom tool. The Slack MCP server remains a fallback,
but `slack_api` is the preferred path: single tool, no MCP hop, predictable
error shape, and the same allowlist on every call.

## When to use this tool

- The user asks to post, react, pin, look up, or search anything in Slack.
- You need to read a thread (`conversations.replies`) before deciding to reply.
- You need to resolve a Slack identity from an email or user ID.

If the user asks for a Slack action that's outside the v1 allowlist (file
upload, canvas write, list write, scheduled message, etc.) — see "Future" at
the bottom; for now, tell the user the action is deferred.

## Auth + endpoint

- Endpoint: `POST https://slack.com/api/<method>` with
  `Authorization: Bearer <token>` and `Content-Type: application/json`.
- The `slack_api` tool builds the URL and headers for you. You only pass
  `method` and a JSON `params` object.
- Token resolution:
  - Default: uses `SLACK_BOT_TOKEN` (xoxb-). Covers ~95% of methods.
  - `as_user: true`: uses `SLACK_USER_TOKEN` (xoxp-). Required for
    `search.messages`, `search.files`, and a few user-scoped reads/writes.
    Set this only when the method requires it OR the user explicitly asked
    to act as themselves.
- If the required token isn't set, the tool returns `isError: true` with a
  clear message naming which env var is missing — relay that to the user.

## The `{ok: bool}` response convention

Every Slack response (HTTP 200 or otherwise) is JSON with a top-level `ok`
boolean. The `slack_api` tool already checks it for you and converts
`ok: false` into `isError: true` with the `error` code in the message. The
codes you'll see most:

- `not_in_channel` — bot isn't a member; user must `/invite` it first.
- `channel_not_found` — channel ID is wrong or the bot can't see it.
- `missing_scope` — manifest doesn't grant a scope this method needs.
- `invalid_blocks` — Block Kit JSON is malformed.
- `ratelimited` — you exceeded the per-method tier (see next section).
- `user_not_found` — email/user ID didn't resolve.

When you see one of these in tool output, fix the call or explain the
constraint to the user. Don't retry blindly.

## Rate-limit etiquette

Slack tiers methods 1–4 (1 = strictest). The most relevant cap:

- `chat.postMessage`: ~1 message per second per channel.

On a real HTTP 429 the `slack_api` tool returns `isError: true` with the
`Retry-After` header value surfaced in the error text. **Never tight-loop on
a 429.** Either:

1. Wait at least the Retry-After value before retrying, OR
2. Hand control back to the user with the wait time, OR
3. Batch the work into fewer calls.

If you're about to chain multiple `chat.postMessage` calls to the same
channel, stop and reconsider — almost always a single message with multiple
lines or blocks is better.

## Mutation safety

The v1 allowlist is the safety floor: only ~25 vetted methods are reachable
without an env override. Within that set, write methods are:

```
chat.postMessage  chat.update  chat.delete
reactions.add  reactions.remove
pins.add  pins.remove
bookmarks.add
conversations.invite
```

Per project policy, writes require explicit user intent in the current
conversation. Do not chain `slack_api` writes from an inferred request —
quote the user's exact ask back to them and proceed only on confirmation.

The tool surfaces `mutation: true` in the result's `details` for the guard
layer. The existing `slack-mcp-guard.ts` extension owns the MCP confirm UX;
a future `slack-api-guard.ts` will mirror it for the native path. Until then,
treat the allowlist + your own explicit-intent check as the gate.

## Idempotency discipline (read this before posting)

The single biggest failure mode for a Slack bot is **double-replying to the
same thread.** Before any `chat.postMessage` with a `thread_ts`, call
`conversations.replies` with the same `channel` + `ts` and scan the result
for an existing reply from your bot user with the same content (or close
enough that a duplicate would be obvious). If you find one, do not post
again — return the existing permalink instead.

Hard rule: never call `chat.postMessage` twice with the same `thread_ts` in
a single turn. If you need to say two things, combine them.

## Core recipes

### 1. Post a reply in a thread

```json
{
  "method": "chat.postMessage",
  "params": {
    "channel": "C0123456789",
    "thread_ts": "1715600000.123456",
    "text": "Reply body here. Markdown-ish: *bold*, _italic_, <https://...|link>."
  }
}
```

- `thread_ts` is the parent message's `ts` (not the reply's).
- Plain `text` is fine for short replies; use `blocks` for rich formatting.
- Returns `{ok:true, ts:"...", channel:"...", message:{...}}`.

### 2. Read a thread

```json
{
  "method": "conversations.replies",
  "params": {
    "channel": "C0123456789",
    "ts": "1715600000.123456",
    "limit": 100
  }
}
```

- Returns `{ok:true, messages:[...], has_more:bool}`.
- Use this BEFORE posting to enforce idempotency (see section above).

### 3. Search Slack history (requires user token)

```json
{
  "method": "search.messages",
  "params": {
    "query": "in:#idea-specs from:@jake \"canvas sink\"",
    "count": 10
  },
  "as_user": true
}
```

- `search.*` requires `SLACK_USER_TOKEN`; pass `as_user: true`.
- Query syntax matches Slack's UI search (`in:`, `from:`, `before:`, quotes).
- Returns `{ok:true, messages:{total:N, matches:[...]}}`.

### 4. Look up a user by email

```json
{
  "method": "users.lookupByEmail",
  "params": { "email": "jake@example.com" }
}
```

- Returns `{ok:true, user:{id:"U...", name:"...", profile:{...}}}`.
- On `users_not_found`, the email isn't in the workspace.

## Future (not in v1)

These are deliberately out of scope for the v1 `slack_api` tool and will
arrive in a later pass:

- **File upload**: `files.upload` was removed in March 2025; the 3-step
  replacement (`files.getUploadURLExternal` → PUT bytes → `files.completeUploadExternal`)
  is deferred until we wire byte-stream handling end-to-end.
- **Canvas API**: `canvases.create`, `canvases.edit`, etc. (the
  `canvas-sink.mjs` path already covers Pi-run canvases; standalone canvas
  authoring is the next pass).
- **Lists API**: `slackLists.*`.
- **assistant.threads.\***: native Slack assistant thread methods.
- **Sub-team scoping**: `usergroups.users.list`, scoped reads.
