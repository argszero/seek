# seek data model v1 — entities and relations

> Merges two earlier lines: the entity relations settled in September (room ≠ session, no headcount classification, workspace bound to session) and the long-lived agent settled on 2026-10-23 (identity, observation, main loop, proactive action).
> Open conflicts with the September draft are listed in §7, waiting for a ruling.

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
| **Bot** | A visible contact — **the thing a room shows** (ruled 2026-10-23) | Owns the **name, avatar and description**. A bot is not an agent and an agent is not a bot: they are two models, and the identity lives here |
| **Agent** | One long-lived worker behind a bot — a bot has one or more (today: one watches, one works) | Adds persona, capabilities, observations, memory, state. **It takes its name and avatar from its bot**, so two agents of one bot speak as one contact; it belongs to no room, and rooms are where it appears through its bot |

> **The distinction that matters**: a Member is a Bot's *projection into one room*. The bot is what people see and address; its agents are the workers behind it, and the audit trail records which one acted.
>
> Feishu models a bot as a kind of member. That is enough there; it is not enough here, because the work behind a bot has a life and a memory that span rooms, and there is more than one worker behind it.

> **Bot and Agent are two entities, not two views of one** (ruled 2026-10-23). Names and avatars live on the bot and are **pushed down to its agents**, so renaming a bot renames every agent of it at once and no agent carries a second copy of the identity. An agent has no name of its own: it has a `role` (`watch`, `work`, and whatever comes later) and its bot's face.

> **A bot is N agents** (ruled 2026-10-23). `agents.yml` registers agents, not bots; each bot is at least two rows today (one watches on a local model, one works on the expensive one) and more are allowed later. Two rows is two of everything the kernel already gives an agent — a model, a session, a memory, a state machine — so nothing needs a new container and nothing that iterates agents needs an exception.
>
> Three things follow, and they are the whole reason the two models are kept apart: **the bot is the member** (membership, @-mention and the room's list of people are bot-level, so two agents never show as two contacts); **the agents are the workers** (a session, a memory and a turn each, so cost and audit stay per-agent and `sessions[agentId]` needs no change); **the identity is the bot's** (name, avatar, description, and the persona's voice, pushed down to its agents).

### 2.2 Space

| Entity | What it is | Key point |
|---|---|---|
| **Room** | Where a group of participants talks | Own id, membership changes, **not classified by headcount**; a direct message is simply a room with two people; one shared message log; **a bot may create one on its own** (ruled 2026-10-23), so membership is not human-gated |
| **Membership** | The Room × Principal relation | Must exist on its own, because the same principal differs per room: join time, role (owner/member), read position, mute, **whether it is observing** |

### 2.3 Time

| Entity | What it is | Key point |
|---|---|---|
| **Message** | An immutable shared fact | Belongs to one room, optionally to one thread; sender is a Principal or `system`; kinds: text, image, file, **tool card**, system notice; **carries `mentions[]`** — the principals it @-mentions, each `{id, name}`, exactly Feishu's own field, and nothing per-reader; carries its own cause — `caused_by` (the message that caused it), `chain` (the root of that causal run) and `depth`; also records **which agent of the bot wrote it**, which the room does not show |
| **Thread** | A "topic" — the message subtree rooted at one message | **Not a new room** (Feishu-style, not Slack/Discord-style); the people in it are already in the room |
| **Session** | An agent's own stretch of work in one room | **Private bookkeeping, never a user-visible unit**; has a start and an end, **binds one workspace**, and is what its cost rolls up to. Five agents in one room have five of these; the room's timeline is continuous |

### 2.4 Execution

| Entity | What it is | Key point |
|---|---|---|
| **Workspace** | Where work runs — a directory/project | Today's `cwd` in EMRG; bound by a Session, used by an Agent |
| **Turn** | One action by an agent | What triggered it (which message, which watch), tokens spent, tools called, messages produced — **the atomic unit of cost and audit** |
| **Observation** | One watch-queue entry, **on the bot's queue** (ruled 2026-10-23) | A reference to a Message + zero-cost hints (mentions me, asks a question, replies to me…) + a verdict (ignore / snooze / keep / act). One message enters one bot's queue once, not once per agent. **Every entry comes from a message** — the clock was deferred 2026-10-23, so a bot never queues an entry for itself. **The hints are derived at delivery for this bot and live here only** — `mentionsMe` is this bot's id found in the message's `mentions[]`, never a field written back onto the message |
| **Memory** | Three levels | Agent diary (cross-room, long-lived) / room digest (rolling, per room) / session memory (today's EMRG session memory) |

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
    ├── Observation ──▶ references a Message (zero-cost hints + a verdict)   ← one queue per bot
    ├── tick / state machine / lastSpoke / spent                            ← the life, not the work
    └── name / avatar / description   ← inherited by every agent of this bot,
                                        so the room sees one contact, not two
```

**Bot and Agent are separate entities** (ruled 2026-10-23), and the line between them is **alive vs. runs**. The bot owns identity, membership, the inbox, the tick and the state machine; an agent owns a model, a prompt, tools, a session, a memory and its own turns. So a bot appears once no matter how many agents work behind it, delivery is one write rather than N, and the audit trail and the bill still name the exact worker.

## 4. Cardinalities and rules (fifteen that must hold)

1. **Room 1 : N Message.** A message belongs to exactly one room; it never crosses rooms.
2. **Message 0..1 : N Thread.** A message roots at most one thread; threads never cross rooms.
3. **Agent 1 : N Session; each Session belongs to one (agent, room) pair.** A room's timeline is continuous and carries no session boundary in it. Five agents in a room have five private spans over the same shared log — which is what makes "messages shared, context private" true by construction rather than by discipline.
4. **Session 1 : 1 Workspace** (fixed once chosen); Workspace 1 : N Session.
5. **Principal N : M Room**, through Membership, which carries per-room state.
6. **Bot 1 : N Observation**, Observation N : 1 Message (one message may enter several bots' queues, but only once per bot). The queue is bot-level because delivery, the tick and "already handled" are bot-level; an agent never watches a room.
7. **Agent 1 : N Turn**; Turn 1 : N Message (one action may say several things).
8. **Agent 1 : 1 memory store** (N room digests + 1 diary). Memory is per agent, not per bot: the two agents of a bot have different windows, so they keep different summaries of the same room.
9. **Human 1 : 1 identity** in v1, with multiple selves left open.
10. **Id prefixes follow the Feishu convention**: `ou_` principal, `oc_` room, `om_` message, plus `ag_` for agents. Readability over a generic UUID.
11. ~~**Every room has at least one human member.**~~ **Withdrawn 2026-10-23.** It was never ruled: the implementer wrote it at 20:12 as a structural wall, and no host message in this conversation asks for it. It is also contradicted by the ruling that **all interaction is IM, group or direct** — a direct room between two bots has no human in it by construction. What bounds agent-to-agent traffic is the depth cap plus the room's consecutive-agent-turn cap, both readable off the data, neither needing a human in the room. Kept as a numbered gap so later rules do not shift.
12. **Message N : 1 Message (causation).** `caused_by` names the message that caused this one; `chain` names the root of that run; `depth` is the hop count. A chain's depth is read off the data, never tracked in a mutable counter — a counter is what silently drifts after a restart.
13. **Nothing splits a room's history for the user.** The interaction is Feishu's: one chat, one continuous timeline. A session boundary, a workspace change or a membership change is recorded in the data and surfaces at most as a system message — never as a list entry, a divider control, or a second timeline.
14. **Bot 1 : N Agent; Agent N : 1 Bot.** The bot owns the name, avatar and description; its agents inherit them rather than storing copies, so a rename reaches every agent at once. An agent has a `role`, not a name. **The bot-level set** is identity, membership, @-mention, a room's participant list, the observation queue, the tick and the state machine — anything that is alive. **The agent-level set** is model, prompt, tools, session, memory, turn and cost — anything that runs.
15. **A message stores `mentions[]`; "I was mentioned" is derived.** The message keeps the Feishu field — who it @-mentions, `{id, name}` — because that is what the interface draws as blue @-text and what the open platform defines. `mentionsMe` is not stored on it: it is the same fact seen from one bot's position, computed at delivery by finding that bot's id in `mentions`, and it lives solely on the observation entry. The message is written once and stays clean; every other bot derives its own answer from the same bytes.

## 5. Five things that are easy to get wrong

1. **Session is bookkeeping, not a place.**
   The user never sees one: a room's timeline runs continuously, exactly as in Feishu, and there is no "new session" to press. What the data needs the span for is private — which workspace this stretch ran in, and what it cost. If a workspace change must be visible at all, it is a **system message** in the timeline, which is a message kind Feishu already has — not a new control.

2. **A thread is not a room.**
   In Slack a thread is a message; in Discord it is a channel. seek takes the Feishu shape: **a thread is a message tree**. The people in it are always the people already in the room, so nothing has to be re-invited or re-permissioned.

3. **A direct message is a headcount, not a type.**
   A room with two people and a room with fifty behave identically. **Feishu agrees and stores it that way**: `chat_mode` has three values (`group` / `topic` / `p2p`), and a direct chat is a chat with its own `oc_` id whose `chat_mode` reads `p2p`. The field may be stored for fidelity; **no domain logic may branch on it**, because the entity it describes is the same Room either way. Note the one asymmetry: Feishu's `p2p` is bot-to-user only, so a direct room between two bots is a seek extension with nothing upstream to copy — it was ruled here (a bot may open a room on its own) rather than derived.

4. **A room does not have to contain you — an earlier draft said it did, and that was wrong.**
   The draft carried a rule that every room has at least one human member, invented at 20:12 and never ruled; the ruling that all interaction is IM, group or direct, allows a direct room between two bots, and that is a room with nobody of yours in it. What is true instead: **a direct message is still a room** — the same entity, the same message log, the same membership. Nothing branches on who is in it, which is the previous point's rule and the reason this one could be withdrawn without touching any code shape. Visibility of bot-to-bot traffic is then a *listing* question, not a model question.

5. **An @-mention lives on the message; "was I mentioned" does not.**
   `Message.mentions` is the Feishu field and the only stored form: *who was named*. Each bot derives `hints.mentionsMe` when the message lands, by finding its own id in that array, and the boolean stays on that bot's queue entry. Storing `mentionsMe` on the message instead would put a reader's viewpoint inside an immutable shared fact — the message would have to be rewritten or duplicated once per bot in the room. It would also spend the one question stage 0 must answer for free: a bot asks it about itself, and the answer is one array scan.

## 6. Why this shape (how others do it)

| Concept | Feishu | Slack / Discord | grok-bot | ADK | **seek** |
|---|---|---|---|---|---|
| Chat container | chat (p2p/group/topic) | channel | Room | — | **Room** (unclassified) |
| Thread | thread (message tree) | Slack: message; Discord: sub-channel | — | `sub_agents` | **Thread (message tree)** |
| A stretch of work | none | none | turn | **Session (event sequence)** | **Session** (an agent's private span, per agent × room — never shown) |
| The executor | bot (a kind of member) | bot | agent (a member) | **Bot + Agent (two entities)** | **Bot (the contact) → Agent (long-lived workers)** |
| Shared vs private | all shared | all shared | all shared | cleanly separated | **messages shared, context private** |

**Three things are seek's own**: ① **a bot and its agents are two entities** — the bot is the contact and owns the identity, its agents are the workers and own the sessions, memory and cost (ruled 2026-10-23); ② an agent is long-lived and spans rooms, and a room is only where its bot appears; ③ messages are shared while context is private — that is what makes "five bots in one room" possible at all.

## 7. Conflicts with earlier decisions (awaiting a ruling)

| # | Conflict | September choice | Today's reality | Suggestion |
|---|---|---|---|---|
| 1 | **What the left list shows** | sessions currently open | today it shows rooms (Feishu-style) | **Resolved 2026-10-23**: rooms. Interaction is Feishu's, so the list is chats — and a session is not a chat |
| 2 | Whether a Session is visible to the user | yes (a new session picks a workspace) | the concept does not exist in the UI at all | **Resolved 2026-10-23**: never visible. A session is an agent's private bookkeeping (rule 3); a workspace change appears at most as a system message (rule 13) |
| 3 | Character kind | human \| virtual | today it is a plain `chatter` with no kind | **Resolved 2026-10-23**: `human \| bot`. A bot is a principal and appears in rooms; an agent is not a principal and never appears on its own |
| 4 | What a workspace binds to | Session | not implemented yet | keep September: bind to Session; an Agent also has a default workspace |
| 5 | Whether a session snapshots its members | undecided | undecided | still open, and it is now purely a memory question: whoever wrote a message is on the message, so a snapshot would only serve an agent asking "who was here when this stretch began" |

## 8. On-disk shape (brief)

One `seek.json` per account (as today), split into `bots / agents / principals / rooms / memberships / sessions[agentId] / messages[roomId] / observations[botId] / turns / memories`.

`bots` and `agents` are separate shards on purpose: a bot is a handful of rows that change when someone renames it, while agents are the things that are many and busy. Keeping the identity in its own shard means a rename is one write, not one per agent.

Three sharding keys, each matching what grows fastest and what must be prunable on its own:

- **messages by room** — one shared log per room, so the shard key is the thing every reader already has.
- **observations by bot, sessions by agent** — the queue is the bot's (one per bot) while the work is the agent's (one per agent). Both are the things that would otherwise make one shared file grow without bound.
- **turns** stay together: they are the ledger, they are small, and a ledger split by agent stops being a ledger.
