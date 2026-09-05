"""Async group-chat orchestration driver.

This wires the pure algorithms (group_chat.py) to a callback that runs one
member's turn. It follows _grok-bot's GroupChatOrchestrator: bounded round
robin, @mention-aware responders, (pass) filtering, and a per-member message cap.

The driver is deliberately agnostic of the agent/LLM: the caller injects
``run_member_turn``. This keeps it unit-testable without any model.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Protocol

from seekd.orchestrator.group_chat import (
    GROUP_MAX_MEMBER_TURNS,
    GROUP_MAX_MESSAGES_PER_TURN,
    GROUP_MAX_ROUNDS,
    build_group_member_system_prompt,
    build_group_turn_prompt,
    is_pass_content,
    messages_since_member_last_spoke,
    order_round_speakers,
    resolve_responders,
)

# A turn runner: given member context + prompts, yield the member's spoken text
# (already limited by the caller). Awaited per member.
RunMemberTurn = Callable[..., Awaitable[list[str]]]


class Member(Protocol):
    """Minimal view of a character the orchestrator needs."""

    id: str
    kind: str
    name: str
    persona: str = ""


class Orchestrator:
    """Drives one bounded group-chat turn for a room/session."""

    def __init__(self, run_member_turn: RunMemberTurn) -> None:
        self._run_turn = run_member_turn

    async def run(
        self,
        *,
        session_id: str,
        members: list[Member],
        history: list[dict],
        group_name: str,
        group_desc: str = "",
        is_current: Callable[[], bool] | None = None,
    ) -> list[dict]:
        """Run up to ``GROUP_MAX_ROUNDS`` rounds. Returns the messages emitted
        by members (each ``{speaker, text}``), so the caller can persist them."""
        if not members:
            return []
        alive = is_current or (lambda: True)
        emitted: list[dict] = []

        member_ids = [m.id for m in members]
        by_id = {m.id: m for m in members}
        member_tuples = [(m.id, m.name) for m in members]

        total_messages = 0
        for round_no in range(GROUP_MAX_ROUNDS):
            if total_messages >= GROUP_MAX_MEMBER_TURNS or not alive():
                break
            # Live history = seeded history + member messages emitted so far.
            live_history = history + emitted
            responder_ids = [m[0] for m in resolve_responders(member_tuples, live_history)]
            round_messages = 0

            for member_id in order_round_speakers(responder_ids, round_no):
                if total_messages >= GROUP_MAX_MEMBER_TURNS or not alive():
                    return emitted
                member = by_id.get(member_id)
                if member is None:
                    continue

                peer_names = [m.name for m in members if m.id != member_id]
                peer_tuples = [(m.id, m.name) for m in members if m.id != member_id]
                new_messages = messages_since_member_last_spoke(live_history, member_id)
                system_prompt = build_group_member_system_prompt(
                    member.name, member.persona, group_name, group_desc, peer_tuples)
                prompt = build_group_turn_prompt(member.name, group_name, peer_names, new_messages)

                spoken = await self._run_turn(member, system_prompt, prompt)

                # Per-member cap: keep at most GROUP_MAX_MESSAGES_PER_TURN messages
                # (grok-bot caps a single member's output in one turn).
                for content in spoken:
                    trimmed = content.strip()
                    if is_pass_content(trimmed):
                        continue
                    emitted.append({"speaker": member.id, "text": trimmed})
                    total_messages += 1
                    round_messages += 1
                    if round_messages >= GROUP_MAX_MESSAGES_PER_TURN:
                        break

            if round_messages == 0:
                break

        return emitted
