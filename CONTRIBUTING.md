# Contributing to seek

## Language

**English is the project language.** Issues, pull requests, commit messages, code comments, identifiers and all documents in this repository are written in English, whatever language the discussion happened in. A quotation from another language is carried in English with its source named.

Translations of design documents may live under `docs/design/zh-CN/`. They are references, never the source of truth: when they disagree with the English text, the English text wins, and a stale translation may be deleted rather than maintained.

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
