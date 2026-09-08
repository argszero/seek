"""transcript_query tool — a character queries its OWN seek.db (read-only).

The transcript is a character's record layer. The ``transcript_query`` tool lets
it dig into its own history — by author, kind, keyword, time — to recall what
was said or what it did, rather than relying only on the recent window that the
LLM sees. It is strictly read-only and only ever opens the calling character's
own ``seek.db``, so it cannot expose another member's private tool calls (those
were never written here).
"""

from __future__ import annotations

from seekd.store.transcript import TranscriptStore
from seekd.tools.base import Tool, ToolResult, ToolSpec


class TranscriptQueryTool(Tool):
    """Search this character's own transcript."""

    def __init__(self, store, character_id: str, session_id: str) -> None:
        self.store = store
        self.character_id = character_id
        self.session_id = session_id

    def definition(self) -> ToolSpec:
        return ToolSpec(
            name="transcript_query",
            description=(
                "Search the transcript of THIS conversation from your own "
                "perspective. Unlike the context window (which only carries the "
                "last ~24 messages), this can recall anything you have seen or done "
                "here. Filters are optional: author id, kind (send-message "
                "/tool-call/user-attachment/turn-ended), a keyword, and a time "
                "range. Returns matching entries (oldest first, capped). Your own "
                "private tool calls are present; other members' are not."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "author": {"type": "string", "description": "Author id, e.g. '我' or a character id."},
                    "kind": {"type": "string",
                             "description": "send-message | tool-call | user-attachment | turn-ended."},
                    "keyword": {"type": "string", "description": "Substring to match in the entry."},
                    "time_start": {"type": "string", "description": "ISO timestamp lower bound."},
                    "time_end": {"type": "string", "description": "ISO timestamp upper bound."},
                    "limit": {"type": "integer", "description": "Max entries to return (default 100)."},
                    "intent": {"type": "string", "description": "The purpose of this call."},
                },
                "required": ["intent"],
            },
        )

    async def execute(self, arguments: dict) -> ToolResult:
        author = arguments.get("author")
        kind = arguments.get("kind")
        keyword = arguments.get("keyword")
        time_start = arguments.get("time_start")
        time_end = arguments.get("time_end")
        try:
            limit = int(arguments.get("limit", 100))
        except (TypeError, ValueError):
            limit = 100
        db = TranscriptStore(self.store.character_seek_db(self.session_id, self.character_id))
        try:
            entries = db.query(author=author, kind=kind, keyword=keyword,
                               time_start=time_start, time_end=time_end, limit=limit)
        finally:
            db.close()
        if not entries:
            return ToolResult(name="transcript_query",
                              content="No matching transcript entries.", error=False)
        lines = [_format_entry(e) for e in entries]
        return ToolResult(name="transcript_query", content="\n\n".join(lines), error=False)


def _format_entry(e: dict) -> str:
    """Render one transcript entry for the agent (compact, readable)."""
    author = e.get("author") or {}
    aid = author.get("id", "?")
    aname = author.get("name", aid)
    kind = e.get("kind", "?")
    ts = e.get("timestampMs", "")
    if kind == "tool-call":
        tool = e.get("tool") or {}
        status = tool.get("status", "")
        head = f"[tool] {aname} ({aid}) · {tool.get('name', '')} · {status} @ {ts}"
        body = tool.get("output", "")
        return f"{head}\n{body}" if body else head
    if kind in ("send-message", "user-attachment"):
        msg = e.get("message") or {}
        content = msg.get("content", "") if isinstance(msg, dict) else str(msg)
        return f"{aname}: {content} @ {ts}"
    return f"{kind} @ {ts}: {json_dumps(e)}"


def json_dumps(e: dict) -> str:
    import json
    return json.dumps(e, ensure_ascii=False)
