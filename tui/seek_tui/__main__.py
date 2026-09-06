"""seek_tui.__main__ — entrypoint for the seek TUI client.

Usage:
    python -m seek_tui            # connect to ws://127.0.0.1:37291
    seek-tui --port 37291         # via the installed script

The TUI is a curses single-column dialog driven by the seek WebSocket protocol
(CONTRACT.md). It is independent of the backend: it never imports server code.
All diagnostics go to ``<cwd>/.seek/logs/tui.log`` (never printed while curses
owns the screen).
"""

from __future__ import annotations

import argparse
import asyncio
import curses
import logging
import os
import sys

from seek_tui.app import App
from seek_tui.logging_setup import setup_tui_logging
from seek_tui.protocol import SeekClient

log = logging.getLogger("seek_tui")


def _run_ui(client: SeekClient):
    """Return a curses.wrapper-compatible callback: stdscr is passed by
    curses.wrapper; ``client`` is captured by closure so we never fight over the
    positional-arg order curses.wrapper uses (func(stdscr, *args))."""
    async def _entry(scr) -> None:
        try:
            log.info("connecting to %s", client.uri)
            await client.connect()
            log.info("connected")
        except Exception as e:  # noqa: BLE001
            log.error("cannot connect to %s: %s", client.uri, e)
            print(f"[seek_tui] cannot connect to {client.uri}: {e} "
                  f"(see {log_path_hint()})", file=sys.stderr)
            client._closed = True
            return
        try:
            await App(client, scr).run()
        except Exception as e:  # noqa: BLE001
            log.exception("TUI runtime error")
            print(f"[seek_tui] runtime error: {e} (see {log_path_hint()})",
                  file=sys.stderr)
        finally:
            log.info("TUI exiting")

    def _wrap(scr):
        asyncio.run(_entry(scr))

    return _wrap


def log_path_hint() -> str:
    """Human-readable path of the TUI log file (for error messages)."""
    try:
        from pathlib import Path

        return str(Path.cwd() / ".seek" / "logs" / "tui.log")
    except Exception:  # noqa: BLE001
        return "tui.log"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="seek-tui", description="seek terminal client")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=37291)
    args = parser.parse_args(argv)

    setup_tui_logging()  # logs to <cwd>/.seek/logs/tui.log
    log.info("seek_tui starting (host=%s port=%d)", args.host, args.port)

    client = SeekClient(host=args.host, port=args.port)
    try:
        curses.wrapper(_run_ui(client))
    except curses.error as e:
        log.error("terminal error: %s (TERM=%r)", e, os.environ.get("TERM"))
        print(f"[seek_tui] terminal error: {e} "
              f"(run in a real TTY; TERM={os.environ.get('TERM')!r})",
              file=sys.stderr)
        return 1
    except (KeyboardInterrupt, SystemExit):
        log.info("interrupted")
        return 0
    finally:
        client._closed = True
        log.info("seek_tui exiting (rc=0)")


if __name__ == "__main__":
    sys.exit(main())
