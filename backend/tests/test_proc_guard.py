"""Tests for proc_guard: adopted child trees are stopped on release_all."""

import asyncio
import os
import sys

import pytest

from seekd.server import proc_guard
from seekd.server.proc_guard import adopt, release_all, unadopt

pytestmark = pytest.mark.skipif(
    sys.platform == "win32", reason="process-group semantics are POSIX-only"
)


async def _alive_pid(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


async def _spawn_tree(marker: str, seconds: int = 60) -> tuple[int, int]:
    """Spawn shell + grandchild sleep (like a `bash` tool run).

    The grandchild writes its own pid to a temp file so the test can assert on
    it deterministically (no ps dependency). Returns (child_pid, grand_pid).
    """
    path = f"/tmp/seek_proc_guard_{marker}.pid"
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    proc = await asyncio.create_subprocess_shell(
        f"sleep {seconds} & echo $! > {path}; wait",
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
        process_group=0,   # same as the bash tool: child leads its own group
    )
    adopt(proc.pid)
    # wait for the grandchild pid file to appear
    for _ in range(100):
        if os.path.exists(path):
            break
        await asyncio.sleep(0.02)
    with open(path) as f:
        grand_pid = int(f.read().strip())
    os.unlink(path)
    return proc.pid, grand_pid


def test_release_all_kills_adopted_tree():
    """release_all TERMs the child AND its grandchild (same process group)."""
    proc_guard._pids.clear()

    async def run():
        child_pid, grand_pid = await _spawn_tree("tree")
        await asyncio.sleep(0.2)
        assert await _alive_pid(child_pid)
        assert await _alive_pid(grand_pid)

        await release_all(grace=0.1)
        await asyncio.sleep(0.2)
        # adopted child is gone
        assert not await _alive_pid(child_pid), "child still alive after release_all"
        # and its grandchild too (killed via the shared process group)
        assert not await _alive_pid(grand_pid), "grandchild survived stop"
        assert not proc_guard._pids, "registry not cleared"

    asyncio.run(run())


def test_unadopt_lets_finished_child_drop():
    """A normally-finished child is forgotten, so release_all has nothing to do."""
    proc_guard._pids.clear()

    async def run():
        proc = await asyncio.create_subprocess_shell("true")
        adopt(proc.pid)
        await proc.wait()
        unadopt(proc.pid)
        assert proc_guard._pids == set()

    asyncio.run(run())


def test_release_all_never_touches_unadopted_pids():
    """release_all only ever signals adopted pids (no collateral damage)."""
    proc_guard._pids.clear()

    async def run():
        # a long-running external process that was never adopted (e.g. the
        # daemon itself / an unrelated shell)
        bystander = await asyncio.create_subprocess_shell("sleep 60")
        try:
            await release_all(grace=0)
            assert await _alive_pid(bystander.pid), "unadopted process was killed"
        finally:
            bystander.kill()
            await bystander.wait()

    asyncio.run(run())
