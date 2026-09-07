"""Tests for seek_tui.__main__ entrypoint (arg parsing, TTY guard)."""

import os
import sys

import pytest

from seek_tui import __main__ as main_mod


def test_parse_args_defaults():
    args = main_mod.parse_args([])
    assert args.host == "127.0.0.1"
    assert args.port == 37291


def test_parse_args_overrides():
    args = main_mod.parse_args(["--host", "mbp", "--port", "9999"])
    assert args.host == "mbp"
    assert args.port == 9999


def test_log_path_hint_contains_cwd():
    hint = main_mod.log_path_hint()
    assert hint.startswith(os.getcwd())
    assert hint.endswith(os.path.join(".seek", "logs", "tui.log"))


def test_main_requires_tty(monkeypatch):
    monkeypatch.setattr(main_mod.sys, "stdin",
                        type("FakeStdin", (), {"isatty": lambda self: False})())
    assert main_mod.main([]) == 1


def test_build_client_uri():
    client = main_mod.SeekClient(host="127.0.0.1", port=37291)
    assert client.uri == "ws://127.0.0.1:37291"
