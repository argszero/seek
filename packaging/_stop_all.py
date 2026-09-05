"""Stop all running seek processes before an install.

The installer runs this first so that replacing files never fails because a
file is locked (Windows) or a daemon holds the data dir (macOS). It matches
processes by command line against the seek binaries (seekd, seek-gui, seek-tui)
and the seek data directory, then stops them — excluding this very process.

Usage:
    python _stop_all.py [--grace 3] [--kill]
"""

from __future__ import annotations

import argparse
import os
import re
import signal
import subprocess
import sys
import time

# Command-line substrings that identify a seek process.
SEEK_MARKERS = (
    "seekd",
    "seek-tui",
    "seek-gui",
    "/seek/backend/.venv/bin/python",  # daemon run from a source checkout
)

# Data dir a process may be holding (only matched on macOS/Linux cmdline).
DATA_MARKERS = (
    "/.seek/",
)


def _cmdline(pid: int) -> str:
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            return f.read().replace(b"\x00", b" ").decode("utf-8", "replace")
    except Exception:
        return ""


def _is_self(pid: int) -> bool:
    return pid == os.getpid()


def _matches(cmdline: str) -> bool:
    return any(m in cmdline for m in SEEK_MARKERS) or any(
        m in cmdline for m in DATA_MARKERS if cmdline
    )


def _processes() -> list[int]:
    """Enumerate PIDs whose cmdline matches a seek marker."""
    out: list[int] = []
    try:
        proc = subprocess.run(["ps", "-Ao", "pid=", "-o", "command="],
                              capture_output=True, text=True, check=True)
    except Exception:
        return out
    for line in proc.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        pid_str, _, rest = line.partition(" ")
        if not pid_str.isdigit():
            continue
        pid = int(pid_str)
        if _is_self(pid):
            continue
        if _matches(line):
            out.append(pid)
    return out


def _stop(pid: int, graceful: bool) -> bool:
    """Stop one process. Returns True if it was signalled."""
    try:
        if graceful:
            os.kill(pid, signal.SIGTERM)
        else:
            os.kill(pid, signal.SIGKILL)
        return True
    except Exception:
        return False


def main() -> int:
    ap = argparse.ArgumentParser(description="stop all running seek processes")
    ap.add_argument("--grace", type=float, default=3.0,
                    help="seconds to wait after graceful stop before force kill")
    ap.add_argument("--kill", action="store_true",
                    help="skip graceful stop; use SIGKILL immediately")
    args = ap.parse_args()

    pids = _processes()
    if not pids:
        print("no matching seek processes", file=sys.stderr)
        return 0

    print(f"stopping {len(pids)} seek process(es): {pids}", file=sys.stderr)
    # Graceful pass first (unless --kill).
    if not args.kill:
        remaining: list[int] = []
        for pid in pids:
            if not _stop(pid, graceful=True):
                remaining.append(pid)
        time.sleep(args.grace)
        # Second pass: anything still alive gets SIGKILL.
        alive = [p for p in pids if _stop(p, graceful=False)]
    return 0


if __name__ == "__main__":
    sys.exit(main())
