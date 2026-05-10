# Slack Data Output Contracts

## Raw export JSON

Produced by `export-slack-history.mjs`:

```json
{
  "exported_at": "2026-05-10T22:00:00.000Z",
  "source": "slack.conversations.history",
  "channel_id": "C0123456789",
  "oldest": "1778190349",
  "latest": "1778449549",
  "include_threads": true,
  "message_count": 79,
  "messages": []
}
```

`messages[]` contains raw Slack message objects plus `iso_time`; threaded parents may include `thread_replies[]`.

## Pipeline artifacts

Produced by `slack-context-pipeline.ts`:

```text
normalized/messages.jsonl
normalized/threads.jsonl
source-map.json
summary.json
context-pack.md
```

- `messages.jsonl`: normalized message rows with text for local summarization.
- `threads.jsonl`: thread aggregates.
- `source-map.json`: IDs/timestamps/thread IDs/permalinks only; no raw text.
- `summary.json`: counts/source/window metadata.
- `context-pack.md`: small agent-facing summary.

Raw/private Slack text should stay local unless the current user explicitly asks otherwise.
