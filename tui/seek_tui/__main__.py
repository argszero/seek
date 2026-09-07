"""seek_tui.__main__ — entrypoint for the seek TUI client.

Usage:
    python -m seek_tui            # connect to ws://127.0.0.1:37291
    seek-tui --port 37291         # via the installed script

The TUI is a raw-ANSI dialog (python-tui engine) driven by the seek WebSocket
protocol (CONTRACT.md). It is independent of the backend: it never imports
server code. All diagnostics go to ``<cwd>/.seek/logs/tui.log`` (never printed
while the terminal is in raw mode).
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys

from seek_tui.app import SeekApp
from seek_tui.logging_setup import setup_tui_logging
from seek_tui.protocol import SeekClient

log = logging.getLogger("seek_tui")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="seek-tui", description="seek terminal client")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=37291)
    return parser.parse_args(argv)


def log_path_hint() -> str:
    """Human-readable path of the TUI log file (for error messages)."""
    try:
        from pathlib import Path

        return str(Path.cwd() / ".seek" / "logs" / "tui.log")
    except Exception:  # noqa: BLE001
        return "tui.log"


async def _run(client: SeekClient) -> int:
    """Build and run the app. Returns process exit code."""
    app = SeekApp(client=client)
    try:
        await app.run()
    except Exception as e:  # noqa: BLE001
        log.exception("TUI runtime error")
        try:
            app.term.shutdown()
        except Exception:
            pass
        print(f"[seek_tui] runtime error: {e} (see {log_path_hint()})",
              file=sys.stderr)
        return 1
    finally:
        log.info("TUI exiting")
    return 0


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if not sys.stdin.isatty():
        print("[seek_tui] requires a real terminal (TTY).", file=sys.stderr)
        return 1

    setup_tui_logging()  # logs to <cwd>/.seek/logs/tui.log
    log.info("seek_tui starting (host=%s port=%d)", args.host, args.port)

    client = SeekClient(host=args.host, port=args.port)
    try:
        return asyncio.run(_run(client))
    except KeyboardInterrupt:
        log.info("interrupted")
        return 0
    except Exception as e:  # noqa: BLE001
        log.error("terminal error: %s", e)
        print(f"[seek_tui] terminal error: {e} "
              f"(run in a real TTY; TERM={os.environ.get('TERM')!r})",
              file=sys.stderr)
        return 1
    finally:
        client._closed = True
        log.info("seek_tui exiting")


if __name__ == "__main__":
    sys.exit(main())
