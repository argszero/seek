# Contributing to seek

## Language

**English is the project language** for everything that leaves the repository: issues, pull requests, commit messages, code comments and identifiers. A quotation from another language is carried in English with its source named.

**Every document ships in both English and Chinese, and the two are kept in step.** The convention is a suffix beside the original, never a parallel tree:

```
README.md            README.zh-CN.md
docs/decisions.md    docs/decisions.zh-CN.md
```

**Both halves are the document.** When they disagree, that is a defect in the pair and is fixed at once, not a hierarchy where one wins by default. So a change to an English file is not finished until its Chinese twin is changed in the same commit; a pull request that updates one and not the other is incomplete.

One thing this convention does not cover: **`LICENSE`** keeps its English text only — a translated licence is not the licence, and only the canonical wording has legal standing.

## What to contribute right now

The design is settled and the kernel is being written. **`src/README.md` is the build order** — the checklist there is the one place that says what comes next, so a contribution that follows it needs no argument about scope.

- **Code, against a line of that checklist.** Say which line you are taking before you start, so two people do not build the same piece.
- **Arguments with the design, still.** Settled is not the same as unchangeable: `docs/host-rulings.md` is the base and it changes when the host says so. Show the case, or the line of code, that breaks — and name the section you are answering.
- **How comparable products do it** (Feishu, Slack, Discord, grok-bot, Google ADK) — as evidence for a decision, not as a wish list.

## What not to do

- **Do not write behaviour the documents do not state.** Every rule comes from `docs/host-rulings.md`, `docs/decisions.md` or `docs/design/`. Where they are silent, the table of defaults in `docs/decisions.md` records the choice that was made and the word that would change it; where even that is silent, ask before building it. A rule invented in code is the one thing here that has to be undone later.
- **Do not refactor `prototype/`.** It is an archive of the previous version, kept to show what a Feishu-style layout looks like. It is not the starting point: its data model is single-user and incompatible with this one.

## Rules

1. **Settle the data model before the interface.** Everything visible on screen must map to an entity. If it does not, the design has a hole.
2. **The host's rulings are the base** (`docs/host-rulings.md`): what he decided, stated as it stands, carrying no dates and no superseded entries. Everything else answers to it.
3. **`docs/decisions.md` holds what the rulings do not**: the facts checked outside this repository, what the design had to derive from a ruling, and every number the host left open. A default is listed as a default, with the word that would change it — never dressed up as a ruling.
4. **A document holds the result, not the process.** What a rule used to be, what it was changed into and why do not appear; the git log carries that.
5. **Say it plainly.** Avoid invented jargon; if a new term is unavoidable, define it the first time it appears.

## Code stage

- **Node + Electron, local-only, no server.** Data stays on the machine. No part of the interface is written yet: the kernel runs on plain Node, and its tests do not need Electron.
- **No dependencies at all** — no runtime dependency and no dev dependency, so a clone runs without an install step. The code is TypeScript, which Node strips itself, so there is no build step and no bundler. A pull request that wants to add a dependency should say what the runtime already cannot do.
- **Tests run through Node's own runner**: `npm test`, which is `node --test "src/**/*.test.ts"`. Behaviour that matters gets a test, and a test is worth having only if it fails when the behaviour is wrong.
- **Commit messages in English**: what changed and why, in one line if possible.
- **One pull request does one thing.**
- **The first milestone is kernel only** — a bot and its agent, the inbox, a gate and one room, with no interface. What is being tested is whether "it says something on its own" holds up, not how it looks.

## License

**MIT**, see `LICENSE`. By contributing you agree to publish your contribution under the same license.

The prototype's visual styling draws on the Feishu desktop look; the boundaries are set out in `NOTICE.md`. Read that first if your contribution involves interface assets.
