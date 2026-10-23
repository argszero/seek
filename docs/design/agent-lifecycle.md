# Long-lived agent design (seek kernel)

> Settled by the host on 2026-10-23: **every bot is alive**, differing from an ordinary agent in three ways —
> **long-lived, observes on its own, acts on its own**. If a bot sits in a room where someone speaks without
> mentioning it, that message is still delivered to it and lands in its **watch queue**. The bot has a
> **main loop**, and that loop is the core of its life — **the only loop there is**. Every tick it first decides from
> the watch data whether to act (rules, then one call to a local model — this is where the money is saved, because a
> permanently alive bot must not burn tokens when nothing is called for). A direct message or an @-mention is not a
> separate road out of this loop: the gate sees it and passes it straight through.
>
> The interaction layer above this (rooms, messages, the sense of presence) is in `~/.emrg/designs/seek-mental-model.md`.

---

## 0. In one sentence

**A bot = one identity + one inbox + one main loop that never stops, in two stages; an agent = a model, a prompt, tools and a memory, called by that loop.**
The first stage spends only what is affordable to look; the second spends what is affordable to act.
All the saving lives in the first stage: **the overwhelming majority of messages should die there, and dying there must cost nothing.**

Keeping the inbox and the loop on the bot is what keeps an agent small (ruled 2026-10-23). An agent stops being a process with a life of its own and becomes a **runnable**: a model, a system prompt, a tool list and a memory, executed when the bot's loop calls it — the same shape as an EMRG session or an ADK `LlmAgent`. Everything alive — watching, deciding, waking, spending, being muted — belongs to the bot.

### Why the first stage has to exist at all

EMRG is **trigger-driven**: nothing runs until something calls it, so an idle agent costs nothing by construction. An agent in seek is **alive** — it keeps watching rooms, and rooms keep producing messages nobody addressed to it. Aliveness is the product; it is also, without a gate, an open tap.

So the watch stage is not an optimisation added to a design that would work without it. **It is what makes aliveness affordable**, and it answers two requirements at once:

1. **It must stop meaningless work.** A room full of other people talking about something that has nothing to do with it is the normal state of a busy room, and every one of those messages must cost nothing to disregard.
2. **It must itself be almost free.** A gate that costs a little per message is not a gate, it is a smaller bill.

### Behind every bot there are two agents: one watches, one works (ruled 2026-10-23)

**The two roles are named `watch` and `work`** (ruled 2026-10-23, replacing "judge" and "the working agent"). The names were chosen from the vocabulary already in the design rather than invented for the roles: the bot's inbox is the **watch queue**, the bot "keeps watching rooms", and the expensive agent's job was already the **work**. So `watch` reads the watch queue and `work` does the work, and a third role later — say `recall` — lands in the same register instead of fighting it.

One watches, one works. Both are agents in the full sense — each has a persona, its own session history, its own memory store, its own turns on the audit trail. **They do not share memory.** What they share is that **each knows the other exists and can read the other's history and memory** (ruled 2026-10-23).

| | The watch agent | The work agent |
|---|---|---|
| Model | `model.watch` — local, bundled, small | `model.work` — whatever expensive model the bot is configured with |
| Window | small (thousands of tokens) | large (as much as the model offers) |
| What it does | answers one question: does anything here concern me? | does the work, speaks in the room, uses tools |
| What it costs | wall-clock, in the low hundreds of milliseconds | money |
| What it remembers | its own compact log: what it looked at, what it decided, how the room usually goes | the full record: everything it did and said |

**Why they must not share one memory: the two windows are an order of magnitude apart, and compaction is destructive.** A shared log means the small-window agent compacts first and, reading its own 4k window, deletes detail the large-window agent can still read. That is not thrift, it is amnesia — and it is silent, because nothing in the room shows the moment a memory was thrown away. Two stores, each compacted against its own window, removes the collision rather than managing it.

**Why they must be able to read each other: an agent that cannot see its own other half invents a reason.** The failure to design against is the split-brain one: the acting half does something, the half that talks to you has no record of why, and it produces a confident explanation that is simply wrong. So the read channel is not an integration nicety, it is what keeps the bot honest about *"I said nothing there"* and *"I already answered that"*.

**Cross-reading is not free, and the two directions cost different things.** The work agent reading the watch agent's log is billed tokens on an expensive model, so it is **on demand, not injected into every turn** — pulled when it matters (the user asks why it stayed quiet; it is about to speak in a room it has been ignoring). The watch agent reading the work agent's log costs no money but costs latency, so it reads a **bounded** slice, never the whole record.

**There is no watch-specific input pipeline.** The watch agent sends the same shape of request the work agent sends — its own history, its own memory, its own compression — because it is an agent, not a classifier. Nothing is summarised on its behalf and no second context has to be kept in sync.

The watch model is **shipped with the product** — no download step, no "install Ollama first", no dependence on what the user's machine happens to have installed.

It never fires on every message, because rules run first and settle most of them for nothing:

| Order | Check | Cost | Verdict |
|---|---|---|---|
| 1 | **No new observations at all** | nothing | **Return.** There is nothing to look at; the tick ends here |
| 2 | **@ me, a reply to my message, or a direct message** | nothing | **Act.** Straight to stage 2 — there is nothing to decide |
| 3 | Muted room, my own message, another bot's broadcast | nothing | Ignore |
| 4 | Everything else | one small-model call | The model decides |

The ordering is the whole economy of the design: the two cases that are both **certain and free** are settled before anything runs, so the model is only ever asked about the genuinely ambiguous remainder — a group of people talking near it, without naming it.

#### What the watch model must be (requirements, ruled 2026-10-23 — the choice itself is deferred)

| # | Requirement | Why |
|---|---|---|
| 1 | **Multilingual: Chinese and English at minimum**, more is better | The product is international from the first screen, and a room's shape follows its people, not a setting. A watch agent that only reads English is blind in exactly the rooms where it is needed |
| 2 | **Multimodal: it must see images** | Messages carry screenshots, photos, diagrams and tool cards. Deciding "is this about me?" from alt text alone is guessing |
| 3 | **Bundled, not downloaded** | The gate is what makes aliveness affordable; making it depend on the user fetching anything means it silently is not there |
| 4 | **Small enough to ship inside an app** — target ≤ 300 MB of weights | Installers are the first thing a user meets |
| 5 | **Runs on a plain CPU, quantised** | It runs per message per agent on ordinary laptops, not on a GPU |
| 6 | **Fast enough that looking is invisible** — a watch agentment in the low hundreds of milliseconds | A gate slower than the thing it gates is not a gate |

**Requirements 2 and 4 pull against each other, and that is the real difficulty.** Measured on 2026-10-23 (bf16 weights as published):

- SmolVLM2-500M-Video-Instruct — **2.0 GB**
- Qwen3-VL-2B-Instruct — **4.3 GB**
- Qwen2.5-VL-3B-Instruct — **~4.0 GB per shard, two shards**

A multimodal model at 300 MB therefore means a very small base or aggressive quantisation (4-bit divides by roughly four, which brings a 500M model to ≈500 MB and a 2B model to ≈1.1 GB). The requirement set is kept as written and the trade is decided at selection time, against real cases — not by quietly dropping the image requirement or the size target.

---

## 1. One path, not three (ruled by the host, 2026-10-23)

There is **one** delivery path and **one** loop. A message to a room is delivered into every member **bot's** inbox and costs nothing to receive. The loop then runs; stage 0 reads the inbox and decides what to do with it. An @-mention, a reply to its own message, or a direct message is not a second road — it is **a fast-pass inside stage 0**: the gate recognises it and sends it straight to stage 2, skipping the watch, because there is nothing to decide.

| What arrives | Where it lands | What stage 0 does |
|---|---|---|
| A DM, an @-mention, a reply to its own message | The inbox, like everything else | **Pass** — straight to stage 2, no watch call |
| A room message that names nobody | The inbox | Everything else: rules, then the watch agent |
| A scheduled tick | No message; the loop wakes anyway | Looks at whatever has accumulated |

Why this matters more than it looks: with two roads, the same message could be answered twice — once by the direct road and once by a later tick that finds it still in the inbox. With one road there is nothing to reconcile, no "mark it handled" bookkeeping, and no ordering rule between two runners.

**Receiving never spends anything.** That is the cost foundation of the whole design. Any implementation where an un-addressed message triggers a model call is already wrong.

---

## 2. The two objects

Everything alive sits on the bot; everything that runs sits on an agent.

```
Bot                                     ← the contact: what a room shows and @-mentions
├─ Identity
│   id / name / avatar / description    ← the only copy of the identity; pushed down to agents
├─ Attention
│   rooms[]        ← which rooms it watches
│   interests[]    ← keywords / topics / "answer when someone asks about X" subscriptions
├─ Watch queue (the inbox, see §3)      ← ONE queue per bot, whatever runs behind it
├─ Life state
│   state: asleep | watching | working | needy (waiting on your decision)
│   lastSpoke[room] / lastTick / sleepUntil / backoff
│   spent: tokens, observed and reported — a number, never a limit
└─ agents[]  ──▶  each is a runnable the loop calls (see below)

Agent                                   ← a runnable, not a process
├─ id / bot / role                     ← which bot it belongs to, and which job it does there
├─ model                               ← its own: the work agent's expensive one, or
│                                        the watch agent's local bundled one
├─ prompt + persona                    ← how it speaks, which is now all "who it is" means
├─ tools[] / sandbox / limits          ← EMRG's existing registry, unchanged; which tools
│                                        a given agent is allowed is ordinary per-agent
│                                        configuration, not a new mechanism
├─ reads[] / readableBy[]              ← the mutual read path (see "a bot is N agents" below)
├─ memory
│   diary (its own markdown memory, across sessions and rooms)
│   roomDigest[room] (rolling summary per room — its own memory, not a watch-agent input format)
└─ Sessions
    session[room] (its own stretch of work in each room; a new one starts when it
    changes workspace — private bookkeeping, never shown to the user)
```

**The split falls where the kernel already falls.** A model, a system prompt, a tool list and a history are exactly what an EMRG session holds and what an ADK `LlmAgent` holds; a clock, a queue, a state machine and a budget of tokens are what a long-lived process holds. Putting the second half on the agent is what made the earlier draft complicated — and putting it on the bot means an agent is only ever "the thing that runs when called", with no lifecycle to design.

### A bot is N agents, and a bot is not an agent (ruled 2026-10-23)

**Bot and Agent are two entities with two jobs.** The bot is the contact and the living thing: it owns the name, the avatar and the description, it owns the inbox and the loop, and it is what a room shows and what an @-mention names. The agents are the runnables behind it: each owns a persona, a model, a session and a memory, and runs when the bot's loop calls it. **The bot pushes its identity down to its agents** — an agent has no name of its own, only a `role` — so renaming a bot reaches every agent at once, and the room never sees two contacts where there is one.

**`agents.yml` registers agents, not bots.** Each bot is at least two rows today — one that watches, one that works — and nothing caps it at two: a bot that later needs a third role gets a third row. This is cheap because each row is a plain runnable: a model, a prompt, tools, a memory. No lifecycle to write for it, because the lifecycle is the bot's.

**The split runs through the whole model**, and it is what keeps both sides honest: membership, @-mention, a room's list of people, the inbox, the tick and the state machine are **bot-level** (so a bot has one queue and one clock however many agents work behind it); session, memory, turn and cost are **agent-level** (so the audit trail says exactly which worker acted, and the bill is per worker). Rules 14 in `data-model.md` states the cardinality.

**One inbox is what removes the hard problem.** With a queue per agent, every message would be delivered N times and each agent would keep its own "already handled" state, and the loop would have to reconcile N of them. With one queue on the bot, delivery is a single write, the tick is a single loop, and stage 0 decides once — then the loop calls whichever agent the decision names.

**Agent ≠ Session.** EMRG today presses the identity into the session (the session is that cwd, that model, that history), so one identity cannot live in three rooms at once. Here the **bot** sits above the sessions, and an agent's sessions are its stretches of memory — that is what lets one contact be present in three rooms at once while each agent keeps one continuous thread per room.

**A session is never a user-visible unit either.** The room's timeline is continuous, the way a chat is in Feishu; five agents in one room simply have five private spans over the same shared log. That is not a display decision but the load-bearing one: it is what makes "messages shared, context private" true by construction.

> This connects to the instruction already given on 2026-10-23: `projects.yml` → `agents.yml`, one agent per project.
> That `agent-abstraction-step1.md` is the first step (abstract the Agent out); this document is the second (give the Agent a life).

---

## 3. Watch queue (the inbox) — one per bot (ruled 2026-10-23)

**The inbox belongs to the bot, not to an agent.** A message to a room is delivered once, into the bot's watch queue; the bot's loop reads that queue and decides, and only then does an agent run. Agents do not watch rooms — the bot does, and the `watch` agent is what it asks.

That is the whole reason the queue is here: delivery is one write per (bot, message) instead of one per (agent, message), there is one "already handled" state instead of N, and the tick stays one loop instead of a fan of loops to reconcile.

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
- **`mentionsMe` and `repliesToMe` are bot-level facts** (ruled 2026-10-23). They are computed once, when the message lands, against the bot — not per agent. No agent ever scans a room for its own name, and the watch agent could not: it is not addressable, so "an @ to me" is a question only the bot can answer. That is what makes stage 0's fast-pass a rule rather than a model call.
- State machine: `new → watched (act | ignore | snooze | keep) → consumed`; `snooze` carries a condition ("when this gets a reply", "in five minutes").
- **Capacity**: per (bot, room) a cap such as 200 entries / 24 hours. Over the cap, entries are not dropped — they collapse into one line inside the bot's `roomDigest`. Otherwise the inbox becomes a second message log and blows up both disk and context.
- The inbox is append-only and the writer **never blocks** (room fan-out must not stall because one bot is busy).
- A verdict is written on the entry, and it is written by the **loop**, not by the agent that produced it — the watch agent only answers; the loop performs (see §4).

---

## 4. The main loop: two stages

This is the core of the whole design:

```
the bot's loop, per tick:
  ┌ Stage 0 · rules only, no model (settles everything that is certain and free)
  │  1. No new observations?   → end of tick, before anything else is considered
  │  2. Rule says act? (@-mentioned / replied to / DM — read off the bot's own
  │     hints, computed at delivery) → straight to stage 2
  │  3. Rule says ignore? (my own message / another bot's broadcast / muted room)
  │                            → mark them ignore, end of tick
  │  4. Everything else → stage 1 (call the watch agent)
  │
  ├ Stage 1 · the loop calls the watch agent (an agent, so it has tools)
  │  input: its own history for this room, its own memory, the persona, why it woke,
  │         plus — when it matters — a bounded slice read from the work agent's log
  │  model: model.watch — local, bundled (no download, no network), max_tokens capped
  │  tools: the same registry EMRG already gives an agent (bash / read / write / edit /
  │         glob / grep / subagent / submit_rant / boss). Nothing new is invented for
  │         this design — memory writes and compaction are not tools at all, they are
  │         what the runtime does at the end of a turn, exactly as in EMRG
  │  output: one decision the loop can act on — the FORM is the implementation's choice
  │          (a single word, a label from a fixed set, a tiny JSON, whatever this model
  │           produces reliably). What matters is that it is unambiguous and parseable
  │  effect: act → stage 2, carrying the messages it decided to care about
  │          no act → record the verdict and the reason if one came back, end of tick
  │          unparseable → treated as no act, and counted as a watch agent failure
  │
  └ Stage 2 · run the work agent (expensive)
     Stage 2 calls the work agent and lets it run — identical to one EMRG turn today:
     full context + tools + streaming + memory write at the end.
     One difference: it opens with "you decided to say this yourself; nobody called you",
     because nothing called it and the reason it woke is context, not a request.
```

### Why two stages

Because **the work agent spends money and the watch agent does not.**

The watch agent is a local model on the user's machine, so its tokens cost nothing; the work agent runs whatever expensive model the bot is configured with, and every call is billed. That moves the watch agent's budget from money to **wall-clock** — which is why requirement 6 (a verdict in the low hundreds of milliseconds) is not a nicety but the real constraint, and why the verdict must stay small: a local model writing a long answer is a local model that makes the app stutter.

It is also why two agents rather than one agent asked two questions: the two windows are an order of magnitude apart. A 4k window cannot hold what a 200k window holds, so the small one needs its own history, compacted to its own shape. Forcing them into one store would either starve the watch agent (fed a log it cannot fit) or truncate the work agent (its history compacted to 4k's convenience).

It raises a risk honestly: a weak local model with a history of its own can produce a confident wrong verdict. Two answers: **what the watch agent ignored is reviewable** — every verdict is recorded with the entry it watched, so a deaf gate is visible rather than silent — and **the work agent can read the watch agent's log**, so a wrong call is discoverable by the half that talks to the user.

### How the watch agent finds out it was wrong (ruled 2026-10-23)

**It reads the outcome off the record it already has.** When the watch agent forwards an observation and the work agent then says nothing in that room, that is visible: the entry it dispatched has no message after it. Next time the watch agent meets the same room, its own memory holds the line it wrote — *"I forwarded this and nothing was said"* — and it can weigh that before deciding again.

No new machinery is built for this. The outcome is not reported to the watch agent by anyone: **it is already on the board**, because a turn that produced no message is a fact of the same data model everything else reads. The watch agent only has to look.

**And it is not learning.** The weights do not move; nothing is trained; no rule is written down for the future. At most the watch agent accumulates its own observations, exactly as any agent's memory does, and a better-informed next watch is all that follows.

**It is also fine if it learns nothing.** If the watch agent never gets meaningfully better, the design still holds: what keeps it honest is the record being reviewable and the work agent being able to read it, not the watch agent improving over time. Nothing downstream may depend on the watch agent getting smarter — no decay schedule, no "wait until it has seen enough", no accuracy target. A weak watch agent with a visible record is an acceptable watch agent; a hidden one is not.

### Three ways to decide not to act

- `ignore`: this is not about me. Consume the entry.
- `snooze`: not now, but possibly later (the question is still unanswered, someone else should speak first). Re-queue with a condition (in five minutes / when this gets a reply / when the room calms down).
- `keep`: no need to speak, but I should remember (someone is discussing my area). Take no action; keep the line.

`keep` matters: it makes an agent "present but not interrupting", which is the most human thing about being permanently alive.

**The watch agent does not perform its own verdicts.** It emits a decision; the loop performs the consequence — `ignore` consumes, `snooze` re-queues, `keep` appends the line. That is why the verdict's shape is free: a word is enough, because the runtime already knows what each one means.

**Both agents get EMRG's toolset, unchanged** (ruled 2026-10-23: *"just use the EMRG set"*). There is no watch-specific tool, no memory tool and no compaction tool to build — the tool registry is the one already in the kernel, and which tools a given agent is allowed is ordinary per-agent configuration in `agents.yml`, not a mechanism this design introduces.

**Memory writes and compaction are not tools in EMRG, and they will not be here.** They are what the runtime does when a turn ends, and an agent does not choose to do them. So "the watch agent needs tools to manage its memory" was wrong on the facts: it has tools because it is an agent, and its memory is maintained for it the same way.

**The latency target stays a target, not a guarantee.** The common judgement is one call with no tool round in the low hundreds of milliseconds. A judgement that does call a tool costs a second round, and a 300 MB local model calling `bash` will rarely be worth it — so the expected shape is that the watch agent almost never uses its tools, while nothing forbids it and no separate toolset has to be maintained. Rules have already settled most traffic before it is called at all.

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
| Every message to the expensive model (the naive port) | 500 × ~1500 = **750k billed** | broke within a day |
| Every message to the local watch agent only (no stage 0) | 500 × ~300 = 150k **local, unbilled** | no bill — but one local inference per message, and each one is latency in the app |
| **This design**: 90% stopped free, 10% watched locally, 5% of those act | 50 × 300 local (unbilled) + 2.5 × 3000 = **≈7.5k billed** | affordable |
| Leaner: watch only when a batch has piled up | another order of magnitude down | at the cost of slower reactions |

(Order-of-magnitude estimates, not measurements.)

Because the watch agent is an agent on a local model, **watch tokens are not money.** The billed column above is only stage 2 — the expensive model actually acting — and it dropped by roughly a third against the pre-ruling table, from ≈23k to ≈7.5k, purely because 15k of watch tokens stopped being billed. What replaced that cost is wall-clock: a local inference per watched batch, in the low hundreds of milliseconds, off the GPU, while the room is live. That is the number the watch model is actually chosen against.

**The gate's hit rate is the product's cost curve.** So it must be observable and tunable: every agent records `watched` (batches watched), `acted` (hits), `ratio` (hit rate) and `spent` (tokens). A hit rate that suddenly jumps to 50% means a persona is written wrong or a room has been flooded by bots — and that has to be visible in the interface.

---

## 6. How it meets the EMRG kernel (without a rewrite)

| Component | What exists today | What is new |
|---|---|---|
| Agent identity | `projects.yml` → `agents.yml` (already decided) | the fields in §2 |
| Main loop | `TaskHandler` (`scheduler.py:982`): heartbeat, interval/backoff, bounded cycles, stop/trigger/status, resume after restart | a new task type `agent-tick` running stages 0 and 1 |
| Stage 2 · action | today's session turn (`_run_tool_loop_locked`) | open with "you chose to speak"; require the three closing notes |
| Delivery into the inbox | room fan-out as a frame broadcast, but only to connected clients | server-side **fan-out into every member bot's inbox** (persisted, not in memory) — the one road in, for every kind of message |
| Watch agent | `llm.py` already selects a model per session, and `session.compact()` already keeps a history per session | a **second row in `agents.yml` per bot**: same machinery, its own session and memory, a local model, smaller windows, a low `max_tokens` cap, and a read path to its sibling. Tools are EMRG's existing registry, unchanged — no watch-specific tool is added. Any unparseable verdict counts as no act |
| Memory compaction | `session.compact()` rewrites the session's history in place | nothing to change *in kind*: each agent already has its own session file, so the two stores are separate by construction. What must be checked is that no code path compacts across them |
| Memory | `memory_store`: session and project levels | add an **agent level** (across rooms and sessions) |
| State visibility | frame broadcast | a new frame: `agent_state` (watching / working / asleep / needy) |

**An honest cost**: today's daemon presses "identity" and "runtime" into the same `EmrgServer`, and the busy table, cancel table and contexts are all keyed by session. Running many agents in one process needs another layer keyed by agent. It is doable; the work is real.

---

## 7. Avoiding the ways this kind of system dies

| Failure | Mechanism |
|---|---|
| **Two bots wake each other and never stop** | ①`fromAgent` marks bot messages, which do not wake other bots unless @-mentioned ②a cap on consecutive bot turns per room (grok-bot uses 3), held **on the Room** ③the root and depth rules, which bound the set of chains without a cooldown — §11 is the full treatment: the root rule and the depth cap bound the set of chains, and "every room has a human member" removes the case where none of this can be noticed |
| The watch agent is too cheap → deaf and blind | hit rate observable; per-agent thresholds; what it ignored can be reviewed (entries and reasons are kept) |
| The watch agent is too expensive → burning money | spent is recorded and visible per agent, so a runaway bill is *seen* rather than silently capped. There is no self-stop: a bill that climbs is a defect in the persona or the gate, and it is fixed there, not papered over by a limit that also silences the agent you wanted to hear from |
| Inbox explosion | a cap plus collapse into the room digest |
| Long-lived means creeping corruption | checkpoint at the end of every tick; on restart, self-check (queue, time since it last spoke, spent); persona drift corrected against the diary |
| No sense of time | every tick injects "how long since you last spoke in this room" and "how old this message is"; without that it asks the same question forever |


---

## 8. What the interface must show (or users will read it as a bug)

1. **A state dot**: watching / working / asleep / needy, as an avatar badge.
2. **Proactive messages are marked**: not a reply to you, but something it chose to say — without a tag you will read it as a non-answer.
3. **"Why did it ignore me?" is expandable**: translate `reason` into plain language ("this was not addressed to me, and someone else is already answering"). This is both the product difference and the only way to debug the thing.
4. **Spend visible**: how much it has spent today. There is no remainder, because there is no limit — the number is there to be read, not enforced.

---

## 9. Staging

- **P1 (minimally alive)**: the Agent object + inbox + stages 0/1 + one room + rule-based gate (no model). Even at this point the question "does it spontaneously say something" gets answered.
- **P2**: the watch agent (a second agent per bot, local model, own memory, cross-reading) + the three ways not to act + the state frame on screen.
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

**Asking for a decision is not asking for permission.** An agent that is stuck, that cannot weigh two options, or that needs your decision is having a conversation. *"May I?"* does not exist; *"which one?"* is ordinary speech.

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
