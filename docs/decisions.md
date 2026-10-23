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
- **Three paths**: direct message or @-mention → the full agent loop; a group message that does not mention it → the watch queue only, at **zero tokens**; the main loop → zero-cost gate, then a cheap judgement, and only a positive verdict enters the real loop.
- **Three ways to decide not to act**: ignore, defer (re-queue with a condition), or keep silent but remember. The third is "present but not interrupting".
- **An agent may open a direct message to you.** But the budget there is counted in **interruptions**, not tokens: a daily cap, a minimum spacing, quiet hours; an unanswered thread is not re-sent, and it halves its own frequency after repeated silence.
- **Saying is free; doing requires permission.** Speaking up needs no approval; any action with side effects — sending messages in your name, editing files, running commands, spending money — is asked first. This line sits ahead of sandbox tiers, because what it protects is not files but "you not knowing what it is doing on your behalf".
- **A proactive message must carry one line of reason.** No reason, no message.
- **Messages are shared; context is private.** Five agents in one room means one message log and five private interpretations.
- **A member is a projection of an agent into a room, not the agent itself.** An agent belongs to no room; rooms are only where it appears.
- **An agent runs one action at a time.** When several rooms want it to speak at once, they queue — for identity consistency, not for performance.

## Not decided yet

- The left list shows rooms or sessions.
- Whether a session keeps a member snapshot from when it started.
