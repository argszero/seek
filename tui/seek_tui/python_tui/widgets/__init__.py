"""Widget primitives for AI coding assistant TUIs.

Exports all widget classes AND the base types (Span, Line, RenderContext, CellWidth)
so consumers can build custom widgets without importing from internal modules.
"""

from seek_tui.python_tui.buffer import CellWidth
from seek_tui.python_tui.widgets.base import Line, RenderContext, Span, Widget
from seek_tui.python_tui.widgets.chat_row import ChatRow
from seek_tui.python_tui.widgets.composer import Composer
from seek_tui.python_tui.widgets.diff import Diff
from seek_tui.python_tui.widgets.markdown import Markdown, StreamingMarkdown
from seek_tui.python_tui.widgets.prompt import InlinePrompt
from seek_tui.python_tui.widgets.spinner import Spinner
from seek_tui.python_tui.widgets.status_line import StatusLine
from seek_tui.python_tui.widgets.table import Table
from seek_tui.python_tui.widgets.tool_card import ToolCard

__all__ = [
    "CellWidth",
    "Line",
    "RenderContext",
    "Span",
    "Widget",
    "ChatRow",
    "Composer",
    "Diff",
    "InlinePrompt",
    "Markdown",
    "Spinner",
    "StatusLine",
    "StreamingMarkdown",
    "Table",
    "ToolCard",
]
