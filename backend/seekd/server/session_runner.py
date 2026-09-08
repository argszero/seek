"""Session runner — wires store + orchestrator + agent for one user turn.

When a user sends a message into a session, this runs one bounded group-chat
turn: every relevant virtual member speaks (with tools), and the transcripts are
persisted to each member's ``seek.db``. The daemon calls this on ``sendMessage``.

v3 model: each member owns a per-session ``seek.db`` (its own view). Shared speech
(``send-message``) is written to every member's db; private tool calls only to the
owning member's db. The agent is assembled with the member's contextual memory +
transcript tools.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from seekd.agent.tool_loop import Agent
from seekd.core.ids import new_id, now_iso
from seekd.core.models import Character, Message
from seekd.llm.base import ChatMessage, LLMClient
from seekd.orchestrator.orchestrator import Orchestrator
from seekd.store.store import SeekStore
from seekd.store.transcript import TranscriptStore
from seekd.tools.registry import member_tools

# The human user is always normalized to id/name "我" (design §4 naming).
YOU_ID = "you"
YOU_NAME = "我"
YOU_KIND = "human"
# Fixed history window size (design §10.18: all members/sessions use the same N).
HISTORY_WINDOW = 24


class MemberContext:
    """A virtual member's identity driving its agent."""

    def __init__(self, id: str, kind: str, name: str, persona: str = "") -> None:
        self.id = id
        self.kind = kind
        self.name = name
        self.persona = persona


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
        persists their replies. It does NOT re-append the user message.
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

        # Shared room speech as the orchestrator history (identical for every
        # member: send-message is shared; tool calls are per-owner and never in
        # the shared stream).
        history = self._room_shared_history(session_id, virtuals[0].id)

        async def run_member_turn(member, system_prompt, prompt):
            return await self._member_turn(member, system_prompt, prompt,
                                           session_id, emit, is_current)

        orchestrator = Orchestrator(run_member_turn)
        emitted = await orchestrator.run(
            session_id=session.id,
            members=[MemberContext(m.id, m.kind, m.name, m.persona) for m in virtuals],
            history=history,
            group_name=room.name,
            group_desc=room.description,
            is_current=is_current,
        )

        # Persist each member's final spoken text to its OWN seek.db, and
        # aggregate a shared frontend message list (broadcast by the daemon).
        saved: list[Message] = []
        for item in emitted:
            speaker = item["speaker"]
            msg = Message(id=new_id(), speaker=speaker, time=now_iso(),
                          kind="text", text=item["text"])
            self._append_shared_speech(session_id, speaker, msg)
            saved.append(msg)
        return saved

    # ---- internals ---------------------------------------------------------
    async def _member_turn(self, member, system_prompt, prompt,
                           session_id: str,
                           emit: Callable[[Message], Awaitable[None]] | None,
                           is_current: Callable[[], bool] | None) -> list[str]:
        # Assemble the member's agent with its contextual memory + transcript tools.
        tools = member_tools(self.store, member.id, session_id)
        agent = self._make_agent(self.llm)
        if self.model_key:
            agent.model = self.model_key
        agent.tools = tools
        agent.tool_by_name = {t.definition().name: t for t in tools}

        # Inject the member's memory context (dirs + indexes + window rule) into
        # its system prompt (v3 §8/§9). persona is already in system_prompt.
        system_prompt = self._inject_memory_context(system_prompt, member.id,
                                                    session_id, member.name)

        messages = [
            ChatMessage(role="system", content=system_prompt),
            ChatMessage(role="user", content=prompt),
        ]

        async def on_tool(tc, result):
            # This member's own private tool call → its own seek.db; broadcast a
            # live tool card to the frontend.
            self._append_private_tool(session_id, member.id, tc, result)
            if emit is None:
                return
            msg = Message(
                id=new_id(),
                speaker=member.id,
                time=now_iso(),
                kind="tool",
                text="",
                cmd=tc.name,
                status="success" if not result.error else "fail",
                ms="",
                output=result.content,
            )
            await emit(msg)

        text = await agent.run(messages, on_tool=on_tool)
        return [text] if text else []

    # ---- per-character persistence ---------------------------------------
    def append_user_message(self, session_id: str, msg: Message) -> None:
        """Persist the human's shared message to EVERY in-room member's seek.db.

        Called by the daemon on ``sendMessage``. The user's author is always
        ``{id:'我', kind:'human'}``.
        """
        entry = {
            "id": msg.id,
            "kind": "send-message",
            "author": {"id": YOU_ID, "name": YOU_NAME, "kind": YOU_KIND},
            "message": {"type": "text", "content": msg.text},
            "timestampMs": msg.time,
        }
        self._append_to_all_members(session_id, entry)

    def _append_shared_speech(self, session_id: str, speaker: str, msg: Message) -> None:
        """Append a virtual member's ``send-message`` to every member's db."""
        author = _author_for(speaker, self.store)
        entry = {
            "id": msg.id,
            "kind": "send-message",
            "author": author,
            "message": {"type": "text", "content": msg.text},
            "timestampMs": msg.time,
        }
        self._append_to_all_members(session_id, entry)

    def _append_private_tool(self, session_id: str, member_id: str, tc, result) -> None:
        """Append a ``tool-call`` ONLY to the owning member's seek.db.

        Other members never receive it (multi-agent privacy boundary).
        """
        entry = {
            "id": new_id(),
            "kind": "tool-call",
            "author": _author_for(member_id, self.store),
            "tool": {
                "name": tc.name,
                "input": tc.arguments,
                "output": result.content,
                "status": "success" if not result.error else "fail",
            },
            "timestampMs": now_iso(),
        }
        db = TranscriptStore(self.store.character_seek_db(session_id, member_id))
        try:
            db.append(entry)
        finally:
            db.close()

    def _append_to_all_members(self, session_id: str, entry: dict) -> None:
        room = self._room_for_session(session_id)
        if room is None:
            return
        for cid in room.member_ids:
            db = TranscriptStore(self.store.character_seek_db(session_id, cid))
            try:
                db.append(entry)
            finally:
                db.close()

    # ---- history / helpers ------------------------------------------------
    def _inject_memory_context(self, system_prompt: str, member_id: str,
                               session_id: str, member_name: str) -> str:
        """Append a member's memory context to its system prompt (v3 §8/§9).

        Injects: the two memory directory paths, a note that *both* indexes are
        injected, the window rule (only the recent window is fed; seek.db is the
        full record), and a directive to use the memory tools. The LLM decides
        *when* to read/search/write.
        """
        sess_mem_dir = self.store.character_session_memory_dir(session_id, member_id)
        glob_mem_dir = self.store.character_global_memory_dir(member_id)
        # Read both indexes (they are auto-injected per design §10.4).
        sess_mem = self.store.character_session_memory(session_id, member_id)
        glob_mem = self.store.character_global_memory(member_id)
        sess_idx = sess_mem.index_text()
        glob_idx = glob_mem.index_text()

        lines = [
            "",
            "== Memory ==",
            f"You are {member_name}. You have your own memory that you manage yourself.",
            f"Your session memory (this conversation): {sess_mem_dir}",
            f"Your global memory (long-term): {glob_mem_dir}",
            "Memory = an index (MEMORY.md) plus detail files. Indexes are always shown to you; details are read on demand.",
            "Use memory_read / memory_search / memory_write / memory_delete for memory. Use transcript_query to search your full transcript.",
            "Do NOT use the generic read/write/shell tools on your memory directory or your seek.db — only the dedicated memory/transcript tools.",
            "",
            "== Your session memory index ==",
            sess_idx,
            "",
            "== Your global memory index ==",
            glob_idx,
            "",
            "== Context window rule ==",
            "The context I see each turn only carries the most recent messages. Your full conversation is in your transcript (seek.db), searchable with transcript_query. If a fact matters long-term (a conclusion, decision, or key detail), write it to your memory now — otherwise it may fall outside the window and you'd have to re-find it.",
        ]
        return system_prompt + "\n".join(lines)

    def _room_shared_history(self, session_id: str, any_member_id: str) -> list[dict]:
        """The room's shared speech (no tool calls) as orchestrator history.

        Shared ``send-message`` is identical in every member's seek.db, so any
        one member's window represents the room. Tool calls are excluded (they
        are per-owner and recalled via transcript_query).
        """
        db = TranscriptStore(self.store.character_seek_db(session_id, any_member_id))
        try:
            entries = db.window(limit=HISTORY_WINDOW)
        finally:
            db.close()
        out: list[dict] = []
        for e in entries:
            h = _as_history(e)
            if h is not None:
                out.append(h)
        return out

    def _room_for_session(self, session_id: str):
        s = self.store.get_session(session_id)
        if s is None:
            return None
        return self.store.get_room(s.room_id)

    def _default_members(self, room_id: str, member_ids: list[str]) -> list[Character]:
        return [c for c in self.store.list_characters() if c.id in member_ids]


def _author_for(speaker: str, store: SeekStore) -> dict:
    """Map a speaker id to a transcript ``author``.

    The human is normalized to ``{id:'我', name:'我', kind:'human'}``. A virtual
    member's author is its character identity.
    """
    if speaker == YOU_ID or speaker == "user":
        return {"id": YOU_ID, "name": YOU_NAME, "kind": YOU_KIND}
    c = store.get_character(speaker)
    if c is None:
        return {"id": speaker, "name": speaker, "kind": "virtual"}
    return {"id": c.id, "name": c.name, "kind": c.kind}


def _as_history(entry: dict) -> dict | None:
    """Translate a transcript entry into the orchestrator's history shape.

    ``send-message``/``user-attachment`` → ``{speaker, kind, text}``. Tool calls
    are never in the shared window, so they are not mapped here (the member
    recalls its own tools via transcript_query).
    """
    kind = entry.get("kind")
    author = entry.get("author") or {}
    if kind not in ("send-message", "user-attachment"):
        return None
    msg = entry.get("message") or {}
    content = msg.get("content", "") if isinstance(msg, dict) else str(msg)
    aid = author.get("id", "")
    if aid == YOU_ID or aid in ("user", ""):
        return {"speaker": "user", "kind": "text", "text": content}
    name = author.get("name", aid)
    return {"speaker": {"id": aid, "name": name}, "kind": "text", "text": content}
