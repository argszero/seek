"""Seed the world for first-run — make the app 'open and use' out of the box.

On a fresh install the store is empty: no characters, no rooms, no sessions. A
blank world means the GUI opens to nothing, which contradicts 'open it and you
are talking with a group'. This module ensures the built-in world exists:

    - ``you``      — the built-in human character (kind=human). This is the
                     user's own identity in the world; it is not editable in the
                     role-management UI and has no agent (speaks only).
    - ``seek``     — the built-in virtual character (kind=virtual, fixed id
                     ``"seek"``). The default AI partner, created at install and
                     not user-modifiable (host decision 2026-09-07).
    - room ``seek``— the built-in default room (fixed id ``ROOM_SEEK_ID``),
                     members are exactly ``you`` + ``seek``. Not modifiable via
                     the protocol (daemon rejects member edits on it).
    - one default session in that room, bound to the default workspace.

``ensure_seeded`` is idempotent and safe on an existing world: it never deletes
or clobbers user data — it only fills in whichever built-in pieces are missing
(so an upgrade of an old world automatically gains the ``seek`` character and
the ``seek`` room, while keeping every existing room/session intact). It also
replaces the old first-run bootstrap (a lone ``you`` room with no virtual
member to talk to) — the built-in room is where the AI actually answers.

Call it once when the daemon starts.
"""

from __future__ import annotations

from pathlib import Path

from seekd.core.ids import new_id, now_iso
from seekd.core.models import Avatar, Character, Room, Session
from seekd.store.store import SeekStore

# Fixed ids for the built-in identities, so clients can recognise them reliably
# (same pattern as the existing YOU_ID="you").
YOU_ID = "you"
YOU_NAME = "you"
SEEK_ID = "seek"
SEEK_NAME = "seek"
# Fixed room id for the built-in default room (named "seek").
ROOM_SEEK_ID = "room-seek"
ROOM_SEEK_NAME = "seek"
DEFAULT_WS = "~/.seek/workspace/default"

# Persona for the built-in virtual member. Concise; the group prompt adds the
# "stay in character / use your toolkit / (pass)" framing on every turn.
SEEK_PERSONA = (
    "You are seek, the built-in AI partner of this workspace. Help the user "
    "think, work and get things done. You have a full toolkit: use it before "
    "answering when real work is needed, keep messages conversational and "
    "short, and never reveal private one-on-one context."
)

# Built-in ids that clients must treat as read-only (roles/rooms management).
BUILTIN_CHARACTER_IDS = frozenset({YOU_ID, SEEK_ID})
BUILTIN_ROOM_IDS = frozenset({ROOM_SEEK_ID})


def default_workspace_path() -> Path:
    """The default workspace directory (G4 decision: ``~/.seek/workspace/default``)."""
    return Path(DEFAULT_WS).expanduser()


def is_builtin_character(cid: str) -> bool:
    return cid in BUILTIN_CHARACTER_IDS


def is_builtin_room(rid: str) -> bool:
    return rid in BUILTIN_ROOM_IDS


def ensure_seeded(store: SeekStore) -> bool:
    """Ensure the built-in world exists. Idempotent and safe on existing worlds.

    Creates whatever built-in piece is missing (you / seek character / seek
    room / default session in it) and returns ``True`` if it created anything,
    ``False`` if everything was already in place. Never deletes user data and
    never duplicates. A failed seed just leaves the store as it was.
    """
    created = False
    try:
        now = now_iso()

        # 1. Built-in human ``you``.
        you = store.get_character(YOU_ID)
        if you is None:
            you = Character(id=YOU_ID, kind="human", name=YOU_NAME,
                            persona="", avatar=Avatar(type="letter", text=YOU_NAME,
                                                      bg="", fg=""),
                            created_at=now, updated_at=now)
            store.save_character(you)
            created = True

        # 2. Built-in virtual ``seek``.
        seek = store.get_character(SEEK_ID)
        if seek is None:
            seek = Character(id=SEEK_ID, kind="virtual", name=SEEK_NAME,
                             persona=SEEK_PERSONA,
                             avatar=Avatar(type="letter", text="se",
                                           bg="", fg=""),
                             created_at=now, updated_at=now)
            store.save_character(seek)
            created = True

        # 3. Built-in room ``seek`` (members you + seek).
        room = store.get_room(ROOM_SEEK_ID)
        if room is None:
            room = Room(id=ROOM_SEEK_ID, name=ROOM_SEEK_NAME, description="",
                        member_ids=[YOU_ID, SEEK_ID], created_at=now)
            store.save_room(room)
            created = True
        else:
            # Existing built-in room: make sure both core members are present so
            # the room always has an AI to talk to (never remove anyone — the
            # daemon rejects member edits on built-in rooms anyway).
            changed = False
            if YOU_ID not in room.member_ids:
                room.member_ids.append(YOU_ID)
                changed = True
            if SEEK_ID not in room.member_ids:
                room.member_ids.append(SEEK_ID)
                changed = True
            if changed:
                store.save_room(room)
                created = True

        # 4. One default session in the built-in room (first usable conversation).
        sessions = [s for s in store.list_sessions() if s.room_id == ROOM_SEEK_ID]
        if not sessions:
            ws = str(default_workspace_path())
            session = Session(id=new_id(), room_id=ROOM_SEEK_ID, name="",
                              workspace=ws, created_at=now,
                              updated_at=now)
            store.save_session(session)
            # Scaffold the seeded session's member dirs (you + seek) so the AI
            # has a ready seek.db + memory to talk into.
            store.ensure_member_dirs(session.id, [YOU_ID, SEEK_ID])
            created = True

        # Ensure the default workspace directory exists (harmless if present).
        try:
            default_workspace_path().mkdir(parents=True, exist_ok=True)
        except OSError:
            pass

        return created
    except Exception:
        # Never crash startup because seeding failed; the user can create a room.
        return created
