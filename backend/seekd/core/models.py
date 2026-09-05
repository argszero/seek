"""Domain models for seek — the entities that make up the world.

These are plain, transport-agnostic data classes. They mirror the structures
defined in CONTRACT.md §2. Each model serializes to/from the *protocol* shape
(camelCase field names, as on the wire and on disk), while the Python attributes
keep snake_case.

The daemon serializes them to the wire; clients hold their own representations
and never import this module.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

Kind = Literal["human", "virtual"]


def _pick(cls: type, d: dict[str, Any], *exclude: str) -> dict[str, Any]:
    """Return only d's keys that name a dataclass field, minus excludes."""
    fields = cls.__dataclass_fields__
    return {k: v for k, v in d.items() if k in fields and k not in exclude}


@dataclass(slots=True)
class Avatar:
    """A character's face. Letter avatars (initial + colors) or an image."""

    type: Literal["letter", "image"]
    text: str = ""
    bg: str = ""
    fg: str = ""
    src: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {"type": self.type, "text": self.text, "bg": self.bg,
                "fg": self.fg, "src": self.src}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Avatar":
        return cls(**_pick(cls, d))


@dataclass(slots=True)
class SpeakStrategy:
    """How a character speaks in a group chat."""

    max_per_turn: int = 2
    allow_pass: bool = True
    max_len: int = 8000

    def to_dict(self) -> dict[str, Any]:
        return {"maxPerTurn": self.max_per_turn, "allowPass": self.allow_pass,
                "maxLen": self.max_len}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "SpeakStrategy":
        raw = {"max_per_turn": d.get("maxPerTurn", 2),
               "allow_pass": d.get("allowPass", True),
               "max_len": d.get("maxLen", 8000)}
        return cls(**raw)


@dataclass(slots=True)
class Character:
    """A social identity in the world (a being you know)."""

    id: str
    kind: Kind
    name: str
    persona: str = ""
    avatar: Avatar | None = None
    agent_id: str | None = None
    speak_strategy: SpeakStrategy = field(default_factory=SpeakStrategy)
    created_at: str = ""
    updated_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "id": self.id,
            "kind": self.kind,
            "name": self.name,
            "persona": self.persona,
            "agentId": self.agent_id,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }
        if self.avatar is not None:
            d["avatar"] = self.avatar.to_dict()
        d["speakStrategy"] = self.speak_strategy.to_dict()
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Character":
        kw = _pick(cls, d, "avatar", "speak_strategy")
        raw = {
            "id": kw["id"],
            "kind": kw.get("kind", "virtual"),
            "name": kw["name"],
            "persona": kw.get("persona", ""),
            "agent_id": kw.get("agent_id"),
        }
        if isinstance(d.get("avatar"), dict):
            raw["avatar"] = Avatar.from_dict(d["avatar"])
        if isinstance(d.get("speakStrategy"), dict):
            raw["speak_strategy"] = SpeakStrategy.from_dict(d["speakStrategy"])
        if "createdAt" in d:
            raw["created_at"] = d["createdAt"]
        if "updatedAt" in d:
            raw["updated_at"] = d["updatedAt"]
        return cls(**raw)


@dataclass(slots=True)
class Room:
    """A persistent group chat container. Runs many sessions over time."""

    id: str
    name: str
    description: str = ""
    member_ids: list[str] = field(default_factory=list)
    created_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "name": self.name, "description": self.description,
                "memberIds": list(self.member_ids), "createdAt": self.created_at}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Room":
        raw = _pick(cls, d, "member_ids")
        raw["member_ids"] = list(d.get("memberIds", []) or [])
        if "createdAt" in d:
            raw["created_at"] = d["createdAt"]
        return cls(**raw)


@dataclass(slots=True)
class Message:
    """One 'who said what' in a session's message stream."""

    id: str
    speaker: str  # character id or 'system'
    time: str
    kind: Literal["text", "tool", "image", "system"]
    text: str = ""
    cmd: str = ""
    status: Literal["success", "fail", "running"] | None = None
    ms: str = ""
    output: str = ""

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {"id": self.id, "speaker": self.speaker,
                             "time": self.time, "kind": self.kind,
                             "text": self.text}
        if self.kind == "tool":
            d["cmd"] = self.cmd
            d["status"] = self.status
            d["ms"] = self.ms
            d["output"] = self.output
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Message":
        raw = _pick(cls, d)
        raw.setdefault("kind", "text")
        return cls(**raw)


@dataclass(slots=True)
class Session:
    """One conversation inside a room, bound to a workspace."""

    id: str
    room_id: str
    name: str = ""
    workspace: str = ""
    messages: list[Message] = field(default_factory=list)
    created_at: str = ""
    updated_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "roomId": self.room_id, "name": self.name,
                "workspace": self.workspace,
                "messages": [m.to_dict() for m in self.messages],
                "createdAt": self.created_at, "updatedAt": self.updated_at}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Session":
        raw = _pick(cls, d, "messages")
        if "roomId" in d:
            raw["room_id"] = d["roomId"]
        if isinstance(d.get("messages"), list):
            raw["messages"] = [Message.from_dict(m) for m in d["messages"]
                               if isinstance(m, dict)]
        if "createdAt" in d:
            raw["created_at"] = d["createdAt"]
        if "updatedAt" in d:
            raw["updated_at"] = d["updatedAt"]
        return cls(**raw)


@dataclass(slots=True)
class ScheduledTask:
    """A scheduled task = a normal session that fires on a schedule.

    Per decision (proto-scheduled-task): each task is an ordinary session with a
    ``schedule`` attached. On fire, the daemon reads the session workspace's fixed
    ``task_prompt.md`` and injects its (variable-substituted) content as a message
    into the session. The only config left is period + enabled.
    """

    id: str  # equals the session id (task lives on its session)
    enabled: bool = True
    interval: int = 86400  # seconds
    last_run: str = ""
    next_run: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "enabled": self.enabled, "interval": self.interval,
                "lastRun": self.last_run, "nextRun": self.next_run}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "ScheduledTask":
        raw = _pick(cls, d)
        raw["enabled"] = d.get("enabled", True)
        raw["interval"] = d.get("interval", 86400)
        if "lastRun" in d:
            raw["last_run"] = d["lastRun"]
        if "nextRun" in d:
            raw["next_run"] = d["nextRun"]
        return cls(**raw)
