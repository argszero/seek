# seek Protocol Contract

This document is the **authoritative specification** of the wire protocol between the seek backend daemon (`seekd`) and every client (TUI / GUI / WEBUI).

**Law of the contract**: clients and backend communicate **exclusively** over this protocol. No client may `import` backend code, and the backend may not `import` client code. Each side implements its own representation of the structures below and aligns behavior to this document.

Transport: **WebSocket**, JSON-encoded messages.

---

## 1. Message Envelope

Every message is a JSON object with a `type` discriminator:

```json
{ "type": "<message-type>", ...fields }
```

Messages from client → backend are requests; backend → client are responses or events.

---

## 2. Core Entities

### Character

```json
{
  "id": "uuid",
  "kind": "human" | "virtual",
  "name": "string",
  "persona": "string",
  "avatar": { "type": "letter", "text": "string", "bg": "#hex", "fg": "#hex" } | { "type": "image", "src": "string" },
  "agentId": "uuid | null",
  "speakStrategy": { "maxPerTurn": 2, "allowPass": true, "maxLen": 8000 },
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601"
}
```

- `kind: "human"` — a real person; speaks only, never binds an agent.
- `kind: "virtual"` — a local AI; may bind an agent to do work.

### Room

```json
{
  "id": "uuid",
  "name": "string",
  "description": "string",
  "memberIds": ["uuid"],
  "createdAt": "ISO-8601"
}
```

A room is a group chat. Members are undifferentiated (no 1:1 / single-kinds). A room runs many sessions.

### Session

```json
{
  "id": "uuid",
  "roomId": "uuid",
  "name": "string",
  "workspace": "string",
  "messages": [Message],
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601"
}
```

A session is one conversation inside a room, bound to a workspace. The workspace is chosen at creation and locked for the session's lifetime.

### Message

```json
{
  "id": "uuid",
  "speaker": "uuid | 'system'",
  "time": "ISO-8601",
  "kind": "text" | "tool" | "image" | "system",
  "text": "string",
  // tool kind only:
  "cmd": "string",
  "status": "success" | "fail" | "running",
  "ms": "string",
  "output": "string"
}
```

### Task (scheduled task)

```json
{
  "id": "uuid",
  "enabled": true,
  "interval": 86400,
  "lastRun": "ISO-8601",
  "nextRun": "ISO-8601",
  "session": Session | null,
  "roomId": "uuid | null"
}
```

A task is an ordinary session with a `schedule` attached. On fire, the daemon reads the session workspace's fixed `task_prompt.md`, substitutes `{{ workspace }}`, and injects it as a message into the session. On the wire (`listTasks`), it also carries the resolved `session` and `roomId`.

### Model

```json
{
  "name": "deepseek-v4-flash",
  "contextWindow": 1024000,
  "vision": true
}
```

A model a client may switch to. `listModels` returns the merged single-endpoint list: the current default model first, then any `[[llm.models]]` entries. `switchModel` is not persisted — it reverts on restart (mirrors EMRG).

---

## 3. Client → Backend Requests

Requests carry a `requestId` the client generates (so a client can identify its own echoed turns).

| `type` | Purpose | Fields |
|---|---|---|
| `ping` | Liveness | `{}` |
| `init` | Get initial world state | `{}` |
| `listRooms` | List rooms | `{}` |
| `listCharacters` | List characters | `{}` |
| `listSessions` | List sessions (optionally by room) | `{ roomId? }` |
| `createSession` | Create a session in a room | `{ roomId, name?, workspace }` |
| `createRoom` | Create a group room; name optional (auto-generated from members) | `{ name?, memberIds?, description? }` |
| `createCharacter` | Create a virtual character (kind fixed `virtual`) | `{ name, persona?, avatar? }` |
| `addRoomMember` | Add an existing character to a room | `{ roomId, characterId }` |
| `removeRoomMember` | Remove a character from a room | `{ roomId, characterId }` |
| `openSession` | Open an existing session | `{ sessionId }` |
| `sendMessage` | User sends a message into a session | `{ sessionId, text, requestId }` |
| `renameSession` | Rename a session | `{ sessionId, title }` |
| `clearSession` | Clear a session history | `{ sessionId }` |
| `switchModel` | Set the default model | `{ modelKey }` |
| `listModels` | List available models | `{}` |
| `getSettings` | Read current LLM settings (for settings page) | `{}` |
| `saveSettings` | Persist LLM settings back to config.toml | `{ apiKey?, baseUrl?, model?, modelDetails? }` |
| `listTasks` | List scheduled tasks | `{}` |
| `triggerTask` | Manually trigger a task | `{ sessionId }` |
| `listWorkspaceFiles` | List a session's workspace dir (top-level) | `{ sessionId }` |
| `readWorkspaceFile` | Read a file inside a session's workspace | `{ sessionId, name }` |
| `cancel` | Cancel the current running turn | `{}` |

---

## 4. Backend → Client Responses / Events

| `type` | Purpose | Fields |
|---|---|---|
| `pong` | Liveness reply | `{}` |
| `world:init` | Full world state snapshot | `{ characters, rooms, sessions, activeSessionId, model }` |
| `session:messages` | Session message stream (snapshot or delta) | `{ sessionId, messages, appendOnly }` |
| `message:new` | A new message appended to a session | `{ sessionId, message }` |
| `turn:start` | A group-chat turn begins | `{ sessionId }` |
| `turn:cancelled` | The running group-chat turn was cancelled | `{ sessionId }` |
| `turn:idle` | A group-chat turn ended | `{ sessionId }` |
| `tasks` | Scheduled tasks list (with schedule + session info) | `{ tasks: Task[] }` |
| `workspaceFiles` | A session's workspace directory listing | `{ sessionId, files: [{ name, path, size, isDir }] }` |
| `workspaceFile` | A file's text content read from the workspace | `{ sessionId, name, content }` |
| `models` | Available models list (current first) | `{ models: Model[], current }` |
| `settings` | Current LLM settings (settings page) | `{ settings: { apiKey, baseUrl, model, currentModel, modelDetails } }` |
| `model:changed` | The default model was switched | `{ model, apiModel, contextWindow }` |
| `session:created` | A session was created (including renames) | `{ session }` |
| `room:created` | A room was created | `{ room }` |
| `room:updated` | A room changed (members added) | `{ room }` |
| `character:created` | A character was created | `{ character }` |
| `session:renamed` | A session was renamed | `{ sessionId, title }` |
| `session:cleared` | A session was cleared | `{ sessionId }` |
| `error` | Request failed | `{ requestId?, message }` |

Note: tool work is surfaced as **regular `message:new` events with `kind:"tool"`** (fields `cmd`/`status`/`ms`/`output`), streamed live during a turn — there are no separate `tool:*` events. Member "speaking" state is derived client-side from turn/stream lifecycles (D2), so no `member:*` events are emitted.

**First-run bootstrap**: on an empty store, the daemon seeds a minimal world so the app is usable immediately — a built-in human `you` (id `"you"`, `kind:"human"`), one default room containing `you`, and one default session in that room bound to the default workspace (`~/.seek/workspace/default`). Seeding is idempotent: it runs once (when there are no characters) and never clobbers an existing world.

---

## 5. Group-Chat Orchestration

When a user sends a message into a session, the backend runs one bounded round-robin turn:

- **`resolveResponders`** — scan backward from the last user message for `@mentions`; the mentioned members respond, or everyone if none are mentioned (or `@everyone` / `@all`).
- **`orderRoundSpeakers`** — rotate the starting member each round: `offset = round % len(memberIds)`.
- **`runOneTurn`** — each member gets a turn: build a system prompt + turn prompt, run the member's agent (may emit tool cards), filter `(pass)`, keep at most `GROUP_MAX_MESSAGES_PER_TURN` (2) messages.
- **`(pass)`** — a member declines to speak; the orchestrator filters it out.
- Bounds: `GROUP_MAX_ROUNDS = 3`, `GROUP_MAX_MEMBER_TURNS = 10`, `GROUP_MAX_MESSAGES_PER_TURN = 2`.

The orchestration is epoch-cancellable — if the user switches away, the turn stops.
