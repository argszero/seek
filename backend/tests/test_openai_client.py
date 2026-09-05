"""Tests for seekd.llm.openai_client — SSE parsing and message mapping."""

import asyncio

from seekd.llm.base import ChatMessage
from seekd.llm.openai_client import _chat_to_openai


def test_chat_to_openai_basic():
    m = ChatMessage(role="user", content="hello")
    assert _chat_to_openai(m) == {"role": "user", "content": "hello"}


def test_chat_to_openai_tool():
    m = ChatMessage(role="tool", content="result", tool_call_id="tc1", name="write")
    d = _chat_to_openai(m)
    assert d["role"] == "tool"
    assert d["tool_call_id"] == "tc1"
    assert d["name"] == "write"


def test_chat_to_openai_assistant_tool_calls():
    m = ChatMessage(role="assistant", content="", tool_calls=[{"id": "1", "name": "bash"}])
    d = _chat_to_openai(m)
    assert d["tool_calls"] == [{"id": "1", "name": "bash"}]
