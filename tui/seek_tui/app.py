"""seek TUI app — EMRG-parity terminal client for seekd.

Interaction model ported from the EMRG TUI (MIT, same author): a raw-ANSI
engine (``seek_tui.python_tui``) with a full line editor, ``/`` command menu
with Tab/↑↓ completion, interactive selectors, a status bar with a busy
elapsed timer, expandable tool cards, Esc-to-interrupt, paste mode, and
auto-reconnect.

The seek world is fixed (host decision 2026-09-07): the built-in room ``seek``
(you + the virtual member ``seek``) is the only room this client uses. There is
no room/character management surface — /sessions switches between sessions of
that room, and a fresh session is created when none exists or after the current
one is deleted.

Wire protocol: seekd over WebSocket (CONTRACT.md). Rows render as:
    user      -> ``> `` cyan markdown
    seek (AI) -> ``● `` magenta
    system    -> ``○ `` dim
    tool      -> expandable ToolCard (Tab toggles output)
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import sys
import time

from seek_tui.python_tui import StatusLine, Terminal, ToolCard
from seek_tui.python_tui.events import InputParser
from seek_tui.protocol import SeekClient
from seek_tui.widgets import (
    ChatHistory,
    CommandDropdown,
    InputWidget,
    ModelSelector,
    SelectorState,
    SessionSelector,
    TaskSelector,
)

log = logging.getLogger("seek_tui")

VERSION = "0.1.13"
ROOM_SEEK_ID = "room-seek"
ROOM_SEEK_NAME = "seek"
CHAR_SEEK_ID = "seek"     # built-in virtual member
CHAR_YOU_ID = "you"       # built-in human

# seek command surface (replaces EMRG's: no /rant /memory /skills /image /
# /compact /rewind — those are EMRG concepts seek has no backend for).
SEEK_COMMAND_HELP: dict[str, str] = {
    "/help":     "Show keyboard shortcuts and commands",
    "/new":      "Start a fresh session in this room",
    "/sessions": "Browse sessions of this room (↑↓/j/k to pick)",
    "/resume":   "Switch to a session by [id] (no args = picker)",
    "/rename":   "Rename current session: /rename <title>",
    "/delete":   "Delete a session (/delete <id>, no args = picker)",
    "/clear":    "Clear current session history and start fresh",
    "/model":    "Switch LLM model (/model <name>, no args = picker)",
    "/trigger":  "List scheduled tasks (no args = picker)",
    "/stop":     "Stop the seek daemon — closes this TUI, the GUI and the WEBUI",
    "/version":  "Show seek version and session info",
}

# The CommandDropdown widget builds its list from the module-level
# _COMMAND_HELP — point it at seek's command set so the dropdown and its
# descriptions match the commands this client actually implements.
import seek_tui.widgets as _seek_widgets  # noqa: E402

_seek_widgets._COMMAND_HELP = SEEK_COMMAND_HELP


def _csi_modifier_action(data: bytes) -> str | None:
    """Map modifier-prefixed CSI arrows (Alt/Ctrl+←→) to word movement.

    Ported from EMRG app.py: macOS terminals send ``\\x1b[1;3D`` for Option+←,
    ``\\x1b[1;3C`` for Option+→, ``\\x1b[1;5D`` for Ctrl+← etc. The Kitty
    keyboard protocol form ``\\x1b[68;3u`` is also handled.
    """
    if len(data) < 4 or data[0] != 0x1B or data[1] != 0x5B:
        return None
    if b";" not in data:
        return None
    final = data[-1]
    if not (0x40 <= final <= 0x7E):
        return None
    try:
        parts = data[2:-1].split(b";")
        if not parts or any(not p.isdigit() for p in parts):
            return None
        params = [int(p) for p in parts]
    except ValueError:
        return None
    if len(params) < 2:
        return None
    mod = params[1]
    if mod not in (3, 5, 7):  # Alt(3) / Ctrl(5) / Alt+Ctrl(7)
        return None
    if final in (0x44, 0x43):  # legacy CSI: D=← C=→
        return "word_left" if final == 0x44 else "word_right"
    if final == 0x75 and params[0] in (67, 68):  # Kitty CSI-u
        return "word_left" if params[0] == 68 else "word_right"
    return None


# ── pure helpers (unit-testable) ─────────────────────────────────────────

def auto_title_from_prompt(text: str, max_len: int = 30) -> str | None:
    """Deterministic session title from the first user prompt (EMRG borrow)."""
    if not text or text.lstrip().startswith("/"):
        return None
    first = next((ln.strip() for ln in text.splitlines() if ln.strip()), "")
    if not first:
        return None
    first = re.sub(r"\s+", " ", first)
    if len(first) <= max_len:
        return first
    return first[: max_len - 1] + "…"


def short_id(sid: str, n: int = 6) -> str:
    return sid[:n] if sid else ""


def session_label(s: dict) -> str:
    """Display label for a session (its name, else a short id)."""
    if not isinstance(s, dict):
        return "?"
    name = s.get("name") or ""
    if name:
        return name
    return short_id(s.get("id", ""), 8) or "?"


def sort_sessions(sessions: list[dict]) -> list[dict]:
    """Most-recently-updated first (updatedAt ISO strings compare lexically)."""
    return sorted(sessions, key=lambda s: s.get("updatedAt", ""), reverse=True)


def is_user_speaker(speaker: str) -> bool:
    return speaker in ("user", CHAR_YOU_ID)


def is_system_message(msg: dict) -> bool:
    return msg.get("kind") == "system" or msg.get("speaker") == "system"


def role_of(msg: dict) -> str:
    """Map a seek message to a ChatHistory row role."""
    if msg.get("kind") == "tool":
        return "tool"
    if is_system_message(msg):
        return "system"
    if is_user_speaker(msg.get("speaker", "")):
        return "user"
    return "assistant"


def count_text_messages(messages: list[dict]) -> int:
    """Count user + virtual text messages (ignores tool/system rows)."""
    return sum(1 for m in messages if role_of(m) in ("user", "assistant"))


def message_to_row(msg: dict, members: list[dict] | tuple = ()) -> tuple[str, str]:
    """Map a seek message to a chat row: ``(role, text)``.

    Role is one of ``user``/``assistant``/``system``/``tool``; the caller adds
    the right widget (markdown user row, ChatRow, or ToolCard). For assistant
    rows the text is prefixed with the member's name when the speaker is not
    the built-in ``seek``.
    """
    msg = msg or {}
    role = role_of(msg)
    text = msg.get("text", "") or ""
    if role == "assistant":
        name = ""
        for c in members or ():
            if c.get("id") == msg.get("speaker"):
                name = c.get("name", "")
                break
        if not name:
            name = msg.get("speaker", "")
        if name and name != CHAR_SEEK_ID:
            text = f"{name}: {text}"
    return role, text


class SeekApp:
    """Terminal client for the built-in ``seek`` room (you + seek)."""

    def __init__(self, client: SeekClient | None = None,
                 host: str = "127.0.0.1", port: int = 37291) -> None:
        self.client = client or SeekClient(host, port)
        self.term = Terminal()
        self.status = StatusLine(left=f"seek v{VERSION}", center="connecting…")
        self.inp = InputWidget()
        self.chat = ChatHistory()
        self.term.mount(status=self.status, composer=self.inp, chat=self.chat)

        # world state (built-in room only)
        self.session_id: str = ""
        self.session_title: str = ""
        self.sessions: list[dict] = []
        self.members: list[dict] = []        # characters of the built-in room
        self.current_model: str = ""
        self.msg_count: int = 0
        self._welcomed = False
        self._running = True
        self._pending_new_session = False    # waiting on our createSession
        self._turn_count = 0                 # active turn bookkeeping
        self._request_start = 0.0
        self._elapsed_task: asyncio.Task | None = None
        self._resize_event = asyncio.Event()
        self._stdin_queue: asyncio.Queue = asyncio.Queue()
        # daemon-wide stop: set when the daemon announces daemon:stopping (or
        # we asked for it via /stop) so the UI exits without reconnecting.
        self._exit_event = asyncio.Event()
        self._stop_requested = False

        # input editing state
        self.history: list[str] = []
        self.history_index = -1
        self.history_saved_input = ""
        self.paste_mode = False

        # selectors
        self.session_sel = SelectorState()
        self.delete_sel = SelectorState()
        self.model_sel = SelectorState()
        self.task_sel = SelectorState()
        self._task_sids: dict[str, str] = {}   # task label → session id

        # command autocomplete
        self._autocomplete_active = False
        self._autocomplete_widget: CommandDropdown | None = None

        # render throttle (~60fps during streams)
        self._last_render_time = 0.0
        self._RENDER_MIN_INTERVAL = 0.016

    @property
    def busy(self) -> bool:
        return self._turn_count > 0

    # ── status helpers ────────────────────────────────────────────────────
    def _status_left(self) -> str:
        parts = [f"seek v{VERSION}"]
        if self.session_title:
            parts.append(self.session_title)
        elif self.session_id:
            parts.append(short_id(self.session_id))
        if self.current_model:
            parts.append(f"[{self.current_model}]")
        return " ".join(parts)

    def _status_center(self) -> str:
        return f"room {ROOM_SEEK_NAME}"

    def _refresh_status(self) -> None:
        self.status.update(
            left=self._status_left(),
            left_extra=(f"· {self.msg_count} msgs" if self.msg_count
                        else "Enter=send  Esc=quit  /help"),
        )
        self.term.render()

    # ── chat helpers ──────────────────────────────────────────────────────
    def _reset_chat(self) -> None:
        self.chat.rows.clear()
        self.chat._line_cache.clear()
        self.chat.dirty = True

    def _system(self, text: str, center: str | None = None) -> None:
        self.chat.add("system", text)
        self.chat.dirty = True
        if center is not None:
            self.status.update(center=center)
        self.term.render()

    def _render_message(self, msg: dict) -> None:
        """Append one seek message to the chat as the right row kind."""
        msg = msg or {}
        role, text = message_to_row(msg, self.members)
        if role == "tool":
            cmd = msg.get("cmd", "") or "tool"
            card = ToolCard(
                name=cmd,
                command=cmd,
                status="failed" if msg.get("status") == "fail" else "done",
                output=msg.get("output", "") or "",
                expanded=False,
            )
            self.chat.add(card)
            return
        self.chat.add(role, text)
        if role in ("user", "assistant"):
            self.msg_count += 1

    # ── lifecycle ─────────────────────────────────────────────────────────
    async def run(self) -> None:
        loop = asyncio.get_event_loop()
        stdin_fd = sys.stdin.fileno()

        if sys.platform == "win32":
            import threading

            from seek_tui.python_tui import win32

            stop = threading.Event()

            def _win_stdin_loop():
                try:
                    win32.flush_console_input(stdin_fd)
                except (OSError, ValueError):
                    pass
                while not stop.is_set():
                    try:
                        data = win32.read_console_unicode(stdin_fd)
                        if data:
                            loop.call_soon_threadsafe(
                                self._stdin_queue.put_nowait, data)
                        else:
                            stop.wait(0.005)
                    except (OSError, ValueError):
                        break

            threading.Thread(target=_win_stdin_loop, name="seek-stdin",
                             daemon=True).start()
            self._win_stop = stop
        else:
            try:
                import fcntl
                flags = fcntl.fcntl(stdin_fd, fcntl.F_GETFL)
                fcntl.fcntl(stdin_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)

                def _stdin_reader():
                    try:
                        data = os.read(stdin_fd, 4096)
                        if data:
                            self._stdin_queue.put_nowait(data)
                    except (BlockingIOError, InterruptedError, OSError):
                        pass
                loop.add_reader(stdin_fd, _stdin_reader)
            except Exception:  # pragma: no cover - unusual environments
                log.warning("non-blocking stdin unavailable", exc_info=True)

        try:
            import signal
            if hasattr(signal, "SIGWINCH"):
                def _on_winch(signum, frame):
                    self._resize_event.set()
                signal.signal(signal.SIGWINCH, _on_winch)
        except Exception:  # pragma: no cover
            log.debug("SIGWINCH unavailable", exc_info=True)

        read_task = asyncio.create_task(self._read_server())
        try:
            await self._connect()
            await self.client.send("init")
            parser = InputParser()
            while self._running:
                stdin_ft = asyncio.ensure_future(self._stdin_queue.get())
                resize_ft = asyncio.ensure_future(self._resize_event.wait())
                exit_ft = asyncio.ensure_future(self._exit_event.wait())
                done, pending = await asyncio.wait(
                    [stdin_ft, resize_ft, exit_ft],
                    return_when=asyncio.FIRST_COMPLETED)
                for ft in pending:
                    ft.cancel()
                    try:
                        await ft
                    except (asyncio.CancelledError, Exception):
                        pass
                if self._exit_event.is_set():
                    # The daemon is stopping (or we stopped it): leave cleanly.
                    self._running = False
                    break
                if self._resize_event.is_set():
                    self._resize_event.clear()
                    try:
                        self.term.handle_resize()
                    except Exception:
                        log.debug("resize handler failed", exc_info=True)
                if stdin_ft not in done:
                    continue
                data = stdin_ft.result()
                if not data:
                    break
                for seq in parser.feed(data):
                    if not await self._handle_key(seq):
                        self._running = False
                        break
                while parser.has_pending():
                    try:
                        more = await asyncio.wait_for(
                            self._stdin_queue.get(), timeout=0.05)
                        for seq in parser.feed(more):
                            if not await self._handle_key(seq):
                                self._running = False
                                break
                    except asyncio.TimeoutError:
                        if parser._buf == bytearray(b"\x1b"):
                            parser._buf.clear()
                            if not await self._handle_key(b"\x1b"):
                                self._running = False
                        break
        except Exception:
            log.exception("TUI main loop crashed")
        finally:
            if sys.platform != "win32":
                try:
                    loop.remove_reader(stdin_fd)
                except (NotImplementedError, ValueError):
                    pass
            read_task.cancel()
            try:
                await read_task
            except (asyncio.CancelledError, Exception):
                pass
            try:
                await self.client.close()
            except Exception:
                pass
            self.term.shutdown()
            sys.stdout.write("\n")
            sys.stdout.flush()

    async def _connect(self) -> None:
        await self.client.connect()
        log.info("connected to %s", self.client.uri)

    # ── world application ─────────────────────────────────────────────────
    def _apply_world(self, world: dict) -> bool:
        """Store room-seek world state from world:init. False if room missing."""
        chars = {c["id"]: c for c in world.get("characters", []) if c.get("id")}
        room = next((r for r in world.get("rooms", [])
                     if r.get("id") == ROOM_SEEK_ID), None)
        if room is None:
            return False
        self.members = [chars[m] for m in room.get("memberIds", []) if m in chars]
        self.sessions = sort_sessions(
            [s for s in world.get("sessions", [])
             if s.get("roomId") == ROOM_SEEK_ID])
        self.current_model = world.get("model") or self.current_model
        self.status.update(left=self._status_left())
        return True

    def _welcome(self) -> None:
        if self._welcomed:
            return
        self._welcomed = True
        names = "、".join(c.get("name", "?") for c in self.members) or "?"
        self._system(
            f"seek v{VERSION}  |  room \"{ROOM_SEEK_NAME}\" — members: {names}\n"
            "Type /help for shortcuts, or just start chatting.",
            center=self._status_center(),
        )

    # ── session opening ───────────────────────────────────────────────────
    async def _open_session(self, sid: str) -> None:
        """Request a snapshot; rows are rebuilt when session:messages arrives."""
        if not sid:
            return
        self.session_id = sid
        self._reset_chat()
        s = next((x for x in self.sessions if x.get("id") == sid), {})
        # Keep the raw name (may be ""): auto-title must still fire for a
        # fresh, untitled session. Display falls back to short id elsewhere.
        self.session_title = s.get("name", "") or ""
        self.msg_count = 0
        self.status.update(left=self._status_left(),
                           center=f"opening session…")
        self.term.render()
        await self.client.send("openSession", sessionId=sid)

    async def _new_session(self) -> None:
        """Create a fresh session in the built-in room (opened on its event)."""
        self._pending_new_session = True
        await self.client.send("createSession", roomId=ROOM_SEEK_ID, name="")

    def _open_latest_or_new(self) -> None:
        if self.sessions:
            asyncio.create_task(self._open_session(self.sessions[0]["id"]))
        else:
            asyncio.create_task(self._new_session())

    # ── busy / elapsed timer ──────────────────────────────────────────────
    def _start_busy(self, center: str = "thinking…") -> None:
        self._turn_count = max(1, self._turn_count + 1)
        if self._elapsed_task is None:
            self._elapsed_task = asyncio.create_task(self._elapsed_timer())
        self.status.update(center=center)
        self.term.render()

    def _end_busy(self) -> None:
        self._turn_count = max(0, self._turn_count - 1)
        if self._turn_count == 0:
            if self._elapsed_task is not None:
                self._elapsed_task.cancel()
                self._elapsed_task = None
            self.status.elapsed = ""
            self.status.update(center=self._status_center())
            self.term.render()

    async def _elapsed_timer(self) -> None:
        while self._turn_count > 0:
            try:
                elapsed = int(time.time() - self._request_start)
                mins, secs = divmod(elapsed, 60)
                self.status.elapsed = f"[{mins}:{secs:02d}]"
                title = self.session_title or short_id(self.session_id) or ROOM_SEEK_NAME
                self.term.set_title(f"[{mins}:{secs:02d}] {title} @ {ROOM_SEEK_NAME}")
                self.term.render()
            except Exception as e:  # pragma: no cover
                log.error("elapsed timer error: %s", e)
            await asyncio.sleep(1)

    def _render_throttled(self) -> None:
        now = time.monotonic()
        if now - self._last_render_time >= self._RENDER_MIN_INTERVAL:
            self._last_render_time = now
            self.term.render()

    # ── server event loop ─────────────────────────────────────────────────
    async def _read_server(self) -> None:
        """Drain daemon events and drive the UI. Reconnects when it ends."""
        while self._running:
            try:
                async for event in self.client.events():
                    try:
                        await self._on_event(event)
                    except Exception:
                        log.exception("event handler failed: %s",
                                      event.get("type"))
            except Exception as e:
                log.warning("server read loop ended: %s", e)
            if (not self._running or self._exit_event.is_set()
                    or self._stop_requested):
                break   # quitting, or the daemon is stopping — do not reconnect
            await self._reconnect()

    async def _reconnect(self) -> None:
        self._end_busy()
        self._system("⏸ server connection lost — reconnecting…",
                     center="reconnecting…")
        try:
            await self.client.close()
        except Exception:
            pass
        while self._running:
            await asyncio.sleep(1)
            try:
                await self._connect()
                await self.client.send("ping")
                await self.client.send("init")
                return  # world:init will resettle the UI
            except Exception as e:
                log.debug("reconnect failed: %s", e)

    async def _on_event(self, event: dict) -> None:
        etype = event.get("type")
        if etype in ("pong", "ok"):
            return

        if etype == "world:init":
            if not self._apply_world(event):
                self._system("⚠ built-in room 'seek' not found — restart seekd "
                             "(it seeds the world).")
                self.status.update(center="no built-in room")
                self.term.render()
                return
            self._welcome()
            if self.session_id and not any(
                    s.get("id") == self.session_id for s in self.sessions):
                self.session_id = ""   # was deleted while we were away
            if self.session_id:
                await self._open_session(self.session_id)
            else:
                self._open_latest_or_new()
            return

        if etype == "session:messages":
            if (event.get("sessionId") == self.session_id
                    and not event.get("appendOnly", False)):
                self._reset_chat()
                msgs = event.get("messages", []) or []
                self.msg_count = count_text_messages(msgs)
                for m in msgs:
                    self._render_message(m)
                self.chat.dirty = True
                self.status.update(center=self._status_center())
                self._refresh_status()
            return

        if etype == "message:new":
            if event.get("sessionId") != self.session_id:
                return
            m = event.get("message", {}) or {}
            self._render_message(m)
            self.chat.dirty = True
            if role_of(m) == "user" and not self.session_title:
                auto = auto_title_from_prompt(m.get("text", ""))
                if auto:
                    await self.client.send("renameSession",
                                           sessionId=self.session_id, title=auto)
                    self.session_title = auto
                    self.status.update(left=self._status_left())
            self._refresh_status()
            self._render_throttled()
            return

        if etype == "turn:start":
            if event.get("sessionId") == self.session_id:
                self._request_start = time.time()
                self._start_busy()
            return
        if etype == "turn:idle":
            # Cancelled turns also end with an idle in the daemon's finally, so
            # we only decrement on idle — counting cancelled would let an old
            # turn's [cancelled+idle] pair zero out a newer turn's busy state
            # when a user sends a second message mid-turn (supersede).
            if event.get("sessionId") == self.session_id:
                self._end_busy()
            return
        if etype == "turn:cancelled":
            return  # followed by turn:idle; see above

        if etype == "session:created":
            s = event.get("session", {})
            if s.get("roomId") == ROOM_SEEK_ID:
                self.sessions.append(s)
                self.sessions = sort_sessions(self.sessions)
                if self._pending_new_session:
                    self._pending_new_session = False
                    await self._open_session(s.get("id", ""))
            return

        if etype == "session:renamed":
            if event.get("sessionId") == self.session_id:
                self.session_title = event.get("title", "")
                self.status.update(left=self._status_left())
                self.term.render()
            return

        if etype == "session:cleared":
            if event.get("sessionId") == self.session_id:
                self._reset_chat()
                self.msg_count = 0
                self._refresh_status()
            return

        if etype == "session:deleted":
            sid = event.get("sessionId")
            self.sessions = [s for s in self.sessions if s.get("id") != sid]
            if sid == self.session_id:
                self.session_id = ""
                self._open_latest_or_new()
            return

        if etype == "sessions":
            self.sessions = sort_sessions(
                [s for s in (event.get("sessions", []) or [])
                 if s.get("roomId") == ROOM_SEEK_ID])
            self._handle_sessions_listed()
            return

        if etype == "models":
            self._handle_models_listed(event)
            return

        if etype == "model:changed":
            self.current_model = event.get("model") or self.current_model
            self.status.update(left=self._status_left())
            self.term.render()
            return

        if etype == "tasks":
            self._handle_tasks_listed(event)
            return

        if etype == "error":
            msg = event.get("message", "") or "error"
            self._turn_count = 0
            if self._elapsed_task is not None:
                self._elapsed_task.cancel()
                self._elapsed_task = None
            self.status.elapsed = ""
            self._system(f"⚠ {msg}", center=self._status_center())
            return

        if etype == "daemon:stopping":
            # The daemon is shutting down (stop request / signal) — every
            # client goes down with it. Exit without reconnecting.
            reason = event.get("reason", "")
            self._system(f"■ seek daemon stopping{f' ({reason})' if reason else ''} — bye",
                         center="stopped")
            self.term.render()
            self._stop_requested = True
            self._exit_event.set()
            self._running = False
            return

    # ── selector list handlers ────────────────────────────────────────────
    def _show_selector(self, widget) -> None:
        self.chat.add(widget)
        self.chat.dirty = True
        self.term.render()

    def _selector_session(self, s: dict) -> dict:
        return {
            "session_id": s.get("id", ""),
            "title": s.get("name", ""),
            "created_at": s.get("createdAt", ""),
            "message_count": len(s.get("messages", []) or []),
        }

    def _handle_sessions_listed(self) -> None:
        entries = [self._selector_session(s) for s in self.sessions]
        if self.delete_sel.pending:
            self.delete_sel.pending = False
            self.delete_sel.widget = SessionSelector(
                entries, current_session_id=self.session_id or None)
            self.delete_sel.active = True
            self._show_selector(self.delete_sel.widget)
            self.status.update(
                center="select session to delete: ↑↓ Enter Esc  (j/k vim) — no confirmation")
        elif self.session_sel.pending:
            self.session_sel.pending = False
            self.session_sel.widget = SessionSelector(
                entries, current_session_id=self.session_id or None)
            self.session_sel.active = True
            self._show_selector(self.session_sel.widget)
            self.status.update(center="select session: ↑↓ Enter Esc  (j/k vim)")
        elif entries:
            self.session_sel.widget = SessionSelector(
                entries, current_session_id=self.session_id or None)
            self.session_sel.active = True
            self._show_selector(self.session_sel.widget)
            self.status.update(center="select session: ↑↓ Enter Esc  (j/k vim)")
        else:
            self._system("No sessions in this room yet. Send a message to create one.",
                         center=self._status_center())

    def _handle_models_listed(self, event: dict) -> None:
        models = event.get("models", []) or []
        current = event.get("current", "") or self.current_model
        if not self.model_sel.pending:
            return
        self.model_sel.pending = False
        if not models:
            self._system("No models configured.", center=self._status_center())
            return
        self.model_sel.widget = ModelSelector(models, current)
        self.model_sel.active = True
        self._show_selector(self.model_sel.widget)
        self.status.update(center="select model: ↑↓ Enter Esc  (j/k vim)")

    def _handle_tasks_listed(self, event: dict) -> None:
        tasks = event.get("tasks", []) or []
        if not self.task_sel.pending:
            return
        self.task_sel.pending = False
        self._task_sids = {}
        entries = []
        for t in tasks:
            s = t.get("session") or {}
            sid = s.get("id", "") or t.get("id", "")
            label = session_label(s) or short_id(sid, 8) or "?"
            self._task_sids[label] = sid
            entries.append({
                "name": label,
                "id": sid,
                "interval": t.get("interval", 0),
                "running": bool(t.get("lastRun") and not t.get("nextRun")),
                "next_run_in_seconds": None,
            })
        if not entries:
            self._system("No scheduled tasks found.", center=self._status_center())
            return
        self.task_sel.widget = TaskSelector(entries)
        self.task_sel.active = True
        self._show_selector(self.task_sel.widget)
        self.status.update(center="select a task to trigger (↑↓/j/k, Enter, Esc)")

    # ── keyboard: selectors ───────────────────────────────────────────────
    @staticmethod
    def _selector_nav(data: bytes, widget) -> bool:
        """Arrow/j/k navigation for any selector widget. True if handled."""
        if len(data) >= 3 and data[0] == 0x1B and data[1] == 0x5B:
            c = data[2]
            if c == 0x41:
                widget.move_up()
                return True
            if c == 0x42:
                widget.move_down()
                return True
        if data == b"j":
            widget.move_down()
            return True
        if data == b"k":
            widget.move_up()
            return True
        return False

    def _cancel_selector(self, state: SelectorState, note: str) -> None:
        state.active = False
        if state.widget is not None:
            self.chat.remove(state.widget)
            state.widget = None
        self.chat.dirty = True
        self.status.update(center=self._status_center())
        if note:
            self.chat.add("system", note)
        self.term.render()

    async def _handle_selector_keys(self, data: bytes) -> bool:
        """Modal key handling while a picker is up. True = consumed."""
        if self.session_sel.active and self.session_sel.widget:
            w = self.session_sel.widget
            if data == b"\x1b":
                self._cancel_selector(self.session_sel, "Session selection cancelled.")
                return True
            if data in (b"\r", b"\n"):
                sid = w.selected_session_id
                self._cancel_selector(self.session_sel, "")
                if sid:
                    await self._open_session(sid)
                return True
            if self._selector_nav(data, w):
                self.chat.dirty = True
                self.term.render()
            return True

        if self.delete_sel.active and self.delete_sel.widget:
            w = self.delete_sel.widget
            if data == b"\x1b":
                self._cancel_selector(self.delete_sel, "Delete cancelled.")
                return True
            if data in (b"\r", b"\n"):
                sid = w.selected_session_id
                self._cancel_selector(self.delete_sel, "")
                if sid:
                    await self.client.send("deleteSession", sessionId=sid)
                    self._system(f"Deleting session {short_id(sid)}…")
                return True
            if self._selector_nav(data, w):
                self.chat.dirty = True
                self.term.render()
            return True

        if self.model_sel.active and self.model_sel.widget:
            w = self.model_sel.widget
            if data == b"\x1b":
                self._cancel_selector(self.model_sel, "Model selection cancelled.")
                return True
            if data in (b"\r", b"\n"):
                name = w.selected_model_name
                self._cancel_selector(self.model_sel, "")
                if name:
                    await self.client.send("switchModel", modelKey=name)
                    self._system(f"Switching model to {name}…")
                return True
            if self._selector_nav(data, w):
                self.chat.dirty = True
                self.term.render()
            return True

        if self.task_sel.active and self.task_sel.widget:
            w = self.task_sel.widget
            if data == b"\x1b":
                self._cancel_selector(self.task_sel, "Task selection cancelled.")
                return True
            if data in (b"\r", b"\n"):
                label = w.selected_task_name
                sid = self._task_sids.get(label or "", "")
                self._cancel_selector(self.task_sel, "")
                if sid:
                    await self.client.send("triggerTask", sessionId=sid)
                    self._system(f"Triggering task {label}…")
                return True
            if self._selector_nav(data, w):
                self.chat.dirty = True
                self.term.render()
            return True

        return False

    # ── keyboard: autocomplete ────────────────────────────────────────────
    def _autocomplete_recompute(self) -> None:
        text = self.inp.text.lstrip()
        if text.startswith("/"):
            cmd_prefix = text.split(None, 1)[0]
            if cmd_prefix in SEEK_COMMAND_HELP:
                if self._autocomplete_active:
                    self._autocomplete_active = False
                    if self._autocomplete_widget:
                        self.chat.remove(self._autocomplete_widget)
                    self.chat.dirty = True
            elif not self._autocomplete_active:
                self._autocomplete_active = True
                self._autocomplete_widget = CommandDropdown(prefix=cmd_prefix)
                self._autocomplete_widget.visible = True
                self.chat.add(self._autocomplete_widget)
                self.chat.dirty = True
            elif self._autocomplete_widget:
                self._autocomplete_widget._recompute(cmd_prefix)
                self.chat.dirty = True
        elif self._autocomplete_active:
            self._autocomplete_active = False
            if self._autocomplete_widget:
                self.chat.remove(self._autocomplete_widget)
            self.chat.dirty = True

    async def _autocomplete_key(self, data: bytes) -> bool:
        """Keys while the /-menu is visible. True if consumed."""
        w = self._autocomplete_widget
        if w is None:
            return False
        if data == b"\x1b":
            self._autocomplete_active = False
            self.chat.remove(w)
            self.inp.text = ""
            self.inp.cursor = 0
            self.inp.dirty = True
            self.chat.dirty = True
            self.term.render()
            return True
        if data in (b"\r", b"\n"):
            cmd = w.selected_command
            if cmd:
                old_prefix = self.inp.text.lstrip().split(None, 1)[0]
                rest = self.inp.text.lstrip()[len(old_prefix):]
                leading = self.inp.text[:len(self.inp.text) - len(self.inp.text.lstrip())]
                self.inp.text = leading + cmd + rest
                self.inp.cursor = len(self.inp.text)
                self.inp.dirty = True
            self._autocomplete_active = False
            self.chat.remove(w)
            self.chat.dirty = True
            self.term.render()
            return True
        if len(data) >= 3 and data[0] == 0x1B and data[1] == 0x5B:
            c = data[2]
            if c == 0x41:
                w.move_up()
                self.chat.dirty = True
                self.term.render()
                return True
            if c == 0x42:
                w.move_down()
                self.chat.dirty = True
                self.term.render()
                return True
        if data == b"\t" or (len(data) == 1 and data[0] == 0x09):
            cmds = w._matching
            if cmds:
                w.selected_index = (w.selected_index + 1) % len(cmds)
                w._dirty = True
                self.chat.dirty = True
                self.term.render()
            return True
        return False  # other keys fall through; recompute on next keystroke

    # ── keyboard: main ────────────────────────────────────────────────────
    async def _handle_key(self, data: bytes) -> bool:
        if len(data) == 0:
            return True
        if data == b"\x1b[200~":
            self.paste_mode = True
            return True
        if data == b"\x1b[201~":
            self.paste_mode = False
            self.term.render()
            return True

        # Esc while an LLM turn is running → interrupt (keeps work so far).
        if data == b"\x1b" and self.busy:
            await self.client.send("cancel")
            self._turn_count = 0
            if self._elapsed_task is not None:
                self._elapsed_task.cancel()
                self._elapsed_task = None
            self.status.elapsed = ""
            self._system("⏸ Interrupted — response stopped. You can continue.",
                         center=self._status_center())
            return True

        # Interactive selectors (modal).
        if await self._handle_selector_keys(data):
            return True

        # Command autocomplete: recompute on every keystroke.
        if not self.busy:
            self._autocomplete_recompute()
            if self._autocomplete_active and await self._autocomplete_key(data):
                return True

        b = data[0]
        if b in (0x03, 0x04):  # Ctrl+C / Ctrl+D → quit
            return False
        if b == 0x01:  # Ctrl+A
            self.inp.move_home(); self.term.render(); return True
        if b == 0x05:  # Ctrl+E
            self.inp.move_end(); self.term.render(); return True
        if b == 0x15:  # Ctrl+U
            self.inp.delete_to_beginning_of_line(); self.term.render(); return True
        if b == 0x17:  # Ctrl+W
            self.inp.delete_word_backward(); self.term.render(); return True
        if b == 0x0B:  # Ctrl+K
            self.inp.delete_to_end_of_line(); self.term.render(); return True

        # Tab: / command completion is handled by the autocomplete layer above;
        # otherwise toggle the newest tool card's output.
        if b == 0x09:
            text = self.inp.text.lstrip()
            if not text.startswith("/"):
                tool_cards = [r for r in self.chat.rows if isinstance(r, ToolCard)]
                if tool_cards:
                    changed = False
                    for tc in tool_cards:
                        if tc.output and not tc.expanded:
                            tc.toggle()
                            changed = True
                            break
                    if not changed:
                        tool_cards[-1].toggle()
                    self.chat.dirty = True
                    self.term.render()
            return True

        # CSI sequences: arrows, Home/End, Del, Option/Ctrl+arrows.
        if b == 0x1B and len(data) >= 3 and data[1] == 0x5B:
            action = _csi_modifier_action(data)
            if action is not None:
                if action == "word_left":
                    self.inp.move_word_left()
                else:
                    self.inp.move_word_right()
                self.term.render()
                return True
            c = data[2]
            if c == 0x41:  # Up
                avail = max(1, self.term.viewport.viewport_width - 2)
                if self.inp._cursor_vrow(avail) == 0:
                    if self.history:
                        if self.history_index == -1:
                            self.history_saved_input = self.inp.text
                            self.history_index = len(self.history) - 1
                        elif self.history_index > 0:
                            self.history_index -= 1
                        self.inp.text = self.history[self.history_index]
                        self.inp.cursor = len(self.inp.text)
                        self.inp.dirty = True
                else:
                    self.inp.move_up(avail)
            elif c == 0x42:  # Down
                avail = max(1, self.term.viewport.viewport_width - 2)
                rows = self.inp._visual_rows(avail)
                if self.inp._cursor_vrow(avail) >= len(rows) - 1:
                    if self.history_index >= 0:
                        if self.history_index < len(self.history) - 1:
                            self.history_index += 1
                            self.inp.text = self.history[self.history_index]
                        else:
                            self.history_index = -1
                            self.inp.text = self.history_saved_input
                        self.inp.cursor = len(self.inp.text)
                        self.inp.dirty = True
                else:
                    self.inp.move_down(avail)
            elif c == 0x43:
                self.inp.move_right()
            elif c == 0x44:
                self.inp.move_left()
            elif c == 0x48:
                self.inp.move_home()
            elif c == 0x46:
                self.inp.move_end()
            elif c == 0x33 and len(data) >= 4 and data[3] == 0x7E:
                self.inp.delete_forward()
            self.term.render()
            return True

        if b in (0x7F, 0x08):
            self.inp.backspace()
            if not self.paste_mode:
                self.term.render()
            return True
        if b == 0x0D:  # Enter
            if self.paste_mode:
                if not self.inp.text.endswith("\n"):
                    self.inp.insert("\n")
                self.term.render()
                return True
            text = self.inp.text.strip()
            if text:
                if text.lower() in ("quit", "exit"):
                    return False
                if text.startswith("/"):
                    await self._run_command(text)
                    # Slash commands must also clear the input: leaving the
                    # text in place made the next typed message concatenate
                    # onto the leftover command (e.g. "/new你好…" → parsed as
                    # an unknown command, message never sent).
                    self.inp.text = ""
                    self.inp.cursor = 0
                    self.inp.dirty = True
                    self.term.render()
                    return True
                await self._send_user_message(self.inp.text)
            self.inp.text = ""
            self.inp.cursor = 0
            self.inp.dirty = True
            self.term.render()
            return True
        if b == 0x1B and len(data) >= 2 and data[1] in (0x0D, 0x0A):
            self.inp.insert("\n")
            if not self.paste_mode:
                self.term.render()
            return True
        if b == 0x1B:
            return True  # lone Esc
        if 0x20 <= b <= 0x7E:
            self.inp.insert(chr(b))
            if not self.paste_mode:
                self.term.render()
            return True
        if b >= 0x80:  # multi-byte UTF-8 (CJK, emoji…)
            try:
                self.inp.insert(data.decode("utf-8"))
            except UnicodeDecodeError:
                pass
            if not self.paste_mode:
                self.term.render()
            return True
        if b == 0x0A:
            if not self.paste_mode:
                self.inp.insert("\n")
                self.term.render()
            return True
        return True

    # ── sending ───────────────────────────────────────────────────────────
    async def _send_user_message(self, raw_text: str) -> None:
        text = raw_text.strip()
        if not text:
            return
        if not self.session_id:
            self._system("⚠ No session yet — waiting for the server…")
            return
        self.history.append(text)
        self.history_index = -1
        await self.client.send("sendMessage", sessionId=self.session_id, text=text)

    # ── commands ──────────────────────────────────────────────────────────
    async def _run_command(self, text: str) -> None:
        parts = text.split(None, 1)
        cmd = parts[0].lower()
        arg = parts[1].strip() if len(parts) > 1 else ""
        if cmd == "/help":
            self._system(self._help_text())
        elif cmd == "/version":
            self._system(
                f"seek v{VERSION}  |  room \"{ROOM_SEEK_NAME}\"\n"
                f"session: {self.session_title or self.session_id or '—'}\n"
                f"model: {self.current_model or 'not set'}")
        elif cmd == "/new":
            await self._new_session()
        elif cmd == "/clear":
            if self.session_id:
                await self.client.send("clearSession", sessionId=self.session_id)
                self._reset_chat()
                self.msg_count = 0
                self._system("Session cleared.", center=self._status_center())
        elif cmd == "/sessions":
            self.session_sel.pending = True
            await self.client.send("listSessions", roomId=ROOM_SEEK_ID)
            self.status.update(center="loading sessions…")
            self.term.render()
        elif cmd == "/resume":
            if arg:
                sid = arg
                if not any(s.get("id") == sid for s in self.sessions):
                    self._system(
                        f"Session {short_id(sid)} not found in room {ROOM_SEEK_NAME}.")
                    return
                await self._open_session(sid)
            else:
                self.session_sel.pending = True
                await self.client.send("listSessions", roomId=ROOM_SEEK_ID)
                self.status.update(center="loading sessions…")
                self.term.render()
        elif cmd == "/delete":
            if arg:
                await self.client.send("deleteSession", sessionId=arg)
                self._system(f"Deleting session {short_id(arg)}…")
            else:
                self.delete_sel.pending = True
                await self.client.send("listSessions", roomId=ROOM_SEEK_ID)
                self.status.update(center="loading sessions…")
                self.term.render()
        elif cmd == "/rename":
            if not arg:
                self._system("Usage: /rename <title>")
            elif not self.session_id:
                self._system("No session open yet.")
            else:
                await self.client.send("renameSession",
                                       sessionId=self.session_id, title=arg)
                self.session_title = arg
                self.status.update(left=self._status_left())
                self._system(f"Session renamed to: {arg}")
        elif cmd == "/model":
            if arg:
                await self.client.send("switchModel", modelKey=arg)
                self._system(f"Switching model to {arg}…")
            else:
                self.model_sel.pending = True
                await self.client.send("listModels")
                self.status.update(center="loading models…")
                self.term.render()
        elif cmd == "/trigger":
            if arg:
                await self.client.send("triggerTask", sessionId=arg)
                self._system(f"Triggering task {arg}…")
            else:
                self.task_sel.pending = True
                await self.client.send("listTasks")
                self.status.update(center="loading tasks…")
                self.term.render()
        elif cmd == "/stop":
            if self._stop_requested or self._exit_event.is_set():
                self._system("Seek is already stopping…")
                return
            self._stop_requested = True
            self._system("Stopping seek daemon and all clients…",
                         center="stopping…")
            self.term.render()
            # The daemon broadcasts daemon:stopping (handled in _on_event) and
            # closes the connection as it exits; we leave on that event. Note:
            # while a turn is running the daemon reads this connection only
            # after the turn ends (single-WS serialization), so /stop during a
            # turn takes effect once the turn finishes.
            await self.client.send("stop")
        else:
            self._system(f"Unknown command: {cmd}  (/help for commands)")

    def _help_text(self) -> str:
        lines = [
            "Keyboard Shortcuts",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "Editing",
            "  Type text           Insert at cursor",
            "  Enter               Send message",
            "  Esc                 Interrupt response / close dialog",
            "  Ctrl+C / Ctrl+D     Quit",
            "  Backspace / Del     Delete left / right",
            "  Ctrl+U / Ctrl+K     Delete to line start / end",
            "  Ctrl+W              Delete word left",
            "  ← →                 Move cursor",
            "  Ctrl+A / Ctrl+E     Jump to line start/end",
            "  ↑ ↓                 Command history (first/last line)",
            "  Opt+Enter           Insert newline (not send)",
            "",
            "Navigation",
            "  Tab                  Toggle tool card output",
            "  /                    Type / to show command menu",
            "  j / k                Vim-style up/down in pickers",
            "",
            "Commands",
        ]
        for cmd, desc in SEEK_COMMAND_HELP.items():
            lines.append(f"  {cmd:<12} {desc}")
        lines += [
            "",
            "Streaming",
            "  > user      Cyan markdown",
            "  ● seek      Magenta replies",
            "  ○ system    Dim system messages",
            "  ◇ tool      Colored tool cards (Tab expands)",
            "  quit/exit   Quit seek",
        ]
        return "\n".join(lines)
