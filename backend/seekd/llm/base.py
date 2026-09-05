"""LLM client interface — the only place seek talks to a model.

An implementation (OpenAI-compatible, Anthropic, local) plugs in here. The
agent tool-loop drives it via ``stream``, which yields either a message delta
or a partial tool-call. The interface is intentionally minimal so real backends
can be added without touching the agent.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Literal

Role = Literal["system", "user", "assistant", "tool"]


@dataclass
class ChatMessage:
    """One message in the LLM conversation."""

    role: Role
    content: str = ""
    # For role == "tool": the tool call id and name it answers.
    tool_call_id: str | None = None
    name: str | None = None
    # Raw tool_calls the assistant emitted (parsed from OpenAI-style).
    tool_calls: list[dict] = field(default_factory=list)


@dataclass
class ToolCall:
    """A tool invocation the model requested."""

    id: str
    name: str
    arguments: dict = field(default_factory=dict)


@dataclass
class StreamEvent:
    """A chunk while streaming."""

    kind: Literal["text", "assistant_tool_call", "done"]
    text: str = ""
    tool_call: ToolCall | None = None


class LLMClient(ABC):
    """Interface for a model backend."""

    @abstractmethod
    def stream(
        self,
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        model: str | None = None,
    ) -> AsyncIterator[StreamEvent]:
        """Stream assistant output. Yields text deltas and tool calls as they
        come; finally a ``done`` event."""
        ...
