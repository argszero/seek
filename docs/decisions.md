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
- **The bundled watch model, measured on a laptop.** Sizes as downloaded: `LFM2.5-VL-3B` Q4_0 **1.52 GB** plus its vision projector Q8 **0.56 GB**; `LFM2.5-VL-450M` Q4_K_M **219 MB**; `Qwen3.5-0.8B` Q4_K_M **508 MB**. Quality on act-or-not, across 76 hand-written cases in three disjoint sets: **3B 0.96–1.00 AUC** (100% on the last 24), **450M 0.48–0.74**, **0.8B 0.48–0.85**. Per message: 3B **96 ms**, 450M **18 ms**, 0.8B **71 ms**. A 3B model re-reading a full box costs ≈**1 ms per token**.

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
- **Two agents, not one agent asked twice.** The two windows differ by an order of magnitude and compaction is destructive, so one shared log would mean the smaller window compacted first and deleted detail the larger one can still read. Each agent keeps its own store, and the one thing they share — a room's standing summary — is written only by the agent that can write and read by the one that cannot. A second writer is what would put the collision back.
- **Compaction is a runtime action, not a turn.** It says nothing, so it is not a proactive turn, it does not open a stretch of work, and no judgement asked for it. A busy room that never needs a word said still has to be compactable, and that is only possible if compaction does not require a turn.
- **The judgement is never asked whether to compact.** The question is arithmetic over entries, tokens, images and minutes, which the runtime answers for free. A model that could request a compaction could request one on every tick, and the one component whose purpose is to stop spending would become the one that spends without a bound.
- **A box handed to a judgement always fits.** Newest observations first, up to the model's window, with the unread count carried along. A judgement that cannot fit its input would be guessing while looking like it judged; a visible unread count is a worse answer that is at least labelled as one.
- **The summary is written by the half that can write.** A decision model emits a choice, a score or a probability and no text, so the standing summary belongs to the work agent. That is also why the box is one per (bot, room) rather than one per agent: two writers of one summary is a disagreement waiting to happen, and only one of them can write at all.
- **The identity is pushed down, never copied.** One copy of the name, avatar and description lives on the bot, and every agent of it is told, at run time, who it is and which agents it has. A second copy is a second thing that can disagree.
- **A stage-2 turn is an ordinary turn.** Nothing extra is written for having been proactive: what differs is only that it opens knowing nobody called it. It may also end having said nothing, because speaking is a tool call like any other.
- **Nothing reaches a room except through the speaking tool.** A turn's output is its own record: not posted, not streamed, not summarised into the room. Two things follow and both are wanted. A bot cannot speak by accident — every message in a room was addressed there on purpose, which is what makes the proactive mark meaningful. And silence is the default rather than a failure, which is what lets "it forwarded this and nothing was said" be read off the record instead of inferred.
- **The transcript is not the delivery channel.** If a turn's text were what the room showed, the same words would land in every room the agent was thinking about, and "which room did it mean" would be a question asked after the fact. A room is named by the sender or the message is not sent.
- **The delta is derived, never stored.** The judgement's box is a summary plus the observations after the point that summary consumed up to, and that second part is read off the inbox rather than copied into a second log. One copy of every observation means nothing to reconcile when one of them is edited, deleted or re-delivered.
- **Compaction is single-flight and commits atomically.** Two compactions over one room would each rewrite the summary from a state the other has already moved past, and whichever finished last would delete the difference — silently. One at a time, with the new summary and its consumed-to point written in a single operation, is what makes "an arrival during compaction is never lost" true rather than hoped for.
- **The state handed to a decision model is structured JSON, not prose.** Its contract is a state that may be any JSON value plus named questions. A paragraph would spend the model's small window on prose and throw away the signals that cost nothing to compute.
- **The previous verdict is input as a fact, never as an instruction.** How long ago it was and what it was, so a `keep` can be looked at again. An instruction to repeat it would make every stale decision self-perpetuating.
- **Memory writes and compaction are runtime behaviour, not tools.** An agent does not choose to do them; the runtime does them when a turn ends.
- **The judgement is binary; the other two verdicts are the loop's to write.** A decision model that answers by reading the probabilities of declared options can only return an option it was given, so the question is act-or-not and nothing wider — four-way was measured at chance on every model tried, including the one that ships. `later` is what the loop writes when a turn schedules a reminder, and `keep` is what it writes when the room is already in flight. This is the same division the compaction question already had: the model answers, the loop performs and records.
- **The question put to the watch model is part of the contract.** Measured, one model's discrimination moved from 0.09 to 0.77 on the same cases purely by rewording, and inverted between English and Chinese. A prompt is therefore something the runtime carries as a fixed, versioned artifact that the operating point was calibrated against — not a string composed at the call site, where a well-meant edit would silently move the threshold.
- **The operating point comes from a labelled set, and the box carries the unread count.** A small model's usable cut sits far from even (0.6 to 0.98 measured), so 0.5 is not a default worth having; and a verdict reached on part of a room is stored with how much of it was read, because a silently partial judgement is indistinguishable from a whole one afterwards.

## Defaults the host left open

Each row is a choice the host did not rule on, listed with the word that changes it.

| # | Question | Default | Why this one | Changed by |
|---|---|---|---|---|
| 1 | How deep one agent-to-agent chain may run | **4 hops** | Long enough for a real hand-off and a reply; short enough that a misunderstanding cannot travel far. Read off the message data, so it survives a restart | "deeper" / "shallower" / a number |
| 2 | How many bot turns one room may take in a row | **3** | The bound that actually stops a burst — depth alone does not, since a burst of short exchanges uses few hops. Held on the Room, because no single agent can see how many times its peers just spoke | a number |
| 3 | When the judgement's box is compacted | **when the delta crosses a line** — a number of observations, or an age, whichever comes first; the numbers are settled by measurement | A judgement reads a delta, so the delta is what has to stay bounded. Compacting on arrival instead would put a generation against the very GPU the verdict needs, and the gate would be slowest exactly when the room is busiest | a number, or "compact on every message" |
| 4 | Whether a session snapshots its members | **No snapshot** | Whoever wrote a message is on the message, so a snapshot would only answer "who was here when this stretch began" — a second fact about membership that goes stale silently, for a private span that has no use for it | "snapshot it" |
| 5 | Whether the watch agent can be @-mentioned | **No** | An @-mention addresses a contact in a room. The watch agent is not a member and has no face; an "@ to me" is answered by the bot | "make it addressable" |
| 6 | Where a verdict is recorded | **On the observation entry it judged**, and nowhere else | Writing it into the work agent's history would put it in the work agent's context every turn, which contradicts "read on demand, never injected". The watch side keeps no history of its own to record it in | "keep it in both" |
| 7 | The licence | **MIT** | The host delegated it | "Apache-2.0" / another |
| 8 | What the left list shows | **Rooms** | Feishu's left list is a list of chats | — (a derivation, kept here for the one question it first answered) |
| 9 | What the speaking tool is called | **`say`, as `say(room, text)`** | It is the register's bare-single-word style (`read` / `write` / `edit` / `glob`), and it cannot be mistaken for the tools it sits beside: not `write`, which is files, and not `post`, which is a Feishu message type and would read as the format rather than the act. `reply` is wrong because most of what it sends is not a reply, and `message` collides with the entity | a different name, settled before the first prompt is written |
| 10 | Which checkpoint of the 3B class ships, and whether the vision projector ships with it | **`LFM2.5-VL-3B` Q4_0 for the text path; the projector ships only once vision is measured** | The text path is the one the gate's correctness rests on and the one that was measured; shipping 0.56 GB of projector for a capability nobody has validated trades installer size for an untested behaviour. Under the LFM Open Licence v1.0 it is redistributable with its NOTICE | "ship the projector now" / a different checkpoint |

## What is not decided here

Anything in `host-rulings.md`. If a line in this file and a line there ever disagree, this file is wrong and gets rewritten — that is the whole point of keeping them apart.
