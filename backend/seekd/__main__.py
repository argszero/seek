"""seek CLI entrypoints.

Two commands are exposed (see backend/pyproject.toml [project.scripts]):
  - ``seekd``  : start the daemon (the only backend; WebSocket IPC + WEBUI).
  - ``seek``   : the main client launcher (currently starts the daemon too,
                 since the CLI is owned by the backend side).
"""

from __future__ import annotations

import argparse
import sys


def main_daemon(argv: list[str] | None = None) -> int:
    """Start the seek daemon."""
    parser = argparse.ArgumentParser(prog="seekd", description="start the seek daemon")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=37291)
    parser.add_argument("--webui-port", type=int, default=37292,
                        help="port for the embedded WEBUI static server")
    parser.add_argument("--webui-dist", default=None, help="path to webui/dist to serve")
    args = parser.parse_args(argv)

    from seekd.server.daemon import Seekd
    from seekd.store.jsonstore import SeekStore
    from seekd.core.seed import ensure_seeded

    from seekd.config import load_config as _load_config

    store = SeekStore()
    # First-run bootstrap: on an empty store, seed `you` + a default room/session
    # so the app opens to a usable world. Idempotent (no-op once a world exists).
    if ensure_seeded(store):
        print("seek: seeded a fresh world (you + default room/session)")
    session_runner = None
    cfg = _load_config()
    if cfg.api_key:
        from seekd.llm.openai_client import OpenAICompatibleClient
        from seekd.server.session_runner import SessionRunner

        session_runner = SessionRunner(store, OpenAICompatibleClient.from_config(cfg))

    daemon = Seekd(host=args.host, port=args.port, webui_dist=args.webui_dist,
                   store=store, session_runner=session_runner, model=cfg.model,
                   llm_config=cfg, webui_port=args.webui_port)
    try:
        import asyncio

        asyncio.run(daemon.run())
    except KeyboardInterrupt:
        pass
    except Exception as e:  # noqa: BLE001
        # The daemon is spawned detached with stdio=DEVNULL, so a bare stderr
        # print is lost. Log the full traceback to ~/.seek/logs/seekd.log.
        from seekd.logutil import setup_logger

        logger = setup_logger("seekd", "seekd.log")
        logger.exception("seekd fatal error")
        print(f"seekd: fatal error (see ~/.seek/logs/seekd.log): {e}", file=sys.stderr)
        return 1
    return 0


def main_cli(argv: list[str] | None = None) -> int:
    """Main seek launcher. For now it runs the daemon."""
    return main_daemon(argv)


if __name__ == "__main__":
    sys.exit(main_daemon())
