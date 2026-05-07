#!/usr/bin/env python3
"""Build normalized transcript bundles for Pi session JSONL logs.

Local-only artifact generator. It preserves raw session paths and writes markdown
transcripts focused on prompts/responses plus compact tool summaries.
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field, asdict
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Iterable

TODAY_DATE = datetime.now().astimezone().date().isoformat()
DEFAULT_TARGET_DATE = (datetime.now().astimezone().date() - timedelta(days=1)).isoformat()
_requested_date = os.environ.get("PI_AUDIT_DATE", DEFAULT_TARGET_DATE).strip().lower()
TARGET_DATE = TODAY_DATE if _requested_date == "today" else DEFAULT_TARGET_DATE if _requested_date == "yesterday" else _requested_date
SESSION_ROOT = Path(os.environ.get("PI_SESSION_ROOT", str(Path.home() / ".pi/agent/sessions"))).expanduser()
OUT_ROOT = Path(os.environ.get("PI_AUDIT_OUT", str(Path.home() / f"pi-session-audit/{TARGET_DATE}"))).expanduser()


def parse_ts(value: Any) -> datetime | None:
    if isinstance(value, (int, float)):
        # message timestamp is Unix ms
        try:
            return datetime.fromtimestamp(value / 1000).astimezone()
        except Exception:
            return None
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone()
        except Exception:
            return None
    return None


def ts_date(value: Any) -> str | None:
    dt = parse_ts(value)
    return dt.date().isoformat() if dt else None


def fmt_ts(value: Any) -> str:
    dt = parse_ts(value)
    if not dt:
        return str(value) if value else "?"
    return dt.strftime("%Y-%m-%d %H:%M:%S %Z")


def md_escape_heading(text: str) -> str:
    return text.replace("\n", " ").strip() or "untitled"


def safe_slug(s: str, max_len: int = 96) -> str:
    s = re.sub(r"[^A-Za-z0-9._-]+", "-", s).strip("-")
    return s[:max_len] or "session"


def code_fence(text: str) -> str:
    # Choose a fence longer than any run of backticks in the text.
    max_ticks = max((len(m.group(0)) for m in re.finditer(r"`+", text)), default=0)
    fence = "`" * max(3, max_ticks + 1)
    return f"{fence}\n{text}\n{fence}"


def content_to_text(content: Any, include_images: bool = False) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if not isinstance(block, dict):
                parts.append(str(block))
                continue
            typ = block.get("type")
            if typ == "text":
                parts.append(block.get("text", ""))
            elif typ == "image":
                mime = block.get("mimeType", "image")
                data_len = len(block.get("data", "") or "")
                parts.append(f"[image omitted: {mime}, base64 chars={data_len}]")
            elif typ == "thinking":
                # Internal reasoning is intentionally not transcribed. It is not
                # needed for prompt/response context and may be extremely noisy.
                parts.append("[assistant thinking block omitted]")
            elif typ == "toolCall":
                parts.append(tool_call_summary(block))
            else:
                parts.append(f"[{typ or 'unknown'} block omitted]")
        return "\n\n".join(p for p in parts if p is not None)
    return str(content)


def compact_json(obj: Any, max_chars: int = 2000) -> str:
    try:
        s = json.dumps(obj, ensure_ascii=False, sort_keys=True)
    except Exception:
        s = str(obj)
    if len(s) > max_chars:
        return s[:max_chars] + f"… [truncated {len(s) - max_chars} chars]"
    return s


def summarize_tool_args(name: str, args: Any) -> str:
    if not isinstance(args, dict):
        return compact_json(args, 1000)
    name = name or "?"
    if name == "read":
        bits = [f"path={args.get('path')!r}"]
        if args.get("offset") is not None: bits.append(f"offset={args.get('offset')}")
        if args.get("limit") is not None: bits.append(f"limit={args.get('limit')}")
        return ", ".join(bits)
    if name == "bash":
        return f"command={args.get('command')!r}" + (f", timeout={args.get('timeout')}" if args.get("timeout") else "")
    if name == "edit":
        edits = args.get("edits") or []
        return f"path={args.get('path')!r}, edits={len(edits)}"
    if name == "write":
        content = args.get("content") or ""
        return f"path={args.get('path')!r}, content_chars={len(content)}"
    if name in {"web_search", "code_search", "fetch_content", "get_search_content"}:
        return compact_json(args, 2500)
    if name == "subagent":
        # Preserve delegated prompts; they are important context.
        return compact_json(args, 12000)
    if name == "mcp":
        return compact_json(args, 3000)
    return compact_json(args, 2000)


def tool_call_summary(block: dict[str, Any]) -> str:
    name = block.get("name") or "?"
    args = block.get("arguments")
    call_id = block.get("id") or "?"
    return f"[tool call: {name} id={call_id} args: {summarize_tool_args(name, args)}]"


def tool_result_summary(msg: dict[str, Any]) -> str:
    tool = msg.get("toolName") or "?"
    is_error = msg.get("isError")
    content_text = content_to_text(msg.get("content"))
    text = content_text.strip()
    line_count = text.count("\n") + (1 if text else 0)
    max_chars = 1200
    excerpt = text[:max_chars]
    if len(text) > max_chars:
        excerpt += f"… [truncated {len(text) - max_chars} chars]"
    return f"tool={tool}, isError={is_error}, chars={len(text)}, lines={line_count}\n\n{excerpt}" if excerpt else f"tool={tool}, isError={is_error}, empty result"


@dataclass
class SessionMeta:
    path: str
    rel_path: str
    size_bytes: int
    group_key: str
    kind: str
    session_id: str | None = None
    header_timestamp: str | None = None
    cwd: str | None = None
    parent_session: str | None = None
    session_name: str | None = None
    first_timestamp: str | None = None
    last_timestamp: str | None = None
    entries: int = 0
    messages: int = 0
    user_messages: int = 0
    assistant_messages: int = 0
    tool_results: int = 0
    bash_executions: int = 0
    compactions: int = 0
    branch_summaries: int = 0
    tool_calls: int = 0
    models: list[str] = field(default_factory=list)
    thinking_levels: list[str] = field(default_factory=list)
    user_prompt_excerpts: list[str] = field(default_factory=list)
    assistant_response_excerpts: list[str] = field(default_factory=list)
    transcript_path: str | None = None


def session_group(path: Path) -> tuple[str, str]:
    """Return (group_key, kind). group_key is parent session stem when possible."""
    rel = path.relative_to(SESSION_ROOT)
    parts = rel.parts
    if len(parts) == 2 and path.name.endswith(".jsonl") and path.name != "session.jsonl":
        return f"{parts[0]}/{path.stem}", "parent"
    # Nested child sessions sit under <project>/<parent-stem>/<run-id>/run-N/session.jsonl
    if len(parts) >= 3:
        return f"{parts[0]}/{parts[1]}", "child"
    return f"ungrouped/{path.stem}", "unknown"


def iter_jsonl(path: Path) -> Iterable[dict[str, Any]]:
    with path.open("r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except Exception as e:
                yield {"type": "parse_error", "error": str(e), "raw": line[:1000]}


def file_has_target_date(path: Path) -> bool:
    for obj in iter_jsonl(path):
        if ts_date(obj.get("timestamp")) == TARGET_DATE:
            return True
        msg = obj.get("message") if isinstance(obj, dict) else None
        if isinstance(msg, dict) and ts_date(msg.get("timestamp")) == TARGET_DATE:
            return True
    return False


def scan_session(path: Path) -> tuple[SessionMeta, list[dict[str, Any]]]:
    group_key, kind = session_group(path)
    rel = str(path.relative_to(SESSION_ROOT))
    meta = SessionMeta(
        path=str(path), rel_path=rel, size_bytes=path.stat().st_size,
        group_key=group_key, kind=kind,
    )
    entries = list(iter_jsonl(path))
    first_dt: datetime | None = None
    last_dt: datetime | None = None
    models_seen: list[str] = []
    thinking_seen: list[str] = []

    for idx, obj in enumerate(entries):
        typ = obj.get("type")
        if typ == "session":
            meta.session_id = obj.get("id")
            meta.header_timestamp = obj.get("timestamp")
            meta.cwd = obj.get("cwd")
            meta.parent_session = obj.get("parentSession")
        if typ == "session_info":
            meta.session_name = obj.get("name") or meta.session_name
        if typ == "model_change":
            model = f"{obj.get('provider')}/{obj.get('modelId')}"
            if model not in models_seen: models_seen.append(model)
        if typ == "thinking_level_change":
            level = obj.get("thinkingLevel")
            if level and level not in thinking_seen: thinking_seen.append(level)
        if typ == "compaction":
            meta.compactions += 1
        if typ == "branch_summary":
            meta.branch_summaries += 1

        dt = parse_ts(obj.get("timestamp"))
        if dt:
            first_dt = min(first_dt, dt) if first_dt else dt
            last_dt = max(last_dt, dt) if last_dt else dt

        if typ == "message":
            meta.messages += 1
            msg = obj.get("message") or {}
            role = msg.get("role")
            if role == "user":
                meta.user_messages += 1
                text = content_to_text(msg.get("content")).strip()
                if text and len(meta.user_prompt_excerpts) < 12:
                    meta.user_prompt_excerpts.append(text[:500] + ("…" if len(text) > 500 else ""))
            elif role == "assistant":
                meta.assistant_messages += 1
                parts = msg.get("content") if isinstance(msg.get("content"), list) else []
                text_bits = []
                for block in parts:
                    if isinstance(block, dict) and block.get("type") == "toolCall":
                        meta.tool_calls += 1
                    elif isinstance(block, dict) and block.get("type") == "text":
                        text_bits.append(block.get("text", ""))
                text = "\n\n".join(text_bits).strip()
                if text and len(meta.assistant_response_excerpts) < 8:
                    meta.assistant_response_excerpts.append(text[:500] + ("…" if len(text) > 500 else ""))
                usage = msg.get("usage") or {}
                model = msg.get("model")
                provider = msg.get("provider")
                if model:
                    model_s = f"{provider}/{model}" if provider else model
                    if model_s not in models_seen: models_seen.append(model_s)
            elif role == "toolResult":
                meta.tool_results += 1
            elif role == "bashExecution":
                meta.bash_executions += 1

    meta.entries = len(entries)
    meta.first_timestamp = first_dt.isoformat() if first_dt else None
    meta.last_timestamp = last_dt.isoformat() if last_dt else None
    meta.models = models_seen
    meta.thinking_levels = thinking_seen
    return meta, entries


def write_session_transcript(meta: SessionMeta, entries: list[dict[str, Any]], out_path: Path) -> None:
    lines: list[str] = []
    lines.append(f"# Pi session transcript: {Path(meta.path).name}\n")
    lines.append("## Metadata\n")
    lines.append(f"- Kind: `{meta.kind}`")
    lines.append(f"- Group: `{meta.group_key}`")
    lines.append(f"- Session ID: `{meta.session_id}`")
    lines.append(f"- Name: {meta.session_name or ''}")
    lines.append(f"- CWD: `{meta.cwd}`")
    lines.append(f"- Header timestamp: {fmt_ts(meta.header_timestamp)}")
    lines.append(f"- First entry: {fmt_ts(meta.first_timestamp)}")
    lines.append(f"- Last entry: {fmt_ts(meta.last_timestamp)}")
    lines.append(f"- Raw path: `{meta.path}`")
    lines.append(f"- Size: {meta.size_bytes} bytes")
    lines.append(f"- Entries/messages: {meta.entries}/{meta.messages}")
    lines.append(f"- Counts: user={meta.user_messages}, assistant={meta.assistant_messages}, toolResults={meta.tool_results}, toolCalls={meta.tool_calls}, bashExecutions={meta.bash_executions}, compactions={meta.compactions}, branchSummaries={meta.branch_summaries}")
    if meta.models:
        lines.append(f"- Models: {', '.join('`'+m+'`' for m in meta.models[:12])}")
    if meta.thinking_levels:
        lines.append(f"- Thinking levels: {', '.join('`'+m+'`' for m in meta.thinking_levels)}")
    lines.append("\n## Normalized transcript\n")
    lines.append("> Internal assistant thinking blocks and base64 images are omitted. Tool outputs are summarized unless they are small. Raw JSONL path above preserves exact original log.\n")

    for n, obj in enumerate(entries, start=1):
        typ = obj.get("type")
        eid = obj.get("id", "-")
        pid = obj.get("parentId", "-")
        when = fmt_ts(obj.get("timestamp"))
        if typ == "session":
            continue
        if typ == "message":
            msg = obj.get("message") or {}
            role = msg.get("role", "?")
            lines.append(f"\n### {n}. {role} — {when} — id `{eid}` parent `{pid}`\n")
            if role in {"user", "custom"}:
                text = content_to_text(msg.get("content")).strip()
                lines.append(code_fence(text) if text else "[empty]")
            elif role == "assistant":
                content = msg.get("content")
                if isinstance(content, list):
                    text_parts: list[str] = []
                    tool_parts: list[str] = []
                    omitted_thinking = 0
                    for block in content:
                        if not isinstance(block, dict):
                            text_parts.append(str(block))
                            continue
                        if block.get("type") == "text":
                            text_parts.append(block.get("text", ""))
                        elif block.get("type") == "toolCall":
                            tool_parts.append(tool_call_summary(block))
                        elif block.get("type") == "thinking":
                            omitted_thinking += 1
                        else:
                            text_parts.append(content_to_text([block]))
                    text = "\n\n".join(t for t in text_parts if t).strip()
                    if text:
                        lines.append("#### Assistant text\n")
                        lines.append(code_fence(text))
                    if omitted_thinking:
                        lines.append(f"\n[omitted {omitted_thinking} assistant thinking block(s)]\n")
                    if tool_parts:
                        lines.append("\n#### Tool calls\n")
                        for t in tool_parts:
                            lines.append(f"- {t}")
                else:
                    lines.append(code_fence(content_to_text(content).strip()))
                usage = msg.get("usage") or {}
                if usage:
                    lines.append(f"\nUsage: `{compact_json(usage, 600)}`")
            elif role == "toolResult":
                lines.append(code_fence(tool_result_summary(msg)))
            elif role == "bashExecution":
                command = msg.get("command", "")
                output = msg.get("output", "") or ""
                truncated = msg.get("truncated")
                full = msg.get("fullOutputPath")
                max_chars = 2000
                excerpt = output[:max_chars]
                if len(output) > max_chars:
                    excerpt += f"\n… [truncated {len(output) - max_chars} chars in normalized transcript]"
                lines.append(f"Command: {code_fence(command)}")
                lines.append(f"Exit: `{msg.get('exitCode')}`, cancelled={msg.get('cancelled')}, truncated={truncated}, fullOutputPath={full}")
                lines.append(code_fence(excerpt))
            else:
                lines.append(code_fence(content_to_text(msg.get("content")).strip()))
        elif typ == "compaction":
            lines.append(f"\n### {n}. compaction — {when} — id `{eid}` parent `{pid}`\n")
            lines.append(f"tokensBefore={obj.get('tokensBefore')}, firstKeptEntryId={obj.get('firstKeptEntryId')}\n")
            lines.append(code_fence(obj.get("summary", "")))
        elif typ == "branch_summary":
            lines.append(f"\n### {n}. branch summary — {when} — id `{eid}` parent `{pid}`\n")
            lines.append(f"fromId={obj.get('fromId')}\n")
            lines.append(code_fence(obj.get("summary", "")))
        elif typ == "model_change":
            lines.append(f"\n### {n}. model change — {when} — id `{eid}` parent `{pid}`\n")
            lines.append(f"- provider/model: `{obj.get('provider')}/{obj.get('modelId')}`")
        elif typ == "thinking_level_change":
            lines.append(f"\n### {n}. thinking level change — {when} — id `{eid}` parent `{pid}`\n")
            lines.append(f"- thinkingLevel: `{obj.get('thinkingLevel')}`")
        elif typ == "session_info":
            lines.append(f"\n### {n}. session info — {when} — id `{eid}` parent `{pid}`\n")
            lines.append(f"- name: {obj.get('name')}")
        elif typ == "custom_message":
            lines.append(f"\n### {n}. custom message `{obj.get('customType')}` — {when} — id `{eid}` parent `{pid}`\n")
            lines.append(code_fence(content_to_text(obj.get("content")).strip()))
        elif typ == "custom":
            lines.append(f"\n### {n}. custom entry `{obj.get('customType')}` — {when} — id `{eid}` parent `{pid}`\n")
            lines.append(code_fence(compact_json(obj.get("data"), 1200)))
        elif typ == "label":
            lines.append(f"\n### {n}. label — {when} — id `{eid}` parent `{pid}`\n")
            lines.append(f"- targetId: `{obj.get('targetId')}`, label: `{obj.get('label')}`")
        elif typ == "parse_error":
            lines.append(f"\n### {n}. parse error\n")
            lines.append(code_fence(compact_json(obj, 1200)))
        else:
            lines.append(f"\n### {n}. {typ} — {when} — id `{eid}` parent `{pid}`\n")
            lines.append(code_fence(compact_json(obj, 2000)))

    out_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    meta.transcript_path = str(out_path)


def write_bundle(group_key: str, metas: list[SessionMeta], out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    parent = next((m for m in metas if m.kind == "parent"), metas[0])
    title = parent.session_name or Path(parent.path).stem
    # Bundle overview
    lines: list[str] = []
    lines.append(f"# Bundle: {group_key}\n")
    lines.append(f"- Title/name: {title}")
    lines.append(f"- Parent raw session: `{parent.path}`")
    lines.append(f"- CWD: `{parent.cwd}`")
    lines.append(f"- Session count: {len(metas)}")
    lines.append(f"- Total size: {sum(m.size_bytes for m in metas)} bytes")
    lines.append(f"- Time range: {fmt_ts(min((m.first_timestamp for m in metas if m.first_timestamp), default=None))} → {fmt_ts(max((m.last_timestamp for m in metas if m.last_timestamp), default=None))}")
    lines.append(f"- Messages: {sum(m.messages for m in metas)} total; user={sum(m.user_messages for m in metas)}, assistant={sum(m.assistant_messages for m in metas)}, toolResults={sum(m.tool_results for m in metas)}, toolCalls={sum(m.tool_calls for m in metas)}")
    lines.append("\n## Sessions in this bundle\n")
    for i, m in enumerate(sorted(metas, key=lambda x: (x.kind != "parent", x.first_timestamp or "", x.path)), start=1):
        rel_transcript = os.path.relpath(m.transcript_path or "", out_dir) if m.transcript_path else ""
        lines.append(f"{i}. **{m.kind}** `{m.session_id}` — {fmt_ts(m.first_timestamp)} → {fmt_ts(m.last_timestamp)} — {m.messages} messages — `{m.rel_path}`")
        lines.append(f"   - transcript: `{rel_transcript}`")
        if m.session_name:
            lines.append(f"   - name: {m.session_name}")
        if m.user_prompt_excerpts:
            lines.append("   - first user prompt excerpts:")
            for ex in m.user_prompt_excerpts[:3]:
                lines.append("     - " + ex.replace("\n", " ")[:350])
    lines.append("\n## User prompts across bundle\n")
    for m in sorted(metas, key=lambda x: (x.kind != "parent", x.first_timestamp or "", x.path)):
        lines.append(f"\n### {m.kind} `{Path(m.path).name}` / `{m.session_id}`\n")
        if not m.user_prompt_excerpts:
            lines.append("- [no user prompts captured]")
        for ex in m.user_prompt_excerpts:
            lines.append("- " + ex.replace("\n", " "))
    lines.append("\n## Assistant response excerpts across bundle\n")
    for m in sorted(metas, key=lambda x: (x.kind != "parent", x.first_timestamp or "", x.path)):
        if not m.assistant_response_excerpts:
            continue
        lines.append(f"\n### {m.kind} `{Path(m.path).name}` / `{m.session_id}`\n")
        for ex in m.assistant_response_excerpts[:5]:
            lines.append("- " + ex.replace("\n", " "))
    lines.append("\n## Analyst instructions\n")
    lines.append("Read this overview first, then inspect individual `transcripts/*.md` files as needed. Raw JSONL paths are listed in every transcript if exact source is required.")
    (out_dir / "bundle-overview.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    (out_dir / "metadata.json").write_text(json.dumps([asdict(m) for m in metas], indent=2, ensure_ascii=False), encoding="utf-8")


def main() -> None:
    OUT_ROOT.mkdir(parents=True, exist_ok=True)
    all_paths = sorted(SESSION_ROOT.rglob("*.jsonl"))
    target_paths: list[Path] = []
    for path in all_paths:
        try:
            if file_has_target_date(path):
                target_paths.append(path)
        except Exception as e:
            print(f"WARN: failed to scan {path}: {e}")

    sessions: list[SessionMeta] = []
    entries_by_path: dict[str, list[dict[str, Any]]] = {}
    by_group: dict[str, list[SessionMeta]] = {}

    transcript_root = OUT_ROOT / "transcripts"
    for path in target_paths:
        meta, entries = scan_session(path)
        sessions.append(meta)
        entries_by_path[str(path)] = entries
        by_group.setdefault(meta.group_key, []).append(meta)

        group_slug = safe_slug(meta.group_key.replace("/", "__"))
        session_slug = safe_slug(Path(path).stem if path.name != "session.jsonl" else "__".join(path.relative_to(SESSION_ROOT).parts[-4:]))
        out_path = transcript_root / group_slug / f"{session_slug}.md"
        out_path.parent.mkdir(parents=True, exist_ok=True)
        write_session_transcript(meta, entries, out_path)

    # Re-write metadata after transcript paths have been set.
    bundles_root = OUT_ROOT / "bundles"
    bundle_index: list[dict[str, Any]] = []
    for group_key, metas in sorted(by_group.items(), key=lambda kv: kv[0]):
        group_slug = safe_slug(group_key.replace("/", "__"))
        out_dir = bundles_root / group_slug
        write_bundle(group_key, metas, out_dir)
        parent = next((m for m in metas if m.kind == "parent"), metas[0])
        bundle_index.append({
            "group_key": group_key,
            "bundle_dir": str(out_dir),
            "overview": str(out_dir / "bundle-overview.md"),
            "metadata": str(out_dir / "metadata.json"),
            "parent_session": parent.path,
            "parent_session_id": parent.session_id,
            "session_name": parent.session_name,
            "cwd": parent.cwd,
            "session_count": len(metas),
            "size_bytes": sum(m.size_bytes for m in metas),
            "messages": sum(m.messages for m in metas),
            "user_messages": sum(m.user_messages for m in metas),
            "assistant_messages": sum(m.assistant_messages for m in metas),
            "tool_calls": sum(m.tool_calls for m in metas),
            "time_start": min((m.first_timestamp for m in metas if m.first_timestamp), default=None),
            "time_end": max((m.last_timestamp for m in metas if m.last_timestamp), default=None),
            "transcripts": [m.transcript_path for m in metas],
        })

    index = {
        "target_date_local": TARGET_DATE,
        "session_root": str(SESSION_ROOT),
        "output_root": str(OUT_ROOT),
        "generated_at": datetime.now().astimezone().isoformat(),
        "file_count": len(sessions),
        "parent_count": sum(1 for m in sessions if m.kind == "parent"),
        "child_count": sum(1 for m in sessions if m.kind == "child"),
        "total_size_bytes": sum(m.size_bytes for m in sessions),
        "total_messages": sum(m.messages for m in sessions),
        "total_user_messages": sum(m.user_messages for m in sessions),
        "total_assistant_messages": sum(m.assistant_messages for m in sessions),
        "total_tool_calls": sum(m.tool_calls for m in sessions),
        "bundles": bundle_index,
        "sessions": [asdict(m) for m in sessions],
    }
    (OUT_ROOT / "index.json").write_text(json.dumps(index, indent=2, ensure_ascii=False), encoding="utf-8")

    md: list[str] = []
    md.append(f"# Pi session audit index — {TARGET_DATE}\n")
    md.append(f"- Session root: `{SESSION_ROOT}`")
    md.append(f"- Output root: `{OUT_ROOT}`")
    md.append(f"- Files: {index['file_count']} total ({index['parent_count']} parent, {index['child_count']} child)")
    md.append(f"- Bytes: {index['total_size_bytes']}")
    md.append(f"- Messages: {index['total_messages']} total; user={index['total_user_messages']}, assistant={index['total_assistant_messages']}, toolCalls={index['total_tool_calls']}")
    md.append("\n## Bundles\n")
    for b in bundle_index:
        md.append(f"### {b['group_key']}\n")
        md.append(f"- Dir: `{b['bundle_dir']}`")
        md.append(f"- Overview: `{b['overview']}`")
        md.append(f"- Parent: `{b['parent_session']}`")
        md.append(f"- Session ID: `{b['parent_session_id']}`")
        md.append(f"- Name: {b['session_name'] or ''}")
        md.append(f"- CWD: `{b['cwd']}`")
        md.append(f"- Sessions/messages/size: {b['session_count']} / {b['messages']} / {b['size_bytes']} bytes")
        md.append(f"- Time: {fmt_ts(b['time_start'])} → {fmt_ts(b['time_end'])}")
    md.append("\n## Next-step subagent recipe\n")
    md.append("Launch one context-builder per bundle overview, asking it to inspect transcripts as needed and write reports under `reports/`. Then synthesize reports into `final-context-pack.md`.")
    (OUT_ROOT / "index.md").write_text("\n".join(md) + "\n", encoding="utf-8")

    print(json.dumps({
        "output_root": str(OUT_ROOT),
        "index_md": str(OUT_ROOT / "index.md"),
        "index_json": str(OUT_ROOT / "index.json"),
        "file_count": index["file_count"],
        "parent_count": index["parent_count"],
        "child_count": index["child_count"],
        "bundle_count": len(bundle_index),
        "total_size_bytes": index["total_size_bytes"],
        "total_messages": index["total_messages"],
    }, indent=2))


if __name__ == "__main__":
    main()
