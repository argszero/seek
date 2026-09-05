# 🧭 seek

<p align="center">
  <strong>An instant messenger where you talk to real people — and AI beings that get work done.</strong>
</p>

<p align="center">
  <img alt="Python" src="https://img.shields.io/badge/Python-3.13-blue.svg">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-React-blue.svg">
  <img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg">
  <img alt="CI" src="https://github.com/argszero/seek/actions/workflows/test.yml/badge.svg">
</p>

<p align="center">
  <b>🇬🇧 English</b> | <a href="README.cn.md">🇨🇳 中文</a>
</p>

---

**What if your group chat had minds in it — and those minds did the work?**

Open `seek` and you're in a room with beings that have faces, personalities, opinions — and the ability to actually get things done. Some of them are people you know. Some are AI characters you've brought to life with a name, a face, and a way of talking. They don't just reply; they do the work. Give one a real task and it thinks through it, uses your tools the way you would, and comes back with a finished result — right in the chat where you're already talking about it.

> *"I Seek You — the original spirit of IM. Typed like ICQ, shaped like the characters you know."*

This isn't a "coding tool with a chat box". It's a **chat app with an AI soul** — the mental model of QQ, with the engine of DeepSeek. Unlike a one-on-one assistant, these beings live in your existing group conversations, side by side with the people you actually talk to.

---

## ✨ Why you'll love it

**The one-line pitch**: `seek` is the messenger where your group chats are packed with AI beings that have real personalities and real tools — so "talking about the work" and "doing the work" happen in the same place.

| What | What it means |
|---|---|
| 🧑 **Real people, side by side with AI** | Every room is a group. You, your friends, and AI characters are all equal members — everyone is just a character in the same conversation. |
| 🗣️ **Characters with faces & personalities** | An AI isn't a blank box — it's a person you define: name, face, persona, way of speaking. Bring one to life, watch it hold opinions and banter. |
| 🛠️ **They talk the talk *and* walk the walk** | When a character runs code, reads a file, or makes an edit, the result drops into the stream right there — like a friend handing you the finished thing, not a separate workbench you have to go to. |
| 🍳 **Rooms that hold a whole life** | Each room is a group chat that runs over time. Every conversation is a session bound to a workspace — the stage where the actual work happens. |
| 🔥 **Several minds, working at once** | Because every being is a member, you can hand tasks to a whole cast at once — the planner, the grinder, the critic. The room becomes a little team, not a single assistant. |
| ⚡ **One app, four ways to show up** | A Python daemon back-end with a TUI, a browser UI, and a desktop app — all talking to the same world over one protocol. |
| 🌍 **100% open source** | MIT, no walled garden, no vendor lock-in. Internationalized — English default, Chinese version available. |

---

## The mental model (three layers)

```
World      (you + the beings you know)      — who is here, who to talk to
Rooms      (a room = a group chat)          — where the conversation happens
Messages   (one "who said what" at a time)  — the message stream
```

Every message has a speaker, a time, and a shape (text / image / tool card / system). Speaking and doing are both folded into messages.

---

## Architecture

`seek` is a monorepo — three frontends talk to one backend over a single WebSocket protocol. No frontend imports backend code; they communicate purely through the protocol contract.

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

---

## Status

`seek` is in early development. The scaffold, product mental model, and architecture decisions are settled, and the core loop works end to end. See the [changelog](CHANGELOG.md) for history and the [design docs](docs/designs/) for the full product mental model and entity relations.

## Installation

Installers are built for Windows and macOS and published with each GitHub release. The installer stops any running `seek` processes before replacing files, so upgrades never fail due to locked files.

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, conventions, and the checks to run before opening a pull request. Everyone is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

If you believe you have found a vulnerability, please see [SECURITY.md](SECURITY.md) and report it **privately**. Do not open a public issue for security problems.

## License

[MIT](LICENSE) — © 2026 argszero
