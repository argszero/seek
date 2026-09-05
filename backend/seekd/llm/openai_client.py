"""OpenAI-compatible LLM client (streaming) over httpx.

Speaks the ``/chat/completions`` streaming protocol (SSE). Configure via
environment: SEEK_LLM_BASE_URL, SEEK_LLM_MODEL, SEEK_LLM_API_KEY. The client
buffers the assistant's streamed text and parses OpenAI-style tool_calls.
"""

from __future__ import annotations

import json
import os
from collections.abc import AsyncIterator

import httpx

from seekd.llm.base import ChatMessage, LLMClient, StreamEvent, ToolCall

DEFAULT_BASE_URL = "https://api.openai.com/v1"


class OpenAICompatibleClient(LLMClient):
    """Streams chat completions from any OpenAI-compatible endpoint."""

    def __init__(self, base_url: str | None = None, model: str | None = None,
                 api_key: str | None = None, max_tokens: int = 8192,
                 temperature: float = 0.7):
        self.base_url = (base_url or os.environ.get("SEEK_LLM_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
        self.model = model or os.environ.get("SEEK_LLM_MODEL") or "gpt-4o-mini"
        self.api_key = api_key or os.environ.get("SEEK_LLM_API_KEY") or ""
        self.max_tokens = max_tokens or int(os.environ.get("SEEK_LLM_MAX_TOKENS", "8192"))
        self.temperature = temperature or float(os.environ.get("SEEK_LLM_TEMPERATURE", "0.7"))

    @classmethod
    def from_config(cls, config) -> "OpenAICompatibleClient":
        """Build a client from a :class:`seekd.config.LlmConfig`."""
        return cls(base_url=config.base_url, model=config.model, api_key=config.api_key,
                   max_tokens=config.max_tokens, temperature=config.temperature)

    async def stream(
        self,
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        model: str | None = None,
    ) -> AsyncIterator[StreamEvent]:
        payload: dict = {
            "model": model or self.model,
            "messages": [_chat_to_openai(m) for m in messages],
            "stream": True,
            "max_tokens": self.max_tokens,
            "temperature": self.temperature,
        }
        if tools:
            payload["tools"] = tools
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream(
                "POST", f"{self.base_url}/chat/completions",
                json=payload, headers=headers,
            ) as resp:
                resp.raise_for_status()
                # Coalesce streamed tool_call fragments (OpenAI sends them in
                # pieces: id only on the first, name only on the first, and
                # arguments split across many deltas). Keyed by index.
                caller: dict[int, dict] = {}
                async for line in resp.aiter_lines():
                    if not line or not line.startswith("data:"):
                        continue
                    data = line[len("data:"):].strip()
                    if data == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    delta = chunk.get("choices", [{}])[0].get("delta", {})
                    text = delta.get("content")
                    if text:
                        yield StreamEvent(kind="text", text=text)
                    for tc in delta.get("tool_calls", []) or []:
                        idx = tc.get("index", 0)
                        acc = caller.setdefault(idx, {"id": "", "name": "", "args": ""})
                        if tc.get("id"):
                            acc["id"] = tc["id"]
                        fn = tc.get("function", {})
                        if fn.get("name"):
                            acc["name"] = fn["name"]
                        if fn.get("arguments"):
                            acc["args"] += fn["arguments"]
            # Emit coalesced tool calls, one per index, after the stream ends.
            for idx in sorted(caller):
                acc = caller[idx]
                args: dict = {}
                raw = acc["args"]
                if raw:
                    try:
                        args = json.loads(raw)
                    except json.JSONDecodeError:
                        args = {"raw": raw}
                if acc["name"]:
                    yield StreamEvent(
                        kind="assistant_tool_call",
                        tool_call=ToolCall(id=acc["id"], name=acc["name"], arguments=args),
                    )
            yield StreamEvent(kind="done")


def _chat_to_openai(m: ChatMessage) -> dict:
    """Convert a ChatMessage to the OpenAI wire shape."""
    out: dict = {"role": m.role, "content": m.content}
    if m.role == "tool":
        out["tool_call_id"] = m.tool_call_id
        if m.name:
            out["name"] = m.name
    if m.tool_calls:
        out["tool_calls"] = m.tool_calls
    return out
