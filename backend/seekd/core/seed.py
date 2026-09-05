"""Seed the world for first-run — make the app 'open and use' out of the box.

On a fresh install the store is empty: no characters, no rooms, no sessions. A
blank world means the GUI opens to nothing, which contradicts 'open it and you
are talking with a group'. This module ensures the minimal, sensible initial
world exists exactly once:

    - ``you``      — the built-in human character (kind=human). This is the
                     user's own identity in the world; it is not editable in the
                     role-management UI and has no agent (speaks only).
    - a default room that contains ``you`` (a group chat needs a container).
    - one default session in that room, bound to the default workspace.

``ensure_seeded`` is idempotent: it does nothing once any character exists, so
it never clobbers a user's existing world and never runs twice on the same data
root. Call it once when the daemon starts.
"""

from __future__ import annotations

from pathlib import Path

from seekd.core.ids import new_id, now_iso
from seekd.core.models import Avatar, Character, Room, Session
from seekd.store.jsonstore import SeekStore

# Fixed id for the built-in human, so clients can recognise "you" reliably.
YOU_ID = "you"
YOU_NAME = "you"
DEFAULT_ROOM_NAME = "我和 AI"
DEFAULT_WS = "~/.seek/workspace/default"


def default_workspace_path() -> Path:
    """The default workspace directory (G4 decision: ``~/.seek/workspace/default``)."""
    return Path(DEFAULT_WS).expanduser()


def ensure_seeded(store: SeekStore) -> tuple[str, str] | None:
    """Create the default world if the store is empty. Idempotent.

    Returns ``(you_id, session_id)`` when it seeded, else ``None`` (already had a
    world). Never raises; a failed seed just leaves the store as it was.
    """
    try:
        if store.list_characters():
            return None  # a world already exists — never clobber it

        now = now_iso()
        you = Character(id=YOU_ID, kind="human", name=YOU_NAME,
                        persona="", avatar=Avatar(type="letter", text="you",
                                                  bg="", fg=""),
                        created_at=now, updated_at=now)
        store.save_character(you)

        room = Room(id=new_id(), name=DEFAULT_ROOM_NAME, description="",
                    member_ids=[YOU_ID], created_at=now)
        store.save_room(room)

        ws = str(default_workspace_path())
        session = Session(id=new_id(), room_id=room.id, name="",
                          workspace=ws, messages=[], created_at=now,
                          updated_at=now)
        store.save_session(session)

        # Ensure the default workspace directory exists (harmless if present).
        try:
            default_workspace_path().mkdir(parents=True, exist_ok=True)
        except OSError:
            pass

        return YOU_ID, session.id
    except Exception:
        # Never crash startup because seeding failed; the user can create a room.
        return None
