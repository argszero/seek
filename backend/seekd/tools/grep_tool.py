"""Grep tool — search file contents with a regex pattern."""

from __future__ import annotations

from pathlib import Path

from seekd.tools.base import Tool, ToolResult, ToolSpec


class GrepTool(Tool):
    """Search file contents for a regex pattern."""

    def definition(self) -> ToolSpec:
        return ToolSpec(
            name="grep",
            description=(
                "Search file contents for a regex pattern. Returns matching "
                "lines prefixed with filename:line_number. Supports -i "
                "(case-insensitive), context lines before/after matches, and "
                "file glob filtering."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "Regex pattern to search for."},
                    "path": {"type": "string", "description": "File or directory to search (default: cwd)."},
                    "glob": {"type": "string", "description": "Only search files matching this glob."},
                    "ignore_case": {"type": "boolean", "description": "Case-insensitive search."},
                    "context_before": {"type": "integer", "description": "Lines of context before each match."},
                    "context_after": {"type": "integer", "description": "Lines of context after each match."},
                    "intent": {"type": "string", "description": "The purpose of this call."},
                },
                "required": ["pattern", "intent"],
            },
        )

    async def execute(self, arguments: dict) -> ToolResult:
        pattern = arguments.get("pattern", "")
        root = Path(arguments.get("path") or ".").expanduser()
        ignore_case = bool(arguments.get("ignore_case", False))
        glob_filter = arguments.get("glob")
        ctx_before = int(arguments.get("context_before", 0))
        ctx_after = int(arguments.get("context_after", 0))
        if not pattern:
            return ToolResult(name="grep", content="Error: no pattern provided", error=True)
        import re
        flags = 0
        if ignore_case:
            flags |= re.IGNORECASE
        try:
            rx = re.compile(pattern, flags)
        except re.error as e:
            return ToolResult(name="grep", content=f"Error: invalid regex {pattern}: {e}", error=True)

        files = self._files(root, glob_filter)
        hits: list[str] = []
        for f in files:
            try:
                lines = f.read_text(encoding="utf-8", errors="replace").splitlines()
            except OSError:
                continue
            for i, line in enumerate(lines):
                if rx.search(line):
                    start = max(0, i - ctx_before)
                    end = min(len(lines), i + ctx_after + 1)
                    for j in range(start, end):
                        marker = ":" if j == i else "-"
                        prefix = f"{f}:{j + 1}{marker}"
                        hits.append(f"{prefix}\t{lines[j]}")
                    if len(hits) > 500:
                        break
            if len(hits) > 500:
                break
        if not hits:
            return ToolResult(name="grep", content="(no matches)")
        return ToolResult(name="grep", content="\n".join(hits[:500]))

    def _files(self, root: Path, glob_filter: str | None) -> list[Path]:
        if root.is_file():
            return [root]
        if glob_filter:
            return sorted(p for p in root.rglob(glob_filter) if p.is_file())
        return sorted(p for p in root.rglob("*") if p.is_file())
