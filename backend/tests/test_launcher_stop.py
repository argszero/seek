"""Tests for the `seek stop` CLI path (launcher._cmd_stop)."""

import asyncio
import json
import os
import signal
import subprocess
import sys
import time

import websockets

from seekd.launcher import _cmd_stop, _daemon_running

PY = sys.executable


def _spawn_test_daemon(port: int, tmp: str) -> subprocess.Popen:
    """A real seekd on an ephemeral port with a throwaway store."""
    env = dict(os.environ)
    env["SEEK_HOME"] = tmp
    return subprocess.Popen(
        [PY, "-m", "seekd.__main__", "--host", "127.0.0.1",
         "--port", str(port), "--webui-port", str(port + 1)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env,
    )


def _wait_port(port: int, up: bool, timeout: float = 8.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if _daemon_running("127.0.0.1", port) == up:
            return True
        time.sleep(0.1)
    return False


def test_cmd_stop_idempotent_when_no_daemon(tmp_path, capsys):
    rc = _cmd_stop("127.0.0.1", 8321)   # nothing listens there
    assert rc == 0
    assert "no daemon running" in capsys.readouterr().out


def test_cmd_stop_stops_running_daemon(tmp_path):
    port = 8322
    d = _spawn_test_daemon(port, str(tmp_path))
    try:
        assert _wait_port(port, True), "test daemon did not start"
        rc = _cmd_stop("127.0.0.1", port)
        assert rc == 0
        assert _wait_port(port, False), "daemon still up after stop"
        d.wait(timeout=10)
        assert d.returncode == 0, f"daemon exited {d.returncode}, want clean 0"
    finally:
        if d.poll() is None:
            d.terminate()
            try:
                d.wait(timeout=5)
            except subprocess.TimeoutExpired:
                d.kill()


def test_stop_request_goes_through_ws_protocol(tmp_path):
    """A raw WS client sees daemon:stopping before the daemon exits."""
    port = 8323
    d = _spawn_test_daemon(port, str(tmp_path))
    try:
        assert _wait_port(port, True)

        async def _probe():
            async with websockets.connect(f"ws://127.0.0.1:{port}") as ws:
                await ws.send(json.dumps({"type": "stop"}))
                got = json.loads(await asyncio.wait_for(ws.recv(), 5))
                assert got["type"] == "daemon:stopping", got
                # connection closes as the daemon exits
                with __import__("pytest").raises(websockets.ConnectionClosed):
                    while True:
                        await asyncio.wait_for(ws.recv(), 5)

        asyncio.run(_probe())
        assert _wait_port(port, False)
        d.wait(timeout=10)
    finally:
        if d.poll() is None:
            d.terminate()
            try:
                d.wait(timeout=5)
            except subprocess.TimeoutExpired:
                d.kill()
