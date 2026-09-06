"""Tests for seek_tui.__main__ entry wiring.

The original bug: ``curses.wrapper(func, *args)`` calls ``func(stdscr, *args)``
— stdscr is ALWAYS the first positional arg. A prior fix declared
``_run_ui(client, scr)`` and called ``curses.wrapper(_run_ui, client)``, so
``client`` received ``stdscr`` and ``_curses.window`` has no ``connect`` /
``uri``. These tests pin the closure-based wiring so the arg order can never
silently regress.
"""

import asyncio

from seek_tui import __main__ as main_mod


class _FakeApp:
    def __init__(self, client, scr):
        self.client = client
        self.scr = scr

    async def run(self):
        self.client.runs += 1
        assert self.client is not None
        assert self.scr is not None


class _FakeClient:
    def __init__(self):
        self.uri = "ws://127.0.0.1:37291"
        self.connected = False
        self.closed = False
        self.runs = 0

    async def connect(self):
        self.connected = True

    async def close(self):
        self.closed = True


def test_run_ui_wrapper_binds_stdscr_to_app(monkeypatch):
    """curses.wrapper(_run_ui(client))(stdscr) must hand stdscr to App, not client."""
    client = _FakeClient()
    fake_scr = object()

    # Replace App with the fake so run() doesn't touch a real curses screen.
    monkeypatch.setattr(main_mod, "App", _FakeApp)

    wrap = main_mod._run_ui(client)   # the callback curses.wrapper will invoke
    # Simulate curses.wrapper calling func(stdscr) — stdscr is the FIRST arg.
    wrap(fake_scr)

    assert client.connected is True, "client.connect() must be awaited"
    assert client.runs == 1, "App.run() must be called exactly once"
    assert client.closed is False, "client.close() runs after wrapper returns (not here)"


def test_run_ui_connect_failure_is_reported(monkeypatch, capsys):
    """If connect() raises, the TUI reports it and does not attempt App.run()."""
    class _BrokenClient(_FakeClient):
        async def connect(self):
            raise ConnectionError("boom")

    client = _BrokenClient()
    fake_scr = object()
    monkeypatch.setattr(main_mod, "App", _FakeApp)

    wrap = main_mod._run_ui(client)
    wrap(fake_scr)

    out = capsys.readouterr().err
    assert "cannot connect" in out
    assert "boom" in out
    assert client.runs == 0, "App.run() must NOT run when connect() fails"
