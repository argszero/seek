"""seek launcher — the ``seek`` command.

``seek`` is the single entry point the user runs. It:
  1. makes sure a ``seekd`` daemon is running (starts one in the background if
     the WebSocket port is not already served),
  2. waits until the embedded WEBUI server is reachable (so the app is fully
     usable once the client opens),
  3. launches the chosen client — the TUI by default, or the GUI with
     ``seek --gui``.

The daemon and WEBUI use dedicated ports (see ``DEFAULT_DAEMON_PORT`` /
``DEFAULT_WEBUI_PORT``) chosen to never collide with EMRG's own ports.

Design notes
------------
- Idempotent: if a daemon is already serving the WebSocket port, ``seek`` does
  NOT start a second one; it only launches the client.
- Fire-and-forget daemon: the spawned dasemon is detached (``start_new_session``)
  so it keeps running after ``seek`` exits; TUI/GUI connect to it over WS.
- WEBUI readiness is polled over HTTP before the client launch, so "daemon up"
  also means "webui reachable".
"""

from __future__ import annotations

import argparse
import http.client
import os
import subprocess
import sys
import time
from pathlib import Path

DEFAULT_DAEMON_PORT = 37291
DEFAULT_WEBUI_PORT = 37292
DEFAULT_HOST = "127.0.0.1"

# Where the daemon lives next to this launcher. The installed runtime keeps the
# daemon entry point at ``<install>/bin/seekd`` and the webui bundle at
# ``<install>/webui``. In a packaged runtime the launcher is vendored into
# site-packages, so resolve the install root from ``~/.seek/install`` (set via
# ``SEEK_HOME`` if overridden) rather than relative to ``__file__``.
def _install_root() -> Path:
    env = os.environ.get("SEEK_HOME")
    base = Path(env).expanduser() if env else Path.home() / ".seek"
    install = base / "install"
    if (install / "bin" / "seekd").exists():
        return install
    return base


def _seekd_bin() -> str:
    """Absolute path to the ``seekd`` daemon executable."""
    root = _install_root()
    cands = [
        root / "bin" / "seekd",
        # dev checkout: venv console script
        Path(__file__).resolve().parent.parent.parent / "backend" / ".venv" / "bin" / "seekd",
    ]
    for c in cands:
        if c.exists():
            return str(c)
    return "seekd"  # let PATH resolve (dev)


def _webui_dist() -> Path | None:
    """Locate the built webui bundle next to the installed runtime."""
    root = _install_root()
    cands = [
        root / "webui",                                # installed runtime
        root / "webui" / "dist",                       # dev build dir
        Path(__file__).resolve().parent / "webui" / "dist",
    ]
    for c in cands:
        if (c / "index.html").exists():
            return c
    return None


def _daemon_running(host: str, port: int, timeout: float = 0.8) -> bool:
    """Probe the WebSocket port; True if something already serves it."""
    import websockets

    async def _probe():
        try:
            async with websockets.connect(f"ws://{host}:{port}",
                                          open_timeout=timeout):
                return True
        except Exception:
            return False

    import asyncio
    try:
        return asyncio.run(_probe())
    except Exception:
        return False


def _webui_reachable(host: str, port: int, timeout: float = 0.8) -> bool:
    """Check that the embedded WEBUI static server responds (HTTP 200)."""
    try:
        conn = http.client.HTTPConnection(host, port, timeout=timeout)
        conn.request("GET", "/")
        resp = conn.getresponse()
        conn.close()
        return resp.status == 200
    except Exception:
        return False


def _spawn_daemon(host: str, daemon_port: int, webui_port: int) -> None:
    """Start ``seekd`` in the background (detached), then wait for WEBUI."""
    bin_path = _seekd_bin()
    webui = _webui_dist()
    cmd = [bin_path, "--host", host, "--port", str(daemon_port),
           "--webui-port", str(webui_port)]
    if webui is not None:
        cmd += ["--webui-dist", str(webui)]
    # Detach so the daemon outlives this launcher; stdio to DEVNULL keeps the
    # terminal clean. SEEK_HOME is inherited so ~/.seek is used.
    try:
        subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
    except Exception as e:  # pragma: no cover - defensive
        print(f"[seek] failed to start daemon: {e}", file=sys.stderr)


def _wait_webui(host: str, webui_port: int, daemon_port: int, tries: int = 40) -> bool:
    """Poll until the WEBUI HTTP server is reachable or the wait expires."""
    for _ in range(tries):
        if _webui_reachable(host, webui_port):
            return True
        # Give up early if the daemon died (port probe fails too).
        if not _daemon_running(host, daemon_port):
            time.sleep(0.25)
            continue
        time.sleep(0.5)
    return _webui_reachable(host, webui_port)


def _launch_tui(host: str, port: int) -> int:
    """Run the seek TUI (curses client) against the running daemon."""
    from seek_tui.__main__ import main as tui_main

    return tui_main(["--host", host, "--port", str(port)])


def _launch_gui() -> int:
    """Open the seek GUI app (its own main.js spawns/links the daemon)."""
    gui_app = _install_root() / "seek-gui" / "seek.app"
    if gui_app.exists():
        subprocess.Popen(["open", str(gui_app)])
        return 0
    # Fallback: dev — GUI is an electron app under gui/.
    gui_dir = Path(__file__).resolve().parent.parent.parent / "gui"
    if (gui_dir / "package.json").exists():
        subprocess.Popen(["npx", "electron", str(gui_dir / "main.js")])
        return 0
    print("[seek] GUI not found (expected seek-gui/seek.app)", file=sys.stderr)
    return 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="seek", description="seek launcher")
    parser.add_argument("--gui", action="store_true", help="open the GUI instead of the TUI")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_DAEMON_PORT)
    parser.add_argument("--webui-port", type=int, default=DEFAULT_WEBUI_PORT)
    args = parser.parse_args(argv)

    # 1. Ensure the daemon is running.
    if not _daemon_running(args.host, args.port):
        _spawn_daemon(args.host, args.port, args.webui_port)

    # 2. For the TUI, wait until WEBUI is up — guarantees the daemon is healthy
    #    and the app is fully usable the moment the TUI connects.
    if not args.gui:
        _wait_webui(args.host, args.webui_port, args.port)

    # 3. Launch the client.
    if args.gui:
        return _launch_gui()
    return _launch_tui(args.host, args.port)


if __name__ == "__main__":
    sys.exit(main())
