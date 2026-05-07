# Migration map

This repo was bootstrapped from the current local Covent/Pi automation state.

| Old local path | New repo path | Notes |
|---|---|---|
| `/home/jfloyd/.pi/agent/pi-mom/` | `apps/pi-mom/` | Slack ↔ Pi bridge. Excludes local `.slack` state, deps, logs, env. |
| `/home/jfloyd/.pi/agent/extensions/` | `extensions/` | Pi tools/guards. `env-guard.ts` copied from symlink target. |
| `/home/jfloyd/.pi/agent/lib/` | `lib/` | Shared runtime helpers. |
| `/home/jfloyd/.pi/agent/agents/` | `agents/` | Local subagent definitions. |
| `/home/jfloyd/.agents/linear-*.md` | `agents/` | User-level Linear auditor agents used in Covent work. |
| `/home/jfloyd/.pi/agent/skills/` | `skills/` | Current local Pi skills. |
| `/home/jfloyd/.agents/skills/*` | `skills/` when missing | Missing user-level skills added without overwriting local Pi versions. |
| `/home/jfloyd/.pi/agent/packages/pi-chrome-access/` | `packages/pi-chrome-access/` | Chrome/DevTools browser access package. |
| `/home/jfloyd/.pi/agent/docs/*.md` | `docs/runbooks/`, `docs/specs/` | Selected sanitized runbooks/specs. |
| `/home/jfloyd/covent-source/*SOURCE_OF_TRUTH*.md` | `docs/source-of-truth/` | Sanitized source-of-truth docs only. |
| `/home/jfloyd/pi-session-audit/2026-05-07/final-context-pack.md` | `docs/history/pi-session-context-2026-05-07.md` | Context summary; raw transcripts excluded. |

## Intentionally excluded

- Real env files and secrets.
- `node_modules/`.
- `.slack/apps.json`, `.slack/config.json`, `.slack/cache/`.
- Pi sessions/transcripts/raw JSONL.
- Logs, pidfiles, generated images, browser profiles/cookies.
