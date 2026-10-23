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
Existence   Principal (Human / Agent)      — who
Space       Room + Membership              — where
Time        Session / Message / Thread     — when, and what was said
Execution   Workspace / Turn / Observation / Memory — how work happens and what it costs
```

### 2.1 Existence

| Entity | What it is | Key point |
|---|---|---|
| **Principal** | Anything that can speak. `kind = human \| agent` | Name, avatar, `description` (self-introduction, used by others to judge whether to approach it) |
| **Human** | You (v1 has exactly one "me") | Also a Principal; no privileges |
| **Agent** | A long-lived bot | Adds persona, capabilities, observations, memory, state — **it belongs to no room; rooms are where it appears** |

> **The distinction that matters**: a Member is an Agent's *projection into one room*, not the Agent itself.
> Feishu models a bot as a kind of member. That is enough there; it is not enough here, because an agent has a life and a memory that span rooms.

### 2.2 Space

| Entity | What it is | Key point |
|---|---|---|
| **Room** | Where a group of participants talks | Own id, membership changes, **not classified by headcount**; a direct message is simply a room with two people; one shared message log |
| **Membership** | The Room × Principal relation | Must exist on its own, because the same principal differs per room: join time, role (owner/member), read position, mute, **whether it is observing** |

### 2.3 Time

| Entity | What it is | Key point |
|---|---|---|
| **Message** | An immutable shared fact | Belongs to one room, optionally to one thread; sender is a Principal or `system`; kinds: text, image, file, **tool card**, system notice; carries its own cause — `caused_by` (the message that caused it), `chain` (the root of that causal run) and `depth` |
| **Thread** | A "topic" — the message subtree rooted at one message | **Not a new room** (Feishu-style, not Slack/Discord-style); the people in it are already in the room |
| **Session** | An agent's own stretch of work in one room | **Private bookkeeping, never a user-visible unit**; has a start and an end, **binds one workspace**, and is what its cost rolls up to. Five agents in one room have five of these; the room's timeline is continuous |

### 2.4 Execution

| Entity | What it is | Key point |
|---|---|---|
| **Workspace** | Where work runs — a directory/project | Today's `cwd` in EMRG; bound by a Session, used by an Agent |
| **Turn** | One action by an agent | What triggered it (which message, which judgement), tokens spent, tools called, messages produced — **the atomic unit of cost and audit** |
| **Observation** | One watch-queue entry | A reference to a Message + zero-cost hints (mentions me, asks a question, replies to me…) + a verdict (ignore / snooze / keep / act) |
| **Memory** | Three levels | Agent diary (cross-room, long-lived) / room digest (rolling, per room) / session memory (today's EMRG session memory) |

---

## 3. Relations

```
                        Principal  (kind: human | agent)
                            │
              ┌─────────────┴──────────────┐
              │ Membership (projection)     │ owns
              ▼                            ├── agent-only: persona / capabilities / state
        ┌─────────── Room ───────────┐     ├── Observation ──▶ references a Message
        │   one shared message log   │     ├── Memory (diary / room digest)
        └──────────────┬────────────┘     ├── Session ──▶ (agent × room), private
                       │ 1:N              └── Turn ──▶ Session, produces Messages
                       ▼
                   Message ◀── root_id self-reference ── Thread (a view)
                       ▲
                       │ tools run in the workspace
                       │
    Session ──1:1──▶ Workspace
    (an agent's own stretch of work in one room; nothing in the room's
     timeline marks where it starts or ends)
```

## 4. Cardinalities and rules (thirteen that must hold)

1. **Room 1 : N Message.** A message belongs to exactly one room; it never crosses rooms.
2. **Message 0..1 : N Thread.** A message roots at most one thread; threads never cross rooms.
3. **Agent 1 : N Session; each Session belongs to one (agent, room) pair.** A room's timeline is continuous and carries no session boundary in it. Five agents in a room have five private spans over the same shared log — which is what makes "messages shared, context private" true by construction rather than by discipline.
4. **Session 1 : 1 Workspace** (fixed once chosen); Workspace 1 : N Session.
5. **Principal N : M Room**, through Membership, which carries per-room state.
6. **Agent 1 : N Observation**, Observation N : 1 Message (one message may enter several agents' queues).
7. **Agent 1 : N Turn**; Turn 1 : N Message (one action may say several things).
8. **Agent 1 : 1 memory store** (N room digests + 1 diary).
9. **Human 1 : 1 identity** in v1, with multiple selves left open.
10. **Id prefixes follow the Feishu convention**: `ou_` principal, `oc_` room, `om_` message, plus `ag_` for agents. Readability over a generic UUID.
11. **Every room has at least one human member.** No room exists that the user cannot open. Agent-to-agent traffic therefore always happens where it can be read and stopped — and the dangerous case (two agents alone, exempting each other from the anti-loop rules) is excluded by the model rather than merely limited.
12. **Message N : 1 Message (causation).** `caused_by` names the message that caused this one; `chain` names the root of that run; `depth` is the hop count. A chain's depth is read off the data, never tracked in a mutable counter — a counter is what silently drifts after a restart.
13. **Nothing splits a room's history for the user.** The interaction is Feishu's: one chat, one continuous timeline. A session boundary, a workspace change or a membership change is recorded in the data and surfaces at most as a system message — never as a list entry, a divider control, or a second timeline.

## 5. Four things that are easy to get wrong

1. **Session is bookkeeping, not a place.**
   The user never sees one: a room's timeline runs continuously, exactly as in Feishu, and there is no "new session" to press. What the data needs the span for is private — which workspace this stretch ran in, and what it cost. If a workspace change must be visible at all, it is a **system message** in the timeline, which is a message kind Feishu already has — not a new control.

2. **A thread is not a room.**
   In Slack a thread is a message; in Discord it is a channel. seek takes the Feishu shape: **a thread is a message tree**. The people in it are always the people already in the room, so nothing has to be re-invited or re-permissioned.

3. **A direct message is a headcount, not a type.**
   A room with two people and a room with fifty behave identically. Any `if (chat_mode === 'p2p')` branch is the model starting to rot.

4. **A room must contain you — and that is a membership rule, not a headcount rule.**
   Rule 11 says every room has at least one human member, which rules out a room of two agents. That is not a contradiction with the previous point: no code branches on the number of members; the invariant is about *who must be present*, and it exists so that nothing an agent does on your behalf happens where you cannot read it. Agent-to-agent work therefore always has either you or a workspace turn above it — never a private channel of its own.

## 6. Why this shape (how others do it)

| Concept | Feishu | Slack / Discord | grok-bot | ADK | **seek** |
|---|---|---|---|---|---|
| Chat container | chat (p2p/group/topic) | channel | Room | — | **Room** (unclassified) |
| Thread | thread (message tree) | Slack: message; Discord: sub-channel | — | `sub_agents` | **Thread (message tree)** |
| A stretch of work | none | none | turn | **Session (event sequence)** | **Session** (an agent's private span, per agent × room — never shown) |
| The executor | bot (a kind of member) | bot | agent (a member) | **Agent (config + behaviour)** | **Agent (long-lived)** |
| Shared vs private | all shared | all shared | all shared | cleanly separated | **messages shared, context private** |

**Two things are seek's own**: ① an agent is a long-lived entity spanning rooms, and a room is only where it appears; ② messages are shared while context is private — that is what makes "five agents in one room" possible at all.

## 7. Conflicts with earlier decisions (awaiting a ruling)

| # | Conflict | September choice | Today's reality | Suggestion |
|---|---|---|---|---|
| 1 | **What the left list shows** | sessions currently open | today it shows rooms (Feishu-style) | **Resolved 2026-10-23**: rooms. Interaction is Feishu's, so the list is chats — and a session is not a chat |
| 2 | Whether a Session is visible to the user | yes (a new session picks a workspace) | the concept does not exist in the UI at all | **Resolved 2026-10-23**: never visible. A session is an agent's private bookkeeping (rule 3); a workspace change appears at most as a system message (rule 13) |
| 3 | Character kind | human \| virtual | today it is a plain `chatter` with no kind | `human \| agent`, aligned with the Agent entity |
| 4 | What a workspace binds to | Session | not implemented yet | keep September: bind to Session; an Agent also has a default workspace |
| 5 | Whether a session snapshots its members | undecided | undecided | still open, and it is now purely a memory question: whoever wrote a message is on the message, so a snapshot would only serve an agent asking "who was here when this stretch began" |

## 8. On-disk shape (brief)

One `seek.json` per account (as today), split into `principals / rooms / memberships / sessions[agentId] / messages[roomId] / observations[agentId] / turns / memories`.

Three sharding keys, each matching what grows fastest and what must be prunable on its own:

- **messages by room** — one shared log per room, so the shard key is the thing every reader already has.
- **observations and sessions by agent** — private, and the two that would otherwise make one shared file grow without bound.
- **turns** stay together: they are the ledger, they are small, and a ledger split by agent stops being a ledger.
