"""Session runner — wires store + orchestrator + agent for one user turn.

When a user sends a message into a session, this runs one bounded group-chat
turn: every relevant virtual member speaks (with tools), and their messages are
appended to the session. The daemon calls this on ``sendMessage``.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from seekd.agent.tool_loop import Agent
from seekd.core.ids import new_id, now_iso
from seekd.core.models import Character, Message, Session
from seekd.llm.base import ChatMessage, LLMClient
from seekd.orchestrator.orchestrator import Orchestrator
from seekd.store.jsonstore import SeekStore


@dataclass
class MemberContext:
    """A virtual member's identity driving its agent."""

    id: str
    kind: str
    name: str
    persona: str = ""


class SessionRunner:
    """Drives orchestration for sessions."""

    def __init__(
        self,
        store: SeekStore,
        llm: LLMClient,
        make_agent: Callable[[LLMClient], Any] | None = None,
        room_members: Callable[[str, list[str]], list[Character]] | None = None,
    ) -> None:
        self.store = store
        self.llm = llm
        self._make_agent = make_agent or (lambda l: Agent(l))
        self._room_members = room_members or self._default_members
        self.model_key: str = getattr(llm, "model", "") or ""

    def set_model(self, key: str) -> None:
        """Switch the default model used for subsequent turns."""
        self.model_key = key

    # ---- public ----------------------------------------------------------
    async def handle_user_message(
        self,
        session_id: str,
        text: str,
        is_current: Callable[[], bool] | None = None,
        emit: Callable[[Message], Awaitable[None]] | None = None,
    ) -> list[Message]:
        """Run the group turn for a user message the caller already persisted.

        The *caller* (daemon) is responsible for appending and broadcasting the
        user's own message; this method only runs the virtual members and
        persists their replies. It does NOT re-append the user message, so a
        single user turn never duplicates the user's text in the session.

        ``is_current`` (optional) is an epoch-cancellable signal: it returns
        ``False`` when a ``cancel`` request should stop the turn. The orchestrator
        checks it between rounds; an in-flight LLM call is interrupted by the
        daemon cancelling the wrapping task.

        ``emit`` (optional) is a callback invoked as each member's tool messaage
        is produced, so the daemon can broadcast a ``kind="tool"`` card *as it
        happens* (rather than only after the whole turn). When absent, tool
        messages are still persisted but not streamed out early.
        """
        session = self.store.get_session(session_id)
        if session is None:
            return []

        room = self.store.get_room(session.room_id)
        if room is None or not room.member_ids:
            return []

        members = self._room_members(room.id, room.member_ids)
        virtuals = [m for m in members if m.kind == "virtual"]
        if not virtuals:
            return []

        history = [self._as_history(m) for m in session.messages]
        group_name = room.name

        async def run_member_turn(member, system_prompt, prompt):
            return await self._member_turn(member, system_prompt, prompt, session_id, emit, is_current)

        orchestrator = Orchestrator(run_member_turn)
        emitted = await orchestrator.run(
            session_id=session.id,
            members=[MemberContext(m.id, m.kind, m.name, m.persona) for m in virtuals],
            history=history,
            group_name=group_name,
            group_desc=room.description,
            is_current=is_current,
        )
        return self._persist(session_id, emitted)

    # ---- internals ---------------------------------------------------------
    async def _member_turn(self, member, system_prompt, prompt,
                           session_id: str,
                           emit: Callable[[Message], Awaitable[None]] | None,
                           is_current: Callable[[], bool] | None) -> list[str]:
        agent = self._make_agent(self.llm)
        if self.model_key:
            agent.model = self.model_key
        messages = [
            ChatMessage(role="system", content=system_prompt),
            ChatMessage(role="user", content=prompt),
        ]

        async def on_tool(tc, result):
            if emit is None:
                return
            # Surface a tool card: persisted + streamed immediately, before the
            # member's final text. Mirrors the CONTRACT ``tool`` message shape.
            msg = Message(
                id=new_id(),
                speaker=member.id,
                time=now_iso(),
                kind="tool",
                text="",  # tool cards show cmd/status/output, not text
                cmd=tc.name,
                status="success" if not result.error else "fail",
                ms="",   # we don't measure execution ms here; leave blank
                output=result.content,
            )
            self.store.append_message(session_id, msg)
            await emit(msg)

        text = await agent.run(messages, on_tool=on_tool)
        return [text] if text else []

    def _persist(self, session_id: str, emitted: list[dict]) -> list[Message]:
        saved: list[Message] = []
        for item in emitted:
            msg = Message(id=new_id(), speaker=item["speaker"], time=now_iso(),
                          kind="text", text=item["text"])
            self.store.append_message(session_id, msg)
            saved.append(msg)
        return saved

    def _default_members(self, room_id: str, member_ids: list[str]) -> list[Character]:
        return [c for c in self.store.list_characters() if c.id in member_ids]

    @staticmethod
    def _as_history(m: Message) -> dict:
        sp = "user" if m.speaker == "user" else m.speaker
        return {"speaker": sp, "text": m.text}
