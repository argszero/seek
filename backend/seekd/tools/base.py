"""Tool executor interface for the seek agent.

Follows the EMRG/Codex pattern: a tool declares a spec (definition()) and runs
its logic via execute(arguments). Tools are the only way an agent touches the
host. Each tool is self-contained and unit-testable.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field


@dataclass
class ToolSpec:
    """A tool's declaration handed to the LLM (name + JSON Schema)."""

    name: str
    description: str
    parameters: dict
    required: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        """The OpenAI-style function spec handed to an LLM."""
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": {**self.parameters, "required": list(self.required)},
            },
        }


@dataclass
class ToolResult:
    """The outcome of a tool run."""

    name: str
    content: str
    error: bool = False


class Tool(ABC):
    """Interface every seek tool implements."""

    @abstractmethod
    def definition(self) -> ToolSpec:
        """Describe the tool to the LLM."""
        ...

    @abstractmethod
    async def execute(self, arguments: dict) -> ToolResult:
        """Run the tool with parsed arguments."""
        ...
