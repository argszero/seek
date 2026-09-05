"""Tests for seekd.orchestrator.group_chat pure algorithms."""

from seekd.orchestrator.group_chat import (
    is_pass_content,
    messages_since_member_last_spoke,
    order_round_speakers,
    parse_group_mentions,
    resolve_responders,
)


def test_order_round_speakers_rotates():
    ids = ["a", "b", "c"]
    assert order_round_speakers(ids, 0) == ["a", "b", "c"]
    assert order_round_speakers(ids, 1) == ["b", "c", "a"]
    assert order_round_speakers(ids, 2) == ["c", "a", "b"]
    assert order_round_speakers([], 0) == []


def test_is_pass_content():
    assert is_pass_content("")
    assert is_pass_content("   ")
    assert is_pass_content("(pass)")
    assert is_pass_content("Pass")
    assert is_pass_content("pass.")
    assert not is_pass_content("hello")
    assert not is_pass_content("(pass) but also")


def test_parse_group_mentions_everyone():
    members = [("m1", "小明"), ("m2", "小红")]
    everyone, mentioned = parse_group_mentions("@everyone look", members)
    assert everyone is True
    assert mentioned == []
    # specific mention
    everyone, mentioned = parse_group_mentions("@小明 what do you think?", members)
    assert everyone is False
    assert mentioned == ["m1"]


def test_resolve_responders_no_mention_all():
    members = [("m1", "小明"), ("m2", "小红")]
    history = [{"speaker": "user", "text": "大家好"}]
    assert [m[0] for m in resolve_responders(members, history)] == ["m1", "m2"]


def test_resolve_responders_specific_mention():
    members = [("m1", "小明"), ("m2", "小红")]
    history = [{"speaker": "user", "text": "@小明 回答一下"}]
    assert [m[0] for m in resolve_responders(members, history)] == ["m1"]


def test_messages_since_member_last_spoke():
    history = [
        {"speaker": "user", "text": "hi"},
        {"speaker": "m1", "text": "hello"},
        {"speaker": "user", "text": "again"},
    ]
    after = messages_since_member_last_spoke(history, "m1")
    # only the last user message remains after m1 spoke
    assert [m["text"] for m in after] == ["again"]
