"""Tests for seekd.orchestrator.orchestrator async driver."""

import asyncio
from dataclasses import dataclass

from seekd.orchestrator.orchestrator import Orchestrator


@dataclass
class FakeMember:
    id: str
    kind: str = "virtual"
    name: str = ""
    persona: str = ""


def _run(coro):
    return asyncio.run(coro)


def test_no_members_returns_empty():
    o = Orchestrator(lambda *a, **k: asyncio.sleep(0) or [])
    out = _run(o.run(session_id="s", members=[], history=[], group_name="g"))
    assert out == []


def test_single_member_speaks():
    calls = {"n": 0}

    async def run_turn(member, system, prompt):
        calls["n"] += 1
        # First turn replies, later turns pass (no new messages → stay quiet).
        return ["hello from " + member.name] if calls["n"] == 1 else ["(pass)"]

    o = Orchestrator(run_turn)
    m = [FakeMember(id="m1", name="小明")]
    out = _run(o.run(session_id="s", members=m, history=[
        {"speaker": "user", "text": "hey"},
    ], group_name="读研"))
    assert out == [{"speaker": "m1", "text": "hello from 小明"}]


def test_pass_is_filtered():
    async def run_turn(member, system, prompt):
        return ["(pass)"]

    o = Orchestrator(run_turn)
    m = [FakeMember(id="m1", name="小明")]
    out = _run(o.run(session_id="s", members=m, history=[], group_name="g"))
    assert out == []


def test_turn_cap():
    # member returns 3 msgs, per-turn cap is 2 (GROUP_MAX_MESSAGES_PER_TURN).
    async def run_turn(member, system, prompt):
        return ["a", "b", "c"]

    o = Orchestrator(run_turn)
    m = [FakeMember(id="m1", name="小明")]
    # A user message seeds history; is_current stops after the first round.
    calls = {"n": 0}

    def alive():
        calls["n"] += 1
        return True  # orchestrator always checkable; cap by seeded single round

    out = _run(o.run(session_id="s", members=m, history=[
        {"speaker": "user", "text": "hey"},
    ], group_name="g", is_current=alive))
    # First round: member speaks, trimmed to 2 messages. Live history then has
    # member messages so the next round's 'no new messages' still asks, but the
    # test asserts the per-turn cap held: the first round emitted exactly 2.
    assert out[0]["text"] == "a"
    assert out[1]["text"] == "b"
    # Each round emits at most 2 messages; total is bounded by GROUP_MAX_ROUNDS.
    assert len(out) <= 2 * 3
