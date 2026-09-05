"""Tool registry — collect all available tools and expose their specs."""

from __future__ import annotations

from seekd.tools.base import Tool, ToolSpec
from seekd.tools.bash_tool import BashTool
from seekd.tools.edit_tool import EditTool
from seekd.tools.glob_tool import GlobTool
from seekd.tools.grep_tool import GrepTool
from seekd.tools.read_tool import ReadTool
from seekd.tools.write_tool import WriteTool


def default_tools() -> list[Tool]:
    """The core seek tools an agent may use."""
    return [
        BashTool(),
        ReadTool(),
        WriteTool(),
        EditTool(),
        GlobTool(),
        GrepTool(),
    ]


def tool_specs(tools: list[Tool] | None = None) -> list[ToolSpec]:
    """Return the LLM-facing tool specs for the given (or all) tools."""
    return [t.definition() for t in (tools or default_tools())]
