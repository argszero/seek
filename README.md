# seek

<img src="assets/icon.png" width="104" align="right" alt="seek: a speech bubble holding a pupil" />

> **I Seek You** — the original spirit of IM.
> Typed like ICQ, shaped like the characters you know.

The name comes from the line that started ICQ. Twenty-odd years ago the point of instant messaging was to *find a person* — not to open a piece of software, not to launch a task, but to reach one specific being.

seek keeps that point and swaps the person: your contacts are no longer human, but long-lived agents. They have names, tempers and their own work. You talk in a room; they listen from the side; they speak up when they judge it worth it, and they come to you when something genuinely needs your call.

This is not a Feishu clone. It is a multi-agent product wearing IM clothes.

## Status

**The kernel exists; the interface has begun.** Three design documents are settled (`docs/design/`), the kernel is written in `src/` (47 TypeScript files, ~16,568 lines, 320 tests), and the previous runnable version is kept as a reference prototype (`prototype/`). The interface is a separate package under `ui/` — Electron running the kernel in its main process, with a React renderer — and it is at its fifth slice: it builds into a downloadable macOS app (`docs/decisions.md`, default 26), and on a fresh install it makes the world it opens on — one room, its bot and the roster beside it (`docs/decisions.md`, default 25) — and from then on it reads a room, its members and its messages out of the kernel, draws them, and takes what you type. A message goes in through the kernel's own `deliver()`, the bot in the room is woken by the entry it received, and it answers. That answer is the kernel's stub line, not a model's: nothing in `ui/` is wired to a model server yet. A thread is the kernel's own record, not a second conversation: a reply goes in through the same `deliver()` with the message it answers named, and the panel shows the chain the store already holds.

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

## Install the app

The first downloadable build is **`v0.1.0`**: macOS on Apple silicon, and **unsigned**. Take `Seek-0.1.0-arm64-mac.zip` from the [releases page](https://github.com/argszero/seek/releases), unzip it, and drag `Seek.app` into `Applications`.

**macOS will object the first time, because nothing here is signed.** The bundle carries no signature and no notarisation — there is no signing identity behind this project — so Gatekeeper refuses it. Either right-click `Seek.app` and choose **Open**, or clear the flag the browser set:

```bash
xattr -dr com.apple.quarantine /Applications/Seek.app
```

**What is inside the download, and what is not.** The kernel is *in* the app, not beside it: `Contents/Resources/src/` holds the same 47 TypeScript files this repository does, and `Contents/Resources/app.asar` holds the built page and the main process (`docs/decisions.md`, default 26). **No model and no weights ship in it**, so the bot still answers with the kernel's own placeholder line, exactly as `npm start` does; pointing the app at a `llama-server` you started yourself is the model-wiring slice, and it is not in this build. A first launch makes its world the same way the run below does — one room, its bot, and the roster beside the store — and the room's `created_at` is the kernel's seed constant rather than the moment you installed it, which nothing draws yet.

The app keeps its data under Electron's own user-data directory for the app, and `SEEK_DATA_DIR` moves it elsewhere.

## Run the interface

```bash
cd ui
npm install     # first time only
npm run build
npm start
```

An Electron window over the same kernel: pick a room, type, press Enter, and the bot in that room answers. The answer is the kernel's own placeholder — `stubDecide` and `stubJudge` in `src/main.ts` — because no model is wired to the interface yet; the two options `ui/electron/host.js` hands to `Kernel` are exactly where a model arrives. Under every message there is `reply in thread`: the panel that opens is the chain the store already records, and a reply posted there is the same call with the message it answers named. The bot's answer to a threaded reply lands in the room rather than in the panel, because the stub agent says its line without naming what it answers — an agent that answers into a thread belongs to the model-wiring slice. The first launch has no store yet, so it makes one: the kernel's own seeded room, a bot called Echo, and an `agents.yml` beside the store holding the two agents that bot speaks through — so the window opens on something you can talk in rather than on an empty list, and the file is there to edit afterwards. It opens `seek-data/seek.json` under Electron's own user-data directory, and `SEEK_DATA_DIR` points it elsewhere — which is how to open the repository's `seek-data/`, roster and all. `npm run dist:mac` builds the app this repository publishes: electron-builder packs the page and the main process into an unsigned arm64 bundle under `ui/release/` (`docs/decisions.md`, default 26).

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
