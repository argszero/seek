"""Tests for seekd.server.session_runner — user turn → group chat → seek.db."""

import asyncio

from seekd.core.models import Character, Room, Session
from seekd.llm.base import ToolCall
from seekd.server.session_runner import SessionRunner
from seekd.store.store import SeekStore
from seekd.store.transcript import TranscriptStore
from seekd.tools.base import ToolResult


class FakeAgent:
    def __init__(self, text):
        self.text = text

    async def run(self, messages, on_tool=None):
        return self.text


class FakeAgentWithTool:
    """An agent that runs one tool (via on_tool) then returns text."""
    async def run(self, messages, on_tool=None):
        if on_tool is not None:
            await on_tool(
                ToolCall(id="tc1", name="read_file", arguments={"path": "/tmp/x"}),
                ToolResult(name="read_file", content="file contents"),
            )
        return "我读完了。"


class FakeLLM:
    """Not used — SessionRunner drives agent.run directly via make_agent."""

    async def stream(self, *a, **k):
        yield None


def _seed(tmp_path):
    store = SeekStore(root=tmp_path)
    you = Character(id="you", kind="human", name="我")
    ai = Character(id="ai", kind="virtual", name="小助手", persona="乐于助人")
    store.save_character(you)
    store.save_character(ai)
    room = Room(id="r1", name="读研", member_ids=["you", "ai"])
    store.save_room(room)
    sess = Session(id="s1", room_id="r1", name="会话", workspace="w")
    store.save_session(sess)
    store.ensure_member_dirs("s1", ["you", "ai"])
    return store


def _db(store, cid):
    return TranscriptStore(store.character_seek_db("s1", cid))


def test_handle_user_message_runs_turn(tmp_path):
    store = _seed(tmp_path)
    # The caller (daemon) appends + broadcasts the user's message via the
    # runner's append_user_message before invoking handle_user_message.
    from seekd.core.ids import new_id, now_iso
    from seekd.core.models import Message
    runner = SessionRunner(store, FakeLLM(), make_agent=lambda l: FakeAgent("我来帮你分析。"))
    runner.append_user_message("s1", Message(id=new_id(), speaker="user", time=now_iso(),
                                             kind="text", text="帮我看看"))
    saved = asyncio.run(runner.handle_user_message("s1", "帮我看看"))
    assert saved, "no messages saved"
    assert any(m.text == "我来帮你分析。" for m in saved)
    assert all(m.speaker != "user" for m in saved)
    # The user message was persisted by the caller into the member dbs.
    db = _db(store, "ai")
    try:
        kinds = [e["kind"] for e in db.tail()]
        assert "send-message" in kinds
        contents = [e["message"]["content"] for e in db.tail()
                    if e["kind"] == "send-message"]
        assert "帮我看看" in contents
        assert "我来帮你分析。" in contents
    finally:
        db.close()


def test_no_virtual_members_no_turn(tmp_path):
    store = _seed(tmp_path)
    room = store.get_room("r1")
    room.member_ids = ["you"]
    store.save_room(room)

    runner = SessionRunner(store, FakeLLM(), make_agent=lambda l: FakeAgent("should not run"))
    saved = asyncio.run(runner.handle_user_message("s1", "hi"))
    assert saved == []


def test_tool_messages_persisted_privately(tmp_path):
    store = _seed(tmp_path)
    from seekd.core.ids import new_id, now_iso
    from seekd.core.models import Message
    runner = SessionRunner(store, FakeLLM(), make_agent=lambda l: FakeAgentWithTool())
    runner.append_user_message("s1", Message(id=new_id(), speaker="user", time=now_iso(),
                                             kind="text", text="读一下文件"))

    emitted: list = []

    async def emit(msg):
        emitted.append(msg)

    saved = asyncio.run(runner.handle_user_message("s1", "读一下文件", emit=emit))
    # Tool card emitted live.
    assert emitted and emitted[0].kind == "tool"
    assert emitted[0].cmd == "read_file"
    assert emitted[0].speaker == "ai"
    # The tool call is in AI's own seek.db, NOT the user's.
    ai_db = _db(store, "ai")
    you_db = _db(store, "you")
    try:
        assert any(e["kind"] == "tool-call" and e["tool"]["name"] == "read_file"
                   for e in ai_db.tail())
        assert not any(e["kind"] == "tool-call" for e in you_db.tail())
        # AI's text reply is a shared send-message in both dbs.
        contents = [e["message"]["content"] for e in ai_db.tail()
                    if e["kind"] == "send-message"]
        assert "我读完了。" in contents
    finally:
        ai_db.close()
        you_db.close()
