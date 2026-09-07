"""Process-group guard for the seek daemon's child processes.

The daemon spawns tool subprocesses (``bash`` runs shell commands which may in
turn start python/git/etc. grandchildren). When the daemon is stopped it must
take its whole descendant tree down with it — a bare ``proc.kill()`` on the
direct child would orphan any grandchildren.

Design (process-relationship based, not pgrep-scavenging):

- POSIX: every adopted child is moved into its own process group
  (``os.setpgid(pid, pid)``). Grandchildren inherit that group, so signalling
  the group reaches the entire subtree below that child. The daemon itself is
  never in those groups, so stopping them can never touch the daemon or any
  unrelated process.
- Windows has no process groups; ``taskkill /T`` walks the process tree from
  the recorded pid instead.

Shutdown is graceful: SIGTERM to every group first, a short grace period, then
SIGKILL for anything that ignored SIGTERM.
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import subprocess
import sys
import threading

from seekd.logutil import setup_logger

log = setup_logger("seekd", "seekd.log")

_POSIX = sys.platform != "win32"

# Pids (POSIX: also the process-group id after setpgid) of live tool children.
_pids: set[int] = set()
_lock = threading.Lock()

# Short window before a stopped child is force-killed.
_GRACE_SECONDS = float(os.environ.get("SEEK_STOP_GRACE", "1.5"))


def adopt(pid: int) -> None:
    """Record a freshly spawned child so the daemon can stop its whole tree.

    The child is expected to have its own process group already (bash tool
    spawns with ``process_group=0``), so the recorded pid doubles as its pgid.
    """
    if not pid:
        return
    with _lock:
        _pids.add(pid)
    log.debug("proc_guard: adopted pid=%d (groups=%d)", pid, len(_pids))


def unadopt(pid: int) -> None:
    """Forget a child that finished on its own (normal tool completion)."""
    with _lock:
        _pids.discard(pid)


def _signal_tree(pid: int, sig: int) -> None:
    """Deliver a signal to the child's whole subtree (its process group)."""
    if _POSIX:
        try:
            os.killpg(pid, sig)  # pgid == pid (child spawned as group leader)
            return
        except ProcessLookupError:
            pass  # group already gone
        except PermissionError:
            log.warning("proc_guard: no permission to signal group of pid=%d", pid)
    # Windows, or the child never got its own group: signal the pid directly.
    try:
        os.kill(pid, sig)
    except OSError:
        pass


async def release_all(grace: float | None = None) -> None:
    """Stop every adopted child subtree: SIGTERM, grace, then SIGKILL.

    Called by the daemon during shutdown. Safe to call multiple times.
    """
    grace = grace if grace is not None else _GRACE_SECONDS
    with _lock:
        pids = list(_pids)
        _pids.clear()
    if not pids:
        return
    log.info("proc_guard: stopping %d child process group(s): %s", len(pids), pids)

    if _POSIX:
        for pid in pids:
            _signal_tree(pid, signal.SIGTERM)
        if grace > 0:
            await asyncio.sleep(grace)
        for pid in pids:
            # Kill what is left (signal-tree is idempotent on dead groups).
            _signal_tree(pid, signal.SIGKILL)
        return

    # Windows: taskkill /T /F walks the tree from each recorded pid.
    for pid in pids:
        try:
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                capture_output=True,
                timeout=grace + 5,
                check=False,
            )
        except Exception as e:  # noqa: BLE001
            log.warning("proc_guard: taskkill pid=%d failed: %s", pid, e)
