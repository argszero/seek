# Decisions

One line each, dated. What is written here is **not casually overturned** — overturning it requires explaining why the earlier reasoning no longer holds.

## Naming and license

- **The name comes from ICQ's original line: I Seek You.** Seeking *a person* is the point of IM — not opening a tool. seek keeps that point and only swaps the person for a long-lived agent. Tagline: *Typed like ICQ, shaped like the characters you know.*
- **License: MIT.**
- **English is the project language** — issues, pull requests, commits, comments and documents. Translations may exist as references but are never authoritative; a stale translation is deleted, not maintained.
- **The product is international from the first screen**: no user-visible string in code; content is never machine-translated behind the user's back; an agent's language belongs to its persona, not to a global setting. Details in `docs/design/i18n.md`.

## Rooms and time

- **Rooms are not classified by headcount.** There is no "1:1" or "direct message" type: a room with two people and a room with fifty behave identically. A branch on headcount in the code means the model is broken.
- **A room is not a session.** The room is the container (persistent, membership changes); a session is one stretch of work inside it (its own timeline, bound to one workspace).
- **A workspace is bound to the session**, fixed once chosen; changing it means starting a new session.
- **A thread is a message tree, not a new room.** Everyone in a thread is already in the room; no re-inviting. Feishu-style, not Slack/Discord-style.

## Agents

- **seek is a multi-agent product.** Behind each avatar is an agent, not a person. The IM shell is only a shell.
- **An agent is long-lived, observes on its own, and acts on its own.** Those are the three differences from an ordinary agent.
- **One path, one loop.** Every message is delivered into the inbox at zero cost; the loop's gate then decides. A direct message, an @-mention or a reply to its own message is not a second road — it is a **fast-pass inside the gate**, skipping the paid judgement because there is nothing to judge. Two roads would let the same message be answered twice; one road has nothing to reconcile.
- **Three ways to decide not to act**: ignore, defer (re-queue with a condition), or keep silent but remember. The third is "present but not interrupting".
- **An agent may open a direct message to you**, with no quota, cooldown or quiet-hours rule. A seek agent *is* an EMRG agent: **its whole constraint is a prompt and a sandbox.** Restraint about interrupting you belongs in how the persona is written, not in a gate beside it. (Earlier drafts of this rule carried a card of invented limits — a five-case whitelist, a four-case blacklist, three a day, thirty minutes apart, silence 22:00–08:00. All of it was the implementer's, none of it was decided; withdrawn 2026-10-23.)
- **An agent does not ask permission before acting** (ruled 2026-10-23). It edits files, runs commands and sends messages without stopping for approval — a per-action dialog would turn an IM into a ticket queue. What holds instead is the sandbox, a complete audit trail (every action is a `Turn`), and a stop that works (you can always see it and end it). Asking *"may I?"* is gone; asking *"which one?"* remains — needing a decision is a conversation, not a permission.
- **Messages are shared; context is private.** Five agents in one room means one message log and five private interpretations.
- **A member is a projection of an agent into a room, not the agent itself.** An agent belongs to no room; rooms are only where it appears.
- **An agent runs one action at a time.** When several rooms want it to speak at once, they queue — for identity consistency, not for performance.
- **An agent may address another agent** (approved 2026-10-23). Finding another agent is a normal part of work. But **an agent never opens a conversation with another agent**: a chain of agent turns always has a root, and the root is a human message or a scheduled tick. Proactive outreach (§10) is to humans only.
- **Every room has at least one human member.** There is no room the user cannot open. This is not a permission rule but a visibility one: whatever an agent does on your behalf, you can read, and stop. Together with the root rule it removes the one unbounded case — two agents alone in a room where each @-mention exempts them from the anti-loop rules and nobody is present to notice.
- **An agent-to-agent chain is bounded by depth, not by money.** Every message carries the message that caused it, so the depth is read off the data rather than kept in a counter someone has to restore. At the cap the agent escalates or stops — it never silently drops the question. There is no chain budget: the depth cap exists to stop a loop, not a bill, and it is the only numeric limit in the design.

## Interaction

- **The interaction is Feishu's, and the model serves it — not the other way round.** Where a design question has two answers, the one that is visible in Feishu wins; a concept that Feishu does not show the user does not appear on screen here either, however useful it is internally.
- **The left list shows rooms, not sessions.** They are chats. (Closes an item that had been open since 18:42.)
- **A session is an agent's private stretch of work in a room, never a user-visible unit.** One room's timeline is continuous; five agents in it have five private spans over one shared log. A workspace change surfaces at most as a system message. This is not a display preference: it is what makes "messages shared, context private" true by construction.

## Not decided yet

- Whether a session keeps a member snapshot from when it started.
