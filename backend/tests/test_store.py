"""Tests for seekd.store — world entities (store) + transcript (seek.db) + memory."""

from pathlib import Path

from seekd.core.models import Character, Room, ScheduledTask, Session
from seekd.store.memory import MemoryStore
from seekd.store.store import SeekStore
from seekd.store.transcript import TranscriptStore


def _store(tmp_path: Path) -> SeekStore:
    return SeekStore(root=tmp_path)


def _seed_world(st: SeekStore, member_ids=None):
    """One room + one session with a couple of members, so member dirs exist."""
    st.save_character(Character(id="you", kind="human", name="我"))
    st.save_character(Character(id="ai", kind="virtual", name="小明"))
    st.save_room(Room(id="r1", name="读研", member_ids=member_ids or ["you", "ai"]))
    st.save_session(Session(id="s1", room_id="r1", name="会话", workspace="w"))
    st.ensure_member_dirs("s1", member_ids or ["you", "ai"])


# ---- world entities --------------------------------------------------------

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


def test_session_save_and_get(tmp_path):
    st = _store(tmp_path)
    s = Session(id="s1", room_id="r1", name="x", workspace="w")
    st.save_session(s)
    got = st.get_session("s1")
    assert got is not None
    assert got.room_id == "r1"
    assert got.workspace == "w"
    # A pristine session has no inline messages (v3).
    assert not hasattr(got, "messages")


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


# ---- per-member dirs / transcript ----------------------------------------

def test_ensure_member_dirs_creates_seek_db_and_memory(tmp_path):
    st = _store(tmp_path)
    _seed_world(st)
    # Both members got a seek.db and an empty memory dir + index.
    for cid in ("you", "ai"):
        assert st.character_seek_db("s1", cid).exists()
        mem = st.character_session_memory("s1", cid)
        assert mem.index_path.exists()
        assert mem.read_index() == []
    # Global memory also exists.
    assert st.character_global_memory("ai").index_path.exists()


def test_append_shared_entry_goes_to_every_member(tmp_path):
    st = _store(tmp_path)
    _seed_world(st)
    st.append_shared_entry("s1", {
        "id": "m1",
        "kind": "send-message",
        "author": {"id": "you", "name": "我", "kind": "human"},
        "message": {"type": "text", "content": "大家好"},
        "timestampMs": "t",
    })
    for cid in ("you", "ai"):
        db = TranscriptStore(st.character_seek_db("s1", cid))
        try:
            assert db.count() == 1
            w = db.window()
            assert w[0]["message"]["content"] == "大家好"
        finally:
            db.close()


def test_private_tool_only_in_own_db(tmp_path):
    st = _store(tmp_path)
    _seed_world(st)
    # ai's own tool call.
    ai_db = TranscriptStore(st.character_seek_db("s1", "ai"))
    you_db = TranscriptStore(st.character_seek_db("s1", "you"))
    try:
        ai_db.append({
            "id": "t1",
            "kind": "tool-call",
            "author": {"id": "ai", "name": "小明", "kind": "virtual"},
            "tool": {"name": "bash", "input": {}, "output": "secret", "status": "success"},
            "timestampMs": "t",
        })
        # ai sees it (via tail), you does not (physically absent).
        assert any(e["kind"] == "tool-call" for e in ai_db.tail())
        assert not any(e["kind"] == "tool-call" for e in you_db.tail())
        # ai's window (non-tool) excludes it.
        assert not any(e["kind"] == "tool-call" for e in ai_db.window())
    finally:
        ai_db.close()
        you_db.close()


def test_get_session_messages_aggregates_shared_speech(tmp_path):
    st = _store(tmp_path)
    _seed_world(st)
    st.append_shared_entry("s1", {
        "id": "m1", "kind": "send-message",
        "author": {"id": "you", "name": "我", "kind": "human"},
        "message": {"type": "text", "content": "hi"}, "timestampMs": "t1",
    })
    st.append_shared_entry("s1", {
        "id": "m2", "kind": "send-message",
        "author": {"id": "ai", "name": "小明", "kind": "virtual"},
        "message": {"type": "text", "content": "hello"}, "timestampMs": "t2",
    })
    msgs = st.get_session_messages("s1")
    assert [m.text for m in msgs] == ["hi", "hello"]
    assert msgs[1].speaker == "ai"


# ---- transcript store (direct) -------------------------------------------

def test_transcript_window_excludes_tool(tmp_path):
    db = TranscriptStore(tmp_path / "x" / "seek.db")
    db.append({"id": "a", "kind": "send-message", "author": {"id": "you", "name": "我", "kind": "human"},
               "message": {"type": "text", "content": "hi"}, "timestampMs": "1"})
    db.append({"id": "b", "kind": "tool-call", "author": {"id": "ai", "name": "A", "kind": "virtual"},
               "tool": {"name": "bash", "input": {}, "output": "x", "status": "success"}, "timestampMs": "2"})
    db.append({"id": "c", "kind": "send-message", "author": {"id": "ai", "name": "A", "kind": "virtual"},
               "message": {"type": "text", "content": "bye"}, "timestampMs": "3"})
    try:
        assert [e["id"] for e in db.window()] == ["a", "c"]
        assert [e["id"] for e in db.tail()] == ["a", "b", "c"]
    finally:
        db.close()


def test_transcript_query_filters(tmp_path):
    db = TranscriptStore(tmp_path / "y" / "seek.db")
    db.append({"id": "1", "kind": "send-message", "author": {"id": "you", "name": "我", "kind": "human"},
               "message": {"type": "text", "content": "project plan"}, "timestampMs": "100"})
    db.append({"id": "2", "kind": "send-message", "author": {"id": "ai", "name": "A", "kind": "virtual"},
               "message": {"type": "text", "content": "let me check"}, "timestampMs": "200"})
    try:
        by_author = db.query(author="ai")
        assert [e["id"] for e in by_author] == ["2"]
        by_kind = db.query(kind="send-message")
        assert len(by_kind) == 2
        by_kw = db.query(keyword="plan")
        assert [e["id"] for e in by_kw] == ["1"]
        by_time = db.query(time_start="150")
        assert [e["id"] for e in by_time] == ["2"]
    finally:
        db.close()


# ---- memory store (direct) ------------------------------------------------

def test_memory_index_and_detail(tmp_path):
    mem = MemoryStore(tmp_path / "memory")
    mem.ensure_index()
    assert mem.read_index() == []
    mem.write_detail("facts/seek.md", "user builds seek.")
    mem.write_index([{"summary": "用户在做 seek 项目", "path": "facts/seek.md"}])
    # The index line points to the detail; the detail body is separate.
    assert mem.index_text().startswith("- 用户在做 seek 项目")
    assert "facts/seek.md" in mem.index_text()
    assert mem.read_detail("facts/seek.md") == "user builds seek."
    hits = mem.search("seek")
    assert hits and hits[0]["path"] == "facts/seek.md"


def test_memory_detail_path_rejects_traversal(tmp_path):
    mem = MemoryStore(tmp_path / "memory")
    try:
        mem.write_detail("../../outside.md", "bad")
        assert False, "should have rejected traversal"
    except ValueError:
        pass
