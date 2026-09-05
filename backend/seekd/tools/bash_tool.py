"""Bash tool — run a shell command and return stdout/stderr."""

from __future__ import annotations

import asyncio
import os

from seekd.tools.base import Tool, ToolResult, ToolSpec

MAX_OUTPUT_CHARS = 100_000


class BashTool(Tool):
    """Execute a shell command via asyncio subprocess."""

    def definition(self) -> ToolSpec:
        return ToolSpec(
            name="bash",
            description=(
                "Execute a shell command and return stdout and stderr. Use for "
                "running tests, git commands, listing files, installing packages, "
                "and other shell operations. Commands run in the working directory "
                "by default; use the `workdir` parameter to override."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "The shell command to execute."},
                    "timeout": {"type": "integer", "description": "Timeout in seconds (default: 30)."},
                    "workdir": {"type": "string", "description": "Working directory (default: cwd)."},
                    "intent": {"type": "string",
                               "description": "The purpose of this call: why you are invoking it."},
                },
                "required": ["command", "intent"],
            },
        )

    async def execute(self, arguments: dict) -> ToolResult:
        cmd = arguments.get("command", "")
        timeout = arguments.get("timeout", 30)
        workdir = arguments.get("workdir")
        if not cmd:
            return ToolResult(name="bash", content="Error: no command provided", error=True)
        try:
            proc = await asyncio.create_subprocess_shell(
                cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=workdir,
            )
        except OSError as e:
            return ToolResult(name="bash", content=f"Error: {e}", error=True)
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            return ToolResult(
                name="bash",
                content=f"Command timed out after {timeout}s: {cmd[:100]}",
                error=True,
            )

        out = stdout.decode("utf-8", errors="replace").rstrip()
        err = stderr.decode("utf-8", errors="replace").rstrip()
        parts: list[str] = []
        if out:
            parts.append(_truncate(out))
        if err:
            parts.append(f"[stderr]\n{_truncate(err)}")
        if not parts:
            parts.append("(no output)")
        return ToolResult(name="bash", content="\n".join(parts),
                          error=proc.returncode not in (0, None))


def _truncate(s: str, limit: int = MAX_OUTPUT_CHARS) -> str:
    if len(s) <= limit:
        return s
    return s[:limit] + f"\n...[truncated {len(s)} → {limit} chars]"
