"""Read tool — display a file with line numbers, for chunk-based reading."""

from __future__ import annotations

from pathlib import Path

from seekd.tools.base import Tool, ToolResult, ToolSpec


class ReadTool(Tool):
    """Read a file (with line numbers) from the filesystem."""

    def definition(self) -> ToolSpec:
        return ToolSpec(
            name="read",
            description=(
                "Read a file from the filesystem. Returns content with line "
                "numbers prefixing each line (format: '  LINE_NUMBER\\tCONTENT'). "
                "Supports start_line and line_limit for reading large files in chunks."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "file_path": {"type": "string", "description": "Absolute path to the file."},
                    "start_line": {"type": "integer", "description": "First line to read (default: 1)."},
                    "line_limit": {"type": "integer", "description": "Max lines to read (default: 1000)."},
                    "intent": {"type": "string", "description": "The purpose of this call."},
                },
                "required": ["file_path", "intent"],
            },
        )

    async def execute(self, arguments: dict) -> ToolResult:
        path = Path(arguments.get("file_path", "")).expanduser()
        start = max(1, int(arguments.get("start_line", 1)))
        limit = int(arguments.get("line_limit", 1000))
        if not path.is_absolute():
            return ToolResult(name="read", content=f"Error: path must be absolute: {path}", error=True)
        if not path.exists():
            return ToolResult(name="read", content=f"Error: file not found: {path}", error=True)
        if path.is_dir():
            return ToolResult(name="read", content=f"Error: is a directory: {path}", error=True)
        try:
            data = path.read_text(encoding="utf-8")
        except OSError as e:
            return ToolResult(name="read", content=f"Error reading {path}: {e}", error=True)

        lines = data.splitlines()
        if not lines:
            return ToolResult(name="read", content="(empty file)")
        total = len(lines)
        end = min(total, start + limit - 1)
        out = []
        for idx in range(start - 1, end):
            out.append(f"{idx + 1:>6}\t{lines[idx]}")
        header = f"[read {path} lines {start}-{end} of {total}]"
        return ToolResult(name="read", content=header + "\n" + "\n".join(out))
