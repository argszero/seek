"""Glob tool — discover files by name pattern."""

from __future__ import annotations

from pathlib import Path

from seekd.tools.base import Tool, ToolResult, ToolSpec


class GlobTool(Tool):
    """Find files matching a glob pattern (e.g. '**/*.py')."""

    def definition(self) -> ToolSpec:
        return ToolSpec(
            name="glob",
            description=(
                "Find files matching a glob pattern. Supports standard glob "
                "patterns: *, ?, [seq], ** for recursive. Use this to discover "
                "files by name pattern. Results are capped at 500 matches, "
                "sorted by path."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "Glob pattern (e.g. '**/*.py')."},
                    "workdir": {"type": "string", "description": "Directory to search in (default: cwd)."},
                    "intent": {"type": "string", "description": "The purpose of this call."},
                },
                "required": ["pattern", "intent"],
            },
        )

    async def execute(self, arguments: dict) -> ToolResult:
        pattern = arguments.get("pattern", "")
        base = Path(arguments.get("workdir") or ".").expanduser()
        if not pattern:
            return ToolResult(name="glob", content="Error: no pattern provided", error=True)
        try:
            matches = sorted(str(p) for p in base.glob(pattern))[:500]
        except (OSError, ValueError) as e:
            return ToolResult(name="glob", content=f"Error globbing {pattern}: {e}", error=True)
        if not matches:
            return ToolResult(name="glob", content="(no matches)")
        return ToolResult(name="glob", content="\n".join(matches))
