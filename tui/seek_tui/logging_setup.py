"""File-logging for the seek TUI.

The TUI runs in full-screen curses, so nothing may be printed to stdout/stderr
while the UI is live (it would corrupt the screen). All diagnostics go to a
file instead.

Log location: ``<cwd>/.seek/logs/tui.log`` where ``cwd`` is the directory the
user launched ``seek`` from — that working directory is the session's working
directory, so the log travels with the project/session the user is in.
Rotates at 1 MB with 3 backups.
"""

from __future__ import annotations

import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path

MAX_BYTES = 1_000_000
BACKUP_COUNT = 3
_FORMAT = "%(asctime)s %(levelname)s [%(name)s] %(message)s"
_DATEFMT = "%Y-%m-%d %H:%M:%S"


def tui_log_path(cwd: Path | None = None) -> Path:
    cwd = Path(cwd or Path.cwd())
    return cwd / ".seek" / "logs" / "tui.log"


def setup_tui_logging(cwd: Path | None = None) -> logging.Logger:
    """Configure the TUI file logger (idempotent) and return it."""
    logger = logging.getLogger("seek_tui")
    if logger.handlers:
        return logger
    path = tui_log_path(cwd)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        handler = RotatingFileHandler(path, maxBytes=MAX_BYTES,
                                      backupCount=BACKUP_COUNT, encoding="utf-8")
    except OSError:
        # Working directory not writable — fall back to a temp location so the
        # TUI still has a log to write to.
        import tempfile

        tmp = Path(tempfile.gettempdir()) / "seek-tui.log"
        try:
            handler = RotatingFileHandler(tmp, maxBytes=MAX_BYTES,
                                          backupCount=1, encoding="utf-8")
        except OSError:
            handler = logging.NullHandler()
    handler.setFormatter(logging.Formatter(_FORMAT, _DATEFMT))
    logger.addHandler(handler)
    logger.setLevel(logging.DEBUG)
    logger.propagate = False
    return logger
