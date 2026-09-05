"""Curses UI for the seek TUI client.

A single-column dialog view (messages + input + status bar), aligned with EMRG.
The client connects to ``seekd`` via protocol.py and renders the group-chat
message stream. Container concepts (rooms/members) live in the data layer only —
the TUI shows the conversation, not the world.

Messages are ``{speaker, time, kind, text}`` (CONTRACT §2), with kind one of
text/tool/system/image. Render prefixes:
    you    -> ``> `` (cyan)
    seek   -> ``● `` (magenta)
    system -> ``─── … ───`` (dim)
    tool   -> ``● 🛠 cmd (status)``
"""

from __future__ import annotations

import asyncio
import curses
import unicodedata

from seek_tui.protocol import SeekClient

VERSION = "0.1.0"


# ---- display width helpers (CJK-aware; curses addwstr must not split a char) ----

def cell_width(ch: str) -> int:
    """Display width of a single character (CJK wide/fullwidth count as 2)."""
    if ch == "\t":
        return 4
    if unicodedata.east_asian_width(ch) in ("W", "F"):
        return 2
    return 1


def _disp_width(ch: str) -> int:
    return cell_width(ch)


def truncate(s: str, width: int) -> str:
    """Truncate a string to ``width`` display columns (CJK-aware)."""
    if width <= 0:
        return ""
    out: list[str] = []
    n = 0
    for ch in s:
        w = cell_width(ch)
        if n + w > width:
            break
        out.append(ch)
        n += w
    return "".join(out)


# ---- message rendering -------------------------------------------------------

def render_message(msg: dict, chars: list[dict], width: int) -> str:
    """Render one message into a single line (truncated to ``width``)."""
    kind = msg.get("kind", "text")
    speaker = msg.get("speaker", "system")
    text = msg.get("text", "")

    if kind == "tool":
        cmd = msg.get("cmd", "")
        status = msg.get("status", "running")
        line = f"● 🛠 {cmd} ({status})"
        if msg.get("output"):
            out = truncate(msg["output"], max(0, width - 4))
            line = f"{line} {out}"
        return truncate(line, width)

    if speaker == "system":
        return truncate(f"─── {text} ───", width)

    if speaker == "user" or speaker == "you":
        return truncate(f"> {text}", width)

    name = next((c.get("name") for c in chars if c.get("id") == speaker), speaker)
    if kind == "image":
        return truncate(f"● {name}: [图片] {text}", width)
    return truncate(f"● {name}: {text}", width)


# ---- App ---------------------------------------------------------------------

class App:
    """The curses application surface (single-column dialog)."""

    def __init__(self, client: SeekClient, stdscr) -> None:
        self.client = client
        self.scr = stdscr
        self.messages: list[dict] = []
        self.rooms: list[dict] = []
        self.characters: list[dict] = []
        self.sessions: list[dict] = []
        self.active_session: str | None = None
        self.input_buf: str = ""
        self.status: str = "connecting…"
        self.scroll: int = 0            # 0 = bottom; >0 = lines scrolled up
        self.version = VERSION
        self._running = True
        self._help = __doc__
        # 交互选择器：None=未激活；否则 {"items": [{id,label}], "index": int}
        self.picker: dict | None = None

    # ---- bootstrap -----------------------------------------------------------
    async def _bootstrap(self) -> None:
        world = await self.client.request("init", expect="world:init")
        self.characters = world.get("characters", [])
        self.rooms = world.get("rooms", [])
        self.sessions = world.get("sessions", [])
        n_s = len(self.sessions)
        self.status = f"connected · {len(self.rooms)} rooms · {n_s} sessions"
        if self.sessions:
            await self._open_session(self.sessions[0]["id"])

    async def _open_session(self, sid: str) -> None:
        self.active_session = sid
        self.messages = []
        self.scroll = 0
        opened = await self.client.request("openSession", sessionId=sid, expect="session:messages")
        if opened.get("type") == "session:messages":
            self.messages = list(opened.get("messages", []) or [])
        sess = self._find_session(sid)
        self.status = f"idle · {sess.get('name') or sid[:6]} ({len(self.messages)} msgs)"

    def _find_session(self, sid: str) -> dict:
        return next((s for s in self.sessions if s.get("id") == sid), {})

    # ---- event consumption ----------------------------------------------------
    async def _consume_events(self) -> None:
        async for event in self.client.events():
            etype = event.get("type")
            if etype == "message:new" and event.get("sessionId") == self.active_session:
                self.messages.append(event["message"])
                self.scroll = 0
                self.status = "idle"
            elif etype == "session:messages":
                self.messages = list(event.get("messages", []) or [])
            elif etype == "turn:start":
                self.status = "turn…"
            elif etype == "turn:idle":
                self.status = "idle"
            elif etype == "turn:cancelled":
                self.status = "cancelled"
            elif etype == "error":
                self.status = f"error: {event.get('message', '')}"

    # ---- rendering -----------------------------------------------------------
    def _draw(self) -> None:
        self.scr.erase()
        h, w = self.scr.getmaxyx()
        self._draw_header(h, w)
        self._draw_messages(h, w)
        self._draw_status(h, w)
        if self.picker:
            self._draw_picker(h, w)
        else:
            self._draw_input(h, w)
        self.scr.refresh()

    def _draw_picker(self, h: int, w: int) -> None:
        """Render the session picker overlay (j/k/↑↓ navigate, Enter confirm)."""
        items = self.picker["items"]
        index = self.picker["index"]
        y = 2
        for i, item in enumerate(items):
            cursor = "▸" if i == index else " "
            label = f" {cursor} {item['label']}"
            attr = curses.A_REVERSE if i == index else curses.A_NORMAL
            try:
                self.scr.addstr(y, 0, truncate(label, w), attr)
            except curses.error:
                pass
            y += 1
            if y >= h - 2:
                break
        # hint at bottom
        try:
            self.scr.addstr(h - 1, 0, truncate("↑↓/j/k 选择 · Enter 确认 · Esc 取消", w), curses.A_DIM)
        except curses.error:
            pass

    def _draw_header(self, h: int, w: int) -> None:
        title = f"  seek v{self.version}"
        if self.active_session:
            sess = self._find_session(self.active_session)
            title += f"  ·  {sess.get('name') or self.active_session[:6]}"
        title += f"  ({len(self.messages)} msgs)"
        self.scr.addstr(0, 0, truncate(title, w), curses.A_BOLD)
        self.scr.addstr(1, 0, "─" * w, curses.A_DIM)

    def _draw_messages(self, h: int, w: int) -> None:
        start_y = 2
        bottom = h - 3
        max_lines = bottom - start_y
        if max_lines <= 0:
            return
        # scroll: 0 = latest; positive = show earlier lines.
        end = len(self.messages)
        start = max(0, end - max_lines - self.scroll)
        body = self.messages[start:end]
        y = start_y
        for msg in body:
            try:
                self.scr.addstr(y, 0, render_message(msg, self.characters, w),
                                self._msg_attr(msg))
            except curses.error:
                pass
            y += 1
            if y >= bottom:
                break

    def _msg_attr(self, msg: dict) -> int:
        kind = msg.get("kind")
        speaker = msg.get("speaker")
        if kind == "system":
            return curses.A_DIM
        if speaker == "user":
            return curses.A_BOLD
        if kind == "tool" and msg.get("status") == "fail":
            return curses.A_BOLD | curses.color_pair(1)  # red
        return curses.A_NORMAL

    def _draw_status(self, h: int, w: int) -> None:
        if h >= 2:
            self.scr.addstr(h - 2, 0, truncate(self.status, w), curses.A_DIM)

    def _draw_input(self, h: int, w: int) -> None:
        y = h - 1
        prefix = "> "
        available = max(1, w - len(prefix))
        self.scr.addstr(y, 0, prefix + truncate(self.input_buf, available), curses.A_BOLD)

    # ---- main loop -----------------------------------------------------------
    async def run(self) -> None:
        self.scr.keypad(True)
        self.scr.nodelay(True)
        if curses.has_colors():
            curses.start_color()
            curses.use_default_colors()
            curses.init_pair(1, curses.COLOR_RED, -1)

        await self._bootstrap()
        ev_task = asyncio.create_task(self._consume_events())
        try:
            while self._running:
                self._draw()
                ch = self.scr.getch()
                if ch != curses.ERR:
                    await self._handle_key(ch)
                await asyncio.sleep(0.02)
        finally:
            ev_task.cancel()

    async def _handle_key(self, ch: int) -> None:
        # 选择器优先：j/k/↑↓ 导航，Enter 确认，Esc/Ctrl+C 取消。
        if self.picker:
            if ch in (ord("j"), curses.KEY_DOWN):
                self.picker["index"] = min(len(self.picker["items"]) - 1,
                                           self.picker["index"] + 1)
            elif ch in (ord("k"), curses.KEY_UP):
                self.picker["index"] = max(0, self.picker["index"] - 1)
            elif ch in (10, 13):
                await self._confirm_picker()
            elif ch in (27, 3):
                self.picker = None
                self._system("已取消选择")
            return
        # Ctrl+C stop generation
        if ch == 3:
            await self.client.send("cancel")
            self.status = "cancelled"
            return
        # Ctrl+D quit (non-blocking)
        if ch == 4:
            self._running = False
            return
        if ch in (27,):  # Esc clear
            self.input_buf = ""
            return
        if ch in (curses.KEY_BACKSPACE, 127, 8):
            self.input_buf = self.input_buf[:-1]
            return
        if ch in (curses.KEY_UP,):
            self.scroll += 1
            return
        if ch in (curses.KEY_DOWN,):
            self.scroll = max(0, self.scroll - 1)
            return
        if ch in (curses.KEY_PPAGE,):
            self.scroll += 10
            return
        if ch in (curses.KEY_NPAGE,):
            self.scroll = max(0, self.scroll - 10)
            return
        if ch in (10, 13):  # Enter
            await self._on_enter()
            return
        if 32 <= ch < 127:
            self.input_buf += chr(ch)
            return

    async def _on_enter(self) -> None:
        text = self.input_buf.strip()
        self.input_buf = ""
        if not text:
            return
        if text.startswith("/"):
            await self._run_command(text)
            return
        if self.active_session:
            await self.client.send("sendMessage", sessionId=self.active_session, text=text)
            self.status = "sending…"

    # ---- slash commands -------------------------------------------------------
    async def _run_command(self, text: str) -> None:
        cmd, _, arg = text.partition(" ")
        cmd = cmd.lower()
        arg = arg.strip()
        if cmd == "/help":
            self._system("命令: /sessions /rename <名> /clear /model <key> /help")
        elif cmd == "/sessions":
            await self._cmd_sessions()
        elif cmd == "/rename":
            await self._cmd_rename(arg)
        elif cmd == "/clear":
            await self.client.send("clearSession", sessionId=self.active_session)
            self.messages = []
            self._system("会话已清空")
        elif cmd == "/model":
            await self._cmd_model(arg)
        elif cmd == "/switch":
            await self._cmd_sessions()
        else:
            self._system(f"未知命令: {cmd}")

    def _system(self, text: str) -> None:
        self.messages.append({"speaker": "system", "kind": "system",
                              "time": "", "text": text})

    async def _cmd_sessions(self) -> None:
        if not self.sessions:
            self._system("没有会话")
            return
        items = [{"id": s.get("id"), "label": self._session_label(s)}
                 for s in self.sessions]
        self.picker = {"items": items, "index": 0}
        self.status = "选择会话…"

    def _session_label(self, s: dict) -> str:
        name = s.get("name") or s.get("id", "")[:6]
        room = next((r.get("name") for r in self.rooms if r.get("id") == s.get("roomId")), "")
        return f"{name}  ({room or s.get('roomId') or '?'})"

    async def _confirm_picker(self) -> None:
        picker = self.picker
        self.picker = None
        if not picker:
            return
        item = picker["items"][picker["index"]]
        await self._open_session(item["id"])

    async def _cmd_rename(self, arg: str) -> None:
        if not arg:
            self._system("用法: /rename <新标题>")
            return
        if self.active_session:
            await self.client.send("renameSession", sessionId=self.active_session, title=arg)
            self._system(f"已重命名为「{arg}」")

    async def _cmd_model(self, arg: str) -> None:
        models = await self.client.request("listModels", expect="models")
        current = (models.get("current") or "")
        if arg:
            await self.client.send("switchModel", modelKey=arg)
            self._system(f"切换到模型 {arg}（下一条消息生效）")
            return
        lst = models.get("models", [])
        names = "、".join(m.get("name", "") for m in lst) or "（无）"
        self._system(f"当前:{current}  可选:{names}")
