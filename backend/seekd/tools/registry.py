"""Tool registry — collect all available tools and expose their specs.

``default_tools()`` are the general-purpose filesystem/shell tools an agent may
use for *real work*. Memory and transcript tools are per-character (they are
bound to the calling character's context) so they are not part of the static
default set; build them via ``memory_tools(store, cid, sid)`` and
``transcript_tool(store, cid, sid)`` and append them when assembling a member's
agent.
"""

from __future__ import annotations

from seekd.store.store import SeekStore
from seekd.tools.base import Tool, ToolSpec
from seekd.tools.bash_tool import BashTool
from seekd.tools.edit_tool import EditTool
from seekd.tools.glob_tool import GlobTool
from seekd.tools.grep_tool import GrepTool
from seekd.tools.memory_tool import MemoryTools
from seekd.tools.read_tool import ReadTool
from seekd.tools.transcript_tool import TranscriptQueryTool
from seekd.tools.write_tool import WriteTool


def default_tools() -> list[Tool]:
    """The core seek tools an agent may use (general-purpose)."""
    return [
        BashTool(),
        ReadTool(),
        WriteTool(),
        EditTool(),
        GlobTool(),
        GrepTool(),
    ]


def memory_tools(store: SeekStore, character_id: str, session_id: str) -> list[Tool]:
    """The per-character memory tools bound to this member's two directories."""
    return MemoryTools(store, character_id, session_id).tools()


def transcript_tool(store: SeekStore, character_id: str, session_id: str) -> list[Tool]:
    """The per-character transcript query tool bound to its own seek.db."""
    return [TranscriptQueryTool(store, character_id, session_id)]


def member_tools(store: SeekStore, character_id: str, session_id: str) -> list[Tool]:
    """Full tool set for one character in one session: general + memory + transcript."""
    return default_tools() + memory_tools(store, character_id, session_id) + transcript_tool(
        store, character_id, session_id
    )


def tool_specs(tools: list[Tool] | None = None) -> list[ToolSpec]:
    """Return the LLM-facing tool specs for the given (or all) tools."""
    return [t.definition() for t in (tools or default_tools())]
