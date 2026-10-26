# seek

<img src="assets/icon.png" width="104" align="right" alt="seek: a speech bubble holding a pupil" />

> **I Seek You** — the original spirit of IM.
> Typed like ICQ, shaped like the characters you know.

The name comes from the line that started ICQ. Twenty-odd years ago the point of instant messaging was to *find a person* — not to open a piece of software, not to launch a task, but to reach one specific being.

seek keeps that point and swaps the person: your contacts are no longer human, but long-lived agents. They have names, tempers and their own work. You talk in a room; they listen from the side; they speak up when they judge it worth it, and they come to you when something genuinely needs your call.

This is not a Feishu clone. It is a multi-agent product wearing IM clothes.

## Status

**The kernel exists; the interface has begun.** Three design documents are settled (`docs/design/`), the kernel is written in `src/` (53 TypeScript files, ~18,987 lines, 357 tests), and the previous runnable version is kept as a reference prototype (`prototype/`). The interface is a separate package under `ui/` — Electron running the kernel in its main process, with a React renderer — and it runs: it builds into a downloadable macOS app (`docs/decisions.md`, default 26), and on a fresh install it makes the world it opens on — one room, its bot and the roster beside it (`docs/decisions.md`, default 25) — and from then on it reads a room, its members and its messages out of the kernel, draws them, and takes what you type. The window writes as well, and only through the kernel: the `+` beside the room list makes a room — a name, and who starts in it — through the kernel's own `createRoom()`, and the member count in a room's header opens the list that puts one more person in through `addMember()`, each refusal drawn beside the form in the kernel's own words. A message names the people it addresses, Feishu's `mentions[]` being the only form of *who was named* the store keeps, and the window draws them under the text. A picture goes further than a name: chosen from a file rather than typed, its bytes are written beside the store and the message carries only a `{key, mime}` reference to them — present exactly when the message is an image — so what a room with pictures in it is, is a store plus a directory of files, never one file with the bytes inlined. A message goes in through the kernel's own `deliver()`, the bot in the room is woken by the entry it received, and it answers. Whether it answers is a model's judgement and what it says is a model's words, each half bound separately to a `llama-server` — the one you name, or the one the download carries, which a launch that names nothing starts over weights it fetches; a half with no server behind it is the kernel's own placeholder, and the window says which half is on which. A thread is the kernel's own record, not a second conversation: a reply goes in through the same `deliver()` with the message it answers named, and the panel shows the chain the store already holds.

The prototype exists to prove one thing: that a Feishu-style interface can be carried by purely local data. It can. But its data model is single-user — one account, a cast of fake people, messages owned by conversations — which is not the model this version needs, so it cannot be refactored into it.

## Why not another IM clone

| | Feishu / WeChat / Slack | seek |
|---|---|---|
| Behind an avatar | a person | a long-lived agent |
| Nobody @-mentions it in a group | it never knows | **it knows** — the message lands in its watch queue, at zero cost |
| When it speaks | only when called | when it judges it should — cheaply, not by running a frontier model on every message |
| Its cost | — | **recorded, never capped** — a turn carries the tokens it read and wrote, and the window shows them; nothing goes quiet because it spent |
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

A store outside `seek-data/` needs a roster beside it. `agents.yml` is read from the store's own directory every time the store is opened, and the store's agents are rebuilt from it (`docs/decisions.md`, defaults 14 and 15). **Two states are not one.** A store with no roster file beside it keeps the agents it already has — a missing file says nothing about the store, so an install whose roster was deleted goes on answering with the workers it had — while a roster that is present and holds no rows is the one that says this bot has no agents. Editing the file is how a bot is given a different set of workers; deleting it is not. What refuses is `npm start`: a run whose bot has no watch agent and no work agent stops and says so, rather than inventing one.

## Install the app

The [releases page](https://github.com/argszero/seek/releases) carries the current build in two shapes: `Seek-<version>-arm64-mac.pkg`, which installs `Seek.app` into `Applications`, and `Seek-<version>-arm64-mac.zip`, the same bundle to unzip and drag. It is macOS on Apple silicon. Releases **up to `v0.1.1`** were built unsigned; a build cut from this tree is signed with a `Developer ID` certificate and notarized by Apple, which is what the rest of this section is about.

**An installer is built from now on, beside that zip.** `npm run dist:pkg` in `ui/` cuts `ui/release/Seek-<version>-arm64-mac.pkg` out of the same bundle with macOS's own `pkgbuild` (`packaging/make-pkg.mjs`), and installing it puts `Seek.app` in `Applications` without the drag. It is a `.pkg` rather than a `.dmg` because electron-builder's `dmg` target ends in `hdiutil create`, which the environment this repository is developed in refuses outright (`the operation is not permitted`), while `pkgbuild` is not refused — the same reason the neighbouring EMRG project ships its macOS download as a `.pkg`. And a release should not be something one machine has to be able to build: pushing a `v*` tag runs that same `npm run dist:pkg` on a macOS runner (`.github/workflows/release.yml`) and attaches both the `.pkg` and the `.zip` to the release.

**A build from this tree installs and opens without an argument.** `release.yml` imports two certificates from repository secrets into a keychain that exists for one run: `Developer ID Application` signs the bundle, `Developer ID Installer` signs the package (`packaging/make-pkg.mjs` calls `productsign` and then reads the chain back with `pkgutil --check-signature`), and `packaging/notarize.mjs` submits the package to Apple with an App Store Connect API key, waits for the verdict, staples the ticket to the file, and has Apple read that ticket back out of it. The last two of those go to Apple, so a network failure there is retried rather than believed: a ticket already written does not stop existing because a host is unreachable, so the final re-read reports an unreachable Apple as a warning, and only a package that really carries no ticket fails the release. The two certificates are not interchangeable — an installer and a bundle are assessed by two different parts of the system, and `productsign` refuses an Application certificate outright. On a laptop the **installer** identity is the one that decides whether the package is signed, and `npm run dist:pkg` without it still builds, says the package is unsigned, and skips `productsign` instead of failing. The **bundle** is not gated that way: electron-builder signs it with an identity it finds in the keychain by itself, so a machine holding any certificate — a development one is enough — produces a signed bundle, and `CSC_IDENTITY_AUTO_DISCOVERY=false` is how that machine asks for an unsigned one instead. The release never depends on discovery: `CSC_LINK` names the certificate the runner uses.

**Releases up to `v0.1.1` will object, because nothing up to there is signed.** Those downloads carry no signature and no notarisation, so Gatekeeper refuses them. The two shapes are refused at different moments, and the `.pkg` first: it is assessed when it is opened, before there is any `Seek.app` to right-click, so the fix that belongs to the installed app cannot be followed by a reader who chose the installer. Measured on the published `v0.1.1` `.pkg`: `pkgutil --check-signature` answers `no signature`, and `spctl -a -t install` answers `rejected` for `no usable signature`. What follows is what those releases need.

The `.pkg` asks you to clear the flag on **the file you downloaded**, and then to open it again — or, in the hour after the refusal, to take **Open Anyway** in System Settings → Privacy & Security:

```bash
xattr -d com.apple.quarantine ~/Downloads/Seek-<version>-arm64-mac.pkg
```

The `.zip` asks for the app: unzip, drag `Seek.app` into `Applications`, then right-click it and choose **Open** — or clear the flag on the installed bundle:

```bash
xattr -dr com.apple.quarantine /Applications/Seek.app
```

**Signing leaves one asymmetry inside a signed release.** The ticket Apple issues is stapled to the installer, and a `.zip` is not something a ticket can be stapled into: the app inside it is signed by the same certificate but carries no ticket of its own, so whether its first launch passes depends on that machine reaching Apple. The `.pkg` is the shape that needs nothing.

**What is inside the download, and what is not.** The kernel is *in* the app, not beside it: `Contents/Resources/src/` holds this repository’s own kernel (26 TypeScript files at `v0.1.3`, which is every source file that is not a test), and `Contents/Resources/app.asar` holds the built page and the main process (`docs/decisions.md`, default 26). **It carries the model server, but not the model.** `Contents/Resources/server/` holds `llama-server` — 18,692,864 bytes, tracked in this repository rather than fetched at build time — and a launch that names no server starts it over the two weight files a first run fetches, so naming a `llama-server` is no longer required; a name you do give still wins. What no package carries is the weights themselves, which arrive on that first launch, so a first launch with no network stays on the kernel's own placeholder line until they do. **No published release has the server yet**: `ui/resources/server/` is empty in every tag up to `v0.1.3`, and only a build cut from this tree carries it. **Which of those two halves a download reaches depends on when it was cut.** Releases **up to** `v0.1.0` were cut before the two halves were wired, so those carry only the placeholders. `v0.1.1` and `v0.1.2` wire both halves in their code and still carry no artifact either half reads — `prompts/` and `i18n/` are in neither package — so naming a server on one of those is refused in the kernel's own words rather than answered. `v0.1.3` is the first download that carries them, and anything built from this tree does too, through the variables the section below names. A first launch makes its world the same way the run below does — one room, its bot, and the roster beside the store — and the room's `created_at` is the kernel's seed constant rather than the moment you installed it, which nothing draws yet.

The app keeps its data under Electron's own user-data directory for the app, and `SEEK_DATA_DIR` moves it elsewhere.

## Run the interface

```bash
cd ui
npm install     # first time only
npm run build
npm start
```

For work on the page itself there is `npm run dev`: Vite serves `index.html` with hot reload, and with `SEEK_UI_DEV_URL` set to that server's address — `http://localhost:5173`, the port Vite listens on when `ui/vite.config.mjs` names none — the window loads the served page instead of the built one, so an edit arrives without a `npm run build` in between.

An Electron window over the same kernel: pick a room, or make one — the `+` beside the list takes a name and ticks who starts in it, and `Create` hands it to the kernel's `createRoom()`, whose refusal of an empty room lands beside the form in the kernel's own words; the member count in a room's header opens the list of who is in it, with `Add` beside everyone who is not, and that button is `addMember()` in the kernel. Then type, and press Enter, and the bot in that room answers. Naming someone is a choice about the message rather than characters in it: the `@` beside the box opens the people in the room, works with the box still empty, and stays chosen as the words are typed. The message stores the people it named, the window draws them under the text, and each bot finds its own id in that list — so naming a bot is how a message addresses it. That is a fast pass **inside** the judgement's first stage and not a second road past it: the judgement notices the `@` and lets the message through (`docs/host-rulings.md`). A picture is chosen rather than typed: the `Picture` button beside the box opens a file dialog and sends what you pick, with whatever is in the box as its caption — and the box may be empty, since a caption is optional where a text message is not. The bytes are written to a file beside the store **before** the message that names them is posted, because `deliver()` refuses an `image` whose reference points at nothing; the message itself carries one `{key, mime}` reference and never the bytes, present exactly when its `kind` is `image`, since the store rewrites its shards whole on every save and an inlined picture would be re-serialised by every unrelated turn (`docs/decisions.md`, default 17). The window draws it back from that reference alone, so a store moved without its `media/` directory says the picture is missing rather than drawing an empty one. What it will send is a closed set — `png`, `jpeg`, `gif`, `webp` — read off the extension, because a file dialog hands back a name with no type on it; a file it cannot type is a sentence in the composer rather than a guess, and a dialog you close is nothing to draw. **Whether it answers** is stage 1, and it is a real model as soon as a server is in use — yours, or the one the app starts when you name none: set `SEEK_SERVER` to a running `llama-server` and `SEEK_WINDOW` to how much one judgement may read, and the verdict comes from the watch model — bound over that server by the kernel's own `watch-server.ts`, against the question `src/prompts/watch-v1.json` declares — so the bot speaks when it judges it should rather than on every message. With neither set the app starts the `llama-server` it carries, over the weights a first run fetched, and binds both halves to that one origin; the judgement is the kernel's placeholder only where no server is in use — a named one that was refused, or a download that did not finish — and a strip at the top of the window says which of the two you are looking at. **What it says** is stage 2, and it is a second server: point `SEEK_WORK_SERVER` at another `llama-server` and the reply is the model's own words, made through the `say` call `src/prompts/work-v1.json` gives it — so the roster's **work** row has to name the model that server serves, since a server serves one model and the two rows may name two (`docs/decisions.md`, default 24). Left unset, and with the app's own server running, the words come from that same origin; `stubDecide`'s line from `src/main.ts` is what you get where no server is in use at all. The two halves take their own origins on purpose, and `SEEK_WINDOW` stays with `SEEK_SERVER` because it is how much one *judgement* may read, while a turn's prompt is re-checked per turn against the work server's own window. Both strips refuse on their own, so a store whose watch row is served and whose work row is not opens, answers in the placeholder, and says both things at once. A server you named and the app did not use (unreachable, serving another model, or given without its pair) does not stop the window opening: the strip names it and says why, in the error colour, because the store is local and its messages do not depend on that server (`docs/decisions.md`, default 27). Under every message there is `reply in thread`: the panel that opens is the chain the store already records, and a reply posted there is the same call with the message it answers named. The placeholder's answer to a threaded reply lands in the room rather than in the panel, because `stubDecide` says its line without naming what it answers; a model's answer is linked to the message that woke it, so it is drawn in the panel. The first launch has no store yet, so it makes one: the kernel's own seeded room, a bot called Echo, and an `agents.yml` beside the store holding the two agents that bot speaks through — so the window opens on something you can talk in rather than on an empty list, and the file is there to edit afterwards. It opens `seek-data/seek.json` under Electron's own user-data directory, and `SEEK_DATA_DIR` points it elsewhere — which is how to open the repository's `seek-data/`, roster and all. `npm run dist:mac` builds the app this repository publishes: electron-builder packs the page and the main process into an arm64 bundle under `ui/release/`, signed with the `Developer ID Application` identity on a machine that has one and left unsigned on a machine that does not (`docs/decisions.md`, default 26).

**A launch that finds no weights fetches them, and says how far it has got.** The app carries the model server but not the model: `LiquidAI/LFM2.5-VL-3B-GGUF` is fetched into `~/Library/Application Support/Seek/weights/` on the first launch, both files, 2.1 GB, with the two strips above the room showing `1.2 GB of 2.2 GB — <file>` while it runs. A download that stops leaves what arrived in `<name>.part` and the next attempt continues from there, so a lid closed halfway costs the rest of the file rather than the whole of it. `SEEK_WEIGHTS_BASE` points a launch at a mirror instead of the canonical `https://huggingface.co` — a network that cannot reach it needs that, and a variable set to nothing is refused rather than silently replaced by the default. Offline, or short of bytes, the strips say so in the same standing line they use for a server that was not used, and launching again is the retry.

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
