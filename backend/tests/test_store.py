"""Tests for seekd.store.jsonstore persistence."""

from pathlib import Path

from seekd.core.models import Character, Message, Room, ScheduledTask, Session
from seekd.store.jsonstore import SeekStore


def _store(tmp_path: Path) -> SeekStore:
    return SeekStore(root=tmp_path)


def test_character_crud(tmp_path):
    st = _store(tmp_path)
    c = Character(id="c1", kind="virtual", name="小明")
    st.save_character(c)
    assert st.get_character("c1").name == "小明"
    assert len(st.list_characters()) == 1
    st.delete_character("c1")
    assert st.get_character("c1") is None


def test_room_crud(tmp_path):
    st = _store(tmp_path)
    r = Room(id="r1", name="读研", member_ids=["c1", "c2"])
    st.save_room(r)
    assert st.get_room("r1").member_ids == ["c1", "c2"]
    assert len(st.list_rooms()) == 1


def test_session_and_append_message(tmp_path):
    st = _store(tmp_path)
    s = Session(id="s1", room_id="r1", name="x", workspace="w")
    st.save_session(s)
    msg = Message(id="m1", speaker="system", time="t", kind="system", text="hi")
    updated = st.append_message("s1", msg)
    assert updated is not None
    assert len(updated.messages) == 1
    assert updated.updated_at == "t"
    # append to a missing session returns None
    assert st.append_message("nope", msg) is None


def test_list_sessions_by_room(tmp_path):
    st = _store(tmp_path)
    st.save_session(Session(id="s1", room_id="r1", updated_at="t2"))
    st.save_session(Session(id="s2", room_id="r1", updated_at="t1"))
    st.save_session(Session(id="s3", room_id="r2", updated_at="t3"))
    r1 = st.list_sessions(room_id="r1")
    assert [s.id for s in r1] == ["s1", "s2"]  # sorted by updated_at desc


def test_task_crud(tmp_path):
    st = _store(tmp_path)
    t = ScheduledTask(id="s1", enabled=True, interval=3600)
    st.save_task(t)
    assert st.get_task("s1").interval == 3600
    assert len(st.list_tasks()) == 1
    st.delete_task("s1")
    assert st.get_task("s1") is None


def test_task_roundtrip_serialization(tmp_path):
    st = _store(tmp_path)
    t = ScheduledTask(id="s1", enabled=False, interval=7200,
                      last_run="2026-01-01T00:00:00", next_run="2026-01-01T01:00:00")
    st.save_task(t)
    got = st.get_task("s1")
    assert got.enabled is False
    assert got.interval == 7200
    assert got.last_run == "2026-01-01T00:00:00"
    assert got.next_run == "2026-01-01T01:00:00"
