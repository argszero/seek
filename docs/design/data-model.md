# seek data model v1 — entities and relations

> The entities, how they relate, and the rules that must hold. Mechanisms, costs and reasoning live in `agent-lifecycle.md`.
> One line matters more than the rest: **messages are shared facts; context is a private interpretation.**

---

## 1. In one sentence

**Messages are shared facts; context is a private interpretation.**
Five agents in one room do not mean five copies of the room — one message log, five private views.

That sentence settles the hardest part of the model.

---

## 2. Four layers

```
Existence   Bot / Agent, Principal (Human)  — who appears, and who works
Space       Room + Membership              — where
Time        Session / Message / Thread     — when, and what was said
Execution   Workspace / Turn / Observation / Memory — how work happens and what it costs

Bot and Agent split it the same way throughout: **the bot owns what is alive** (identity, inbox, tick, state, being a member), **an agent owns what runs** (model, prompt, tools, session, memory).
```

### 2.1 Existence

| Entity | What it is | Key point |
|---|---|---|
| **Principal** | Anything that can appear in a room and be addressed. `kind = human \| bot` | Name, avatar, `description` (self-introduction, used by others to gauge whether to approach it). **Agents are not principals**; a message records which agent of the bot produced it, so the audit trail stays exact while the room sees one speaker |
| **Human** | You (v1 has exactly one "me") | Also a Principal; no privileges |
| **Bot** | A visible contact — **the thing a room shows** | Owns the **name, avatar and description**. A bot is not an agent and an agent is not a bot: they are two models, and the identity lives here |
| **Agent** | One long-lived worker behind a bot — a bot has one or more (today: one watches, one works) | Adds a model, a persona, tools, memory and sessions, plus **a home directory of its own**. **It takes its name and avatar from its bot**, so two agents of one bot speak as one contact; it belongs to no room, and rooms are where it appears through its bot. It holds **no** queue and **no** life state: the inbox, the tick and the state machine are the bot's. **It knows its bot and its siblings** — the identity and the roster are read from the bot, not stored on the agent (rule 16) |

> **The distinction that matters**: a Member is a Bot's *projection into one room*. The bot is what people see and address; its agents are the workers behind it, and the audit trail records which one acted.
>
> Feishu models a bot as a kind of member. That is enough there; it is not enough here, because the work behind a bot has a life and a memory that span rooms, and there is more than one worker behind it.

> **Bot and Agent are two entities, not two views of one**. Names and avatars live on the bot and are **pushed down to its agents**, so renaming a bot renames every agent of it at once and no agent carries a second copy of the identity. An agent has no name of its own: it has a `role` (`watch`, `work`, and whatever comes later) and its bot's face.

> **A bot is N agents**. `agents.yml` registers agents, not bots; each bot is at least two rows today (one watches on a local decision model, one works on the expensive one) and more are allowed later. Two rows is two of what the kernel already gives an agent — a model, a prompt, a memory — and the two need not be the same kind of model: the watch row answers in one pass and keeps a box instead of a session. Nothing needs a new container and nothing that iterates agents needs an exception.
>
> Three things follow, and they are the whole reason the two models are kept apart: **the bot is the member** (membership, @-mention and the room's list of people are bot-level, so two agents never show as two contacts); **the agents are the workers** (a session, a memory and a turn each, so cost and audit stay per-agent and `sessions[agentId]` needs no change); **the identity is the bot's** (name, avatar, description, and the persona's voice, pushed down to its agents).

### 2.2 Space

| Entity | What it is | Key point |
|---|---|---|
| **Room** | Where a group of participants talks | Own id, membership changes, **not classified by headcount**; a direct message is simply a room with two people; one shared message log; **a bot may create one on its own**, so membership is not human-gated |
| **Membership** | The Room × Principal relation | Must exist on its own, because the same principal differs per room: join time, role (owner/member), read position, mute, **whether it is observing** |

### 2.3 Time

| Entity | What it is | Key point |
|---|---|---|
| **Message** | A shared fact: its own words are written once, and may be taken back once | Belongs to one room, optionally to one thread; sender is a Principal or `system`; kinds: text, image, file, **tool card**, system notice; **carries `mentions[]`** — the principals it @-mentions, each `{id, name}`, exactly Feishu's own field, and nothing per-reader; **carries `media`** — one `{key, mime}` reference to its picture, present exactly when the kind is `image`, with the bytes in a file beside the store rather than in the message; carries its own cause — `caused_by` (the message that caused it), `chain` (the root of that causal run) and `depth`; also records **which agent of the bot wrote it**, which the room does not show; **carries what other people added to it** — `reactions[]`, one entry per emoji holding `operators[]`, and no stored count: the count is that array's length, and "did I react" is derived where it is asked, so one entry cannot say four people and name two; **carries the two snapshots a message can be sent with** — `quoted` (the quoted sender's name and its words, cut to the block that draws it) and `forwarded_from` (whose message it was), each taken from the store at send time and stored, so a message dropped or a person renamed afterwards does not rewrite what the later message says it answered; and **carries `deleted_at`** — the stamp `deleteMessage()` writes once, in the same step as the words, the picture, the attachment, the mentions, the reactions and the two snapshots come off, because the row itself stays |
| **Thread** | A "topic" — the message subtree rooted at one message | **Not a new room** (Feishu-style, not Slack/Discord-style); the people in it are already in the room |
| **Session** | An agent's own stretch of work in one room | **Private bookkeeping, never a user-visible unit**; has a start and an end, **binds one workspace**, and is what its cost rolls up to. Five agents in one room have five of these; the room's timeline is continuous |

### 2.4 Execution

| Entity | What it is | Key point |
|---|---|---|
| **Workspace** | Where work runs — a directory/project | Today's `cwd` in EMRG; bound by a Session. **Every agent has a home directory**, which is the workspace its sessions open in unless they chose another (rule 16) |
| **Turn** | One action by an agent | What triggered it (which message, which watch), tokens spent, tools called, messages produced **by the speaking tool** — **the atomic unit of cost and audit**. A turn that called it not at all produced no message, which is a record, not an absence |
| **Observation** | One watch-queue entry, **on the bot's queue** | A reference to a Message + zero-cost hints (mentions me, asks a question, replies to me…) + a verdict (ignore / snooze / keep / act) **and the reason behind it, when one came back**. The reason sits next to the verdict on the same entry: it is what makes a bad call reviewable, and the work agent may read it back. **It is never put into the work agent's context** — a reason there is a premise, not advice — and no rule writes one, because a reason is the judgement's own sentence (`agent-lifecycle.md` §4). One message enters one bot's queue once, not once per agent. **An entry is a delivery, and deliveries have two producers**: a message from a person or another bot, or a schedule entry coming due — the second is the one case where the entry's author is the bot itself. **An entry may skip the verdict altogether**: stage 0's fast-pass (@-mention, reply, direct message, reminder) consumes it without asking the watch agent, including when it is injected into a turn that is already running (`agent-lifecycle.md` §4). **The hints are derived at delivery for this bot and live here only** — `mentionsMe` is this bot's id found in the message's `mentions[]`, never a field written back onto the message |
| **Schedule** | One row in **one global table**, every bot reads and writes it | `when` + `what reminder` + `which bot`. Not a per-bot timer and not an entity on the bot: a single table in the process, plus a comparator. When a row comes due, its `text` becomes an Observation of `kind: "reminder"` on the target bot's queue — a delivery, so the ordinary wake rule applies unchanged. The row is written by a tool (`schedule`), never by the runtime on someone's behalf, and its text is delivered verbatim. **It has no room and it is never displayed**: a reminder reaches the inbox and stops there |
| **Memory** | Three levels | Agent diary (cross-room, long-lived) / room digest (rolling, per room) / session memory (today's EMRG session memory). **A room digest also carries the consumed-to point it has summarised up to**, written with the summary in one operation, because the delta a judgement reads is derived from it — the queue entries after that point — rather than copied into a second log |

---

## 3. Relations

```
   Principal (kind: human | bot)     ← what a room shows and can @-mention
        │
        └── Membership ──▶ Room ──1:N──▶ Message ◀── root_id self-reference ── Thread (a view)
                              │            ▲
                              │            │ tools run in the workspace
                              │            │
   Bot ──1:N──▶ Agent ────────┘            │
    │             │                        │
    │             ├── model / prompt(+persona) / tools / sandbox
    │             ├── Session ──1:1──▶ Workspace     (agent × room, private bookkeeping)
    │             ├── Memory (diary / room digest)
    │             └── Turn ──▶ Session, produces Messages
    │
    ├── Observation ──▶ references a Message (zero-cost hints + a verdict and its reason)   ← one queue per bot
    ├── tick / state machine / lastSpoke / spent                            ← the life, not the work
    └── name / avatar / description   ← inherited by every agent of this bot,
                                        so the room sees one contact, not two
```

**Bot and Agent are separate entities**, and the line between them is **alive vs. runs**. The bot owns identity, membership, the inbox, the tick and the state machine; an agent owns a model, a prompt, tools, a session, a memory and its own turns. So a bot appears once no matter how many agents work behind it, delivery is one write rather than N, and the audit trail and the bill still name the exact worker.

## 4. Cardinalities and rules

1. **Room 1 : N Message.** A message belongs to exactly one room; it never crosses rooms.
2. **Message 0..1 : N Thread.** A message roots at most one thread; threads never cross rooms.
3. **Agent 1 : N Session; each Session belongs to one (agent, room) pair.** A room's timeline is continuous and carries no session boundary in it. Five agents in a room have five private spans over the same shared log — which is what makes "messages shared, context private" true by construction rather than by discipline.
4. **Session 1 : 1 Workspace** (fixed once chosen); Workspace 1 : N Session, and **Agent 1 : 1 home Workspace** — the directory a session opens in unless it was given another (rule 16).
5. **Principal N : M Room**, through Membership, which carries per-room state.
6. **Bot 1 : N Observation**, Observation N : 1 Message (one message may enter several bots' queues, but only once per bot). The queue is bot-level because delivery, the tick and "already handled" are bot-level; an agent never watches a room.
7. **Agent 1 : N Turn**; Turn 1 : N Message, and every one of those messages comes from a call to the speaking tool rather than from the turn's output. One action may say several things: three calls, three messages, each addressed to a room.
8. **Agent 1 : 1 memory store** (N room summaries + 1 diary). Memory is per agent, not per bot: the diary and the sessions are each agent's own. A room's standing summary is written once per (bot, room) and read by both agents — the watch agent produces no text, so a copy of its own would only be a second version to disagree with.
9. **Human 1 : 1 identity** in v1, with multiple selves left open.
10. **Id prefixes follow the Feishu convention**: `ou_` principal, `oc_` room, `om_` message, plus `ag_` for agents. Readability over a generic UUID.
11. **A room needs no human member.** A direct room between two bots is a room; membership is not human-gated. What bounds agent-to-agent traffic is the depth cap and the room's consecutive-agent-turn cap, both readable off the data, neither needing a human present to notice a runaway.
12. **Message N : 1 Message (causation).** `caused_by` names the message that caused this one; `chain` names the root of that run; `depth` is the hop count. A chain's depth is read off the data, never tracked in a mutable counter — a counter is what silently drifts after a restart.
13. **Nothing splits a room's history for the user.** The interaction is Feishu's: one chat, one continuous timeline. A session boundary, a workspace change or a membership change is recorded in the data and surfaces at most as a system message — never as a list entry, a divider control, or a second timeline.
14. **Bot 1 : N Agent; Agent N : 1 Bot.** The bot owns the name, avatar and description; its agents inherit them rather than storing copies, so a rename reaches every agent at once. An agent has a `role`, not a name. **The bot-level set** is identity, membership, @-mention, a room's participant list, the observation queue, the tick and the state machine — anything that is alive. **The agent-level set** is model, prompt, tools, session, memory, turn and cost — anything that runs.
15. **A message stores `mentions[]`; "I was mentioned" is derived.** The message keeps the Feishu field — who it @-mentions, `{id, name}` — because that is what the interface draws as blue @-text and what the open platform defines. `mentionsMe` is not stored on it: it is the same fact seen from one bot's position, computed at delivery by finding that bot's id in `mentions`, and it lives solely on the observation entry. The message is written once and may be taken back once; nothing a delivery derives is written back onto it, and every other bot derives its own answer from the same bytes.
16. **A deletion is a stamp, never a hole.** `deleteMessage()`, `deleteThread()` and `deleteRoom()` write `deleted_at` and drop the content in the same step — the words, the picture, the attachment, the mentions, the reactions and the two snapshots — while the row stays, because an `Observation`, a reply's `root_id`/`chain` and a `Turn` all name that id and would otherwise point at nothing. A thread is not a second record with its own deletion: it is the `chain` rooted at one message, so deleting the root takes every reply at one instant. A room takes its messages and its memberships with it, the memberships being what makes it leave every list — a room nobody of them is in cannot be read or typed into, and `deliver()` refuses it in a sentence that says it no longer exists. A stamp rather than a boolean, for the reason `Bot.deleted_at` is one: "when" answers both "is it gone" and "since when" with one fact.
17. **Agent 1 : 1 home directory; its bot is read, never copied.** An agent's home directory holds its persona, its skills and its memory, and it is the workspace the agent's sessions open in unless a session was given another. Nothing about the bot is stored on the agent: **the bot's name, avatar and description, and the roster of its agents — each one's role, what it does and its directory — are read from the bot when the agent runs**, so a rename or a new row reaches every agent at once and no agent carries a second copy that can disagree. The identity and the roster are given to the agent in its prompt or in a generated skill file, so it knows them without asking.

## 5. Five things that are easy to get wrong

1. **Session is bookkeeping, not a place.**
   The user never sees one: a room's timeline runs continuously, exactly as in Feishu, and there is no "new session" to press. What the data needs the span for is private — which workspace this stretch ran in, and what it cost. If a workspace change must be visible at all, it is a **system message** in the timeline, which is a message kind Feishu already has — not a new control.

2. **A thread is not a room.**
   In Slack a thread is a message; in Discord it is a channel. seek takes the Feishu shape: **a thread is a message tree**. The people in it are always the people already in the room, so nothing has to be re-invited or re-permissioned.

3. **A direct message is a headcount, not a type.**
   A room with two people and a room with fifty behave identically. **Feishu agrees and stores it that way**: `chat_mode` has three values (`group` / `topic` / `p2p`), and a direct chat is a chat with its own `oc_` id whose `chat_mode` reads `p2p`. The field may be stored for fidelity; **no domain logic may branch on it**, because the entity it describes is the same Room either way. Note the one asymmetry: Feishu's `p2p` is bot-to-user only, so a direct room between two bots is a seek extension with nothing upstream to copy — it was ruled here (a bot may open a room on its own) rather than derived.

4. **A room does not have to contain you.**
   A direct room between two bots has nobody of yours in it, and it is still a room: the same entity, the same message log, the same membership. Nothing branches on who is in it — that is the previous point, and it is why a room's contents never look like a code shape. Visibility of bot-to-bot traffic is a *listing* question, not a model question.

5. **An @-mention lives on the message; "was I mentioned" does not.**
   `Message.mentions` is the Feishu field and the only stored form: *who was named*. Each bot derives `hints.mentionsMe` when the message lands, by finding its own id in that array, and the boolean stays on that bot's queue entry. Storing `mentionsMe` on the message instead would put a reader's viewpoint inside the message's own record — the message would have to be rewritten or duplicated once per bot in the room. It would also spend the one question stage 0 must answer for free: a bot asks it about itself, and the answer is one array scan.

## 6. Why this shape (how others do it)

| Concept | Feishu | Slack / Discord | grok-bot | ADK | **seek** |
|---|---|---|---|---|---|
| Chat container | chat (p2p/group/topic) | channel | Room | — | **Room** (unclassified) |
| Thread | thread (message tree) | Slack: message; Discord: sub-channel | — | `sub_agents` | **Thread (message tree)** |
| A stretch of work | none | none | turn | **Session (event sequence)** | **Session** (an agent's private span, per agent × room — never shown) |
| The executor | bot (a kind of member) | bot | agent (a member) | **Bot + Agent (two entities)** | **Bot (the contact) → Agent (long-lived workers)** |
| Shared vs private | all shared | all shared | all shared | cleanly separated | **messages shared, context private** |

**Three things are seek's own**: ① **a bot and its agents are two entities** — the bot is the contact and owns the identity, its agents are the workers and own the sessions, memory and cost; ② an agent is long-lived and spans rooms, and a room is only where its bot appears; ③ messages are shared while context is private — that is what makes "five bots in one room" possible at all.

## 7. On-disk shape (brief)

One `seek.json` per account (as today), split into `bots / agents / principals / rooms / memberships / sessions[agentId] / messages[roomId] / observations[botId] / turns / memories[agentId] / schedule`.

`schedule` is **not** sharded by bot, unlike `observations`: it is one global table every bot reads and writes, so sharding it would make the one operation it exists for — a bot writing a row for another bot — a cross-shard write.

`bots` and `agents` are separate shards on purpose: a bot is a handful of rows that change when someone renames it, while agents are the things that are many and busy. Keeping the identity in its own shard means a rename is one write, not one per agent.

Three sharding keys, each matching what grows fastest and what must be prunable on its own:

- **messages by room** — one shared log per room, so the shard key is the thing every reader already has.
- **observations by bot, sessions by agent** — the queue is the bot's (one per bot) while the work is the agent's (one per agent). Both are the things that would otherwise make one shared file grow without bound.
- **turns** stay together: they are the ledger, they are small, and a ledger split by agent stops being a ledger.