---
name: claude-code-hooks
description: Claude Code hooks for intercepting lifecycle events, validating or blocking actions, auto-responding, injecting context, and automating workflows.
---


# Claude Code Hooks — Master Skill

> 21 lifecycle events. 4 handler types. Python scripts on stdin/stdout.

Hooks fire at specific points in Claude Code's lifecycle. Each hook receives JSON on stdin, can
return JSON on stdout, and can optionally block the action (exit code 2). This skill covers
**writing hook scripts** (Python), **configuring hooks**, and **combining hooks** for powerful
automation patterns.

## Decision Router

| Goal | Go to |
|------|-------|
| Write a hook script for a specific event | `references/hook-events.md` → find your event |
| Block dangerous commands before execution | [PreToolUse Patterns](#pretooluse--block-validate-rewrite) |
| Auto-approve or deny permissions | [PermissionRequest Patterns](#permissionrequest--auto-approve-or-deny) |
| Run linters/tests after file edits | [PostToolUse Patterns](#posttooluse--react-to-tool-results) |
| Inject context at session start | [SessionStart Patterns](#sessionstart--environment-setup) |
| Prevent premature stopping | [Stop Hook Patterns](#stop--verify-before-finishing) |
| Understand all 21 events | `references/hook-events.md` |
| See Python recipes for common tasks | `references/python-recipes.md` |
| Debug hooks not firing | [Troubleshooting](#troubleshooting) |

---

## Configuration

Hooks live in `settings.json` at any scope:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "python3 ~/.claude/hooks/validate_bash.py",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

**Scopes** (all merge — all matching hooks run):
- `~/.claude/settings.json` — user-level, all projects
- `.claude/settings.json` — project-level, shareable via git
- `.claude/settings.local.json` — project-level, local only (gitignored)

**Handler types:**

| Type | How it works | Timeout | Supports blocking? |
|------|-------------|---------|-------------------|
| `command` | Shell script, JSON on stdin/stdout | 600s | Yes (exit code 2) |
| `http` | POST JSON to URL, JSON response | 30s | Yes (via JSON response) |
| `prompt` | Single-turn Claude Haiku eval | 30s | Yes (`ok: false`) |
| `agent` | Subagent with tool access (up to 50 turns) | 60s | Yes (`ok: false`) |

Not all events support all types. `command` works everywhere. `prompt` and `agent` only work
on: PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest, UserPromptSubmit, Stop,
SubagentStop, TaskCompleted.

**Matchers** are regex patterns tested against event-specific values:

| Event category | Matches against | Example |
|---------------|----------------|---------|
| Tool events (Pre/Post/Permission) | Tool name | `Bash`, `Edit\|Write`, `mcp__memory__.*` |
| SessionStart | Source | `startup`, `resume` |
| SessionEnd | Reason | `logout`, `clear` |
| Notification | Type | `permission_prompt`, `idle_prompt` |
| Subagent events | Agent type | `Explore`, `Plan` |
| Compact events | Trigger | `manual`, `auto` |

Events without matcher support (always fire): UserPromptSubmit, Stop, TeammateIdle,
TaskCompleted, WorktreeCreate, WorktreeRemove, InstructionsLoaded.

---

## Common Input (All Hooks Receive)

```json
{
  "session_id": "abc123",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/home/user/project",
  "permission_mode": "default",
  "hook_event_name": "PreToolUse"
}
```

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success — parse stdout for JSON |
| `2` | Block the action (blockable events only) — stderr shown to Claude |
| Other | Non-blocking error — stderr in verbose mode, execution continues |

## Conflict Resolution

When multiple hooks fire for the same event, they run **in parallel**. Blocking decisions
(exit 2, `deny`, `block`) **always win** over allowing decisions.

---

## The Big 5: Most Useful Hook Patterns

### PreToolUse — Block, Validate, Rewrite

Fires before every tool call. The most powerful hook — can block execution, modify arguments,
or add context.

```python
#!/usr/bin/env python3
"""Block dangerous Bash commands before execution."""
import json, sys, re

request = json.load(sys.stdin)
tool = request.get("tool_name", "")
tool_input = request.get("tool_input", {})

if tool == "Bash":
    cmd = tool_input.get("command", "")
    dangerous = [
        r"\brm\s+-rf\s+/",          # rm -rf /
        r"\bgit\s+push\s+--force",   # force push
        r"\bgit\s+reset\s+--hard",   # hard reset
        r"\bdrop\s+database\b",      # SQL drop
    ]
    for pattern in dangerous:
        if re.search(pattern, cmd, re.IGNORECASE):
            print(f"BLOCKED: {pattern} matched in: {cmd}", file=sys.stderr)
            sys.exit(2)

# Rewrite: add timeout to long-running commands
if tool == "Bash" and "npm test" in tool_input.get("command", ""):
    json.dump({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow",
            "updatedInput": {
                "command": tool_input["command"],
                "timeout": 300000,  # 5 min max
            },
        }
    }, sys.stdout)
```

**Config:** `"matcher": "Bash"` — only fires for Bash tool.

**Output options:**
- `permissionDecision: "allow"` — skip permission dialog
- `permissionDecision: "deny"` — block with reason
- `permissionDecision: "ask"` — still show dialog (default)
- `updatedInput: {...}` — modify tool arguments before execution

### PermissionRequest — Auto-Approve or Deny

Fires when Claude would show a permission dialog. Respond programmatically.

```python
#!/usr/bin/env python3
"""Auto-approve safe operations, deny dangerous ones."""
import json, sys, re

request = json.load(sys.stdin)
tool = request.get("tool_name", "")
tool_input = request.get("tool_input", {})

# Auto-approve: read-only tools, npm/pytest, git status
safe_patterns = [
    (r"^Read$", None),
    (r"^Glob$", None),
    (r"^Grep$", None),
    (r"^Bash$", r"^(npm test|pytest|git status|git diff|git log|ls |cat )"),
]
for tool_pat, cmd_pat in safe_patterns:
    if re.match(tool_pat, tool):
        if cmd_pat is None or re.match(cmd_pat, tool_input.get("command", "")):
            json.dump({
                "hookSpecificOutput": {
                    "hookEventName": "PermissionRequest",
                    "decision": {"behavior": "allow"},
                }
            }, sys.stdout)
            sys.exit(0)

# Auto-deny: destructive commands
if tool == "Bash" and re.search(r"rm\s+-rf|drop\s+table", tool_input.get("command", ""), re.I):
    json.dump({
        "hookSpecificOutput": {
            "hookEventName": "PermissionRequest",
            "decision": {
                "behavior": "deny",
                "message": "Destructive command blocked by policy",
            },
        }
    }, sys.stdout)
```

### PostToolUse — React to Tool Results

Fires after a tool succeeds. Run linters, log activity, add context.

```python
#!/usr/bin/env python3
"""Run ruff after Python file edits."""
import json, subprocess, sys

request = json.load(sys.stdin)
tool = request.get("tool_name", "")
tool_input = request.get("tool_input", {})
file_path = tool_input.get("file_path", "")

if tool in ("Write", "Edit") and file_path.endswith(".py"):
    result = subprocess.run(
        ["ruff", "check", file_path, "--fix"],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        json.dump({
            "hookSpecificOutput": {
                "hookEventName": "PostToolUse",
                "additionalContext": f"Ruff found issues in {file_path}:\n{result.stdout}",
            }
        }, sys.stdout)
```

**Config:** `"matcher": "Write|Edit"` — only fires for file modifications.

### SessionStart — Environment Setup

Fires when a session begins. Set env vars, load context, log session.

```python
#!/usr/bin/env python3
"""Set up session environment and inject project context."""
import json, os, sys
from datetime import datetime
from pathlib import Path

request = json.load(sys.stdin)
source = request.get("source", "startup")

# Persist env vars for Bash commands via CLAUDE_ENV_FILE
env_file = os.environ.get("CLAUDE_ENV_FILE")
if env_file and source == "startup":
    with open(env_file, "a") as f:
        f.write("export NODE_ENV=development\n")
        f.write("export PYTHONDONTWRITEBYTECODE=1\n")

# Inject context into Claude's awareness
context_parts = [f"Session started at {datetime.now().isoformat()}"]

# Load project-specific context
todo_file = Path(request.get("cwd", ".")) / "TODO.md"
if todo_file.exists():
    context_parts.append(f"Active TODOs:\n{todo_file.read_text()[:500]}")

json.dump({
    "hookSpecificOutput": {
        "hookEventName": "SessionStart",
        "additionalContext": "\n".join(context_parts),
    }
}, sys.stdout)
```

**Special:** Only hook with access to `$CLAUDE_ENV_FILE` for persisting env vars across Bash commands.

### Stop — Verify Before Finishing

Fires when Claude is about to stop responding. Block to force continuation.

```python
#!/usr/bin/env python3
"""Ensure tests pass before Claude stops."""
import json, subprocess, sys

request = json.load(sys.stdin)

# CRITICAL: check stop_hook_active to prevent infinite loops
if request.get("stop_hook_active"):
    sys.exit(0)  # Already asked once — don't loop

# Run tests
result = subprocess.run(["pytest", "--tb=short", "-q"], capture_output=True, text=True, timeout=120)

if result.returncode != 0:
    json.dump({
        "decision": "block",
        "reason": f"Tests failing. Fix before stopping:\n{result.stdout[-500:]}",
    }, sys.stdout)
```

The `stop_hook_active` check is essential — without it, the hook fires again after Claude
tries to stop a second time, creating an infinite loop.

---

## Additional Patterns

### UserPromptSubmit — Validate or Inject Context

Cannot modify the prompt, but can block it or add context.

```python
#!/usr/bin/env python3
"""Inject client context when prompt mentions a client name."""
import json, sys, re

CLIENTS = {
    "dave": "Dave Kurian — Blue Hill Home Buyers, DFW wholesaler, InvestorLift user",
    "claudia": "Claudia Sanchez — Brains & Beauty Med Spa, Tucson AZ, GHL Conversation AI",
}

request = json.load(sys.stdin)
prompt = request.get("prompt", "").lower()

context = []
for name, info in CLIENTS.items():
    if name in prompt:
        context.append(f"Client context: {info}")

if context:
    json.dump({
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": "\n".join(context),
        }
    }, sys.stdout)
```

### PostToolUse — Audit Logger

```python
#!/usr/bin/env python3
"""Log every tool call to a JSONL file."""
import json, sys
from datetime import datetime
from pathlib import Path

request = json.load(sys.stdin)
log_entry = {
    "ts": datetime.utcnow().isoformat(),
    "tool": request.get("tool_name"),
    "input": request.get("tool_input"),
    "session": request.get("session_id"),
}

log_path = Path.home() / ".claude" / "tool-audit.jsonl"
with open(log_path, "a") as f:
    f.write(json.dumps(log_entry) + "\n")
```

**Config:** `"matcher": ".*"` — fires for ALL tools.

### Notification — Route to External Systems

```python
#!/usr/bin/env python3
"""Send desktop notification when Claude needs permission."""
import json, subprocess, sys

request = json.load(sys.stdin)
ntype = request.get("notification_type", "")

if ntype == "permission_prompt":
    subprocess.run([
        "notify-send", "Claude Code",
        f"Permission needed: {request.get('message', 'Check Claude Code')}",
    ])
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Hook doesn't fire | Wrong event name or matcher | Run `/hooks` in Claude Code to see active hooks |
| Hook fires but doesn't block | Event isn't blockable (PostToolUse, SessionStart, etc.) | Check `references/hook-events.md` for blockable column |
| Hook fires but dialog still shows | No JSON output on stdout | Must print JSON to stdout to suppress |
| Exit code 2 doesn't block | Event doesn't support blocking | Only blockable events respect exit 2 |
| Stop hook loops infinitely | Not checking `stop_hook_active` | Always check and exit 0 if true |
| SessionEnd hook doesn't run | Timeout too short (1.5s default) | Set `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS=5000` |
| JSON parse error | Debug output on stdout | Redirect debug to stderr: `print("debug", file=sys.stderr)` |
| Hook works locally but not in project | Wrong settings.json scope | Check if hook is in user vs project settings |
| Config changes not picked up | Hooks snapshot at session start | Restart session or check `/hooks` menu |
| `updatedInput` ignored | Field not used by the tool | Only modify fields the tool actually accepts |
| MCP tools not matching | Wrong matcher pattern | MCP pattern: `mcp__<server>__<tool>` |

---

## Quick Reference

### All 21 Events

| Event | Can Block? | Handler Types | Matcher |
|-------|-----------|---------------|---------|
| SessionStart | No | command | source |
| SessionEnd | No | command | reason |
| InstructionsLoaded | No | command | none |
| **UserPromptSubmit** | **Yes** | all 4 | none |
| **PreToolUse** | **Yes** | all 4 | tool name |
| PostToolUse | No | all 4 | tool name |
| PostToolUseFailure | No | all 4 | tool name |
| **PermissionRequest** | **Yes** | all 4 | tool name |
| SubagentStart | No | command | agent type |
| **SubagentStop** | **Yes** | all 4 | agent type |
| **Stop** | **Yes** | all 4 | none |
| **TeammateIdle** | **Yes** | command | none |
| **TaskCompleted** | **Yes** | all 4 | none |
| Notification | No | command | type |
| **ConfigChange** | **Yes** | command | source |
| PreCompact | No | command | trigger |
| PostCompact | No | command | trigger |
| **WorktreeCreate** | **Yes** | command | none |
| WorktreeRemove | No | command | none |
| **Elicitation** | **Yes** | command | server name |
| **ElicitationResult** | **Yes** | command | server name |

### Python Hook Template

```python
#!/usr/bin/env python3
"""Hook description."""
import json, sys

request = json.load(sys.stdin)
event = request.get("hook_event_name", "")

# Your logic here...

# Option 1: Do nothing (pass through)
# sys.exit(0) with no output

# Option 2: Add context
# json.dump({"hookSpecificOutput": {"additionalContext": "..."}}, sys.stdout)

# Option 3: Block (blockable events only)
# print("Reason", file=sys.stderr); sys.exit(2)
```

### Testing Hooks Locally

```bash
echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"rm -rf /"}}' \
  | python3 ~/.claude/hooks/my_hook.py
echo "Exit: $?"
```
