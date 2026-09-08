"""Tests for the memory + transcript tools (v3 §8/§9)."""

import asyncio

from seekd.core.models import Character, Room, Session
from seekd.store.store import SeekStore
from seekd.tools.memory_tool import MemoryTools
from seekd.tools.transcript_tool import TranscriptQueryTool


def _run(coro):
    return asyncio.run(coro)


def _seed(tmp_path):
    store = SeekStore(root=tmp_path)
    store.save_character(Character(id="you", kind="human", name="我"))
    store.save_character(Character(id="ai", kind="virtual", name="小明", persona="乐于助人"))
    store.save_room(Room(id="r1", name="读研", member_ids=["you", "ai"]))
    store.save_session(Session(id="s1", room_id="r1", name="会话", workspace="w"))
    store.ensure_member_dirs("s1", ["you", "ai"])
    return store


def test_memory_write_then_read(tmp_path):
    store = _seed(tmp_path)
    tools = {t.definition().name: t for t in MemoryTools(store, "ai", "s1").tools()}
    # write a session memory
    r = _run(tools["memory_write"].execute({
        "scope": "session", "topic": "facts/seek.md",
        "summary": "用户在做 seek 项目", "content": "用户在构建 seek。", "intent": "t",
    }))
    assert r.error is False
    # read the index
    idx = _run(tools["memory_read"].execute({"scope": "session", "mode": "index", "intent": "t"}))
    assert "用户在做 seek 项目" in idx.content
    # read the detail
    det = _run(tools["memory_read"].execute({"scope": "session", "mode": "detail",
                                             "topic": "facts/seek.md", "intent": "t"}))
    assert "用户在构建 seek。" in det.content


def test_memory_search_and_delete(tmp_path):
    store = _seed(tmp_path)
    tools = {t.definition().name: t for t in MemoryTools(store, "ai", "s1").tools()}
    _run(tools["memory_write"].execute({
        "scope": "global", "topic": "others.md",
        "summary": "小明认识小华", "content": "小华是同事。", "intent": "t",
    }))
    hits = _run(tools["memory_search"].execute({"scope": "global", "query": "小华", "intent": "t"}))
    assert "小明认识小华" in hits.content
    # delete it
    del_r = _run(tools["memory_delete"].execute({"scope": "global", "topic": "others.md", "intent": "t"}))
    assert del_r.error is False
    hits2 = _run(tools["memory_search"].execute({"scope": "global", "query": "小华", "intent": "t"}))
    assert "No memories" in hits2.content


def test_memory_tools_isolated_per_character(tmp_path):
    """The 'ai' tools only touch ai's memory; 'you' has its own."""
    store = _seed(tmp_path)
    ai_tools = {t.definition().name: t for t in MemoryTools(store, "ai", "s1").tools()}
    you_tools = {t.definition().name: t for t in MemoryTools(store, "you", "s1").tools()}
    _run(ai_tools["memory_write"].execute({
        "scope": "session", "topic": "goals.md",
        "summary": "AI 的目标", "content": "帮用户完成项目。", "intent": "t",
    }))
    # ai sees it
    ai_idx = _run(ai_tools["memory_read"].execute({"scope": "session", "mode": "index", "intent": "t"}))
    assert "AI 的目标" in ai_idx.content
    # you does NOT see it
    you_idx = _run(you_tools["memory_read"].execute({"scope": "session", "mode": "index", "intent": "t"}))
    assert "AI 的目标" not in you_idx.content


def test_memory_write_rejects_path_traversal(tmp_path):
    store = _seed(tmp_path)
    tools = {t.definition().name: t for t in MemoryTools(store, "ai", "s1").tools()}
    r = _run(tools["memory_write"].execute({
        "scope": "session", "topic": "../../outside.md",
        "summary": "x", "content": "y", "intent": "t",
    }))
    assert r.error is True
    assert "invalid memory topic" in r.content or "Error" in r.content


def test_transcript_query_sees_own_private_tool(tmp_path):
    store = _seed(tmp_path)
    # Append shared + a private tool entry directly to ai's db.
    from seekd.store.transcript import TranscriptStore
    db = TranscriptStore(store.character_seek_db("s1", "ai"))
    try:
        db.append({"id": "m1", "kind": "send-message",
                   "author": {"id": "you", "name": "我", "kind": "human"},
                   "message": {"type": "text", "content": "读一下文件"}, "timestampMs": "t1"})
        db.append({"id": "t1", "kind": "tool-call",
                   "author": {"id": "ai", "name": "小明", "kind": "virtual"},
                   "tool": {"name": "read_file", "input": {"path": "/x"},
                            "output": "secret content", "status": "success"},
                   "timestampMs": "t2"})
    finally:
        db.close()
    tool = TranscriptQueryTool(store, "ai", "s1")
    # query by kind = tool-call sees the private tool.
    r = _run(tool.execute({"kind": "tool-call", "intent": "t"}))
    assert "read_file" in r.content
    assert "secret content" in r.content
    # query by author = the user finds the shared message.
    r2 = _run(tool.execute({"author": "you", "intent": "t"}))
    assert "读一下文件" in r2.content


def test_transcript_query_cannot_see_others_private_tool(tmp_path):
    """A character querying only its own db never sees another's tool call."""
    store = _seed(tmp_path)
    from seekd.store.transcript import TranscriptStore
    # Put a private tool in 'you's db; 'ai' must not find it.
    you_db = TranscriptStore(store.character_seek_db("s1", "you"))
    try:
        you_db.append({"id": "t1", "kind": "tool-call",
                       "author": {"id": "you", "name": "我", "kind": "human"},
                       "tool": {"name": "private_cmd", "input": {}, "output": "cash",
                                "status": "success"}, "timestampMs": "t"})
    finally:
        you_db.close()
    tool = TranscriptQueryTool(store, "ai", "s1")
    r = _run(tool.execute({"kind": "tool-call", "intent": "t"}))
    assert "private_cmd" not in r.content
