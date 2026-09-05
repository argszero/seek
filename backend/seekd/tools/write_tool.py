"""Write tool — create or fully replace a file (parent dirs created)."""

from __future__ import annotations

from pathlib import Path

from seekd.tools.base import Tool, ToolResult, ToolSpec


class WriteTool(Tool):
    """Create a file (or overwrite it), auto-creating parent directories."""

    def definition(self) -> ToolSpec:
        return ToolSpec(
            name="write",
            description=(
                "Write content to a file. Creates the file if it doesn't exist, "
                "or overwrites it if it does. Parent directories are created "
                "automatically. Use this for creating new files or fully replacing "
                "existing file contents."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "file_path": {"type": "string", "description": "Absolute path to write."},
                    "content": {"type": "string", "description": "The complete content."},
                    "intent": {"type": "string", "description": "The purpose of this call."},
                },
                "required": ["file_path", "content", "intent"],
            },
        )

    async def execute(self, arguments: dict) -> ToolResult:
        path = Path(arguments.get("file_path", "")).expanduser()
        content = arguments.get("content", "")
        if not path.is_absolute():
            return ToolResult(name="write", content=f"Error: path must be absolute: {path}", error=True)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
        except OSError as e:
            return ToolResult(name="write", content=f"Error writing {path}: {e}", error=True)
        return ToolResult(name="write", content=f"Wrote {len(content)} chars to {path}")
