# Contributing to seek

## Language

**English is the project language** for everything that leaves the repository: issues, pull requests, commit messages, code comments and identifiers. A quotation from another language is carried in English with its source named.

**Every document ships in both English and Chinese, and the two are kept in step** (ruled 2026-10-24). The convention is a suffix beside the original, never a parallel tree:

```
README.md            README.zh-CN.md
docs/decisions.md    docs/decisions.zh-CN.md
```

**Both halves are the document.** When they disagree, that is a defect in the pair and is fixed at once, not a hierarchy where one wins by default. So a change to an English file is not finished until its Chinese twin is changed in the same commit; a pull request that updates one and not the other is incomplete.

Two things this convention does not cover: **`LICENSE`** keeps its English text only — a translated licence is not the licence, and only the canonical wording has legal standing — and **dated reviews** (`docs/reviews/`) are records of what was believed on that date, so their translations are snapshots and are not rewritten when the design moves on.

## What to contribute right now

The project is in the **design stage**. There is no implementation yet, so the most valuable contribution is **arguing with the design**, not writing code.

- Point out where the two design documents contradict each other.
- Show where a decision breaks a real usage scenario.
- Bring in how comparable products do it (Feishu, Slack, Discord, grok-bot, Google ADK) and why.

When opening an issue, name the section in `docs/design/` you are responding to.

## What not to do at this stage

- **Do not start writing the implementation in `src/`.** The design is not finished; code written first will take the design hostage.
- **Do not refactor `prototype/`.** It is an archive of the previous version, kept to show what a Feishu-style layout looks like. It is not the starting point: its data model is single-user and incompatible with this one.

## Rules for the design stage

1. **Settle the data model before the interface.** Everything visible on screen must map to an entity. If it does not, the design has a hole.
2. **Every decision goes into `docs/decisions.md`**, one line each, dated. Overturning an older decision requires saying why the earlier reasoning no longer holds.
3. **Write "not decided yet" instead of papering over uncertainty with a default.** A default becomes a fact nobody remembers choosing.
4. **Say it plainly.** Avoid invented jargon; if a new term is unavoidable, define it the first time it appears.

## Code stage (later)

- Node + Electron, local-only, no server.
- Commit messages in English: what changed and why, in one line if possible.
- One pull request does one thing.

## License

**MIT**, see `LICENSE`. By contributing you agree to publish your contribution under the same license.

The prototype's visual styling draws on the Feishu desktop look; the boundaries are set out in `NOTICE.md`. Read that first if your contribution involves interface assets.
