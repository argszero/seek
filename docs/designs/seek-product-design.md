# seek Product & Entity Design

**seek** is an AI-native instant-messaging (IM) application. Open it and you are
talking with a group of beings that have faces, personalities, get work done,
and chat with each other.

It is not a "development tool with a chat box" — it is a "chat application with an
AI soul": the mental model of QQ, with the engine of DeepSeek.

> I Seek You — the original spirit of IM. Typed like ICQ, shaped like the
> characters you know.

This document describes the product mental model and the entity relations that
drive the code. The wire protocol (what clients speak to the daemon) is the
authority in [`CONTRACT.md`](../../CONTRACT.md).

---

## 1. The mental model (three layers)

```
World      (you + the beings you know)      — who is here, who to talk to
Rooms      (a room = a group chat)          — where the conversation happens
Messages   (one "who said what" at a time)  — the message stream
```

- **Not 1:1, only group chat.** Every room is a group. Members (real people and
  virtual AI characters) are first-class, undifferentiated participants.
- **Rooms are containers.** A room is where a group of characters chat. A room
  runs many sessions over time. Each session is one conversation, bound to a
  workspace (the stage where the work happens).

## 2. Entities

### Character — a social identity

A **Character** is a social identity: name, face, persona, way of speaking. It
may be bound to an **Agent** (tools + memory) that does the actual work.

- `kind: "human"` — a real person; speaks only, never binds an agent.
- `kind: "virtual"` — a local AI; may bind an agent to do work.

### Room — a group chat

A room is a group chat. Members are undifferentiated — there is no 1:1 / single
kind. A room runs many sessions.

### Session — one conversation

A session is one conversation inside a room, bound to a workspace. The workspace
is chosen at creation and locked for the session's lifetime.

### Workspace — the stage

A workspace is the filesystem stage where the work happens. The daemon reads the
workspace's fixed `task_prompt.md` for scheduled tasks.

### Message — "who said what"

Every message has a speaker, a time, and a shape (`text` / `tool` / `image` /
`system`). Speaking and doing are both folded into messages.

## 3. Speaking and doing are both messages

When a character runs a tool, it shows up as a foldable tool card in the message
stream — like a friend sending you a screenshot, not a separate "workbench".

```json
{
  "id": "uuid",
  "speaker": "uuid | 'system'",
  "time": "ISO-8601",
  "kind": "text" | "tool" | "image" | "system",
  "text": "string",
  "cmd": "string",     // tool kind only
  "status": "success" | "fail" | "running",
  "ms": "string",
  "output": "string"
}
```

## 4. Group-chat orchestration

When a user sends a message into a session, the backend runs one **bounded
round-robin turn**:

- Mentioned members respond via `@mention`; everyone responds if none are
  mentioned (or `@everyone` / `@all`).
- The starting member rotates each round (`offset = round % len(members)`).
- Each member gets a turn: build a prompt, run the agent (may emit tool cards),
  filter `(pass)`, keep at most `GROUP_MAX_MESSAGES_PER_TURN` (2) messages.
- Bounds: `GROUP_MAX_ROUNDS = 3`, `GROUP_MAX_MEMBER_TURNS = 10`,
  `GROUP_MAX_MESSAGES_PER_TURN = 2`.

## 5. Role status (D2)

A character's status (`thinking` / `typing` / `busy` / `idle`) is **derived
client-side from stream/tool lifecycle signals** — no dedicated daemon events.
See [`CONTRACT.md`](../../CONTRACT.md) §4 for the lifecycle events a client uses
to drive this.

## 6. Frontends

seek is a monorepo: **three frontends talk to one backend over a WebSocket
protocol**. No frontend imports backend code; they communicate purely through the
protocol contract.

- `backend/` — Python daemon (`seekd`): the only backend. WebSocket IPC +
  group-chat orchestration + agent + embedded WEBUI static server.
- `tui/` — curses terminal client (independent; can be swapped for Rust later
  over the same protocol).
- `webui/` — React + TypeScript + Vite (browser).
- `gui/` — Electron shell that loads `webui/dist` and bridges to the daemon.
