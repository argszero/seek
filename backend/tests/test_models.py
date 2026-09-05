"""Tests for seekd.core.models serialization."""

from seekd.core.models import Avatar, Character, Message, Room, Session, SpeakStrategy


def test_character_roundtrip():
    c = Character(
        id="c1", kind="virtual", name="小明",
        avatar=Avatar(type="letter", text="小明"),
        speak_strategy=SpeakStrategy(max_per_turn=3),
        created_at="t0", updated_at="t0",
    )
    d = c.to_dict()
    assert d["kind"] == "virtual"
    assert d["speakStrategy"]["maxPerTurn"] == 3
    assert d["avatar"]["text"] == "小明"
    c2 = Character.from_dict(d)
    assert c2.avatar.text == "小明"
    assert c2.speak_strategy.max_per_turn == 3


def test_room_roundtrip():
    r = Room(id="r1", name="读研", member_ids=["c1"], created_at="t0")
    d = r.to_dict()
    assert d["memberIds"] == ["c1"]
    r2 = Room.from_dict(d)
    assert r2.member_ids == ["c1"]
    assert r2.created_at == "t0"


def test_message_tool_kind():
    m = Message(id="m1", speaker="c1", time="t", kind="tool",
                text="", cmd="ls", status="success", ms="12", output="x")
    d = m.to_dict()
    assert d["kind"] == "tool"
    assert d["cmd"] == "ls"
    m2 = Message.from_dict(d)
    assert m2.cmd == "ls"
    assert m2.status == "success"


def test_session_roundtrip_messages():
    m = Message(id="m1", speaker="system", time="t", kind="system", text="hi")
    s = Session(id="s1", room_id="r1", name="x", workspace="w",
                messages=[m], created_at="t", updated_at="t")
    d = s.to_dict()
    assert d["roomId"] == "r1"
    assert d["messages"][0]["kind"] == "system"
    s2 = Session.from_dict(d)
    assert len(s2.messages) == 1
    assert s2.messages[0].text == "hi"
