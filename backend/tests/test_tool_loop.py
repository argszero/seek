"""Tests for seekd.agent.tool_loop — the LLM↔tools loop."""

import asyncio
from pathlib import Path

from seekd.agent.tool_loop import Agent
from seekd.llm.base import ChatMessage, LLMClient, StreamEvent, ToolCall
from seekd.tools.write_tool import WriteTool


class FakeLLM(LLMClient):
    """Yields scripted events per stream call, then a final text."""

    def __init__(self, plan):
        self.plan = plan  # list of (events, final_text)
        self.calls = 0

    async def stream(self, messages, tools=None, model=None):
        events, final = self.plan[self.calls]
        self.calls += 1
        for ev in events:
            yield ev
        yield StreamEvent(kind="done")


def _run(coro):
    return asyncio.run(coro)


def test_loop_runs_tool_then_text(tmp_path):
    out_file = tmp_path / "out.txt"
    # First stream: request a write tool call. Second stream: final text.
    llm = FakeLLM([
        ([StreamEvent(kind="assistant_tool_call", text="", tool_call=ToolCall(
            id="tc1", name="write", arguments={"file_path": str(out_file),
                                               "content": "hi", "intent": "t"}))], ""),
        ([StreamEvent(kind="text", text="done writing")], "done writing"),
    ])
    agent = Agent(llm, tools=[WriteTool()])
    result = _run(agent.run([ChatMessage(role="user", content="write a file")]))
    assert out_file.read_text() == "hi"
    assert result == "done writing"


def test_loop_unknown_tool_does_not_crash():
    llm = FakeLLM([
        ([StreamEvent(kind="assistant_tool_call", text="", tool_call=ToolCall(
            id="tc1", name="nope", arguments={}))], ""),
        ([StreamEvent(kind="text", text="ok")], "ok"),
    ])
    agent = Agent(llm, tools=[WriteTool()])
    result = _run(agent.run([ChatMessage(role="user", content="x")]))
    assert result == "ok"


def test_loop_no_tool_returns_text():
    llm = FakeLLM([
        ([StreamEvent(kind="text", text="hello")], "hello"),
    ])
    agent = Agent(llm, tools=[])
    result = _run(agent.run([ChatMessage(role="user", content="hi")]))
    assert result == "hello"
