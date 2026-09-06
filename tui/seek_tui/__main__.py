"""seek_tui.__main__ — entrypoint for the seek TUI client.

Usage:
    python -m seek_tui            # connect to ws://127.0.0.1:37291
    seek-tui --port 37291         # via the installed script

The TUI is a curses single-column dialog driven by the seek WebSocket protocol
(CONTRACT.md). It is independent of the backend: it never imports server code.
"""

from __future__ import annotations

import argparse
import asyncio
import curses
import os
import sys

from seek_tui.app import App
from seek_tui.protocol import SeekClient


def _run_ui(client: SeekClient, scr) -> None:
    """Run the async UI inside the curses screen. Called from curses.wrapper.

    This is the *only* asyncio.run() in the process. curses.wrapper passes a
    sync callable written against ``stdscr``; we hand the coroutine to a single
    event loop here instead of nesting another asyncio.run() (which would raise
    "cannot be called from a running event loop").
    """
    async def _entry() -> None:
        try:
            await client.connect()
        except Exception as e:  # noqa: BLE001
            print(f"[seek_tui] cannot connect to {client.uri}: {e}", file=sys.stderr)
            client._closed = True
            return
        await App(client, scr).run()

    asyncio.run(_entry())


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="seek-tui", description="seek terminal client")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=37291)
    args = parser.parse_args(argv)

    client = SeekClient(host=args.host, port=args.port)
    try:
        curses.wrapper(_run_ui, client)
    except curses.error as e:
        print(f"[seek_tui] terminal error: {e} "
              f"(run in a real TTY; TERM={os.environ.get('TERM')!r})",
              file=sys.stderr)
        return 1
    except (KeyboardInterrupt, SystemExit):
        return 0
    finally:
        client._closed = True


if __name__ == "__main__":
    sys.exit(main())
