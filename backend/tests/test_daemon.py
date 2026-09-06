"""Integration tests for the seekd WebSocket protocol (CONTRACT.md §3/§4)."""

import asyncio
import json
from pathlib import Path

import websockets

from seekd.core.models import Room, ScheduledTask, Session
from seekd.config import LlmConfig
from seekd.server.daemon import Seekd
from seekd.store.jsonstore import SeekStore


def _start(tmp_path: Path, port: int, model: str = "", llm_config: LlmConfig | None = None):
    store = SeekStore(root=tmp_path)
    # Seed one room so createSession has a target.
    store.save_room(Room(id="room-1", name="读研", member_ids=[]))
    daemon = Seekd(host="127.0.0.1", port=port, store=store, model=model,
                   llm_config=llm_config)
    return daemon


async def _roundtrip(url, req):
    async with websockets.connect(url) as ws:
        await ws.send(json.dumps(req))
        return json.loads(await ws.recv())


def test_ping(tmp_path):
    d = _start(tmp_path, port=8201)
    async def run():
        async with websockets.serve(d._handle, "127.0.0.1", 8201):
            r = await _roundtrip("ws://127.0.0.1:8201", {"type": "ping"})
            assert r["type"] == "pong"
    asyncio.run(run())


def test_init_returns_world(tmp_path):
    d = _start(tmp_path, port=8202, model="deepseek-v4-flash")
    async def run():
        async with websockets.serve(d._handle, "127.0.0.1", 8202):
            r = await _roundtrip("ws://127.0.0.1:8202", {"type": "init"})
            assert r["type"] == "world:init"
            assert isinstance(r["characters"], list)
            assert isinstance(r["rooms"], list)
            assert r["rooms"][0]["id"] == "room-1"
            assert r["model"] == "deepseek-v4-flash"
    asyncio.run(run())


def test_create_session_and_open(tmp_path):
    d = _start(tmp_path, port=8203)
    async def run():
        async with websockets.serve(d._handle, "127.0.0.1", 8203):
            url = "ws://127.0.0.1:8203"
            created = await _roundtrip(url, {"type": "createSession",
                                             "roomId": "room-1", "name": "会话一"})
            assert created["type"] == "session:created"
            sid = created["session"]["id"]
            opened = await _roundtrip(url, {"type": "openSession", "sessionId": sid})
            assert opened["type"] == "session:messages"
            assert opened["sessionId"] == sid
            assert opened["messages"] == []
    asyncio.run(run())


async def _recv_until(url, req, want_type, limit=10):
    """Send req, read responses until one matches want_type (or limit)."""
    async with websockets.connect(url) as ws:
        await ws.send(json.dumps(req))
        for _ in range(limit):
            m = json.loads(await ws.recv())
            if m["type"] == want_type:
                return m
        raise AssertionError(f"did not get {want_type} in {limit} reads")


def test_unknown_request(tmp_path):
    d = _start(tmp_path, port=8204)
    async def run():
        async with websockets.serve(d._handle, "127.0.0.1", 8204):
            r = await _roundtrip("ws://127.0.0.1:8204", {"type": "bogus", "requestId": "x"})
            assert r["type"] == "error"
            assert "bogus" in r["message"]
    asyncio.run(run())


def test_send_message_persists_user_msg(tmp_path):
    d = _start(tmp_path, port=8205)
    async def run():
        async with websockets.serve(d._handle, "127.0.0.1", 8205):
            url = "ws://127.0.0.1:8205"
            created = await _roundtrip(url, {"type": "createSession",
                                             "roomId": "room-1", "name": "会话"})
            sid = created["session"]["id"]
            # Without a session_runner, sendMessage persists the user message.
            # The sender gets a broadcast message:new (its own msg) and an ok.
            ok = await _recv_until(url, {"type": "sendMessage", "sessionId": sid, "text": "hi"}, "ok")
            assert ok["type"] == "ok"
            opened = await _roundtrip(url, {"type": "openSession", "sessionId": sid})
            assert opened["messages"][0]["speaker"] == "user"


def test_create_character(tmp_path):
    d = _start(tmp_path, port=8206)
    async def run():
        async with websockets.serve(d._handle, "127.0.0.1", 8206):
            r = await _roundtrip("ws://127.0.0.1:8206", {"type": "createCharacter", "name": "小新"})
            assert r["type"] == "character:created"
            ch = r["character"]
            assert ch["kind"] == "virtual"
            assert ch["name"] == "小新"
            # Default letter avatar when none given.
            assert ch["avatar"]["type"] == "letter"
            assert d.store.get_character(ch["id"]) is not None
    asyncio.run(run())


def test_create_character_requires_name(tmp_path):
    d = _start(tmp_path, port=8207)
    async def run():
        async with websockets.serve(d._handle, "127.0.0.1", 8207):
            r = await _roundtrip("ws://127.0.0.1:8207", {"type": "createCharacter", "name": ""})
            assert r["type"] == "error"
            assert "name required" in r["message"]
    asyncio.run(run())


def test_create_room_auto_names_from_members(tmp_path):
    d = _start(tmp_path, port=8210)
    async def run():
        async with websockets.serve(d._handle, "127.0.0.1", 8210):
            url = "ws://127.0.0.1:8210"
            # Create two characters first.
            a = (await _roundtrip(url, {"type": "createCharacter", "name": "小明"}))["character"]
            b = (await _roundtrip(url, {"type": "createCharacter", "name": "小华"}))["character"]
            r = await _roundtrip(url, {"type": "createRoom", "memberIds": [a["id"], b["id"]]})
            assert r["type"] == "room:created"
            room = r["room"]
            assert room["name"] == "小明、小华"  # auto-generated from members
            assert set(room["memberIds"]) == {a["id"], b["id"]}
            assert d.store.get_room(room["id"]) is not None
    asyncio.run(run())


def test_create_room_explicit_name(tmp_path):
    d = _start(tmp_path, port=8211)
    async def run():
        async with websockets.serve(d._handle, "127.0.0.1", 8211):
            r = await _roundtrip("ws://127.0.0.1:8211", {"type": "createRoom", "name": "课题组"})
            assert r["type"] == "room:created"
            assert r["room"]["name"] == "课题组"
    asyncio.run(run())


def test_add_room_member(tmp_path):
    d = _start(tmp_path, port=8212)
    async def run():
        async with websockets.serve(d._handle, "127.0.0.1", 8212):
            url = "ws://127.0.0.1:8212"
            ch = (await _roundtrip(url, {"type": "createCharacter", "name": "小丽"}))["character"]
            r = await _roundtrip(url, {"type": "addRoomMember", "roomId": "room-1", "characterId": ch["id"]})
            assert r["type"] == "room:updated"
            assert ch["id"] in r["room"]["memberIds"]
    asyncio.run(run())


def test_add_room_member_duplicate_is_idempotent(tmp_path):
    d = _start(tmp_path, port=8213)
    async def run():
        async with websockets.serve(d._handle, "127.0.0.1", 8213):
            url = "ws://127.0.0.1:8213"
            ch = (await _roundtrip(url, {"type": "createCharacter", "name": "小刚"}))["character"]
            await _roundtrip(url, {"type": "addRoomMember", "roomId": "room-1", "characterId": ch["id"]})
            r2 = await _roundtrip(url, {"type": "addRoomMember", "roomId": "room-1", "characterId": ch["id"]})
            assert r2["type"] == "room:updated"
            assert r2["room"]["memberIds"].count(ch["id"]) == 1  # no dup
    asyncio.run(run())


def test_add_room_member_missing_target(tmp_path):
    d = _start(tmp_path, port=8214)
    async def run():
        async with websockets.serve(d._handle, "127.0.0.1", 8214):
            r = await _roundtrip("ws://127.0.0.1:8214", {"type": "addRoomMember",
                                                         "roomId": "nope", "characterId": "nope"})
            assert r["type"] == "error"
            assert "not found" in r["message"]
    asyncio.run(run())


def test_remove_room_member(tmp_path):
    d = _start(tmp_path, port=8215)
    async def run():
        async with websockets.serve(d._handle, "127.0.0.1", 8215):
            url = "ws://127.0.0.1:8215"
            ch = (await _roundtrip(url, {"type": "createCharacter", "name": "小强"}))["character"]
            await _roundtrip(url, {"type": "addRoomMember", "roomId": "room-1", "characterId": ch["id"]})
            r = await _roundtrip(url, {"type": "removeRoomMember", "roomId": "room-1", "characterId": ch["id"]})
            assert r["type"] == "room:updated"
            assert ch["id"] not in r["room"]["memberIds"]
    asyncio.run(run())


def test_remove_room_member_absent_is_noop(tmp_path):
    d = _start(tmp_path, port=8216)
    async def run():
        async with websockets.serve(d._handle, "127.0.0.1", 8216):
            r = await _roundtrip("ws://127.0.0.1:8216", {"type": "removeRoomMember",
                                                         "roomId": "room-1", "characterId": "nope"})
            assert r["type"] == "room:updated"  # absent member → no-op, still ok
    asyncio.run(run())


def test_remove_room_member_missing_room(tmp_path):
    d = _start(tmp_path, port=8217)
    async def run():
        async with websockets.serve(d._handle, "127.0.0.1", 8217):
            r = await _roundtrip("ws://127.0.0.1:8217", {"type": "removeRoomMember",
                                                         "roomId": "nope", "characterId": "x"})
            assert r["type"] == "error"
            assert "room not found" in r["message"]
    asyncio.run(run())


class _SlowRunner:
    """A stub session_runner whose turn blocks until cancelled."""
    def __init__(self):
        self.cancelled = False

    async def handle_user_message(self, session_id, text, is_current=None):
        await asyncio.sleep(30)  # long-running; interrupted by cancel
        return []


def test_cancel_interrupts_running_turn(tmp_path):
    store = SeekStore(root=tmp_path)
    store.save_room(Room(id="room-1", name="读研", member_ids=[]))
    runner = _SlowRunner()
    d = Seekd(host="127.0.0.1", port=8218, store=store, session_runner=runner)
    async def run():
        async with websockets.serve(d._handle, "127.0.0.1", 8218):
            url = "ws://127.0.0.1:8218"
            created = await _roundtrip(url, {"type": "createSession",
                                             "roomId": "room-1", "name": "会话"})
            sid = created["session"]["id"]
            # Send a message: starts a background turn (slow runner).
            await _roundtrip(url, {"type": "sendMessage", "sessionId": sid, "text": "hi"})
            # Give the background task a moment to start.
            await asyncio.sleep(0.2)
            # Cancel it.
            r = await _roundtrip(url, {"type": "cancel"})
            assert r["type"] == "ok"
            # Wait for the cancellation to be observed.
            await asyncio.sleep(0.2)
            # The task should have been cancelled and cleared.
            assert d._turn_task is None or d._turn_task.done()
    asyncio.run(run())


def test_cancel_idempotent_when_idle(tmp_path):
    d = _start(tmp_path, port=8219)
    async def run():
        async with websockets.serve(d._handle, "127.0.0.1", 8219):
            r = await _roundtrip("ws://127.0.0.1:8219", {"type": "cancel"})
            assert r["type"] == "ok"  # no running turn → idempotent ok
    asyncio.run(run())


def test_list_tasks_returns_metadata(tmp_path):
    d = _start(tmp_path, port=8220)
    async def run():
        async with websockets.serve(d._handle, "127.0.0.1", 8220):
            # Seed a session + its task.
            sid = "s-task"
            d.store.save_session(Session(id=sid, room_id="room-1", name="任务会话"))
            d.store.save_task(ScheduledTask(id=sid, enabled=True, interval=3600))
            r = await _roundtrip("ws://127.0.0.1:8220", {"type": "listTasks"})
            assert r["type"] == "tasks"
            assert len(r["tasks"]) == 1
            t = r["tasks"][0]
            assert t["id"] == sid
            assert t["enabled"] is True
            assert t["interval"] == 3600
            assert t["session"]["id"] == sid
    asyncio.run(run())


def test_trigger_task_injects_prompt(tmp_path):
    d = _start(tmp_path, port=8221)
    async def run():
        async with websockets.serve(d._handle, "127.0.0.1", 8221):
            url = "ws://127.0.0.1:8221"
            sid = "s-task"
            ws = tmp_path / "ws"
            ws.mkdir()
            (ws / "task_prompt.md").write_text("请总结本周进度,{{ workspace }}", encoding="utf-8")
            d.store.save_session(Session(id=sid, room_id="room-1", name="任务会话", workspace=str(ws)))
            d.store.save_task(ScheduledTask(id=sid, enabled=True, interval=3600))
            r = await _recv_until(url, {"type": "triggerTask", "sessionId": sid}, "ok")
            assert r["type"] == "ok"
            # The system prompt message should have been injected & persisted.
            sess = d.store.get_session(sid)
            assert sess.messages, "expected an injected task prompt message"
            # Variable substitution: {{ workspace }} → the workspace path.
            assert str(ws) in sess.messages[-1].text
    asyncio.run(run())


def test_trigger_task_missing_prompt_errors(tmp_path):
    d = _start(tmp_path, port=8222)
    async def run():
        async with websockets.serve(d._handle, "127.0.0.1", 8222):
            sid = "s-task"
            d.store.save_session(Session(id=sid, room_id="room-1", name="任务会话", workspace=str(tmp_path)))
            r = await _roundtrip("ws://127.0.0.1:8222", {"type": "triggerTask", "sessionId": sid})
            assert r["type"] == "error"
            assert "task_prompt.md" in r["message"]
    asyncio.run(run())


def test_switch_model_updates_key(tmp_path):
    d = _start(tmp_path, port=8223)
    async def run():
        async with websockets.serve(d._handle, "127.0.0.1", 8223):
            url = "ws://127.0.0.1:8223"
            r = await _roundtrip(url, {"type": "switchModel", "modelKey": "gpt-4o"})
            assert r["type"] == "ok"
            assert d.model_key == "gpt-4o"
            # init now reports the switched model
            init = await _roundtrip(url, {"type": "init"})
            assert init["model"] == "gpt-4o"
    asyncio.run(run())


class _ModelRunner:
    """A session_runner stub that records set_model calls."""
    def __init__(self):
        self.model = ""
    def set_model(self, key):
        self.model = key


def test_switch_model_forwards_to_runner(tmp_path):
    store = SeekStore(root=tmp_path)
    store.save_room(Room(id="room-1", name="读研", member_ids=[]))
    runner = _ModelRunner()
    d = Seekd(host="127.0.0.1", port=8224, store=store, session_runner=runner)
    async def run():
        async with websockets.serve(d._handle, "127.0.0.1", 8224):
            r = await _roundtrip("ws://127.0.0.1:8224", {"type": "switchModel", "modelKey": "kimi"})
            assert r["type"] == "ok"
            assert runner.model == "kimi"
    asyncio.run(run())


def test_list_models_merges_default_and_config(tmp_path):
    cfg = LlmConfig(model="deepseek-v4-flash", context_window=1024000,
                    models=[{"name": "deepseek-v4-flash", "context_window": 1024000, "vision": True},
                            {"name": "gpt-4o", "context_window": 128000, "vision": True}])
    d = _start(tmp_path, port=8225, model="deepseek-v4-flash", llm_config=cfg)
    async def run():
        async with websockets.serve(d._handle, "127.0.0.1", 8225):
            r = await _roundtrip("ws://127.0.0.1:8225", {"type": "listModels"})
            assert r["type"] == "models"
            assert r["current"] == "deepseek-v4-flash"
            names = [m["name"] for m in r["models"]]
            # default first, then config entries (deduped)
            assert names[0] == "deepseek-v4-flash"
            assert "gpt-4o" in names
            assert len(names) == 2  # deepseek deduped (default + config)
    asyncio.run(run())


def test_switch_model_resolves_apimodel_override(tmp_path):
    cfg = LlmConfig(model="deepseek-v4-flash", context_window=1024000,
                    models=[{"name": "kimi", "model": "moonshotai/Kimi-K2.7", "context_window": 256000}])
    d = _start(tmp_path, port=8226, model="deepseek-v4-flash", llm_config=cfg)
    async def run():
        async with websockets.serve(d._handle, "127.0.0.1", 8226):
            url = "ws://127.0.0.1:8226"
            r = await _roundtrip(url, {"type": "switchModel", "modelKey": "kimi"})
            assert r["type"] == "ok"
            # api model override applied to daemon.key
            assert d.model_key == "moonshotai/Kimi-K2.7"
    asyncio.run(run())


def test_get_settings_returns_llm_config(tmp_path):
    cfg = LlmConfig(base_url="https://x/v1", api_key="k", model="m",
                    models=[{"name": "m1", "model": "m1-api", "vision": True}])
    d = _start(tmp_path, port=8230, model="m", llm_config=cfg)
    async def run():
        async with websockets.serve(d._handle, "127.0.0.1", 8230):
            r = await _roundtrip("ws://127.0.0.1:8230", {"type": "getSettings"})
            assert r["type"] == "settings"
            s = r["settings"]
            assert s["apiKey"] == "k"
            assert s["baseUrl"] == "https://x/v1"
            assert s["model"] == "m"
            assert s["currentModel"] == "m"
            assert s["modelDetails"][0]["name"] == "m1"
            assert s["modelDetails"][0]["model"] == "m1-api"
    asyncio.run(run())


def test_save_settings_writes_config_back(tmp_path, monkeypatch):
    cfg_path = tmp_path / "config.toml"
    monkeypatch.setenv("SEEK_CONFIG", str(cfg_path))
    cfg = LlmConfig(base_url="https://x/v1", api_key="k", model="m")
    d = _start(tmp_path, port=8231, model="m", llm_config=cfg)
    async def run():
        async with websockets.serve(d._handle, "127.0.0.1", 8231):
            r = await _roundtrip("ws://127.0.0.1:8231", {
                "type": "saveSettings",
                "apiKey": "new-key",
                "baseUrl": "https://y/v1",
                "model": "gpt-4o",
                "modelDetails": [{"name": "gpt-4o", "contextWindow": 128000},
                                 {"name": "kimi", "model": "kimi-api", "vision": True}],
            })
            assert r["type"] == "ok"
            # The daemon re-synced its runtime model key.
            assert d.model_key == "gpt-4o"
    asyncio.run(run())

    # config.toml written by daemon.settings → reload round-trips.
    import tomllib
    doc = tomllib.loads(cfg_path.read_text(encoding="utf-8"))
    assert doc["llm"]["api_key"] == "new-key"
    assert doc["llm"]["model"] == "gpt-4o"
    models = doc["llm"]["models"]
    assert models[0]["name"] == "gpt-4o"
    assert models[0]["context_window"] == 128000
    assert models[1]["name"] == "kimi"
    assert models[1]["model"] == "kimi-api"


def test_save_settings_normalizes_models(tmp_path, monkeypatch):
    cfg_path = tmp_path / "config.toml"
    monkeypatch.setenv("SEEK_CONFIG", str(cfg_path))
    cfg = LlmConfig(base_url="https://x/v1", api_key="k", model="m")
    d = _start(tmp_path, port=8232, model="m", llm_config=cfg)
    async def run():
        async with websockets.serve(d._handle, "127.0.0.1", 8232):
            r = await _roundtrip("ws://127.0.0.1:8232", {
                "type": "saveSettings",
                "modelDetails": [{"name": "  ", "model": "x"},  # blank name → dropped
                                 {"name": "n1", "model": "n1"},
                                 {"name": "n2", "model": "n2-api", "vision": True}],
            })
            assert r["type"] == "ok"
    asyncio.run(run())
    # Only valid entries persisted; blank names dropped; same-name model elided.
    got = d.llm_config.models
    names = [m.get("name") for m in got]
    assert "n1" in names and "n2" in names
    # n1's model equals its name → omitted; n2 has an api override → kept.
    assert {"name": "n1"} in got
    assert {"name": "n2", "model": "n2-api", "vision": True} in got


def test_send_message_without_runner_emits_turn_lifecycle(tmp_path):
    """With no session_runner (no api_key), sendMessage must still emit a
    paired turn:start + turn:idle so a client's composing flag never sticks."""
    d = _start(tmp_path, port=8233)
    async def run():
        async with websockets.serve(d._handle, "127.0.0.1", 8233):
            url = "ws://127.0.0.1:8233"
            created = await _roundtrip(url, {"type": "createSession",
                                             "roomId": "room-1", "name": "会话"})
            sid = created["session"]["id"]
            types = []
            async with websockets.connect(url) as ws:
                await ws.send(json.dumps({"type": "sendMessage",
                                          "sessionId": sid, "text": "hi"}))
                for _ in range(10):
                    m = json.loads(await ws.recv())
                    types.append(m["type"])
                    if m["type"] == "turn:idle":
                        break
            assert "turn:start" in types, f"turn:start missing: {types}"
            assert "turn:idle" in types, f"turn:idle missing: {types}"
            assert "message:new" in types
    asyncio.run(run())


def test_send_message_with_runner_runs_turn(tmp_path):
    """Regression: with a session_runner wired, sendMessage must actually run
    the group turn and broadcast the virtual member's reply.

    The guard in ``_run_turn`` used to read ``if self._turn_cancel:`` — an
    ``asyncio.Event`` object is always truthy, so every turn returned before
    calling the runner and no virtual member ever replied (observed on a real
    install: ``turn:start`` followed instantly by ``turn:idle``, no message).
    """
    from seekd.core.ids import new_id, now_iso
    from seekd.core.models import Message

    store = SeekStore(root=tmp_path)
    store.save_room(Room(id="room-1", name="读研", member_ids=["s-1"]))
    store.save_session(Session(id="sess-1", room_id="room-1", name="会话",
                               workspace="", created_at=now_iso(), updated_at=now_iso()))

    class FakeRunner:
        def __init__(self):
            self.calls = 0

        async def handle_user_message(self, session_id, text, is_current=None, emit=None):
            self.calls += 1
            assert session_id == "sess-1"
            return [Message(id=new_id(), speaker="s-1", time=now_iso(),
                            kind="text", text="hello back")]

    runner = FakeRunner()
    d = Seekd(host="127.0.0.1", port=8235, store=store, session_runner=runner)
    async def run():
        async with websockets.serve(d._handle, "127.0.0.1", 8235):
            url = "ws://127.0.0.1:8235"
            types = []
            reply = None
            async with websockets.connect(url) as ws:
                await ws.send(json.dumps({"type": "sendMessage",
                                          "sessionId": "sess-1", "text": "hi"}))
                for _ in range(10):
                    m = json.loads(await ws.recv())
                    types.append(m["type"])
                    if m["type"] == "message:new" and m["message"].get("speaker") == "s-1":
                        reply = m["message"]
                    if m["type"] == "turn:idle":
                        break
            assert runner.calls == 1, f"runner never invoked; types={types}"
            assert reply is not None, f"no virtual-member reply broadcast; types={types}"
            assert reply["text"] == "hello back"
            assert "turn:start" in types
            assert "turn:idle" in types
    asyncio.run(run())


def test_workspace_files_list_read_and_traversal(tmp_path):
    """listWorkspaceFiles/readWorkspaceFile work on the session workspace,
    and path traversal (``..``) is rejected."""
    ws = tmp_path / "workspace"
    ws.mkdir()
    (ws / "notes.md").write_text("# 笔记\n内容", encoding="utf-8")
    (ws / "sub").mkdir()
    out = tmp_path / "outside.txt"
    out.write_text("secret", encoding="utf-8")

    d = _start(tmp_path, port=8234)
    async def run():
        async with websockets.serve(d._handle, "127.0.0.1", 8234):
            url = "ws://127.0.0.1:8234"
            created = await _roundtrip(url, {"type": "createSession",
                                             "roomId": "room-1", "name": "会话",
                                             "workspace": str(ws)})
            sid = created["session"]["id"]
            # list
            listed = await _roundtrip(url, {"type": "listWorkspaceFiles", "sessionId": sid})
            assert listed["type"] == "workspaceFiles"
            names = {f["name"]: f for f in listed["files"]}
            assert "notes.md" in names and not names["notes.md"]["isDir"]
            assert "sub" in names and names["sub"]["isDir"]
            # read
            read = await _roundtrip(url, {"type": "readWorkspaceFile",
                                          "sessionId": sid, "name": "notes.md"})
            assert read["type"] == "workspaceFile"
            assert "内容" in read["content"]
            # path traversal rejected
            trap = await _roundtrip(url, {"type": "readWorkspaceFile",
                                          "sessionId": sid, "name": "../outside.txt"})
            assert trap["type"] == "error", trap
    asyncio.run(run())
