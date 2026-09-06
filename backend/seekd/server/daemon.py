"""seekd daemon — a WebSocket server exposing the seek protocol.

This is the *only* backend. It accepts clients (TUI / GUI / WEBUI), routes
requests from CONTRACT.md §3, and emits events per §4. It also serves the
built WEBUI bundle so a browser can open `http://localhost:<port>`.

The daemon is intentionally thin: it wires the store, the group-chat
orchestrator, and the agent runner. Each concern lives in its own module.
"""

from __future__ import annotations

import asyncio
import json
import logging
import signal
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import websockets

from seekd.core.ids import new_id, now_iso
from seekd.core.models import Character, Message, Room, ScheduledTask, Session
from seekd.logutil import setup_logger
from seekd.server.httpserver import WebUiServer
from seekd.store.jsonstore import SeekStore

log = setup_logger("seekd", "seekd.log")



class Seekd:
    """Owns the WebSocket listener, the static WEBUI server, and the store."""

    def __init__(self, host: str = "127.0.0.1", port: int = 37291,
                 webui_dist: str | None = None, store: SeekStore | None = None,
                 session_runner: "SessionRunner | None" = None,
                 model: str = "", llm_config: Any | None = None,
                 webui_port: int = 37292) -> None:
        self.host = host
        self.port = port
        self.webui_server = WebUiServer(webui_dist, self.host, webui_port)
        self.store = store or SeekStore()
        self.session_runner = session_runner
        self.model_key = model
        self.llm_config = llm_config
        # Active session id a client last opened, stored per-connection.
        self.active: dict = {}
        # Live client sockets, for broadcasting new messages.
        self.clients: set = set()
        # Current running group-chat turn (for `cancel`), if any.
        self._turn_task: asyncio.Task | None = None
        self._turn_session: str | None = None
        self._turn_cancel: asyncio.Event | None = None
        self._scheduler_task: asyncio.Task | None = None

    # ---- connection handling ---------------------------------------------
    async def _handle(self, ws) -> None:
        """Route one client connection. Requests are handled per message."""
        self.clients.add(ws)
        peer = getattr(ws, "remote_address", None)
        log.info("client connected: %s (total=%d)", peer, len(self.clients))
        try:
            async for raw in ws:
                try:
                    req = json.loads(raw)
                except json.JSONDecodeError as e:
                    log.warning("invalid JSON from %s: %s", peer, e)
                    await self._send(ws, {"type": "error", "message": "invalid JSON"})
                    continue
                try:
                    await self._dispatch(ws, req)
                except Exception as e:  # noqa: BLE001
                    # Never let one bad request kill the connection.
                    log.exception("error handling %r from %s", req.get("type"), peer)
                    await self._send(ws, {"type": "error", "requestId": req.get("requestId"),
                                          "message": f"internal error: {e}"})
        except websockets.ConnectionClosed as e:
            log.info("client disconnected: %s (code=%s)", peer, getattr(e, "code", "?"))
        except Exception as e:  # noqa: BLE001
            log.exception("connection loop error for %s", peer)
        finally:
            self.clients.discard(ws)

    async def _dispatch(self, ws, req: dict) -> None:
        """Route a request envelope to a handler."""
        rtype = req.get("type", "")
        request_id = req.get("requestId")
        if rtype == "ping":
            await self._send(ws, {"type": "pong"})
        elif rtype == "init":
            await self._init(ws)
        elif rtype == "listRooms":
            await self._send(ws, {"type": "rooms", "rooms": [r.to_dict() for r in self.store.list_rooms()]})
        elif rtype == "listCharacters":
            await self._send(ws, {"type": "characters", "characters": [c.to_dict() for c in self.store.list_characters()]})
        elif rtype == "listSessions":
            room_id = req.get("roomId")
            sessions = self.store.list_sessions(room_id=room_id)
            await self._send(ws, {"type": "sessions", "sessions": [s.to_dict() for s in sessions]})
        elif rtype == "createSession":
            await self._create_session(ws, req)
        elif rtype == "createRoom":
            await self._create_room(ws, req)
        elif rtype == "createCharacter":
            await self._create_character(ws, req)
        elif rtype == "addRoomMember":
            await self._add_room_member(ws, req)
        elif rtype == "removeRoomMember":
            await self._remove_room_member(ws, req)
        elif rtype == "openSession":
            await self._open_session(ws, req)
        elif rtype == "renameSession":
            await self._rename_session(ws, req)
        elif rtype == "clearSession":
            await self._clear_session(ws, req)
        elif rtype == "sendMessage":
            await self._send_message(ws, req)
        elif rtype == "switchModel":
            await self._switch_model(ws, req)
        elif rtype == "listModels":
            await self._list_models(ws, req)
        elif rtype == "getSettings":
            await self._get_settings(ws)
        elif rtype == "saveSettings":
            await self._save_settings(ws, req)
        elif rtype == "cancel":
            await self._cancel(ws, req)
        elif rtype == "listTasks":
            await self._list_tasks(ws, req)
        elif rtype == "triggerTask":
            await self._trigger_task(ws, req)
        elif rtype == "listWorkspaceFiles":
            await self._list_workspace_files(ws, req)
        elif rtype == "readWorkspaceFile":
            await self._read_workspace_file(ws, req)
        else:
            log.warning("unknown request type %r from %s", rtype, getattr(ws, "remote_address", "?"))
            await self._send(ws, {
                "type": "error",
                "requestId": request_id,
                "message": f"unknown request: {rtype}",
            })

    # ---- handlers -----------------------------------------------------------
    async def _init(self, ws) -> None:
        characters = [c.to_dict() for c in self.store.list_characters()]
        rooms = [r.to_dict() for r in self.store.list_rooms()]
        sessions = [s.to_dict() for s in self.store.list_sessions()]
        await self._send(ws, {
            "type": "world:init",
            "characters": characters,
            "rooms": rooms,
            "sessions": sessions,
            "activeSessionId": None,
            "model": self.model_key,
        })

    async def _create_session(self, ws, req: dict) -> None:
        room_id = req.get("roomId")
        if not room_id or not self.store.get_room(room_id):
            await self._send(ws, {"type": "error", "requestId": req.get("requestId"),
                                  "message": "room not found"})
            return
        now = now_iso()
        sid = new_id()
        session = Session(id=sid, room_id=room_id, name=req.get("name", ""),
                          workspace=req.get("workspace", ""), created_at=now,
                          updated_at=now)
        self.store.save_session(session)
        await self._send(ws, {"type": "session:created", "session": session.to_dict()})

    async def _create_room(self, ws, req: dict) -> None:
        """Create a room. Room name optional (auto-generated from members if
        blank per decision-g8). memberIds are existing character ids."""
        member_ids = [m for m in req.get("memberIds", []) if self.store.get_character(m)]
        now = now_iso()
        rid = new_id()
        name = req.get("name", "") or self._auto_room_name(member_ids)
        room = Room(id=rid, name=name, description=req.get("description", ""),
                    member_ids=member_ids, created_at=now)
        self.store.save_room(room)
        await self._send(ws, {"type": "room:created", "room": room.to_dict()})
        await self._broadcast({"type": "room:created", "room": room.to_dict()})

    async def _create_character(self, ws, req: dict) -> None:
        """Create a virtual character with a letter avatar by default.

        Per decision-role-mgmt-settings, new characters are always ``virtual``
        (the built-in human ``you`` is not editable here); kind/agent/speak
        strategy are fixed.
        """
        name = (req.get("name") or "").strip()
        if not name:
            await self._send(ws, {"type": "error", "requestId": req.get("requestId"),
                                  "message": "name required"})
            return
        now = now_iso()
        cid = new_id()
        from seekd.core.models import Avatar
        avatar = req.get("avatar")
        if avatar is None:
            avatar = Avatar(type="letter", text=name[:2], bg="", fg="")
        person = Character(id=cid, kind="virtual", name=name,
                           persona=req.get("persona", ""), avatar=avatar,
                           created_at=now, updated_at=now)
        self.store.save_character(person)
        await self._send(ws, {"type": "character:created", "character": person.to_dict()})
        await self._broadcast({"type": "character:created", "character": person.to_dict()})

    async def _add_room_member(self, ws, req: dict) -> None:
        """Add a character to a room."""
        rid = req.get("roomId")
        cid = req.get("characterId")
        room = self.store.get_room(rid) if rid else None
        if room is None or not self.store.get_character(cid or ""):
            await self._send(ws, {"type": "error", "requestId": req.get("requestId"),
                                  "message": "room or character not found"})
            return
        if cid not in room.member_ids:
            room.member_ids.append(cid)
            self.store.save_room(room)
        await self._send(ws, {"type": "room:updated", "room": room.to_dict()})
        await self._broadcast({"type": "room:updated", "room": room.to_dict()})

    async def _remove_room_member(self, ws, req: dict) -> None:
        """Remove a character from a room (G9: members are addable/removable)."""
        rid = req.get("roomId")
        cid = req.get("characterId")
        room = self.store.get_room(rid) if rid else None
        if room is None:
            await self._send(ws, {"type": "error", "requestId": req.get("requestId"),
                                  "message": "room not found"})
            return
        if cid and cid in room.member_ids:
            room.member_ids = [m for m in room.member_ids if m != cid]
            self.store.save_room(room)
        await self._send(ws, {"type": "room:updated", "room": room.to_dict()})
        await self._broadcast({"type": "room:updated", "room": room.to_dict()})

    def _auto_room_name(self, member_ids: list[str]) -> str:
        """decision-g8: blank room name → join member names (e.g. "小明、小华")."""
        names = []
        for mid in member_ids:
            c = self.store.get_character(mid)
            if c:
                names.append(c.name)
        if names:
            return "、".join(names[:2]) if len(names) > 2 else "、".join(names)
        return "新房间"

    async def _open_session(self, ws, req: dict) -> None:
        sid = req.get("sessionId")
        session = self.store.get_session(sid) if sid else None
        if session is None:
            await self._send(ws, {"type": "error", "requestId": req.get("requestId"),
                                  "message": "session not found"})
            return
        self.active[id(ws)] = sid
        await self._send(ws, {"type": "session:messages", "sessionId": sid,
                              "messages": [m.to_dict() for m in session.messages],
                              "appendOnly": False})

    async def _rename_session(self, ws, req: dict) -> None:
        sid = req.get("sessionId")
        session = self.store.get_session(sid) if sid else None
        if session is None:
            await self._send(ws, {"type": "error", "requestId": req.get("requestId"),
                                  "message": "session not found"})
            return
        title = req.get("title", "")
        session.name = title
        session.updated_at = now_iso()
        self.store.save_session(session)
        await self._send(ws, {"type": "session:renamed", "sessionId": sid, "title": title})

    async def _clear_session(self, ws, req: dict) -> None:
        sid = req.get("sessionId")
        session = self.store.get_session(sid) if sid else None
        if session is None:
            await self._send(ws, {"type": "error", "requestId": req.get("requestId"),
                                  "message": "session not found"})
            return
        session.messages = []
        session.updated_at = now_iso()
        self.store.save_session(session)
        await self._send(ws, {"type": "session:cleared", "sessionId": sid})

    async def _send_message(self, ws, req: dict) -> None:
        sid = req.get("sessionId")
        text = req.get("text", "")
        session = self.store.get_session(sid) if sid else None
        if session is None:
            await self._send(ws, {"type": "error", "requestId": req.get("requestId"),
                                  "message": "session not found"})
            return
        # Persist the user message first, then run the group turn if wired.
        user_msg = Message(id=new_id(), speaker="user", time=now_iso(),
                           kind="text", text=text)
        self.store.append_message(sid, user_msg)
        await self._broadcast({"type": "message:new", "sessionId": sid, "message": user_msg.to_dict()})
        await self._send(ws, {"type": "ok", "requestId": req.get("requestId")})
        if self.session_runner is None:
            # No LLM wired (no api_key): the user's message still persists and
            # broadcasts, but there is nothing to run. Emit a paired turn:start +
            # turn:idle so a client's composing flag is always cleared — otherwise
            # the input would stay disabled forever.
            await self._broadcast({"type": "turn:start", "sessionId": sid})
            await self._broadcast({"type": "turn:idle", "sessionId": sid})
            return
        # Run the group turn as a background task so `cancel` can interrupt it.
        # The turn is cancellable via an asyncio.Event; orchestrator's
        # `is_current` callback observes it and stops between rounds too.
        await self._start_turn(sid, text)

    async def _start_turn(self, sid: str, text: str) -> None:
        """Launch the group-chat turn for a user message, tracking it for cancel."""
        # If a previous turn is still running, cancel it before starting a new one
        # (a user sending a new message supersedes the prior in-flight turn).
        if self._turn_task and not self._turn_task.done():
            self._turn_cancel and self._turn_cancel.set()
            self._turn_task.cancel()
        cancel_event = asyncio.Event()
        self._turn_cancel = cancel_event
        self._turn_session = sid

        async def is_current() -> bool:
            return not cancel_event.is_set()

        task = asyncio.create_task(self._run_turn(sid, text, is_current))
        self._turn_task = task
        await self._broadcast({"type": "turn:start", "sessionId": sid})
        try:
            await task
        except asyncio.CancelledError:
            # Cancelled via `cancel` request: emit a cancelled marker event.
            await self._broadcast({"type": "turn:cancelled", "sessionId": sid})
        except Exception as e:  # never crash the connection on a turn error
            await self._broadcast({"type": "error", "message": f"turn failed: {e}"})
        finally:
            await self._broadcast({"type": "turn:idle", "sessionId": sid})
            if self._turn_task is task:
                self._turn_task = None
                self._turn_session = None
                self._turn_cancel = None

    async def _run_turn(self, sid: str, text: str, is_current) -> None:
        """Persist + broadcast a group-chat turn (called inside a task)."""
        if self._turn_cancel:  # already cancelled before it ran
            return

        async def emit(msg: Message) -> None:
            # Stream a tool card as it happens, before the member's final text.
            await self._broadcast({"type": "message:new", "sessionId": sid, "message": msg.to_dict()})

        saved = await self.session_runner.handle_user_message(sid, text,
                                                              is_current=is_current,
                                                              emit=emit)
        for m in saved:
            await self._broadcast({"type": "message:new", "sessionId": sid, "message": m.to_dict()})

    async def _cancel(self, ws, req: dict) -> None:
        """Cancel the currently running group-chat turn (CONTRACT §3 `cancel`)."""
        if self._turn_task and not self._turn_task.done():
            if self._turn_cancel:
                self._turn_cancel.set()
            self._turn_task.cancel()
            await self._send(ws, {"type": "ok", "requestId": req.get("requestId")})
            return
        # Nothing running: idempotent ok.
        await self._send(ws, {"type": "ok", "requestId": req.get("requestId")})

    async def _switch_model(self, ws, req: dict) -> None:
        """Set the default model (CONTRACT §3 `switchModel`).

        Aligns with EMRG's ``set_model``: resolves the chosen name against
        ``[[llm.models]]`` for an optional API-model override, then records the
        runtime key (and context_window/vision) and forwards it to the session
        runner so subsequent turns use it. Not persisted — reverts on restart.
        """
        name = req.get("modelKey", "")
        if not name:
            await self._send(ws, {"type": "error", "requestId": req.get("requestId"),
                                  "message": "modelKey required"})
            return
        api_model: str = name
        new_ctx: int | None = None
        new_vision: bool | None = None
        cfg = self.llm_config
        models = (cfg.models if cfg else []) or []
        for m in models:
            if m.get("name") == name:
                api_model = m.get("model", name)
                new_ctx = m.get("context_window")
                if "vision" in m:
                    new_vision = m["vision"]
                break
        self.model_key = api_model
        if self.session_runner is not None:
            self.session_runner.set_model(api_model)
        await self._send(ws, {"type": "ok", "requestId": req.get("requestId")})
        await self._broadcast({
            "type": "model:changed", "model": name, "apiModel": api_model,
            "contextWindow": new_ctx,
        })

    async def _list_models(self, ws, req: dict) -> None:
        """List available models (CONTRACT §3 `listModels`).

        Merges the current default model (first) with any ``[[llm.models]]``
        entries, mirroring EMRG's ``list_models``. Only models a client may
        switch to are listed.
        """
        cfg = self.llm_config
        default_name = self.model_key or (cfg.model if cfg else "") or ""
        default_ctx = (cfg.context_window if cfg and cfg.context_window else None)
        models_config = (cfg.models if cfg else []) or []

        seen: set[str] = set()
        merged: list[dict] = []
        if default_name:
            merged.append({"name": default_name, "contextWindow": default_ctx})
            seen.add(default_name)
        for m in models_config:
            nm = m.get("name")
            if nm and nm not in seen:
                merged.append({
                    "name": nm,
                    "contextWindow": m.get("context_window"),
                    "vision": m.get("vision"),
                })
                seen.add(nm)

        await self._send(ws, {"type": "models", "models": merged, "current": default_name})

    # ---- model settings (write-back to config.toml) -----------------------
    async def _get_settings(self, ws) -> None:
        """Return the current LLM settings (for the settings model page)."""
        cfg = self.llm_config
        settings = {
            "apiKey": (cfg.api_key if cfg else ""),
            "baseUrl": (cfg.base_url if cfg else ""),
            "model": (cfg.model if cfg else ""),
            "currentModel": self.model_key,
            "modelDetails": [self._model_detail(m) for m in ((cfg.models if cfg else []) or [])],
        }
        await self._send(ws, {"type": "settings", "settings": settings})

    def _model_detail(self, m: dict) -> dict:
        detail = {"name": m.get("name") or "", "model": m.get("model", "") or "",
                  "contextWindow": m.get("context_window"),
                  "vision": m.get("vision", False)}
        if detail["model"] == detail["name"]:
            detail["model"] = ""
        return detail

    async def _save_settings(self, ws, req: dict) -> None:
        """Persist LLM settings back to config.toml (model add/edit/delete).

        Accepts ``{ apiKey?, baseUrl?, model?, modelDetails? }``. modelDetails is
        the full list of ``[[llm.models]]`` entries (add/edit/delete all expressed
        as re-writing this list). After saving, the daemon reloads its config and
        re-broadcasts the model list so clients reflect the change.
        """
        from seekd.config import save_llm_config
        cfg = self.llm_config
        if cfg is None:
            from seekd.config import LlmConfig
            cfg = LlmConfig()

        if "apiKey" in req:
            cfg.api_key = str(req["apiKey"] or "")
        if "baseUrl" in req:
            cfg.base_url = str(req["baseUrl"] or "")
        if "model" in req:
            cfg.model = str(req["model"] or "")
        if "modelDetails" in req:
            cfg.models = self._normalize_models(req["modelDetails"])
        if "contextWindow" in req and req["contextWindow"]:
            cfg.context_window = int(req["contextWindow"])

        save_llm_config(cfg)
        # Re-sync the daemon's runtime model key to the (possibly edited) default.
        self.llm_config = cfg
        if cfg.model:
            self.model_key = cfg.model
            if self.session_runner is not None:
                self.session_runner.set_model(cfg.model)
        await self._send(ws, {"type": "ok", "requestId": req.get("requestId")})
        await self._broadcast({"type": "model:changed", "model": cfg.model,
                               "apiModel": cfg.model, "contextWindow": cfg.context_window})

    def _normalize_models(self, raw: list) -> list[dict]:
        """Coerce modelDetails to `[[llm.models]]` entries (name required)."""
        out: list[dict] = []
        for item in raw or []:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or "").strip()
            if not name:
                continue
            entry: dict = {"name": name}
            model = str(item.get("model") or "").strip()
            if model and model != name:
                entry["model"] = model
            if item.get("contextWindow") is not None:
                entry["context_window"] = int(item["contextWindow"])
            if item.get("vision") is not None:
                entry["vision"] = bool(item["vision"])
            out.append(entry)
        return out

    # ---- scheduled tasks --------------------------------------------------
    async def _list_tasks(self, ws, req: dict) -> None:
        """List all scheduled tasks with schedule metadata + session info."""
        tasks = []
        for t in self.store.list_tasks():
            session = self.store.get_session(t.id)
            tasks.append({
                "id": t.id,
                "enabled": t.enabled,
                "interval": t.interval,
                "lastRun": t.last_run,
                "nextRun": t.next_run,
                "session": session.to_dict() if session else None,
                "roomId": session.room_id if session else None,
            })
        await self._send(ws, {"type": "tasks", "tasks": tasks})

    async def _trigger_task(self, ws, req: dict) -> None:
        """Manually trigger a scheduled task (CONTRACT §3 `triggerTask`).

        Reads the session workspace's fixed ``task_prompt.md``, substitutes
        ``{{ workspace }}``, injects it as a message, and runs a group turn.
        """
        sid = req.get("sessionId")
        session = self.store.get_session(sid) if sid else None
        if session is None:
            await self._send(ws, {"type": "error", "requestId": req.get("requestId"),
                                  "message": "session not found"})
            return
        prompt = self._read_task_prompt(session)
        if not prompt:
            await self._send(ws, {"type": "error", "requestId": req.get("requestId"),
                                  "message": "task_prompt.md not found in workspace"})
            return
        message = Message(id=new_id(), speaker="system", time=now_iso(),
                          kind="text", text=prompt)
        self.store.append_message(sid, message)
        await self._broadcast({"type": "message:new", "sessionId": sid, "message": message.to_dict()})
        self._update_task_after_run(sid)
        await self._start_turn(sid, prompt)
        await self._send(ws, {"type": "ok", "requestId": req.get("requestId")})

    def _workspace_dir(self, session: Session) -> Path:
        """Resolve a session's workspace directory (G4 default path fallback)."""
        ws = Path(session.workspace).expanduser() if session.workspace else None
        if ws is None:
            ws = Path.home() / ".seek/workspace/default"
        return ws

    def _read_task_prompt(self, session: Session) -> str:
        """Read the workspace's fixed ``task_prompt.md`` and substitute vars."""
        ws = self._workspace_dir(session)
        pf = ws / "task_prompt.md"
        if not pf.exists():
            return ""
        text = pf.read_text(encoding="utf-8")
        return text.replace("{{ workspace }}", str(ws))

    # ---- workspace files --------------------------------------------------
    async def _list_workspace_files(self, ws, req: dict) -> None:
        """List the *top-level* entries of a session's workspace directory.

        Only the workspace root is listed (no recursive descent): the product
        surfaces workspace files/dirs the user might add for model context.
        """
        sid = req.get("sessionId")
        session = self.store.get_session(sid) if sid else None
        if session is None:
            await self._send(ws, {"type": "error", "requestId": req.get("requestId"),
                                  "message": "session not found"})
            return
        root = self._workspace_dir(session).expanduser()
        files = []
        if root.exists() and root.is_dir():
            for p in sorted(root.iterdir()):
                if p.is_file():
                    try:
                        size = p.stat().st_size
                    except OSError:
                        size = 0
                    files.append({"name": p.name, "path": str(p),
                                  "size": size, "isDir": False})
                elif p.is_dir():
                    files.append({"name": p.name, "path": str(p),
                                  "size": None, "isDir": True})
        await self._send(ws, {"type": "workspaceFiles", "sessionId": sid, "files": files})

    async def _read_workspace_file(self, ws, req: dict) -> None:
        """Read a single file *inside* a session's workspace directory.

        Security: the resolved path must stay within the workspace root — a path
        traversal (``..``) or absolute path is rejected with an error.
        """
        sid = req.get("sessionId")
        name = req.get("name")
        session = self.store.get_session(sid) if sid else None
        if session is None:
            await self._send(ws, {"type": "error", "requestId": req.get("requestId"),
                                  "message": "session not found"})
            return
        if not name:
            await self._send(ws, {"type": "error", "requestId": req.get("requestId"),
                                  "message": "name required"})
            return
        root = self._workspace_dir(session).expanduser()
        target = (root / name).resolve()
        # Reject anything outside the workspace root (path traversal / absolute).
        try:
            inside = target.is_relative_to(root.resolve())
        except ValueError:
            inside = False
        if not inside or not target.exists() or not target.is_file():
            await self._send(ws, {"type": "error", "requestId": req.get("requestId"),
                                  "message": "file not found or outside workspace"})
            return
        try:
            content = target.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            content = None  # binary file; surface as an error downstream
        if content is None:
            await self._send(ws, {"type": "error", "requestId": req.get("requestId"),
                                  "message": "file is binary; cannot read as text"})
            return
        await self._send(ws, {"type": "workspaceFile", "sessionId": sid,
                              "name": target.name, "content": content})

    def _update_task_after_run(self, sid: str) -> None:
        """Mark a task as run and schedule its next run."""
        t = self.store.get_task(sid)
        if t is None:
            # No task record yet: don't auto-create; a task is explicit.
            return
        t.last_run = now_iso()
        t.next_run = self._next_run_iso(t.interval)
        t.enabled = True
        self.store.save_task(t)

    @staticmethod
    def _next_run_iso(interval: int) -> str:
        from datetime import timedelta
        return (datetime.now(timezone.utc) + timedelta(seconds=interval)).isoformat()

    # ---- scheduler loop ---------------------------------------------------
    async def _scheduler_loop(self) -> None:
        """Background loop: fire enabled tasks whose ``next_run`` has elapsed."""
        try:
            while True:
                await self._check_tasks()
                await asyncio.sleep(5)
        except asyncio.CancelledError:
            pass

    async def _check_tasks(self) -> None:
        now = datetime.now(timezone.utc)
        for t in self.store.list_tasks():
            if not t.enabled or not t.next_run:
                continue
            try:
                due = datetime.fromisoformat(t.next_run)
            except ValueError:
                continue
            if due <= now:
                session = self.store.get_session(t.id)
                if session is None:
                    continue
                prompt = self._read_task_prompt(session)
                if not prompt:
                    continue
                message = Message(id=new_id(), speaker="system", time=now_iso(),
                                  kind="text", text=prompt)
                self.store.append_message(t.id, message)
                await self._broadcast({"type": "message:new", "sessionId": t.id, "message": message.to_dict()})
                self._update_task_after_run(t.id)
                # If not currently running a turn, kick one off.
                if self._turn_task is None or self._turn_task.done():
                    await self._start_turn(t.id, prompt)

    async def _broadcast(self, payload: dict) -> None:
        data = json.dumps(payload, ensure_ascii=False)
        for client in list(self.clients):
            try:
                await client.send(data)
            except Exception as e:  # noqa: BLE001
                log.warning("broadcast failed, dropping client: %s", e)
                self.clients.discard(client)

    async def _send(self, ws, payload: dict) -> None:
        await ws.send(json.dumps(payload, ensure_ascii=False))

    async def run(self) -> None:
        """Start the WebSocket listener and the WEBUI static server."""
        log.info("seekd starting: ws://%s:%d webui_dist=%s",
                 self.host, self.port, self.webui_server.dist)
        self.webui_server.start()
        log.info("webui server: %s", self.webui_server.url() or "(not started)")
        self._scheduler_task = asyncio.create_task(self._scheduler_loop())
        async with websockets.serve(self._handle, self.host, self.port):
            log.info("websocket listener up on %s:%d", self.host, self.port)
            stop = asyncio.Event()
            loop = asyncio.get_running_loop()
            try:
                for sig in (signal.SIGINT, signal.SIGTERM):
                    loop.add_signal_handler(sig, stop.set)
            except (NotImplementedError, ValueError, RuntimeError):
                # Not on the main thread or non-POSIX: rely on KeyboardInterrupt.
                pass
            await stop.wait()
            log.info("seekd shutting down")
            self._scheduler_task.cancel()
