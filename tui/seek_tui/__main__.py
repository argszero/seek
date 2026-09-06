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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="seek-tui", description="seek terminal client")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=37291)
    args = parser.parse_args(argv)

    async def _connect() -> None:
        client = SeekClient(host=args.host, port=args.port)
        try:
            await client.connect()
        except Exception as e:
            print(f"[seek_tui] cannot connect to {client.uri}: {e}", file=sys.stderr)
            return
        # curses.wrapper takes a sync callable; run the async UI inside it.
        def _launch(scr):
            return asyncio.run(App(client, scr).run())
        try:
            curses.wrapper(_launch)
        except curses.error as e:
            print(f"[seek_tui] terminal error: {e} "
                  f"(run in a real TTY; TERM={os.environ.get('TERM')!r})",
                  file=sys.stderr)

    try:
        asyncio.run(_connect())
        return 0
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
