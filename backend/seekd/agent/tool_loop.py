"""Agent tool-loop — drive an LLM across a set of tools until it produces text.

The loop: feed messages to the LLM; when it requests a tool call, run the tool,
append the result as a tool message, and continue. It stops when the model
returns a final text answer (with no pending tool calls). The caller provides an
``LLMClient`` and a tool lookup (``registry``). Goal: one member's turn in a
group chat emits plain text (the spoken message); tool work happens first.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from seekd.llm.base import LLMClient, ChatMessage, ToolCall
from seekd.tools.base import Tool, ToolResult, ToolSpec

MAX_TOOL_ITERATIONS = 12

# Optional hook invoked after each tool executes, so the caller can surface
# tool work (e.g. persist a ``kind="tool"`` message) as it happens. Awaited so a
# slow persist (append + disk write) never races the turn.
OnTool = Callable[[ToolCall, ToolResult], Awaitable[None]]


class Agent:
    """Runs one assistant turn with a tool loop."""

    def __init__(
        self,
        llm: LLMClient,
        tools: list[Tool] | None = None,
        model: str | None = None,
    ) -> None:
        self.llm = llm
        self.tools = tools or []
        self.tool_by_name = {t.definition().name: t for t in self.tools}
        self.model = model

    def tool_specs(self) -> list[ToolSpec]:
        return [t.definition() for t in self.tools]

    async def run(
        self,
        messages: list[ChatMessage],
        on_tool: OnTool | None = None,
    ) -> str:
        """Run the tool-loop to completion, returning the final text.

        ``on_tool`` (optional) is awaited after each tool execution with the
        tool call + its result, so a caller can persist/broadcast tool cards as
        they happen (rather than only at the end).
        """
        convo: list[ChatMessage] = list(messages)
        accumulated: list[str] = []
        for _ in range(MAX_TOOL_ITERATIONS):
            deltas: list[str] = []
            tool_calls: list[ToolCall] = []
            async for ev in self.llm.stream(
                convo, [s.to_dict() for s in self.tool_specs()], self.model
            ):
                if ev.kind == "text":
                    deltas.append(ev.text)
                elif ev.kind == "assistant_tool_call" and ev.tool_call:
                    tool_calls.append(ev.tool_call)
            text = "".join(deltas).strip()

            if not tool_calls:
                # Final answer (maybe text, maybe empty). Append it so the
                # caller sees the machine's whole reply.
                if text:
                    accumulated.append(text)
                break

            # Record assistant text + tool calls, then run each tool.
            if text:
                accumulated.append(text)
            convo.append(ChatMessage(role="assistant", content=text,
                                     tool_calls=[tc.__dict__ for tc in tool_calls]))
            for tc in tool_calls:
                result = await self._run_tool(tc)
                if on_tool is not None:
                    await on_tool(tc, result)
                convo.append(ChatMessage(role="tool", content=result.content,
                                         tool_call_id=tc.id, name=tc.name))
        return "".join(accumulated).strip()

    async def _run_tool(self, tc: ToolCall) -> ToolResult:
        tool = self.tool_by_name.get(tc.name)
        if tool is None:
            return ToolResult(name=tc.name, content=f"Error: unknown tool {tc.name}", error=True)
        try:
            return await tool.execute(tc.arguments)
        except Exception as e:  # never crash the turn on a tool bug
            return ToolResult(name=tc.name, content=f"Error: {e}", error=True)
