"""Tests for seekd.core.seed — first-run world bootstrap."""

from pathlib import Path

from seekd.core.seed import ensure_seeded, YOU_ID, default_workspace_path
from seekd.store.jsonstore import SeekStore


def test_seeds_you_room_session_on_empty(tmp_path: Path):
    store = SeekStore(root=tmp_path)
    result = ensure_seeded(store)
    assert result == (YOU_ID, result[1])  # you id + session id
    chars = store.list_characters()
    assert len(chars) == 1 and chars[0].id == YOU_ID and chars[0].kind == "human"
    rooms = store.list_rooms()
    assert len(rooms) == 1
    sessions = store.list_sessions()
    assert len(sessions) == 1
    # the default session is bound to the default workspace
    assert sessions[0].workspace == str(default_workspace_path())
    # the default room contains you
    assert YOU_ID in rooms[0].member_ids


def test_seed_is_idempotent(tmp_path: Path):
    store = SeekStore(root=tmp_path)
    assert ensure_seeded(store) is not None
    # Second call must NOT clobber the existing world.
    assert ensure_seeded(store) is None
    assert len(store.list_characters()) == 1  # still just you, no duplicates


def test_seed_noop_when_world_exists(tmp_path: Path):
    from seekd.core.models import Character, Avatar
    from seekd.core.ids import new_id, now_iso
    store = SeekStore(root=tmp_path)
    now = now_iso()
    other = Character(id=new_id(), kind="virtual", name="小明", persona="",
                      avatar=Avatar(type="letter", text="小明", bg="", fg=""),
                      created_at=now, updated_at=now)
    store.save_character(other)
    assert ensure_seeded(store) is None  # already has a world -> no seed
    assert store.list_rooms() == []  # did not inject default room
