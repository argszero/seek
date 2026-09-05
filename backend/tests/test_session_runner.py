"""Tests for seekd.server.session_runner — user turn → group chat → persist."""

import asyncio

from seekd.core.models import Character, Room, Session
from seekd.llm.base import ToolCall
from seekd.server.session_runner import SessionRunner
from seekd.store.jsonstore import SeekStore
from seekd.tools.base import ToolResult


class FakeAgent:
    def __init__(self, text):
        self.text = text

    async def run(self, messages, on_tool=None):
        return self.text


class FakeAgentWithTool:
    """An agent that runs one tool (via on_tool) then returns text."""
    async def run(self, messages, on_tool=None):
        from seekd.tools.base import ToolResult
        if on_tool is not None:
            # Simulate the loop executing a tool call after the LLM requested it.
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
    you = Character(id="you", kind="human", name="你")
    ai = Character(id="ai", kind="virtual", name="小助手", persona="乐于助人")
    store.save_character(you)
    store.save_character(ai)
    room = Room(id="r1", name="读研", member_ids=["you", "ai"])
    store.save_room(room)
    sess = Session(id="s1", room_id="r1", name="会话", workspace="w")
    store.save_session(sess)
    return store


def test_handle_user_message_runs_turn(tmp_path):
    store = _seed(tmp_path)
    # The *caller* (daemon) appends + broadcasts the user's own message
    # before invoking the runner. Runner only produces virtual replies.
    from seekd.core.ids import new_id, now_iso
    from seekd.core.models import Message
    store.append_message("s1", Message(id=new_id(), speaker="user", time=now_iso(),
                                       kind="text", text="帮我看看"))

    def make_agent(llm):
        return FakeAgent("我来帮你分析。")

    runner = SessionRunner(store, FakeLLM(), make_agent=make_agent)
    saved = asyncio.run(runner.handle_user_message("s1", "帮我看看"))
    assert saved, "no messages saved"
    assert any(m.text == "我来帮你分析。" for m in saved)
    # The user message was persisted by the caller, so it is the first message
    # and the runner did NOT duplicate it.
    sess = store.get_session("s1")
    assert sess.messages[0].speaker == "user"
    assert sess.messages[0].text == "帮我看看"
    # The runner's saved list contains only the virtual member's replies.
    assert all(m.speaker != "user" for m in saved)
    # And the virtual reply is present in the persisted session too.
    assert any(m.text == "我来帮你分析。" for m in sess.messages)


def test_no_virtual_members_no_turn(tmp_path):
    store = _seed(tmp_path)
    # keep only the human in the room
    room = store.get_room("r1")
    room.member_ids = ["you"]
    store.save_room(room)

    def make_agent(llm):
        return FakeAgent("should not run")

    runner = SessionRunner(store, FakeLLM(), make_agent=make_agent)
    saved = asyncio.run(runner.handle_user_message("s1", "hi"))
    assert saved == []


def test_tool_messages_persisted_and_emitted(tmp_path):
    store = _seed(tmp_path)
    from seekd.core.ids import new_id, now_iso
    from seekd.core.models import Message
    store.append_message("s1", Message(id=new_id(), speaker="user", time=now_iso(),
                                       kind="text", text="读一下文件"))

    def make_agent(llm):
        return FakeAgentWithTool()

    emitted: list[Message] = []

    async def emit(msg: Message):
        emitted.append(msg)

    runner = SessionRunner(store, FakeLLM(), make_agent=make_agent)
    saved = asyncio.run(runner.handle_user_message("s1", "读一下文件", emit=emit))
    # A tool card was emitted live and persisted to the session.
    assert emitted, "expected a tool card to be emitted during the turn"
    tool = emitted[0]
    assert tool.kind == "tool"
    assert tool.cmd == "read_file"
    assert tool.speaker == "ai"
    assert "file contents" in tool.output
    # The tool card is also persisted, before(the member's text reply).
    sess = store.get_session("s1")
    kinds = [m.kind for m in sess.messages]
    assert "tool" in kinds
    # The member's text reply is persisted after the tool card.
    texts = [m.text for m in sess.messages if m.kind == "text"]
    assert "我读完了。" in texts
