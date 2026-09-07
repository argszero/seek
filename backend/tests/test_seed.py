"""Tests for seekd.core.seed — built-in world bootstrap."""

from pathlib import Path

from seekd.core.models import Room
from seekd.core.seed import (SEEK_ID, SEEK_NAME, ROOM_SEEK_ID, ROOM_SEEK_NAME,
                             YOU_ID, ensure_seeded, default_workspace_path,
                             is_builtin_character, is_builtin_room)
from seekd.store.jsonstore import SeekStore


def _find_room(store: SeekStore, rid: str):
    return store.get_room(rid)


def test_seeds_builtin_world_on_empty(tmp_path: Path):
    store = SeekStore(root=tmp_path)
    assert ensure_seeded(store) is True  # created something
    chars = {c.id: c for c in store.list_characters()}
    assert YOU_ID in chars and chars[YOU_ID].kind == "human"
    assert SEEK_ID in chars and chars[SEEK_ID].kind == "virtual"
    assert chars[SEEK_ID].name == SEEK_NAME
    # The built-in room has exactly you + seek (so there is an AI to talk to).
    room = _find_room(store, ROOM_SEEK_ID)
    assert room is not None and room.name == ROOM_SEEK_NAME
    assert set(room.member_ids) == {YOU_ID, SEEK_ID}
    # One default session in the built-in room, bound to the default workspace.
    sessions = [s for s in store.list_sessions() if s.room_id == ROOM_SEEK_ID]
    assert len(sessions) == 1
    assert sessions[0].workspace == str(default_workspace_path())
    assert room.id == ROOM_SEEK_ID


def test_seed_is_idempotent(tmp_path: Path):
    store = SeekStore(root=tmp_path)
    assert ensure_seeded(store) is True
    # Second call must NOT duplicate anything.
    assert ensure_seeded(store) is False
    chars = store.list_characters()
    assert len(chars) == 2  # you + seek
    assert len(store.list_rooms()) == 1  # only the built-in room
    assert len(store.list_sessions()) == 1


def test_seed_upgrades_existing_world_without_clobber(tmp_path: Path):
    """An existing world (pre-built-in upgrade) keeps its data and gains the
    seek character + seek room; the daemon-side helper reports built-ins."""
    from seekd.core.models import Character, Avatar
    from seekd.core.ids import new_id, now_iso
    store = SeekStore(root=tmp_path)
    now = now_iso()
    old_you = Character(id=YOU_ID, kind="human", name=YOU_ID, persona="",
                        avatar=Avatar(type="letter", text="you", bg="", fg=""),
                        created_at=now, updated_at=now)
    store.save_character(old_you)
    store.save_room(Room(id=new_id(), name="我和 AI", description="",
                         member_ids=[YOU_ID], created_at=now))
    store.save_character(Character(id=new_id(), kind="virtual", name="小明",
                                   persona="", avatar=Avatar(type="letter",
                                                             text="明", bg="", fg=""),
                                   created_at=now, updated_at=now))
    assert ensure_seeded(store) is True  # filled in the missing built-ins
    chars = store.list_characters()
    assert len(chars) == 3  # you + seek + 小明 (nothing deleted)
    room = _find_room(store, ROOM_SEEK_ID)
    assert room is not None and set(room.member_ids) == {YOU_ID, SEEK_ID}
    # User rooms untouched.
    assert len(store.list_rooms()) == 2
    # Idempotent on the upgraded world.
    assert ensure_seeded(store) is False


def test_seed_repairs_missing_builtin_member(tmp_path: Path):
    """If the built-in room exists but lost a core member, seed adds it back."""
    from seekd.core.models import Room
    from seekd.core.ids import now_iso
    store = SeekStore(root=tmp_path)
    assert ensure_seeded(store) is True
    room = _find_room(store, ROOM_SEEK_ID)
    assert room is not None
    room.member_ids = [YOU_ID]  # simulate tampering: seek removed
    store.save_room(room)
    assert ensure_seeded(store) is True  # repaired
    assert set(_find_room(store, ROOM_SEEK_ID).member_ids) == {YOU_ID, SEEK_ID}


def test_builtin_helpers(tmp_path: Path):
    assert is_builtin_character(YOU_ID) and is_builtin_character(SEEK_ID)
    assert not is_builtin_character("someone-else")
    assert is_builtin_room(ROOM_SEEK_ID) and not is_builtin_room("room-xyz")
