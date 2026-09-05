"""Seek WebSocket protocol client.

Talks to the ``seekd`` daemon over CONTRACT.md. One connection per client. A
background reader task routes each inbound message to an event queue the UI
drains. ``request`` sends a message, then waits for the *first* message whose
``type`` matches the expected response, because CONTRACT responses (``world:init``,
``rooms``, ``models``, ``session:messages``, …) carry no ``requestId`` — they are
broadcast to every connected client. Only ``ok`` / ``error`` echo a ``requestId``.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections import deque
from collections.abc import AsyncIterator


class SeekClient:
    """A thin conversation layer over a WebSocket to ``seekd``.

    Usage:
        client = SeekClient(host, port)
        await client.connect()
        world = await client.request("init", expect="world:init")
        async for event in client.events():
            ...  # message:new, session:messages, turn:start, etc.
    """

    def __init__(self, host: str = "127.0.0.1", port: int = 8123, timeout: float = 15.0) -> None:
        self.uri = f"ws://{host}:{port}"
        self.timeout = timeout
        self._ws: object | None = None
        self._events: deque = deque()
        self._events_ready = asyncio.Event()
        self._closed = False

    async def connect(self) -> None:
        import websockets
        self._ws = await websockets.connect(self.uri)
        asyncio.create_task(self._reader())

    async def close(self) -> None:
        self._closed = True
        if self._ws is not None:
            await self._ws.close()  # type: ignore[attr-defined]
            self._ws = None

    async def send(self, rtype: str, **fields) -> None:
        """Fire-and-forget send (no response awaited). Results arrive via events."""
        assert self._ws is not None
        rid = str(uuid.uuid4())
        req = {"type": rtype, "requestId": rid, **fields}
        await self._ws.send(json.dumps(req, ensure_ascii=False))  # type: ignore[attr-defined]

    async def request(self, rtype: str, *, expect: str | None = None, timeout: float | None = None, **fields) -> dict:
        """Send a request and await the first matching response.

        ``expect`` is the response ``type`` to wait for (e.g. ``"world:init"`` for
        ``init``). When ``expect`` is omitted we fall back to matching by
        ``requestId`` for requests whose responses do echo one (``ok``/``error``).
        Returns the matching message dict; raises ``TimeoutError`` on timeout.
        """
        assert self._ws is not None
        rid = str(uuid.uuid4())
        req = {"type": rtype, "requestId": rid, **fields}
        await self._ws.send(json.dumps(req, ensure_ascii=False))  # type: ignore[attr-defined]

        if expect is not None:
            deadline = asyncio.get_running_loop().time() + (timeout or self.timeout)
            while not self._closed:
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    raise TimeoutError(f"no response of type '{expect}' for '{rtype}'")
                if not self._events:
                    await asyncio.wait_for(self._events_ready.wait(), timeout=remaining)
                    self._events_ready.clear()
                    continue
                msg = self._events.popleft()
                if msg.get("type") == expect:
                    return msg
            raise ConnectionError("client closed")

        # Fallback: wait for a response echoing this requestId (ok/error).
        return await self._wait_request_id(rid, timeout)

    async def _wait_request_id(self, rid: str, timeout: float | None) -> dict:
        deadline = asyncio.get_running_loop().time() + (timeout or self.timeout)
        while not self._closed:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                raise TimeoutError(f"no response for requestId {rid}")
            if not self._events:
                await asyncio.wait_for(self._events_ready.wait(), timeout=remaining)
                self._events_ready.clear()
                continue
            msg = self._events.popleft()
            if msg.get("requestId") == rid:
                return msg
            # Not our response: re-queue so the UI's event consumer still sees it.
            self._events.append(msg)
        raise ConnectionError("client closed")

    async def events(self) -> AsyncIterator[dict]:
        """Yield inbound messages that are NOT matched as a request response."""
        while True:
            if not self._events:
                await self._events_ready.wait()
                self._events_ready.clear()
            while self._events:
                yield self._events.popleft()

    async def _reader(self) -> None:
        """Push every inbound message onto the event queue."""
        assert self._ws is not None
        try:
            async for raw in self._ws:  # type: ignore[attr-defined]
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                self._events.append(msg)
                self._events_ready.set()
        except Exception:
            # Connection dropped; the UI notices via events/status.
            pass
        finally:
            self._closed = True
            self._events_ready.set()
