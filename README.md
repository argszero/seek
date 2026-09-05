# seek

**seek is an AI-native instant messaging (IM) application.**
Open it and you are talking with a group of beings that have faces, personalities, get work done, and chat with each other.

[![CI](https://github.com/argszero/seek/actions/workflows/test.yml/badge.svg)](https://github.com/argszero/seek/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Python](https://img.shields.io/badge/Python-3.13-blue.svg)](backend/)
[![TypeScript](https://img.shields.io/badge/TypeScript-React-blue.svg)](webui/)

It is not a "development tool with a chat box" — it is a "chat application with an AI soul": the mental model of QQ, with the engine of DeepSeek.

> I Seek You — the original spirit of IM. Typed like ICQ, shaped like the characters you know.

> **Language**: English is the primary language for all user-facing documentation and the protocol contract. Chinese translations may be added alongside.


## What is seek?

- **Not 1:1, only group chat.** Every room is a group. Members (real people and virtual AI characters) are first-class, undifferentiated participants.
- **Rooms are containers.** A room is where a group of characters chat. A room runs many sessions over time. Each session is one conversation, bound to a workspace (the stage where the work happens).
- **Roles are characters.** A **Character** is a social identity — name, face, persona, way of speaking. It may be bound to an **Agent** (tools + memory) that does the actual work. You, the human, are a character too: pure speaking, no agent.
- **Speaking and doing are both messages.** When a character runs a tool, it shows up as a foldable tool card in the message stream — like a friend sending you a screenshot, not a separate "workbench".

## The mental model (three layers)

```
World   (you + the beings you know)     — who is here, who to talk to
Rooms   (a room = a group chat)          — where the conversation happens
Messages (one "who said what" at a time) — the message stream
```

Every message has a speaker, a time, and a shape (text / image / tool card / system). Speaking and doing are both folded into messages.

## Architecture

seek is a monorepo — three frontends talk to one backend over a WebSocket protocol. No frontend imports backend code; they communicate purely through the protocol contract.

```
seek/
├── backend/     # Python daemon (seekd) — the only backend. WebSocket IPC + group-chat orchestration + agent + embedded WEBUI static server
├── tui/         # TUI client (Python curses) — independent; can be replaced by Rust later over the same protocol
├── webui/       # WEBUI client (React + TypeScript + Vite) — runs in the browser
├── gui/         # GUI client (Electron) — a shell that loads webui/dist
├── packaging/   # Installers (Inno Setup .exe / macOS .pkg) + stop_all
└── docs/        # Design documents
```

The protocol contract lives in [`CONTRACT.md`](CONTRACT.md) — the authoritative definition of the WebSocket message format that every client must align to.

## Status

Seek is in early development. The scaffold, product mental model, and architecture decisions are settled, and the core loop is working end to end. See the [changelog](CHANGELOG.md) for history and the [design docs](docs/designs/) for the full product mental model and entity relations.

## Installation

Installers are built for Windows and macOS and published with each GitHub release. The installer stops any running seek processes before replacing files, so upgrades never fail due to locked files.

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, conventions, and the checks to run before opening a pull request. Everyone is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

If you believe you have found a vulnerability, please see [SECURITY.md](SECURITY.md) and report it **privately**. Do not open a public issue for security problems.

## License

[MIT](LICENSE) — © 2026 argszero
