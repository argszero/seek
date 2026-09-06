"""Shared file-logging setup for seek backend processes (daemon / webui / launcher).

All seek backend logs land in ``<data_root>/logs/`` — ``$SEEK_HOME/logs`` when
``SEEK_HOME`` is set, otherwise ``~/.seek/logs``. Each file rotates at 1 MB with
3 backups so a runaway daemon cannot fill the disk.

Logger naming convention: the top-level logger ``seekd`` owns the file handler;
component loggers (``seekd.daemon``, ``seekd.webui``, …) propagate up to it.
``setup_logger("seekd", "seekd.log")`` must be called once at process start
(``__main__.py``); the daemon module also self-configures on import so a bare
``python -m seekd`` run still writes logs without the CLI wrapper.
"""

from __future__ import annotations

import logging
import os
from logging.handlers import RotatingFileHandler
from pathlib import Path

LOG_DIR_NAME = "logs"
MAX_BYTES = 1_000_000  # 1 MB per file
BACKUP_COUNT = 3
_FORMAT = "%(asctime)s %(levelname)s [%(name)s] %(message)s"
_DATEFMT = "%Y-%m-%d %H:%M:%S"


def data_root() -> Path:
    """User data root: $SEEK_HOME if set, else ~/.seek."""
    env = os.environ.get("SEEK_HOME")
    if env:
        return Path(env).expanduser()
    return Path.home() / ".seek"


def logs_dir() -> Path:
    d = data_root() / LOG_DIR_NAME
    d.mkdir(parents=True, exist_ok=True)
    return d


def setup_logger(name: str, filename: str, level: int = logging.INFO) -> logging.Logger:
    """Configure (once) a file logger appending to ``logs_dir()/filename``.

    Idempotent: re-calling with the same ``name`` returns the existing logger
    without stacking duplicate handlers.
    """
    logger = logging.getLogger(name)
    if logger.handlers:  # already configured
        return logger
    logger.setLevel(level)
    path = logs_dir() / filename
    handler = RotatingFileHandler(path, maxBytes=MAX_BYTES,
                                  backupCount=BACKUP_COUNT, encoding="utf-8")
    handler.setFormatter(logging.Formatter(_FORMAT, _DATEFMT))
    logger.addHandler(handler)
    logger.propagate = False  # never leak to root logger / stderr
    return logger
