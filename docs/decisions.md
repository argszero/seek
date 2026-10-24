# Decisions the implementer made

`host-rulings.md` is the base: it holds what the host decided, and this file answers to it. Nothing here may contradict a ruling, and **a ruling always wins** — where the two meet, this file changes.

What is written here is two kinds of thing:

- **Derived** — a consequence the design had to draw from a ruling, where the ruling itself does not spell it out. It is not a second ruling; it is the only shape the ruling could take.
- **Default** — a number or a choice the host left open. Every default is listed with the single word that would change it.

Nothing here carries a date, and nothing records what it used to say. The git log holds that.

---

## Facts checked outside this repository

- **Feishu's chat modes.** `chat_mode` has three values — 群组 / 话题 / 单聊 (`group` / `topic` / `p2p`) — and **a direct chat is a chat**: it has its own `chat_id` beginning `oc_`, and `chat_mode` reads `p2p` when queried. So "a direct message is a room with two people" is how Feishu stores it, not an invention of ours. Two things follow. ①**The field exists; the domain logic still must not branch on it** — the entity is a Room either way, and Feishu's own behaviours (you cannot invite into a p2p, you cannot leave one) are properties of the surface, not reasons to split the model. ②**Feishu's `p2p` is bot-to-user only**, so a direct room between two bots has no counterpart to imitate; it is settled by a ruling instead.
- **Feishu's message fields.** `mentions[]` on a message carries the principals it names, `{id, name}` each. Id prefixes: `ou_` principal, `oc_` room, `om_` message. seek adds `ag_` for agents.

## Derived from a ruling

- **A room's timeline is continuous, so a session can never be a user-visible unit.** The interaction is Feishu's: one chat, one timeline. A session is the agent's private bookkeeping, and a workspace change surfaces at most as a system message — a message kind Feishu already has — never as a list entry, a divider or a second timeline.
- **The left list shows rooms, not sessions.** They are chats, and a session is not a chat.
- **A thread is a message tree, not a sub-room.** Everyone in it is already in the room, so nothing is re-invited and no second membership exists to keep true.
- **A member is a bot's projection into one room, not an agent.** An agent belongs to no room; the room is where its bot appears. This is what lets one contact be in three rooms while each agent keeps one continuous thread per room.
- **One inbox removes the reconciliation problem, and that is why an agent can stay small.** With a queue per agent, every message is delivered N times, each agent keeps its own "already handled" state, and the loop reconciles N of them. With one queue per bot, delivery is one write, the tick is one loop, and stage 0 decides once.
- **No agent scans a room for its own name.** "@ me" is answered by the bot, once, at delivery. The watch agent could not answer it at all, being unaddressable — and that is what keeps stage 0's fast-pass a rule rather than a model call.
- **"Was I addressed" is derived per bot, never stored on the message.** A per-reader boolean on a shared immutable fact would force a rewrite or a copy per bot in the room.
- **A chain's depth is read off the data, never kept in a counter.** A counter has to be restored after a crash, and the one time it is restored wrong is the one time it matters.
- **A guard that has to be maintained by a policy layer is a defect in the persona.** A quota, a cooldown or a quiet-hours rule beside the agent would be exactly the standing governance the design refuses; where a bot talks too much, the persona is rewritten.
- **Cost is recorded, never enforced.** A bill that climbs is a persona or gate defect, visible in the numbers, fixed at its cause. There is no self-stop, because a self-stop hides the defect instead of showing it.
- **The reason a reminder is not displayed.** Feishu parity governs how a bot reaches other principals; a reminder reaches nobody, so there is no second party to show it to. What the user sees is what the bot does about it.
- **The schedule cannot be a timer.** It is one table in the process plus a comparator, so nothing is paid per bot and no model is called to discover that nothing is due. A row coming due *is* a delivery, so the wake rule — a delivery and nothing else starts a tick — is untouched.
- **Two agents, not one agent asked twice.** The two windows differ by an order of magnitude and compaction is destructive, so one shared log would mean the small model compacted first and deleted detail the large one can still read. Two stores, each compacted against its own window, removes the collision instead of managing it.
- **The identity is pushed down, never copied.** One copy of the name, avatar and description lives on the bot, and every agent of it is told, at run time, who it is and which agents it has. A second copy is a second thing that can disagree.
- **A stage-2 turn is an ordinary turn.** Nothing extra is written for having been proactive: what differs is only that it opens knowing nobody called it.
- **The delta is derived, never stored.** The judgement's box is a summary plus the observations after the point that summary consumed up to, and that second part is read off the inbox rather than copied into a second log. One copy of every observation means nothing to reconcile when one of them is edited, deleted or re-delivered.
- **Compaction is single-flight and commits atomically.** Two compactions over one room would each rewrite the summary from a state the other has already moved past, and whichever finished last would delete the difference — silently. One at a time, with the new summary and its consumed-to point written in a single operation, is what makes "an arrival during compaction is never lost" true rather than hoped for.
- **The state handed to a decision model is structured JSON, not prose.** Its contract is a state that may be any JSON value plus named questions. A paragraph would spend the model's small window on prose and throw away the signals that cost nothing to compute.
- **The previous verdict is input as a fact, never as an instruction.** How long ago it was and what it was, so a `keep` can be looked at again. An instruction to repeat it would make every stale decision self-perpetuating.
- **Memory writes and compaction are runtime behaviour, not tools.** An agent does not choose to do them; the runtime does them when a turn ends.

## Defaults the host left open

Each row is a choice the host did not rule on, listed with the word that changes it.

| # | Question | Default | Why this one | Changed by |
|---|---|---|---|---|
| 1 | How deep one agent-to-agent chain may run | **4 hops** | Long enough for a real hand-off and a reply; short enough that a misunderstanding cannot travel far. Read off the message data, so it survives a restart | "deeper" / "shallower" / a number |
| 2 | How many bot turns one room may take in a row | **3** | The bound that actually stops a burst — depth alone does not, since a burst of short exchanges uses few hops. Held on the Room, because no single agent can see how many times its peers just spoke | a number |
| 3 | When the judgement's box is compacted | **when the delta crosses a line** — a number of observations, or an age, whichever comes first; the numbers are settled by measurement | A judgement reads a delta, so the delta is what has to stay bounded. Compacting on arrival instead would put a generation against the very GPU the verdict needs, and the gate would be slowest exactly when the room is busiest | a number, or "compact on every message" |
| 4 | Whether a session snapshots its members | **No snapshot** | Whoever wrote a message is on the message, so a snapshot would only answer "who was here when this stretch began" — a second fact about membership that goes stale silently, for a private span that has no use for it | "snapshot it" |
| 5 | Whether the watch agent can be @-mentioned | **No** | An @-mention addresses a contact in a room. The watch agent is not a member and has no face; an "@ to me" is answered by the bot | "make it addressable" |
| 6 | Where a watch agent's turn is recorded | **Its own history only** | Writing it into the work agent's history would put it in the work agent's context every turn, which contradicts "read on demand, never injected" | "keep it in both" |
| 7 | The licence | **MIT** | The host delegated it | "Apache-2.0" / another |
| 8 | What the left list shows | **Rooms** | Feishu's left list is a list of chats | — (a derivation, kept here for the one question it first answered) |

## What is not decided here

Anything in `host-rulings.md`. If a line in this file and a line there ever disagree, this file is wrong and gets rewritten — that is the whole point of keeping them apart.
