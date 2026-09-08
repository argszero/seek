"""Memory tools — a character reads/writes its OWN two memory directories.

These are the *only* sanctioned way for a character to touch its memory (the
design forbids the generic Read/Write/Shell tools from reaching into a memory
directory or a seek.db). Each tool is bound to the calling character's context
(``character_id``, ``session_id``, ``store``) at construction, so permission is
enforced structurally: the value the tool holds is a real ``MemoryStore`` for
the character's own session-level or global directory, never another's.

Scopes:
  - ``session`` → ``rooms/<roomId>/sessions/<sid>/<characterId>/memory/`` (primary)
  - ``global``  → ``characters/<characterId>/memory/`` (secondary)

The agent decides *when* and *what* to read/write; this module only enforces
that everything stays within its own two directories.
"""

from __future__ import annotations

from seekd.store.memory import MemoryStore
from seekd.tools.base import Tool, ToolResult, ToolSpec

_SCOPE_HELP = "Which memory: 'session' (this conversation) or 'global' (long-term)."


def _memory_store(store, character_id: str, session_id: str, scope: str) -> MemoryStore:
    """Resolve the MemoryStore for a scope, raising ValueError on bad scope."""
    scope = (scope or "session").lower()
    if scope == "session":
        return store.character_session_memory(session_id, character_id)
    if scope == "global":
        return store.character_global_memory(character_id)
    raise ValueError(f"unknown memory scope: {scope!r}")


class MemoryTools:
    """Factory that binds the memory tools to one character's context."""

    def __init__(self, store, character_id: str, session_id: str) -> None:
        self.store = store
        self.character_id = character_id
        self.session_id = session_id

    def tools(self) -> list[Tool]:
        return [
            MemoryReadTool(self.store, self.character_id, self.session_id),
            MemoryWriteTool(self.store, self.character_id, self.session_id),
            MemorySearchTool(self.store, self.character_id, self.session_id),
            MemoryDeleteTool(self.store, self.character_id, self.session_id),
        ]


class MemoryReadTool(Tool):
    """memory_read — read the memory index or a detail file."""

    def __init__(self, store, character_id: str, session_id: str) -> None:
        self.store = store
        self.character_id = character_id
        self.session_id = session_id

    def definition(self) -> ToolSpec:
        return ToolSpec(
            name="memory_read",
            description=(
                "Read your memory. Pass scope 'session' or 'global'. With mode "
                "'index' (default) returns the MEMORY.md index (list of memory "
                "lines). With mode 'detail' and a topic (the detail file path from "
                "an index line, e.g. 'facts/seek.md'), returns that detail's content."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "scope": {"type": "string", "description": _SCOPE_HELP},
                    "mode": {"type": "string",
                             "description": "'index' (default) or 'detail'."},
                    "topic": {"type": "string",
                              "description": "Detail file path, needed when mode='detail'."},
                    "intent": {"type": "string", "description": "The purpose of this call."},
                },
                "required": ["scope", "intent"],
            },
        )

    async def execute(self, arguments: dict) -> ToolResult:
        scope = arguments.get("scope", "session")
        mode = arguments.get("mode", "index")
        topic = arguments.get("topic", "")
        intent = arguments.get("intent", "")
        try:
            mem = _memory_store(self.store, self.character_id, self.session_id, scope)
        except ValueError as e:
            return ToolResult(name="memory_read", content=f"Error: {e}", error=True)
        try:
            if mode == "detail":
                if not topic:
                    return ToolResult(name="memory_read",
                                      content="Error: topic required for mode='detail'",
                                      error=True)
                body = mem.read_detail(topic)
                return ToolResult(name="memory_read", content=f"--- {topic} ---\n{body}",
                                  error=False)
            # default: index
            text = mem.index_text()
            return ToolResult(name="memory_read", content=text, error=False)
        except Exception as e:  # noqa: BLE001
            return ToolResult(name="memory_read", content=f"Error: {e}", error=True)


class MemoryWriteTool(Tool):
    """memory_write — write a detail file and add its index line."""

    def __init__(self, store, character_id: str, session_id: str) -> None:
        self.store = store
        self.character_id = character_id
        self.session_id = session_id

    def definition(self) -> ToolSpec:
        return ToolSpec(
            name="memory_write",
            description=(
                "Write a memory. Give a scope ('session'|'global'), a topic (detail "
                "file path, may include a subdir like 'decisions/code.md'), a one-line "
                "summary, and the full content. This creates/updates the detail file "
                "and adds/updates its entry in the MEMORY.md index. Topic paths must "
                "stay inside your own memory directory."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "scope": {"type": "string", "description": _SCOPE_HELP},
                    "topic": {"type": "string", "description": "Detail file path (e.g. 'facts/seek.md')."},
                    "summary": {"type": "string",
                                "description": "One-line index summary (<=512 chars)."},
                    "content": {"type": "string", "description": "Full memory body."},
                    "intent": {"type": "string", "description": "The purpose of this call."},
                },
                "required": ["scope", "topic", "summary", "content", "intent"],
            },
        )

    async def execute(self, arguments: dict) -> ToolResult:
        scope = arguments.get("scope", "session")
        topic = arguments.get("topic", "")
        summary = arguments.get("summary", "")
        content = arguments.get("content", "")
        if not topic:
            return ToolResult(name="memory_write", content="Error: topic required", error=True)
        try:
            mem = _memory_store(self.store, self.character_id, self.session_id, scope)
            mem.write_detail(topic, content)
        except ValueError as e:
            return ToolResult(name="memory_write", content=f"Error: {e}", error=True)
        except Exception as e:  # noqa: BLE001
            return ToolResult(name="memory_write", content=f"Error: {e}", error=True)
        self._upsert_index(mem, topic, summary)
        return ToolResult(
            name="memory_write",
            content=f"Wrote memory '{topic}' (scope={scope}) and updated the index.",
            error=False,
        )

    def _upsert_index(self, mem: MemoryStore, topic: str, summary: str) -> None:
        entries = mem.read_index()
        for e in entries:
            if e.get("path") == topic:
                e["summary"] = summary.strip()
                mem.write_index(entries)
                return
        entries.append({"summary": summary.strip(), "path": topic})
        mem.write_index(entries)


class MemorySearchTool(Tool):
    """memory_search — scan the memory index for matching memories."""

    def __init__(self, store, character_id: str, session_id: str) -> None:
        self.store = store
        self.character_id = character_id
        self.session_id = session_id

    def definition(self) -> ToolSpec:
        return ToolSpec(
            name="memory_search",
            description=(
                "Search your memory index by a free-text query. Returns matching "
                "index lines (summary + detail path) so you can read_detail the "
                "hits. Pass scope 'session' or 'global'."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "scope": {"type": "string", "description": _SCOPE_HELP},
                    "query": {"type": "string", "description": "Keyword to search in summaries/paths."},
                    "intent": {"type": "string", "description": "The purpose of this call."},
                },
                "required": ["scope", "query", "intent"],
            },
        )

    async def execute(self, arguments: dict) -> ToolResult:
        scope = arguments.get("scope", "session")
        query = arguments.get("query", "")
        if not query:
            return ToolResult(name="memory_search", content="Error: query required", error=True)
        try:
            mem = _memory_store(self.store, self.character_id, self.session_id, scope)
        except ValueError as e:
            return ToolResult(name="memory_search", content=f"Error: {e}", error=True)
        hits = mem.search(query)
        if not hits:
            return ToolResult(name="memory_search",
                              content=f"No memories matching '{query}' in {scope}.",
                              error=False)
        lines = [f"- {h['summary']} -> {h['path']}" for h in hits]
        return ToolResult(name="memory_search", content="\n".join(lines), error=False)


class MemoryDeleteTool(Tool):
    """memory_delete — delete a detail file and remove its index line."""

    def __init__(self, store, character_id: str, session_id: str) -> None:
        self.store = store
        self.character_id = character_id
        self.session_id = session_id

    def definition(self) -> ToolSpec:
        return ToolSpec(
            name="memory_delete",
            description=(
                "Delete a memory detail file and remove its line from the MEMORY.md "
                "index. Pass scope and the topic (detail path). Use to clean up "
                "outdated/stale memories; merging is just re-writing two topics into "
                "one and deleting the other."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "scope": {"type": "string", "description": _SCOPE_HELP},
                    "topic": {"type": "string", "description": "Detail file path to delete."},
                    "intent": {"type": "string", "description": "The purpose of this call."},
                },
                "required": ["scope", "topic", "intent"],
            },
        )

    async def execute(self, arguments: dict) -> ToolResult:
        scope = arguments.get("scope", "session")
        topic = arguments.get("topic", "")
        if not topic:
            return ToolResult(name="memory_delete", content="Error: topic required", error=True)
        try:
            mem = _memory_store(self.store, self.character_id, self.session_id, scope)
        except ValueError as e:
            return ToolResult(name="memory_delete", content=f"Error: {e}", error=True)
        existed = mem.delete_detail(topic)
        if existed:
            entries = mem.read_index()
            entries = [e for e in entries if e.get("path") != topic]
            mem.write_index(entries)
        return ToolResult(
            name="memory_delete",
            content=(f"Deleted memory '{topic}' (scope={scope})." if existed
                     else f"No memory '{topic}' in {scope}."),
            error=False,
        )
