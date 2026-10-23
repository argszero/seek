# Long-lived agent design (seek kernel)

> Settled by the host on 2026-10-23: **every bot is a complete agent**, differing from an ordinary agent in three ways —
> **long-lived, observes on its own, acts on its own**. If the agent sits in a room where someone speaks without
> mentioning it, that message is still delivered to it and lands in its own watch queue. Inside the agent there is a
> **main loop**, and that loop is the core of its life. Every tick it first decides from the watch data whether to act
> (rules / events / a cheap model / a local model — this is where the money is saved, because a permanently alive
> agent must not burn tokens when nothing is called for). Only after a positive verdict does it enter the real agent
> loop. The agent also has a direct "receive a message and handle it" path, used when someone talks to it directly or
> @-mentions it — the same as today's EMRG conversation.
>
> The interaction layer above this (rooms, messages, the sense of presence) is in `~/.emrg/designs/seek-mental-model.md`.

---

## 0. In one sentence

**An agent = one identity + one inbox + one main loop that never stops, in two stages.**
The first stage spends only what is affordable to look; the second spends what is affordable to act.
All the saving lives in the first stage: **the overwhelming majority of messages should die there, and dying there must cost nothing.**

---

## 1. Three paths (fix the boundaries first)

| Path | Trigger | Cost | What it feels like |
|---|---|---|---|
| **A Direct** | DM, @-mention, or a reply to its own message | The full agent loop (tools, full context, streaming) | Today's EMRG conversation |
| **B Observe** | A message in a room that does not name it | **Zero** (lands in the inbox only) | A person sitting in a meeting, listening |
| **C Main loop** | Wakes on a timer or an event, looks at the inbox | Cheap judgement first, pay only if it hits | A person deciding "this one I should answer" |

A is "someone called me". C is "I decided I should speak". **B never spends anything** — that is the cost foundation of the whole design. Any implementation where an un-addressed message triggers a model call is already wrong.

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
│   state: asleep | observing | judging | working | quiet (budget spent) | blocked (waiting for approval)
│   lastSpoke[room] / lastTick / sleepUntil / backoff
│   budget: tokens per hour and per day, spent, resets at
└─ Sessions
    session[room] (one session per room; a group room is shared, but "its" context is its own)
```

**Agent ≠ Session.** EMRG today presses the identity into the session (the session is that cwd, that model, that history), so one identity cannot live in three rooms at once. The Agent sits above the session; sessions are its stretches of memory.

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
  ┌ Stage 0 · zero-cost gate (pure local computation, no model)
  │  1. Budget spent?          → state=quiet, end of tick (and visible outside)
  │  2. Inside cooldown?       → unless @-mentioned, end of tick
  │  3. No new entries?        → increase backoff, sleep longer, end of tick
  │  4. Rule says ignore? (pure emoji / my own message / another bot's broadcast / muted room)
  │                            → mark them ignore, end of tick
  │  5. Rule says act? (@-mentioned / replied to / a must-answer subscription)
  │                            → go straight to stage 2 (skip the judge, save the money)
  │  6. Everything else → stage 1
  │
  ├ Stage 1 · cheap judgement (one call, summaries only)
  │  input: why it woke + a one-line summary of the last N messages in that room + roomDigest
  │         + my job/interests (+ how long since I last spoke here)
  │  model: model.judge (local small model / cheapest cloud model), no tools, max_tokens capped
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
| Direct path A | unchanged | — |
| Observe path B | room fan-out (frame broadcast exists, but only to connected clients) | server-side **fan-out into every member agent's inbox** (persisted, not in memory) |
| Judge model | `llm.py` already selects a model per session | a call shape with no tools, a low `max_tokens` cap and a mandatory JSON reply |
| Memory | `memory_store`: session and project levels | add an **agent level** (across rooms and sessions) |
| State visibility | frame broadcast | a new frame: `agent_state` (observing / judging / working / asleep / quiet) |

**An honest cost**: today's daemon presses "identity" and "runtime" into the same `EmrgServer`, and the busy table, cancel table and contexts are all keyed by session. Running many agents in one process needs another layer keyed by agent. It is doable; the work is real.

---

## 7. Avoiding the ways this kind of system dies

| Failure | Mechanism |
|---|---|
| **Two bots wake each other and never stop** | ①`fromAgent` marks bot messages, which do not wake other bots unless @-mentioned ②a cap on consecutive bot turns per room (grok-bot uses 3) ③a forced cooldown after acting |
| The judge is too cheap → deaf and blind | hit rate observable; per-agent thresholds; what it ignored can be reviewed (entries and reasons are kept) |
| The judge is too expensive → burning money | budget as a first-class citizen: over budget means `quiet`, and the interface says so plainly (never let the user think it died) |
| Inbox explosion | a cap plus collapse into the room digest |
| Long-lived means creeping corruption | checkpoint at the end of every tick; on restart, self-check (budget, queue, time since it last spoke); persona drift corrected against the diary |
| No sense of time | every tick injects "how long since you last spoke in this room" and "how old this message is"; without that it asks the same question forever |


---

## 8. What the interface must show (or users will read it as a bug)

1. **A state dot**: observing / judging / working / asleep / quiet, as an avatar badge.
2. **Proactive messages are marked**: not a reply to you, but something it chose to say — without a tag you will read it as a non-answer.
3. **"Why did it ignore me?" is expandable**: translate `reason` into plain language ("this was not addressed to me, and someone else is already answering"). This is both the product difference and the only way to debug the thing.
4. **Budget visible**: how much it has spent today, how much is left.

---

## 9. Staging

- **P1 (minimally alive)**: the Agent object + inbox + stages 0/1 + one room + rule-based gate (no model). Even at this point the question "does it spontaneously say something" gets answered.
- **P2**: judge model + the three ways not to act + budget and cooldown + the state frame on screen.
- **P3**: multi-room concurrency and the action queue + the diary + a hit-rate panel.
- **P4**: multi-agent group chat (bounded turns, @-wake, the `(pass)` protocol) + delegation trees in threads.

---

## 10. Proactive direct messages (approved 2026-10-23: **yes**)

One word filled in the last rung of the ladder: **observe → speak in a room → open a thread → direct message → must-reach**.

### 10.1 What changes qualitatively
Speaking in a room is being *present*; a direct message is *coming to find you*. The first is budgeted in tokens, **the second is budgeted in interruptions**. Talking a lot in a group is lively; too many DMs is harassment — so everything in this section is about being rare and right.

### 10.2 The five cases worth interrupting you (a whitelist, written into the persona)

1. **Blocked**: without a decision it cannot go on.
2. **Already handled on your behalf**: someone asked something only it could answer, it answered, and it brings you the original plus the conclusion.
3. **A long-running task of yours has reached a conclusion** (a conclusion, not a progress report).
4. **An anomaly**: a scheduled task failed, a PR was rejected, CI went red, the budget is being burned.
5. **Something it cannot judge and must not guess**.

### 10.3 What must not be a DM

- Restating what was just said in the room.
- "Here is what I did today" work reports with no conclusion.
- A second message on the same subject (dedupe key = subject + room + counterpart; one subject follows one thread — no new conversation each time).
- "Are you there?" while it is already waiting for your answer.

### 10.4 Three hard gates

| Gate | Default | Note |
|---|---|---|
| Per day | 3 | "Blocked" does not count against the quota, but at most once a day |
| Minimum spacing | 30 minutes | Between two proactive DMs |
| Quiet hours | 22:00–08:00 | Even "blocked" sends only once, and says plainly that it can wait until tomorrow |

When the quota is spent, it degrades to a room message, and the state stays visible (you can see in the room that it wanted to say something but held back).

### 10.5 When you do not answer

- An unanswered DM is marked `unanswered`, and **the same subject is never re-sent**.
- Three `unanswered` in a row → that agent halves its own proactive frequency; one reply from you restores it.
- It never asks "just confirming?" again. Silence is information, not a refusal, and it should keep working.

### 10.6 Speaking is free, doing needs permission

**Speaking up needs no approval. Any action with side effects** — sending messages in your name, editing files, running commands, spending money — **is asked first**.
This line sits ahead of sandbox tiers, because what it protects is not files but "you not knowing what it is doing on your behalf".

### 10.7 In the interface

- A proactive DM carries a **"proactive"** tag **and must carry one line of reason** ("the task you gave me just failed"). No reason, no message — the reason line is mandatory, and it is the only basis you have for judging afterwards whether to trust it.
- The contact list shows "1 proactive message".
- After sending, it does not wait: the interface must be able to express "I'll carry on; look at it when you get a chance".
