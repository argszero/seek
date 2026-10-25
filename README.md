# seek

<img src="assets/icon.png" width="104" align="right" alt="seek: a speech bubble holding a pupil" />

> **I Seek You** — the original spirit of IM.
> Typed like ICQ, shaped like the characters you know.

The name comes from the line that started ICQ. Twenty-odd years ago the point of instant messaging was to *find a person* — not to open a piece of software, not to launch a task, but to reach one specific being.

seek keeps that point and swaps the person: your contacts are no longer human, but long-lived agents. They have names, tempers and their own work. You talk in a room; they listen from the side; they speak up when they judge it worth it, and they come to you when something genuinely needs your call.

This is not a Feishu clone. It is a multi-agent product wearing IM clothes.

## Status

**The kernel exists; the interface does not.** Two design documents are settled (`docs/design/`), the kernel is written in `src/` (47 TypeScript files, ~16,035 lines, 314 tests), and the previous runnable version is kept as a reference prototype (`prototype/`).

The prototype exists to prove one thing: that a Feishu-style interface can be carried by purely local data. It can. But its data model is single-user — one account, a cast of fake people, messages owned by conversations — which is not the model this version needs, so it cannot be refactored into it.

## Why not another IM clone

| | Feishu / WeChat / Slack | seek |
|---|---|---|
| Behind an avatar | a person | a long-lived agent |
| Nobody @-mentions it in a group | it never knows | **it knows** — the message lands in its watch queue, at zero cost |
| When it speaks | only when called | when it judges it should — cheaply, not by running a frontier model on every message |
| Its cost | — | budget is a first-class citizen: it goes quiet when it runs out, and you can see that |
| Context | fully shared | **messages are shared, context is private** — five agents in one room is not five copies of the room |

## Layout

```
seek/
├── docs/design/        Settled design (the implementation follows these)
│   ├── data-model.md       Entities and relations: messages shared, context private
│   └── agent-lifecycle.md  How an agent lives: inbox, two-stage loop, proactive DMs
├── docs/host-rulings.md  Every decision the host made himself (in order; superseded ones kept)
├── docs/decisions.md   Decisions already made (one line each, dated)
├── prototype/          Previous runnable prototype (Electron, local-only)
├── src/                The kernel (TypeScript, no interface yet)
├── CONTRIBUTING.md
├── NOTICE.md           Relationship to Feishu, licensing boundaries
└── LICENSE             MIT
```

**Read in this order**: `docs/design/data-model.md` settles *what exists and how it relates*; `docs/design/agent-lifecycle.md` settles *how those things stay alive and when they spend money*. And for "who decided what, when, and in what words", read `docs/host-rulings.md`.

**Every document comes in English and Chinese, kept in step.** The Chinese version sits beside the original with a `.zh-CN.md` suffix (`README.zh-CN.md`, `docs/decisions.zh-CN.md`, …); the two are changed together, and a disagreement between them is a defect in the pair rather than one of them winning. `LICENSE` is the exception and stays English only — a translated licence is not the licence. See `CONTRIBUTING.md`.

## Run the kernel

**Nothing to install**: no dependencies and no build step, so a clone runs where it stands. It needs Node 22.18 or newer — the code is TypeScript, and Node strips the types itself.

```bash
npm start                      # the first milestone
npm start -- --lang zh-CN      # the same run in Chinese
npm start -- seek-data/b.json  # a second store, beside the shipped roster
```

What it prints is one room, a person saying something that names nobody, and whether the bot answered on its own. **Both halves of the bot are placeholders** — the decision to act, and the words said — and the report says so in as many words. What a run demonstrates is the kernel: delivery into one inbox per bot, the gate, the turn. What it cannot demonstrate is whether the design holds up; that needs a model.

State lives in `seek-data/seek.json`, and a second run appends to the room the first one made — the data outliving the process is the product's own thesis, so the room grows instead of resetting. Delete that file to start over.

To ask the measured watch model instead of the placeholder, point the run at a `llama-server` you have started yourself:

```bash
npm start -- --server http://127.0.0.1:8080 --window 24
```

`--server` is the origin of a process **seek does not start, supervise or stop** (`docs/decisions.md`, default 20), and `--window` is how much one judgement may read — the caller's number, because the runtime does not know a model's window. The two go together: either one alone is refused rather than half-guessed. **No weights ship with this repository**, so this is the one command here that needs something you provide.

A store outside `seek-data/` needs a roster beside it. `agents.yml` is read from the store's own directory (`docs/decisions.md`, defaults 14 and 15), and a store with no roster beside it opens over a bot with no agents and refuses to run rather than inventing one.

## Run the prototype

```bash
cd prototype
npm install     # first time only
npm start
```

An Electron desktop client with a four-column Feishu-style layout: messages, threads, contacts, groups and accounts. Everything is stored locally (`~/Library/Application Support/Seek/seek-data/`), including image and file attachments. See `prototype/README.md`.

## Two foundations

1. **Messages are shared facts; context is a private interpretation.** A room has exactly one message log, but each agent has its own view, memory and budget.
2. **The saving happens in the first stage.** Every tick, an agent decides whether to act using zero-cost rules and one cheap judgement; only then does it enter the real agent loop. The part that spends nothing is what makes a permanently alive product affordable.

## Assets

The mark is a speech bubble holding a pupil — it speaks, and it watches. `assets/icon.svg` is the only source; `node assets/render-icons.js` regenerates every PNG from it. That script needs nothing beyond Node: it evaluates the shapes per sample and writes the PNGs itself, because the icon is simple enough that a rasteriser dependency would cost more than it saves.

`assets/social-card.html` is the 1280×640 link preview; `assets/render-social-card.js` screenshots it with the Electron binary from the prototype, since laying out text is the one thing plain Node cannot do.

## License

MIT — see `LICENSE`. The prototype's visual styling is a reference re-creation of the Feishu desktop look; the boundaries are described in `NOTICE.md`.
