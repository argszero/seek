"""Regression tests for seek_tui.app input-submit behaviour.

These drive SeekApp._handle_key with lightweight fakes (no real Terminal, so
no raw-mode side effects). The key regression: after a slash command the input
line must be cleared — an earlier version returned early after /-commands and
left the text in place, so the next typed message concatenated onto the
leftover command (e.g. "/new你好…") and was parsed as an unknown command,
never reaching the daemon.
"""

import asyncio

from seek_tui.app import ROOM_SEEK_ID, SeekApp
from seek_tui.python_tui.widgets.status_line import StatusLine
from seek_tui.widgets import ChatHistory, InputWidget, SelectorState


class _FakeClient:
    def __init__(self):
        self.sent = []

    async def send(self, rtype: str, **fields):
        self.sent.append((rtype, fields))

    async def request(self, *a, **kw):
        return {}


class _FakeTerm:
    def __init__(self):
        self.renders = 0

    def render(self, full: bool = False):
        self.renders += 1

    def set_title(self, title: str):
        pass


def _make_app() -> SeekApp:
    app = SeekApp.__new__(SeekApp)
    app.client = _FakeClient()
    app.term = _FakeTerm()
    app.status = StatusLine()
    app.inp = InputWidget()
    app.chat = ChatHistory()
    app.session_id = "sess-1"
    app.session_title = ""
    app.sessions = []
    app.members = []
    app.current_model = ""
    app.msg_count = 0
    app._turn_count = 0
    app._elapsed_task = None
    app._request_start = 0.0
    app.paste_mode = False
    app.session_sel = SelectorState()
    app.delete_sel = SelectorState()
    app.model_sel = SelectorState()
    app.task_sel = SelectorState()
    app._task_sids = {}
    app._autocomplete_active = False
    app._autocomplete_widget = None
    app.history = []
    app.history_index = -1
    app.history_saved_input = ""
    app._pending_new_session = False
    import asyncio as _aio
    app._resize_event = _aio.Event()
    app._exit_event = _aio.Event()
    app._stop_requested = False
    app._running = True
    app._welcomed = False
    return app


def test_enter_clears_input_after_command():
    app = _make_app()
    app.inp.text = "/new"
    app.inp.cursor = 4
    asyncio.run(app._handle_key(b"\r"))
    assert app.inp.text == ""
    assert app.client.sent[0][0] == "createSession"
    assert app.client.sent[0][1]["roomId"] == ROOM_SEEK_ID


def test_enter_clears_input_after_plain_message():
    app = _make_app()
    app.inp.text = "你好"
    app.inp.cursor = 2
    asyncio.run(app._handle_key(b"\r"))
    assert app.inp.text == ""
    assert ("sendMessage", {"sessionId": "sess-1", "text": "你好"}) in app.client.sent


def test_typed_text_after_command_starts_fresh():
    """A message typed after a /-command must not inherit the command text."""
    app = _make_app()
    app.inp.text = "/new"
    asyncio.run(app._handle_key(b"\r"))
    assert app.inp.text == ""
    # now type a fresh message
    app.inp.insert("你好")
    asyncio.run(app._handle_key(b"\r"))
    assert app.client.sent[-1][0] == "sendMessage"
    assert app.client.sent[-1][1]["text"] == "你好"


def test_enter_unknown_command_dismisses_dropdown_only():
    """Unknown /-prefix keeps the dropdown up: Enter dismisses it but does not
    submit (EMRG behaviour — recompute re-activates on the next keystroke, so
    an unmatched prefix is never submitted; Esc clears the input)."""
    app = _make_app()
    app.inp.text = "/bogus"
    asyncio.run(app._handle_key(b"\r"))
    assert app._autocomplete_active is False  # dropdown dismissed
    assert app.inp.text == "/bogus"           # but input kept, nothing sent
    assert not app.client.sent


def test_slash_stop_sends_stop_request():
    """/stop asks the daemon to stop and marks the app as stopping."""
    app = _make_app()
    app.inp.text = "/stop"
    asyncio.run(app._handle_key(b"\r"))
    assert app._stop_requested is True
    assert ("stop", {}) in app.client.sent
    assert app.inp.text == ""   # input cleared like every other command


def test_daemon_stopping_event_exits_without_reconnect():
    """daemon:stopping sets the exit event so run() leaves cleanly."""
    app = _make_app()
    asyncio.run(app._on_event({"type": "daemon:stopping", "reason": "request from 127.0.0.1"}))
    assert app._exit_event.is_set()
    assert app._running is False
    assert app._stop_requested is True


def test_slash_stop_twice_is_idempotent():
    """A second /stop while already stopping sends nothing new."""
    app = _make_app()
    app._stop_requested = True
    app.inp.text = "/stop"
    asyncio.run(app._handle_key(b"\r"))
    assert app.client.sent == []   # no duplicate stop request
