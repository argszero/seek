"""Tests for seek_tui.protocol — request/response and event routing.

Uses a real websockets server that mimics the seek daemon's CONTRACT responses.
Real daemon responses (``world:init``, ``session:messages``, ``models``, …) carry
NO ``requestId`` — they are broadcast. Only ``ok``/``error`` echo a ``requestId``.
So ``request`` matches by ``expect`` type; fire-and-forget ``send`` gets results
via ``events``.
"""

import asyncio
import json

import pytest
import websockets

from seek_tui.protocol import SeekClient


def _handler(start_event):
    """Return a handler that answers protocol requests like the real daemon."""
    async def handler(ws):
        async for raw in ws:
            req = json.loads(raw)
            rtype = req.get("type")
            rid = req.get("requestId")
            if rtype == "init":
                # World init: broadcast, NO requestId (matches real daemon).
                await ws.send(json.dumps({
                    "type": "world:init",
                    "characters": [], "rooms": [], "sessions": [],
                    "activeSessionId": None, "model": ""}))
            elif rtype == "ping":
                await ws.send(json.dumps({"type": "pong", "requestId": rid}))
            elif rtype == "listModels":
                # models list: broadcast, NO requestId.
                await ws.send(json.dumps({"type": "models",
                                          "models": [{"name": "m1"}], "current": "m1"}))
            elif rtype == "openSession":
                # session messages: broadcast, NO requestId.
                await ws.send(json.dumps({"type": "session:messages", "sessionId": "s1",
                                          "messages": [{"speaker": "user", "text": "hi", "kind": "text"}],
                                          "appendOnly": False}))
            elif rtype == "sendMessage":
                # broadcast an event first, then respond ok echoing requestId.
                await ws.send(json.dumps({"type": "message:new",
                                          "sessionId": "s1",
                                          "message": {"speaker": "user", "text": "hi", "kind": "text"}}))
                await ws.send(json.dumps({"type": "ok", "requestId": rid}))
            else:
                await ws.send(json.dumps({"type": "error", "requestId": rid,
                                          "message": f"unknown {rtype}"}))
    return handler


@pytest.mark.asyncio
async def test_request_matches_by_expect_type():
    handler = _handler(None)
    async with websockets.serve(handler, "127.0.0.1", 0) as srv:
        port = srv.sockets[0].getsockname()[1]
        client = SeekClient(host="127.0.0.1", port=port)
        await client.connect()
        # Real daemon's world:init carries no requestId; we match by type.
        world = await client.request("init", expect="world:init")
        assert world["type"] == "world:init"
        assert world["characters"] == []
        await client.close()


@pytest.mark.asyncio
async def test_request_models_by_expect():
    handler = _handler(None)
    async with websockets.serve(handler, "127.0.0.1", 0) as srv:
        port = srv.sockets[0].getsockname()[1]
        client = SeekClient(host="127.0.0.1", port=port)
        await client.connect()
        models = await client.request("listModels", expect="models")
        assert models["current"] == "m1"
        assert models["models"][0]["name"] == "m1"
        await client.close()


@pytest.mark.asyncio
async def test_send_is_fire_and_forget_events_carry_result():
    handler = _handler(None)
    async with websockets.serve(handler, "127.0.0.1", 0) as srv:
        port = srv.sockets[0].getsockname()[1]
        client = SeekClient(host="127.0.0.1", port=port)
        await client.connect()
        got = []
        ev_task = asyncio.create_task(_collect(client, got))
        # sendMessage is fire-and-forget: the message:new arrives via events.
        await client.send("sendMessage", sessionId="s1", text="hi")
        await asyncio.sleep(0.2)
        ev_task.cancel()
        assert any(e["type"] == "message:new" for e in got)
        await client.close()


@pytest.mark.asyncio
async def test_broadcast_events_consumed_by_events_stream():
    handler = _handler(None)
    async with websockets.serve(handler, "127.0.0.1", 0) as srv:
        port = srv.sockets[0].getsockname()[1]
        client = SeekClient(host="127.0.0.1", port=port)
        await client.connect()
        got = []
        ev_task = asyncio.create_task(_collect(client, got))
        await client.send("sendMessage", sessionId="s1", text="hi")
        await asyncio.sleep(0.2)
        ev_task.cancel()
        # message:new is broadcast (no requestId) and reaches the events stream.
        assert any(e["type"] == "message:new" for e in got)
        await client.close()


async def _collect(client, sink):
    async for ev in client.events():
        sink.append(ev)
