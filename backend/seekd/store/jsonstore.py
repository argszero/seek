"""JSON-file persistence for the seek world.

Layout on disk (root defaults to ``~/.seek/``, override with ``SEEK_HOME``):

    <root>/
      characters/<id>.json
      rooms/<id>.json
      sessions/<id>.json

Each file holds one serialized entity. Writes are atomic (write to a temp file,
then ``os.replace``) so a crash mid-write never corrupts a file.
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

from seekd.core.models import Character, Message, Room, ScheduledTask, Session

if TYPE_CHECKING:
    from collections.abc import Iterable

Entity = Character | Room | Session | ScheduledTask


def _data_root() -> Path:
    env = os.environ.get("SEEK_HOME")
    if env:
        return Path(env).expanduser()
    return Path.home() / ".seek"


class SeekStore:
    """A filesystem-backed store for the seek world entities.

    One instance per daemon. Each entity is a single JSON file keyed by id, so
    lookups by id are O(1) and there is no global index to rebuild.
    """

    def __init__(self, root: Path | str | None = None) -> None:
        self.root = Path(root) if root is not None else _data_root()

    # ---- paths -----------------------------------------------------------
    def _dir(self, kind: str) -> Path:
        d = self.root / kind
        d.mkdir(parents=True, exist_ok=True)
        return d

    def _path(self, kind: str, entity_id: str) -> Path:
        return self._dir(kind) / f"{entity_id}.json"

    def _save(self, kind: str, entity_id: str, data: dict[str, Any]) -> None:
        path = self._path(kind, entity_id)
        tmp_fd, tmp_name = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
        try:
            with os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            os.replace(tmp_name, path)
        except BaseException:
            os.unlink(tmp_name)
            raise

    # ---- characters ------------------------------------------------------
    def save_character(self, c: Character) -> None:
        self._save("characters", c.id, c.to_dict())

    def get_character(self, cid: str) -> Character | None:
        p = self._path("characters", cid)
        if not p.exists():
            return None
        return Character.from_dict(json.loads(p.read_text(encoding="utf-8")))

    def list_characters(self) -> list[Character]:
        return [
            Character.from_dict(json.loads(p.read_text(encoding="utf-8")))
            for p in self._dir("characters").glob("*.json")
        ]

    # ---- rooms -----------------------------------------------------------
    def save_room(self, r: Room) -> None:
        self._save("rooms", r.id, r.to_dict())

    def get_room(self, rid: str) -> Room | None:
        p = self._path("rooms", rid)
        if not p.exists():
            return None
        return Room.from_dict(json.loads(p.read_text(encoding="utf-8")))

    def list_rooms(self) -> list[Room]:
        return [
            Room.from_dict(json.loads(p.read_text(encoding="utf-8")))
            for p in self._dir("rooms").glob("*.json")
        ]

    # ---- sessions ---------------------------------------------------------
    def save_session(self, s: Session) -> None:
        self._save("sessions", s.id, s.to_dict())

    def get_session(self, sid: str) -> Session | None:
        p = self._path("sessions", sid)
        if not p.exists():
            return None
        return Session.from_dict(json.loads(p.read_text(encoding="utf-8")))

    def list_sessions(self, room_id: str | None = None) -> list[Session]:
        out: Iterable[Session]
        out = [
            Session.from_dict(json.loads(p.read_text(encoding="utf-8")))
            for p in self._dir("sessions").glob("*.json")
        ]
        if room_id is not None:
            out = [s for s in out if s.room_id == room_id]
        return sorted(out, key=lambda s: s.updated_at, reverse=True)

    # ---- messages ----------------------------------------------------------
    def append_message(self, sid: str, msg: Message) -> Session | None:
        """Append a message to a session, updating ``updated_at``. Returns the
        updated session, or ``None`` if the session does not exist."""
        s = self.get_session(sid)
        if s is None:
            return None
        s.messages.append(msg)
        s.updated_at = msg.time  # last activity is the newest message time
        self.save_session(s)
        return s

    # ---- tasks ------------------------------------------------------------
    # A task lives in tasks/<session_id>.json; schedule metadata only.
    def save_task(self, t: ScheduledTask) -> None:
        self._save("tasks", t.id, t.to_dict())

    def get_task(self, sid: str) -> ScheduledTask | None:
        p = self._path("tasks", sid)
        if not p.exists():
            return None
        return ScheduledTask.from_dict(json.loads(p.read_text(encoding="utf-8")))

    def list_tasks(self) -> list[ScheduledTask]:
        return [
            ScheduledTask.from_dict(json.loads(p.read_text(encoding="utf-8")))
            for p in self._dir("tasks").glob("*.json")
        ]

    def delete_task(self, sid: str) -> None:
        self._path("tasks", sid).unlink(missing_ok=True)

    # ---- generic delete ---------------------------------------------------
    def delete_character(self, cid: str) -> None:
        self._path("characters", cid).unlink(missing_ok=True)

    def delete_room(self, rid: str) -> None:
        self._path("rooms", rid).unlink(missing_ok=True)

    def delete_session(self, sid: str) -> None:
        self._path("sessions", sid).unlink(missing_ok=True)
