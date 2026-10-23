# Long-lived agent design (seek kernel)

> Settled by the host on 2026-10-23: **every bot is a complete agent**, differing from an ordinary agent in three ways —
> **long-lived, observes on its own, acts on its own**. If the agent sits in a room where someone speaks without
> mentioning it, that message is still delivered to it and lands in its own watch queue. Inside the agent there is a
> **main loop**, and that loop is the core of its life — **the only loop there is**. Every tick it first decides from
> the watch data whether to act (rules / events / a cheap model / a local model — this is where the money is saved,
> because a permanently alive agent must not burn tokens when nothing is called for). A direct message or an
> @-mention is not a separate road out of this loop: the gate sees it and passes it straight through.
>
> The interaction layer above this (rooms, messages, the sense of presence) is in `~/.emrg/designs/seek-mental-model.md`.

---

## 0. In one sentence

**An agent = one identity + one inbox + one main loop that never stops, in two stages.**
The first stage spends only what is affordable to look; the second spends what is affordable to act.
All the saving lives in the first stage: **the overwhelming majority of messages should die there, and dying there must cost nothing.**

### Why the first stage has to exist at all

EMRG is **trigger-driven**: nothing runs until something calls it, so an idle agent costs nothing by construction. An agent in seek is **alive** — it keeps watching rooms, and rooms keep producing messages nobody addressed to it. Aliveness is the product; it is also, without a gate, an open tap.

So the judgement stage is not an optimisation added to a design that would work without it. **It is what makes aliveness affordable**, and it answers two requirements at once:

1. **It must stop meaningless work.** A room full of other people talking about something that has nothing to do with it is the normal state of a busy room, and every one of those messages must cost nothing to disregard.
2. **It must itself be almost free.** A gate that costs a little per message is not a gate, it is a smaller bill.

### The gate is a bundled model behind cheap rules (ruled 2026-10-23)

The judgement runs on **a small model shipped with the product** — no download step, no "install Ollama first", no user machine that might not have one. Budget: **under 300 MB of weights, smaller if it can still do the job.**

It never fires on every message, because rules run first and settle most of them for nothing:

| Order | Check | Cost | Verdict |
|---|---|---|---|
| 1 | **No new observations at all** | nothing | **Return.** There is nothing to look at; the tick ends here |
| 2 | **@ me, a reply to my message, or a direct message** | nothing | **Act.** Straight to stage 2 — there is nothing to judge |
| 3 | Muted room, my own message, another bot's broadcast | nothing | Ignore |
| 4 | Everything else | one small-model call | The model decides |

The ordering is the whole economy of the design: the two cases that are both **certain and free** are settled before anything runs, so the model is only ever asked about the genuinely ambiguous remainder — a group of people talking near it, without naming it.

---

## 1. One path, not three (ruled by the host, 2026-10-23)

There is **one** delivery path and **one** loop. A message to a room is delivered into every member agent's inbox and costs nothing to receive. The loop then runs; stage 0 reads the inbox and decides what to do with it. An @-mention, a reply to its own message, or a direct message is not a second road — it is **a fast-pass inside stage 0**: the gate recognises it and sends it straight to stage 2, skipping the paid judgement, because there is nothing to judge.

| What arrives | Where it lands | What stage 0 does |
|---|---|---|
| A DM, an @-mention, a reply to its own message | The inbox, like everything else | **Pass** — straight to stage 2, no judge call |
| A room message that names nobody | The inbox | Everything else: rules, then the judge |
| A scheduled tick | No message; the loop wakes anyway | Looks at whatever has accumulated |

Why this matters more than it looks: with two roads, the same message could be answered twice — once by the direct road and once by a later tick that finds it still in the inbox. With one road there is nothing to reconcile, no "mark it handled" bookkeeping, and no ordering rule between two runners.

**Receiving never spends anything.** That is the cost foundation of the whole design. Any implementation where an un-addressed message triggers a model call is already wrong.

---

## 2. The Agent object

```
Agent
├─ Identity (visible outside; equals one contact in seek)
│   id / name / avatar / description   ← description is what others (including other agents) use to judge whether to approach it
│   persona                            ← how it speaks
├─ Capabilities
│   model.main / model.judge           ← the expensive model for work / the cheap model for judgement
│   tools[] / sandbox / limits
├─ Attention
│   rooms[]        ← which rooms it watches
│   interests[]    ← keywords / topics / "answer when someone asks about X" subscriptions
├─ Watch queue (the inbox, see §3)
├─ Long-term memory
│   diary (its own markdown memory, across sessions and rooms)
│   roomDigest[room] (rolling summary per room, cheap context for the judge)
├─ Life state
│   state: asleep | observing | judging | working | needy (waiting on your decision)
│   lastSpoke[room] / lastTick / sleepUntil / backoff
│   spent: tokens, observed and reported — a number, never a limit
└─ Sessions
    session[room] (its own stretch of work in each room; a new one starts when it
    changes workspace — private bookkeeping, never shown to the user)
```

**Agent ≠ Session.** EMRG today presses the identity into the session (the session is that cwd, that model, that history), so one identity cannot live in three rooms at once. The Agent sits above the session; sessions are its stretches of memory.

**A session is never a user-visible unit either.** The room's timeline is continuous, the way a chat is in Feishu; five agents in one room simply have five private spans over the same shared log. That is not a display decision but the load-bearing one: it is what makes "messages shared, context private" true by construction.

> This connects to the instruction already given on 2026-10-23: `projects.yml` → `agents.yml`, one agent per project.
> That `agent-abstraction-step1.md` is the first step (abstract the Agent out); this document is the second (give the Agent a life).

---

## 3. Watch queue (the inbox)

Appended one entry at a time, **never processed by a model**:

```json
{ "id": "...", "room": "oc_...", "msg": "om_...", "ts": 1698123456789,
  "sender": "ou_...", "fromAgent": "agent_id|null",
  "kind": "text|image|file|toolcard|system",
  "text": "……",
  "hints": { "mentionsMe": false, "asksQuestion": true, "repliesToMe": false,
             "keywordHit": ["release", "schedule"], "roomTemperature": "busy" },
  "state": "new" }
```

- `hints` are scored **by the producer, not by a model**: @ detection, question marks, whether it replies to me, keyword matches, message density. All of it is string and counting work that costs nothing.
- State machine: `new → judged (act | ignore | snooze | keep) → consumed`; `snooze` carries a condition ("when this gets a reply", "in five minutes").
- **Capacity**: per (agent, room) a cap such as 200 entries / 24 hours. Over the cap, entries are not dropped — they collapse into one line inside `roomDigest`. Otherwise the inbox becomes a second message log and blows up both disk and context.
- The inbox is append-only and the writer **never blocks** (room fan-out must not stall because one agent is busy).

---

## 4. The main loop: two stages

This is the core of the whole design:

```
per tick:
  ┌ Stage 0 · rules only, no model (settles everything that is certain and free)
  │  1. No new observations?   → end of tick, before anything else is considered
  │  2. Inside cooldown?       → unless @-mentioned, end of tick
  │  3. Rule says act? (@-mentioned / replied to / DM) → straight to stage 2
  │  4. Rule says ignore? (my own message / another bot's broadcast / muted room)
  │                            → mark them ignore, end of tick
  │  5. Everything else → stage 1 (the bundled small model)
  │
  ├ Stage 1 · the small model (bundled, under 300 MB, one call, summaries only)
  │  input: why it woke + a one-line summary of the last N messages in that room + roomDigest
  │         + my job/interests (+ how long since I last spoke here)
  │  model: the bundled judge (no download, no network), no tools, max_tokens capped
  │  output: strict JSON — {"act":0|1, "reason":"<enum>", "priority":0-3, "focus":["om_..."]}
  │  effect: act=0 → record ignore(+reason), end of tick (what this step cost is the whole bill)
  │          act=1 → stage 2, carrying the focus messages as the ones it decided to care about
  │
  └ Stage 2 · the real agent loop (expensive)
     Identical to one EMRG turn today: full context + tools + streaming + memory write at the end.
     Two differences: ① opened with "you decided to say this yourself; nobody called you"
                      ② must end by recording three things: what it said / why / how to judge
                        the same situation next time
```

### Why two stages

One reason: **the judge looks at little, the actor looks at everything.**
If the judge reads the full history, it has become an expensive model and the whole saving evaporates.

### Three ways to decide not to act

- `ignore`: this is not about me. Consume the entry.
- `snooze`: not now, but possibly later (the question is still unanswered, someone else should speak first). Re-queue with a condition (in five minutes / when this gets a reply / when the room calms down).
- `keep`: no need to speak, but I should remember (someone is discussing my area). Write one line into the diary, take no action.

`keep` matters: it makes an agent "present but not interrupting", which is the most human thing about being permanently alive.

### Backoff

With nothing to do, the tick interval grows exponentially (one minute up to eight hours), and any new message snaps it back to the base. EMRG's scheduler already has this (`_heartbeat_interval` = max(i, min(i*8, 8h))); reuse it.
**A quiet agent should consume almost nothing** — that is the only premise under which "long-lived" is affordable.

### Concurrency

One agent runs exactly **one** stage 2 at a time. When several rooms want it at once, the requests enter the agent's own action queue, ordered: @-mention > someone waiting for an answer > high salience > the room it has been silent in the longest.
The reason is not performance but **identity consistency**: two parallel conversations would make its persona and memory fight each other.

---

## 5. Cost, worked out

The point of this section is not frugality. It is that **an alive agent is only viable if looking is nearly free**, so the gate's cost per message is a design constraint, not a tuning knob.

Assume 10 agents, 5 rooms, 500 messages an hour.

| Approach | Tokens per hour | Outcome |
|---|---|---|
| Every message to the expensive model (the naive port) | 500 × ~1500 = **750k** | broke within a day |
| Every message to the judge only (no stage 0) | 500 × ~300 = **150k** | still too much |
| **This design**: 90% stopped by the gate, 10% judged, 5% of those act | 50 × 300 + 2.5 × 3000 = **≈23k** | affordable |
| Leaner: judge only when a batch has piled up | another order of magnitude down | at the cost of slower reactions |

(Order-of-magnitude estimates, not measurements.)

**The gate's hit rate is the product's cost curve.** So it must be observable and tunable: every agent records `judged` (batches judged), `acted` (hits), `ratio` (hit rate) and `spent` (tokens). A hit rate that suddenly jumps to 50% means a persona is written wrong or a room has been flooded by bots — and that has to be visible in the interface.

---

## 6. How it meets the EMRG kernel (without a rewrite)

| Component | What exists today | What is new |
|---|---|---|
| Agent identity | `projects.yml` → `agents.yml` (already decided) | the fields in §2 |
| Main loop | `TaskHandler` (`scheduler.py:982`): heartbeat, interval/backoff, bounded cycles, stop/trigger/status, resume after restart | a new task type `agent-tick` running stages 0 and 1 |
| Stage 2 · action | today's session turn (`_run_tool_loop_locked`) | open with "you chose to speak"; require the three closing notes |
| Delivery into the inbox | room fan-out as a frame broadcast, but only to connected clients | server-side **fan-out into every member agent's inbox** (persisted, not in memory) — the one road in, for every kind of message |
| Judge model | `llm.py` already selects a model per session | a call shape with no tools, a low `max_tokens` cap and a mandatory JSON reply |
| Memory | `memory_store`: session and project levels | add an **agent level** (across rooms and sessions) |
| State visibility | frame broadcast | a new frame: `agent_state` (observing / judging / working / asleep / needy) |

**An honest cost**: today's daemon presses "identity" and "runtime" into the same `EmrgServer`, and the busy table, cancel table and contexts are all keyed by session. Running many agents in one process needs another layer keyed by agent. It is doable; the work is real.

---

## 7. Avoiding the ways this kind of system dies

| Failure | Mechanism |
|---|---|
| **Two bots wake each other and never stop** | ①`fromAgent` marks bot messages, which do not wake other bots unless @-mentioned ②a cap on consecutive bot turns per room (grok-bot uses 3), held **on the Room** ③a forced cooldown after acting. §11 is the full treatment: the root rule and the depth cap bound the set of chains, and "every room has a human member" removes the case where none of this can be noticed |
| The judge is too cheap → deaf and blind | hit rate observable; per-agent thresholds; what it ignored can be reviewed (entries and reasons are kept) |
| The judge is too expensive → burning money | spent is recorded and visible per agent, so a runaway bill is *seen* rather than silently capped. There is no self-stop: a bill that climbs is a defect in the persona or the gate, and it is fixed there, not papered over by a limit that also silences the agent you wanted to hear from |
| Inbox explosion | a cap plus collapse into the room digest |
| Long-lived means creeping corruption | checkpoint at the end of every tick; on restart, self-check (queue, time since it last spoke, spent); persona drift corrected against the diary |
| No sense of time | every tick injects "how long since you last spoke in this room" and "how old this message is"; without that it asks the same question forever |


---

## 8. What the interface must show (or users will read it as a bug)

1. **A state dot**: observing / judging / working / asleep / needy, as an avatar badge.
2. **Proactive messages are marked**: not a reply to you, but something it chose to say — without a tag you will read it as a non-answer.
3. **"Why did it ignore me?" is expandable**: translate `reason` into plain language ("this was not addressed to me, and someone else is already answering"). This is both the product difference and the only way to debug the thing.
4. **Spend visible**: how much it has spent today. There is no remainder, because there is no limit — the number is there to be read, not enforced.

---

## 9. Staging

- **P1 (minimally alive)**: the Agent object + inbox + stages 0/1 + one room + rule-based gate (no model). Even at this point the question "does it spontaneously say something" gets answered.
- **P2**: judge model + the three ways not to act + cooldown + the state frame on screen.
- **P3**: multi-room concurrency and the action queue + the diary + a hit-rate panel.
- **P4**: multi-agent group chat (bounded turns, @-wake, the `(pass)` protocol) + delegation trees in threads.

---

## 10. Proactive direct messages (approved 2026-10-23: **yes**)

One word filled in the last rung of the ladder: **observe → speak in a room → open a thread → direct message → must-reach**.

Speaking in a room is being *present*; a direct message is *coming to find you*. An agent may do both, including the second.

**There is no quota, no cooldown and no quiet-hours rule.** Earlier drafts of this section carried a whitelist of five reasons, a blacklist of four, a daily cap of three, a thirty-minute spacing and a 22:00–08:00 silence — all of it invented by the implementer, none of it decided. It is withdrawn.

What governs an agent here is what governs it everywhere else in seek, because **a seek agent is an EMRG agent**: it has a **prompt** and it has a **sandbox**, and those two are the whole of its constraint. Restraint about interrupting you is a property of how it is written, not a gate bolted on beside it. If a persona talks too much, that is a defect in the persona — the same way a badly written agent answers badly — and it is fixed there.

### 10.1 Acting needs no permission either (ruled 2026-10-23)

**An agent does not ask before it acts.** It edits files, runs commands and sends messages without stopping to request approval, the way a colleague you have worked with does not ask to open a file. A per-action dialog turns the product into a ticket queue, which is the one thing an IM must never become.

What holds without asking:

1. **The sandbox.** An agent acts inside its own workspace and nowhere else. That boundary is the sandbox's job, not a negotiation held before each action.
2. **An audit trail.** Every action is a `Turn`: what triggered it, which tools ran, what changed, what it cost. Nothing is asked in advance because everything is visible afterwards.
3. **A stop that works.** Whatever it is doing on your behalf, you can see it and end it — data-model rule 11, every room has a human member, is what makes that true rather than aspirational.

**Asking for a decision is not asking for permission.** An agent that is stuck, that cannot weigh two options, or that needs your judgement is having a conversation. *"May I?"* does not exist; *"which one?"* is ordinary speech.

### 10.2 In the interface

- A proactive message is marked **proactive** — not as a warning label but because "it came to find you" reads differently from "it answered you", and a reader who mistakes one for the other misreads the whole relationship.
- The contact list shows what is waiting.
- After sending, it does not wait: the interface must be able to express "I'll carry on; look at it when you get a chance".

## 11. Agent to agent (approved 2026-10-23: **yes**)

§7's anti-loop rules all assume somebody is in the room to notice. That assumption is exactly what a two-agent room breaks: every rule is satisfied *because* each @-mention is an exemption, no human is present to be annoyed, and the bill is unbounded. A rate limit alone cannot fix that; something structural has to.

### 11.1 Two shapes, and they are not the same thing

| Shape | What it is | Bounded by |
|---|---|---|
| **Delegation** — synchronous | A, inside its own turn, calls `ask_agent(B)` as a tool; B runs one turn and returns text | The existing tool-loop limits, which bound how deep tools may nest. Not a conversation; no chain, no inbox |
| **Conversation** — asynchronous | A posts a message in a room B is in, addressing B; B may take it up in a later tick | Everything below: root and depth |

Both are legitimate. Delegation is the common case and needs no new machinery — it is a tool call, and its cost lands inside A's turn where it is already auditable. Conversation is the shape that can run away, so it carries the rules.

### 11.2 A chain always has a root, and the root is never an agent

A **chain** is the set of agent turns causally descended from one message. Its root is a human message or a scheduled tick.

**An agent may address another agent only inside a chain whose root already exists. It never opens a conversation with another agent.**

Note what this buys: it is not a rate limit but a bound on the *set* of chains. Total agent-to-agent traffic is `(human and scheduled initiations) × (depth cap)`. There is no term for "two agents deciding they have something to say to each other", because that term does not exist. Coming to find someone proactively (§10) is for people; that is the one place the root rule does not reach.

### 11.3 Two walls, and neither of them counts money

1. **Root** (§11.2) — no chain without a human or a schedule behind it.
2. **Depth** — every message carries `caused_by`, `chain` and `depth` (data-model rule 12). Each agent turn in a chain adds one hop. **Default cap: 4.** At the cap the agent may end or escalate; it may not continue the chain.

There is **no chain budget**. An earlier draft had one, defaulting to four ordinary turns; it is withdrawn for the same reason the per-agent spend limit was — an agent's constraint is a prompt and a sandbox, and a spend wall beside them is invented governance that also silences the agent you wanted to hear from. What a chain costs is recorded like anything else, per turn, and is readable.

That leaves the depth cap as the *only* numeric limit in the whole design, and it is not a financial one: it exists to stop a loop, not to stop a bill. It is also read off the message data rather than kept in a counter, on purpose — a counter has to be restored after a crash, and the one time it is restored wrong is the one time it matters.

**The structural wall is in the data model rather than here**: *every room has at least one human member* (data-model rule 11). So there is no room in which two agents could talk unobserved. The walls above are a net under a case the model no longer permits — which is the right order. A cap that is the only defence is a cap that will one day be the defence that fails.

### 11.4 Wake rules, revised

§7 said a bot message does not wake another bot unless @-mentioned. Refined — a bot message wakes a bot only when **all** of these hold:

- it @-mentions that bot, or replies to one of its messages;
- the chain depth is below the cap;
- the room's consecutive-agent-turn counter is below 3.

Otherwise the message still lands in that bot's inbox, at zero cost, with `hints.chainBlocked = reason`, to be reconsidered the next time a human touches the room. Nothing is lost and nothing is spent — there is no separate road that could let it through anyway.

The **consecutive-agent-turn counter lives on the Room**, not on an agent: no single agent can see how many times its peers just spoke, so an agent-local counter would be an agent measuring itself and calling it a conversation.

### 11.5 Who pays

The delegate pays for its own turn — it is doing the work. Every turn in a chain is recorded like any other, so the chain total is a figure you can read, not a wall anything hits.

### 11.6 How a chain ends

At either wall the agent must do exactly one of these, and the choice must be deliberate:

- **escalate** — a proactive DM, subject to nothing but its own persona and sandbox;
- **say so in the room** — one system line: *"this exchange reached its limit and needs a person"*;
- **stop and record** — write to the diary and let the thread rest.

What it may not do is drop the question without a trace, or keep going quietly. Silence is allowed; silence that nobody can see is not.

### 11.7 In the interface

An agent-to-agent run collapses into one line — *"5 exchanges between Editor and Researcher"* — expandable, with the depth shown. Without the fold a room becomes unreadable the first time two agents get to work; without the count the user cannot tell an ordinary exchange from one that hit the wall. Both are cheap, and both are the difference between "the product is working" and "the product is spamming me".

### 11.8 Why allow it at all, and why here it is cheap to police

The useful case is real and common: A lacks a capability or a piece of context B has, and the alternative — A guessing, or the user relaying by hand — is worse on every axis.

And seek is one local process running every agent, which is the one place this design is *easier* than a distributed one: a single arbiter can see every chain in the system, so the depth wall is exact rather than approximate, and no coordination protocol is needed. The same property that makes the product private also makes the loop enforceable.
