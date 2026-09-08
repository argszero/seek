"""World entity store — filesystem-paths for characters, rooms, sessions, tasks.

This replaces the old flat ``jsonstore``. The world is now hierarchical:

    <root>/
      characters/<id>/character.json + memory/
      rooms/<id>/room.json
      rooms/<id>/sessions/<sid>/session.json + <characterId>/{seek.db,memory/}
      tasks/<sid>.json

Entities are plain JSON files (atomic write). Messages are *not* stored inline on
a session anymore — each member's transcript lives in its own ``seek.db`` (see
``transcript.py``); this module only manages the entity metadata + the per-member
directory scaffolding.
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING, Any

from seekd.core.models import Character, Room, ScheduledTask, Session
from seekd.store.memory import MemoryStore
from seekd.store.transcript import TranscriptStore

if TYPE_CHECKING:
    from collections.abc import Iterable


def _data_root() -> Path:
    env = os.environ.get("SEEK_HOME")
    if env:
        return Path(env).expanduser()
    return Path.home() / ".seek"


class SeekStore:
    """Hierarchical store for the seek world (characters / rooms / sessions).

    One instance per daemon. Entity metadata is a single JSON file per id; each
    session directory additionally holds per-member ``seek.db`` + ``memory/``.
    """

    def __init__(self, root: Path | str | None = None) -> None:
        self.root = Path(root) if root is not None else _data_root()

    # ---- path helpers ------------------------------------------------------
    def character_dir(self, cid: str) -> Path:
        d = self.root / "characters" / cid
        d.mkdir(parents=True, exist_ok=True)
        return d

    def character_global_memory(self, cid: str) -> MemoryStore:
        """A character's global (cross-session) memory directory."""
        d = self.character_dir(cid) / "memory"
        d.mkdir(parents=True, exist_ok=True)
        return MemoryStore(d)

    def character_global_memory_dir(self, cid: str) -> Path:
        return self.character_dir(cid) / "memory"

    def room_path(self, rid: str) -> Path:
        return self.root / "rooms" / rid / "room.json"

    def room_dir(self, rid: str) -> Path:
        d = self.root / "rooms" / rid
        d.mkdir(parents=True, exist_ok=True)
        return d

    def session_dir(self, sid: str, room_id: str | None = None) -> Path:
        """The session directory, derived from a room_id.

        ``room_id`` may be passed explicitly (e.g. by ``save_session``, when the
        session isn't on disk yet); otherwise it is looked up from the stored
        session. Raises ``KeyError`` if neither is available.
        """
        if room_id is None:
            s = self.get_session(sid)
            if s is None:
                raise KeyError(f"session not found: {sid}")
            room_id = s.room_id
        d = self.room_dir(room_id) / "sessions" / sid
        d.mkdir(parents=True, exist_ok=True)
        return d

    def session_path(self, sid: str, room_id: str | None = None) -> Path:
        return self.session_dir(sid, room_id) / "session.json"

    def character_session_dir(self, sid: str, cid: str) -> Path:
        """A member's per-session directory (holds its seek.db + memory/)."""
        d = self.session_dir(sid) / cid
        d.mkdir(parents=True, exist_ok=True)
        return d

    def character_seek_db(self, sid: str, cid: str) -> Path:
        return self.character_session_dir(sid, cid) / "seek.db"

    def character_session_memory(self, sid: str, cid: str) -> MemoryStore:
        """A member's session-level memory directory."""
        d = self.character_session_dir(sid, cid) / "memory"
        d.mkdir(parents=True, exist_ok=True)
        return MemoryStore(d)

    def character_session_memory_dir(self, sid: str, cid: str) -> Path:
        return self.character_session_dir(sid, cid) / "memory"

    # ---- atomic JSON write ------------------------------------------------
    def _save(self, path: Path, data: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp_fd, tmp_name = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
        try:
            with os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            os.replace(tmp_name, path)
        except BaseException:
            os.unlink(tmp_name)
            raise

    def _load(self, path: Path) -> dict[str, Any] | None:
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding="utf-8"))

    # ---- characters --------------------------------------------------------
    def save_character(self, c: Character) -> None:
        self._save(self.character_dir(c.id) / "character.json", c.to_dict())

    def get_character(self, cid: str) -> Character | None:
        data = self._load(self.root / "characters" / cid / "character.json")
        return Character.from_dict(data) if data else None

    def list_characters(self) -> list[Character]:
        chars: list[Character] = []
        for d in (self.root / "characters").iterdir() if (self.root / "characters").exists() else []:
            if not d.is_dir():
                continue
            data = self._load(d / "character.json")
            if data:
                chars.append(Character.from_dict(data))
        return chars

    # ---- rooms -------------------------------------------------------------
    def save_room(self, r: Room) -> None:
        self._save(self.room_path(r.id), r.to_dict())

    def get_room(self, rid: str) -> Room | None:
        data = self._load(self.room_path(rid))
        return Room.from_dict(data) if data else None

    def list_rooms(self) -> list[Room]:
        rooms: list[Room] = []
        base = self.root / "rooms"
        for d in base.iterdir() if base.exists() else []:
            if not d.is_dir():
                continue
            data = self._load(d / "room.json")
            if data:
                rooms.append(Room.from_dict(data))
        return rooms

    # ---- sessions ----------------------------------------------------------
    def save_session(self, s: Session) -> None:
        self.room_dir(s.room_id)
        self._save(self.session_path(s.id, s.room_id), s.to_dict())

    def get_session(self, sid: str) -> Session | None:
        # A session path is rooted under its room, which we don't know without
        # reading it. We scan the rooms tree for the session's folder.
        base = self.root / "rooms"
        if not base.exists():
            return None
        for room_dir in base.iterdir():
            if not room_dir.is_dir():
                continue
            sess_dir = room_dir / "sessions" / sid
            if sess_dir.exists():
                data = self._load(sess_dir / "session.json")
                return Session.from_dict(data) if data else None
        return None

    def list_sessions(self, room_id: str | None = None) -> list[Session]:
        out: list[Session] = []
        base = self.root / "rooms"
        if not base.exists():
            return []
        for room_dir in base.iterdir():
            if not room_dir.is_dir():
                continue
            sessions_base = room_dir / "sessions"
            if not sessions_base.exists():
                continue
            for sess_dir in sessions_base.iterdir():
                if not sess_dir.is_dir():
                    continue
                data = self._load(sess_dir / "session.json")
                if not data:
                    continue
                s = Session.from_dict(data)
                if room_id is None or s.room_id == room_id:
                    out.append(s)
        return sorted(out, key=lambda s: s.updated_at, reverse=True)

    # ---- per-member scaffolding -------------------------------------------
    def ensure_member_dirs(self, sid: str, member_ids: list[str]) -> None:
        """Create each member's per-session dir + seek.db + empty memory index.

        Called on session creation (and idempotently on open) so every in-room
        member has a ready record layer and memory directory.
        """
        for cid in member_ids:
            # Connect (creates the seek.db file + tables), then close.
            db = TranscriptStore(self.character_seek_db(sid, cid))
            db._connect()
            db.close()
            mem = self.character_session_memory(sid, cid)
            mem.ensure_index()
            # Global memory for this character (independent of session).
            gmem = self.character_global_memory(cid)
            gmem.ensure_index()

    # ---- messages (aggregate view for the frontend) ------------------------
    def members_for_session(self, sid: str) -> list[str]:
        """The member ids of a session's room (or [] if the session is missing)."""
        s = self.get_session(sid)
        if s is None:
            return []
        r = self.get_room(s.room_id)
        return list(r.member_ids) if r is not None else []

    def append_shared_entry(self, sid: str, entry: dict[str, Any]) -> None:
        """Append a shared ``send-message`` entry to every in-room member's seek.db.

        The conversation (shared speech) is identical in every member's view, so
        a single entry is written to each. Tool calls are private and never go
        through this path (see ``transcript`` for per-owner writes).
        """
        for cid in self.members_for_session(sid):
            db = TranscriptStore(self.character_seek_db(sid, cid))
            try:
                db.append(entry)
            finally:
                db.close()

    def get_session_messages(self, sid: str) -> list[Any]:
        """Return the session's shared message stream (aggregated across members).

        The frontend needs one ordered list of *shared* messages for a session.
        We read the newest member's seek.db ``window`` for the non-tool stream
        (everyone's send-message + system messages are shared). For the old flat
        contract we keep the ``message`` shapes; see ``transcript`` for the rich
        entry format. This is a best-effort view used by ``openSession``.
        """
        s = self.get_session(sid)
        if s is None:
            return []
        room = self.get_room(s.room_id)
        if room is None:
            return []
        from seekd.core.models import Message

        # Pick a "viewer" = the first virtual member; shared speech is identical
        # across members (only tool calls differ, and those are private). If the
        # room has no virtual member, fall back to any member.
        viewer = next((m for m in room.member_ids if m != "you"), None) or (
            room.member_ids[0] if room.member_ids else None
        )
        if viewer is None:
            return []
        db = TranscriptStore(self.character_seek_db(sid, viewer))
        try:
            entries = db.window(limit=50_000)  # frontend wants full stream
        finally:
            db.close()
        msgs: list[Message] = []
        for e in entries:
            msg = _entry_to_message(e)
            if msg is not None:
                msgs.append(msg)
        return msgs

    # ---- tasks -------------------------------------------------------------
    def save_task(self, t: ScheduledTask) -> None:
        self._save(self.root / "tasks" / f"{t.id}.json", t.to_dict())

    def get_task(self, sid: str) -> ScheduledTask | None:
        data = self._load(self.root / "tasks" / f"{sid}.json")
        return ScheduledTask.from_dict(data) if data else None

    def list_tasks(self) -> list[ScheduledTask]:
        tasks: list[ScheduledTask] = []
        base = self.root / "tasks"
        for p in base.glob("*.json") if base.exists() else []:
            data = self._load(p)
            if data:
                tasks.append(ScheduledTask.from_dict(data))
        return tasks

    def delete_task(self, sid: str) -> None:
        (self.root / "tasks" / f"{sid}.json").unlink(missing_ok=True)

    # ---- deletes -----------------------------------------------------------
    def delete_character(self, cid: str) -> None:
        import shutil
        d = self.root / "characters" / cid
        if d.exists():
            shutil.rmtree(d, ignore_errors=True)

    def delete_room(self, rid: str) -> None:
        import shutil
        d = self.root / "rooms" / rid
        if d.exists():
            shutil.rmtree(d, ignore_errors=True)

    def clear_session_transcripts(self, sid: str) -> None:
        """Drop all transcript entries from every in-room member's seek.db.

        Keeps the seek.db files themselves (so member dirs + memory indexes stay
        intact); only the message log is wiped. Used by ``clearSession``.
        """
        for cid in self.members_for_session(sid):
            import sqlite3
            db = TranscriptStore(self.character_seek_db(sid, cid))
            try:
                # The db is append-only via TranscriptStore; for a full clear we
                # reach into the connection (only deleting rows we own).
                conn = db._connect()
                conn.execute("DELETE FROM transcript_entries")
                conn.commit()
            finally:
                db.close()

    def delete_session(self, sid: str) -> None:
        import shutil
        s = self.get_session(sid)
        if s is None:
            return
        d = self.room_dir(s.room_id) / "sessions" / sid
        if d.exists():
            shutil.rmtree(d, ignore_errors=True)


def _entry_to_message(e: dict[str, Any]) -> "Message | None":
    """Translate a transcript entry into the wire ``Message`` shape.

    Tool calls are private and are folded into the speaker's own history; the
    frontend stream only needs shared speech + system/turn markers. This maps
    ``send-message`` → ``Message(kind='text')`` and ``turn-ended``/system → a
    system message; ``tool-call`` is dropped here (it is offered to the agent
    via ``tail``/``query``, not the broadcast stream).
    """
    from seekd.core.models import Message

    kind = e.get("kind")
    author = e.get("author") or {}
    ts = e.get("timestampMs", "")
    if e.get("turn-ended"):
        return Message(id=str(e.get("id")), speaker="system", time=str(ts),
                       kind="system", text=str(e.get("turn-ended", "")))
    if kind in ("send-message", "user-attachment"):
        msg = e.get("message") or {}
        # author.id maps to speaker; the human is always "我".
        speaker = author.get("id", "user")
        text = msg.get("content", "") if isinstance(msg, dict) else str(msg)
        return Message(id=str(e.get("id")), speaker=speaker, time=str(ts),
                       kind="text", text=text)
    return None
