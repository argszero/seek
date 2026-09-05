"""Edit tool — replace an exact substring in a file (safer than write for tweaks)."""

from __future__ import annotations

from pathlib import Path

from seekd.tools.base import Tool, ToolResult, ToolSpec


class EditTool(Tool):
    """Replace an exact old_string with new_string in a file."""

    def definition(self) -> ToolSpec:
        return ToolSpec(
            name="edit",
            description=(
                "Replace old_string with new_string in an existing file. "
                "old_string must appear exactly once. Use this for targeted "
                "changes over write (safer; shows a diff). Set replace_all to "
                "true for multiple occurrences."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "file_path": {"type": "string", "description": "Absolute path to the file."},
                    "old_string": {"type": "string", "description": "Exact text to find and replace."},
                    "new_string": {"type": "string", "description": "Text to replace old_string with."},
                    "replace_all": {"type": "boolean", "description": "Replace all occurrences (default false)."},
                    "intent": {"type": "string", "description": "The purpose of this call."},
                },
                "required": ["file_path", "old_string", "new_string", "intent"],
            },
        )

    async def execute(self, arguments: dict) -> ToolResult:
        path = Path(arguments.get("file_path", "")).expanduser()
        old = arguments.get("old_string", "")
        new = arguments.get("new_string", "")
        replace_all = bool(arguments.get("replace_all", False))
        if not path.is_absolute():
            return ToolResult(name="edit", content=f"Error: path must be absolute: {path}", error=True)
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as e:
            return ToolResult(name="edit", content=f"Error reading {path}: {e}", error=True)
        count = text.count(old)
        if count == 0:
            return ToolResult(name="edit", content=f"Error: old_string not found in {path}", error=True)
        if count > 1 and not replace_all:
            return ToolResult(
                name="edit",
                content=f"Error: old_string appears {count} times; pass replace_all=true "
                        f"or make it unique. Path: {path}",
                error=True,
            )
        updated = text.replace(old, new, -1 if replace_all else 1)
        try:
            path.write_text(updated, encoding="utf-8")
        except OSError as e:
            return ToolResult(name="edit", content=f"Error writing {path}: {e}", error=True)
        return ToolResult(name="edit", content=f"Replaced {count} occurrence(s) in {path}")
