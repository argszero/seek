# Long-lived agent design (seek kernel)

> Settled by the host on 2026-10-23: **every bot is alive**, differing from an ordinary agent in three ways —
> **long-lived, observes on its own, acts on its own**. If a bot sits in a room where someone speaks without
> mentioning it, that message is still delivered to it and lands in its **watch queue**. The bot has a
> **main loop**, and that loop is the core of its life — **the only loop there is**, and a tick of it happens when
> something is delivered, not on a timer (the clock was considered and deferred on 2026-10-23). Every tick it first
> decides from the watch data whether to act (rules, then one call to a local model — this is where the money is saved,
> because a permanently alive bot must not burn tokens when nothing is called for). A direct message or an @-mention is
> not a separate road out of this loop: the gate sees it and passes it straight through.
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
| **A reminder I scheduled coming due** | The inbox, as an entry of `kind: "reminder"` | **Pass** — same as an @-mention (§12) |

**One wake source: a delivery** (ruled 2026-10-23, and the schedule ruled 2026-10-24 did not change it). A delivery into the inbox starts a tick; with nothing delivered, nothing runs at all. **What the schedule added is a second producer of deliveries, not a second way to wake** — the clock itself is still deferred, and §12 says why the two are not the same thing.

**What deferring the clock cost, and how much of it the schedule repaid.** Both costs were written down on 2026-10-23 and neither is smoothed over; the schedule ruled the next day moved the line, and it is worth seeing exactly which half moved.

- ①*Proactive outreach was reachable only while awake* — a bot could open a conversation with you (§10) or with another bot (§11.2), but only inside a tick somebody else's message had already started, so "it came to find you" always had a message upstream. **Repaid.** A bot can leave itself a reminder (§12) and act on it; the upstream entry is then its own yesterday's note rather than somebody's fresh message. What is *not* repaid: nothing makes a bot act at an instant it never wrote down.
- ②*Nothing could wake on time*, so a `snooze` conditioned on "in five minutes" had nothing behind it. **Repaid**, by the loop writing a row (§12) and the row firing as a delivery.

**What the deferral bought is still bought.** With no timer, there is **no idle path**: a bot with nothing delivered and nothing due is not running, so nothing has to be argued about what an idle tick may call. The schedule did not reopen that question, because its comparator is not a tick and touches no bot — it compares a number. **The question that would come back with a real clock has not come back**: nothing wakes a bot but a delivery, still.

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
│   lastSpoke[room] / lastTick        ← no interval and no sleep-until:
│                                       nothing wakes a bot on time (2026-10-23)
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
  "kind": "text|image|file|toolcard|system|reminder",
  "text": "……",
  "hints": { "mentionsMe": false, "asksQuestion": true, "repliesToMe": false,
             "keywordHit": ["release", "schedule"], "roomTemperature": "busy" },
  "state": "new" }
```

- **Every entry is a delivery, and there are two producers of deliveries** (2026-10-23: the clock was deferred, and with it the `kind: "clock"` entry that would have carried a timer's own facts; 2026-10-24: the schedule was ruled, and its due rows *are* deliveries). A person or another bot sends a message, or a schedule entry comes due — either way one entry lands in one inbox, and the tick that follows is the same tick. **This retires a claim that used to be true and is now false**: the queue no longer holds only messages from someone else, because a bot may leave itself a reminder (§12) and that entry's author is itself. What survives is the part that mattered — an entry is never *synthesised by the loop to have something to judge*, so stage 0's first rule (no new entries, end of tick) is still the only exit that fires on an empty queue.

- `hints` are scored **by the producer, not by a model**: @ detection, question marks, whether it replies to me, keyword matches, message density. All of it is string and counting work that costs nothing.
- **`mentionsMe` and `repliesToMe` are bot-level facts** (ruled 2026-10-23). They are computed once, when the message lands, against the bot — not per agent. No agent ever scans a room for its own name, and the watch agent could not: it is not addressable, so "an @ to me" is a question only the bot can answer. That is what makes stage 0's fast-pass a rule rather than a model call.
- **`mentionsMe` is derived, not stored on the message** (ruled 2026-10-23: *"look at `mentions` and see whether its own name is in there"*). The message carries Feishu's own field, `mentions[]` — the principals it names, `{id, name}` each — and that is the only stored form. Delivery finds **this bot's id** in that array and records the boolean here, on this bot's entry. Nothing in `hints` is ever written back onto the message: the message is written once and stays clean, and the next bot derives its own answer from the same bytes.
- State machine: `new → watched (act | ignore | snooze | keep) → consumed`; `snooze` carries a condition ("when this gets a reply", "in five minutes"). An entry that stage 0 fast-passes skips `watched` and goes `new → consumed` — including one injected into a turn already running (§4).
- **The inbox is also the running turn's queue.** There is no second, in-memory pending list as in EMRG, because every entry is already on disk before any turn starts: a message that arrives mid-turn is the same entry, read again at the next round boundary (§4). One queue, one "already handled" state, no reconciliation between an arrival queue and a work queue.
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
  │  2. Rule says act? (@-mentioned / replied to / DM / my own reminder coming
  │     due — read off the bot's own hints, computed at delivery; "@-mentioned"
  │     means this bot's id appears in the message's mentions[]) → stage 2
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
  │  effect: act → stage 2, carrying the observation entries and nothing else
  │          no act → record the verdict and the reason if one came back, end of tick
  │          unparseable → treated as no act, and counted as a watch agent failure
  │
  └ Stage 2 · run the work agent (expensive)
     Stage 2 calls the work agent and lets it run — identical to one EMRG turn today:
     full context + tools + streaming + memory write at the end.
     It receives the observation entries and nothing else: NOT the watch agent's
     reason (see "what crosses the line" below).
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

### What crosses the line from watch to work (ruled 2026-10-23)

**The observation entries cross; the watch agent's reasoning does not.**

When the watch agent decides to act, the work agent is woken with the entries and nothing more — not the line the watch agent wrote about why they mattered. It reads its own history and its own memory and decides for itself what, if anything, to say.

**Why not pass the reason: the work agent would start depending on a 300 MB model's judgement without knowing it.** A reason in the context is not advice, it is a premise — the expensive model reads it as a fact about the world and builds on it. Where the watch agent is wrong, the work agent would not correct it, it would amplify it, and the amplification would look like coherence.

**The cost, stated plainly:** sometimes the work agent will look at the entries and cannot tell why it was called at all. It may then say something slightly flat-footed, or ask what the point was. That is a real cost and it is the right side of the trade: a bot that looks a little slow is better than a bot whose confidence is borrowed from a model nobody chose to trust.

**The reason is still recorded** — on the observation entry, next to the verdict — because it is what makes a bad call reviewable, and because the watch agent reads its own log back. It just never enters the work agent's context.

### How slow a judgement is

**The latency target stays a target, not a guarantee.** The common judgement is one call with no tool round in the low hundreds of milliseconds. A judgement that does call a tool costs a second round, and a 300 MB local model calling `bash` will rarely be worth it — so the expected shape is that the watch agent almost never uses its tools, while nothing forbids it and no separate toolset has to be maintained. Rules have already settled most traffic before it is called at all.

### Backoff — still gone, and the schedule does not bring it back

**There is still no interval to back off from.** Earlier drafts carried an exponential interval — one minute up to eight hours, EMRG's `_heartbeat_interval` reused — computed *from nothing*, which is only meaningful if something ticks when the queue is empty. That was withdrawn with the clock on 2026-10-23, and the schedule ruled on 2026-10-24 does not restore it: the schedule is a table plus a comparator, and the comparator runs whether or not any bot needs anything (§12). Backing off would mean making the table miss its own due times.

What remains true, and is now satisfied in two different ways: **a quiet agent must consume almost nothing**, because that is the only premise under which "long-lived" is affordable. A bot with nothing delivered and nothing due satisfies it **absolutely** — no delivery, no tick, no call. The comparator that watches the schedule satisfies it **cheaply but not for free** — it compares a number once in a while, calls no model, and touches no bot. Any future mechanism has to earn its place against the same standard.

### Concurrency

A bot runs exactly **one** stage 2 at a time — one turn, held by a lock, as in EMRG (`_session_busy[session_id]`, `daemon.py:1759`). When several rooms want it at once, the entries wait in the inbox, ordered: @-mention > someone waiting for an answer > high salience > the room it has been silent in the longest.
The reason is not performance but **identity consistency**: two parallel conversations would make its persona and memory fight each other.

### A message that arrives while the agent is running (ruled 2026-10-23 — EMRG's steer, kept as it is)

The host's words: *"same as EMRG — when a new direct message arrives, wait for the tool run to finish and then insert the new information."* EMRG does exactly this, and two naive readings of it are both wrong: **the running turn is not cancelled and it does not swallow the message, and the message is not held until the turn ends either.** It is inserted at the **round boundary** — after the current round's tools have returned, before the next model request (`daemon.py:4574-4578`, at the round head inside the tool loop). One turn therefore looks like:

```
model → tools run → [inject] → model → tools run → [inject] → … → done
```

never `tools run → the message interrupts`, and never `the turn ends → a new turn starts`.

Six things EMRG does around that insertion, and what carries over:

1. **One turn per session, by a lock.** A second message never starts a second turn; it queues.
2. **Arrival while busy is queued per session, FIFO** (`daemon.py:1760-1770`), and the sender is told its position (`task_queued` with `position`) — so "queued" is visible, not guessed.
3. **The drain is one atomic `pop` of the whole list** (`daemon.py:3992`), never read-then-clear. Anything appended while the drain waits on a broadcast lands in a fresh list and goes in at the next boundary; the docstring's own words are *"Never dropped."* This is the part that is easy to get wrong: read-then-clear silently loses exactly the message that arrived during the window.
4. **Each injected message becomes a real record in the history**, written once with its timestamp at commit, and a `steer_committed` frame carries that same stamp (`daemon.py:4000-4022`). So compaction rebuilding from history keeps it, and nobody has to invent a time for it later.
5. **The round budget is refreshed for the injected messages, not spent on them.** If the turn has exhausted its round cap and the queue is not empty, the drain hands the new messages a fresh budget instead of stranding them; only an *empty* queue produces the "Exceeded maximum rounds" error (`daemon.py:4540-4548`). seek has no quota anywhere else, so it follows: a message can lengthen a turn, and nothing caps it.
6. **Nothing is ever dropped silently.** EMRG ends a clean turn by broadcasting the still-queued request ids and letting the **client re-send** them (`queued_requeue`, `daemon.py:4160-4172`), and drops the queue only when the turn was cancelled, errored or disconnected (`queued_cancelled`).

**Two divergences, both of them deletions, both because seek's queue is already on disk.**

- **seek needs no requeue contract.** EMRG's pending list is in-memory only, so the client has to re-send. In seek the delivery wrote a persistent entry into the bot's inbox *before* any turn started, so **the in-flight queue is the inbox**. The turn ends, the loop reads the inbox again, and if anything is left that the gate would act on, the next turn starts at once. No frame, no client contract, nothing to re-send — and one fewer way to lose a message. The hazard `queued_requeue` exists for is still ours to hold, and it is now a line of the loop rather than a protocol: **a delivery that arrives mid-turn must not be stranded when that turn ends.**
- **An injected message is marked `consumed` at the moment it is injected.** In EMRG a cancelled turn drops its queue, so a queued prompt can vanish unread. Here the entry is already a fact on disk and the human's message is visible in the room either way, so the honest record is "this was taken up" — a stop point after injection does not resurrect it, and the person can simply say it again.

**Which arrivals are injected at all.** In EMRG every inbound prompt is addressed to that session by construction, so the drain injects everything. seek's one inbox holds both *for me* and *possibly not for me*, and pushing the second kind into a running turn is exactly what the gate exists to prevent. So the injected set is stage 0's **fast-pass set** — an @-mention, a reply to its own message, a direct message — and a plain room message waits in the inbox for the next turn. This follows the host's own word (直达, *direct*) and the gate already ruled, and it is the only reading that keeps a message no one has judged from landing in the middle of a job.

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
| **Idle, in this design** | **zero** — no delivery, no tick, no call | the clock was deferred (2026-10-23), so there is no idle path to pay for and nothing to argue about what an idle tick may call |

**There is no idle row to defend, and that is the deferral's real gift.** A draft ruled earlier the same day added a timer, and with it a `kind: "clock"` entry so an idle bot would reach the watch agent — which meant an idle bot paying one local inference per tick, and the design owing an answer about what a bare tick may call. Dropping the clock withdrew the mechanism and the question together. If a clock is ever added back, both come back with it, and the line to hold will be the same: an idle tick may reach the watch agent and must never reach the *work* agent.

One correction to the table's denominator: traffic arrives **per message**, but a message costs work **per bot in the room** — ten bots and one message is ten inbox entries. The figures above hold only because stage 0 is free per bot; the moment any per-bot step costs a call, the multiplication matters and the table understates it.

**The schedule comparator is the one background cost in the design, and it is not on this table** because it is not tokens: it reads the clock, compares it with the next due row and sleeps otherwise, calling no model and touching no bot. What it must never become is a tick — the moment the comparator calls a model to find out that nothing is due, this table is wrong by a factor of sixty per bot per hour.

**Injection does not add a row to this table.** A direct message that arrives mid-turn lengthens the turn it lands in — one more round after the model re-reads its context — instead of starting a turn of its own. The saving is the turn's whole setup; the cost is that the context is sent again, which is what a round costs anyway. What can grow without a cap is only the length of one turn, and that is deliberate (§4, point 5).

(Order-of-magnitude estimates, not measurements.)

Because the watch agent is an agent on a local model, **watch tokens are not money.** The billed column above is only stage 2 — the expensive model actually acting — and it dropped by roughly a third against the pre-ruling table, from ≈23k to ≈7.5k, purely because 15k of watch tokens stopped being billed. What replaced that cost is wall-clock: a local inference per watched batch, in the low hundreds of milliseconds, off the GPU, while the room is live. That is the number the watch model is actually chosen against.

**The gate's hit rate is the product's cost curve.** So it must be observable and tunable: every agent records `watched` (batches watched), `acted` (hits), `ratio` (hit rate) and `spent` (tokens). A hit rate that suddenly jumps to 50% means a persona is written wrong or a room has been flooded by bots — and that has to be visible in the interface.

---

## 6. How it meets the EMRG kernel (without a rewrite)

| Component | What exists today | What is new |
|---|---|---|
| Agent identity | `projects.yml` → `agents.yml` (already decided) | the fields in §2 |
| Main loop | `TaskHandler` (`scheduler.py:982`): heartbeat, interval/backoff, bounded cycles, stop/trigger/status, resume after restart | a new task type that runs stages 0 and 1 — **driven by delivery, not by the scheduler's heartbeat**: EMRG's interval machinery is not what calls it, and a bot must never be woken by a beat |
| Schedule | `TaskHandler`'s timer infrastructure exists, and `_heartbeat_interval` is the same shape | a **comparator over one global table** (§12) whose only output is a delivery. It runs on a timer; the timer's fingerprints must not reach a bot — nothing a bot sees may say "a beat happened" |
| Stage 2 · action | today's session turn (`_run_tool_loop_locked`) | open with "you chose to speak". **Nothing else**: an earlier draft required three closing records, which was never ruled and was withdrawn 2026-10-23 |
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
| **Two bots wake each other and never stop** | ①`fromAgent` marks bot messages, which do not wake other bots unless @-mentioned, replied to, or a direct message ②a cap on consecutive bot turns per room (grok-bot uses 3), held **on the Room** — this is what bounds a burst ③the depth cap, which bounds how long one chain runs (§11). **There is no root rule any more** (withdrawn 2026-10-23): a bot may open a conversation with another bot, so the number of chains is bounded by nothing but judgement and the record |
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

**This section is about coming to find a person, and since 2026-10-23 the same act toward another bot is allowed too** — see §11.2, where the root rule was withdrawn. A bot opening a direct room with another bot is the same behaviour with a different recipient, and it carries the same absence of quota.

**There is no quota, no cooldown and no quiet-hours rule.** Earlier drafts of this section carried a whitelist of five reasons, a blacklist of four, a daily cap of three, a thirty-minute spacing and a 22:00–08:00 silence — all of it invented by the implementer, none of it decided. It is withdrawn.

What governs an agent here is what governs it everywhere else in seek, because **a seek agent is an EMRG agent**: it has a **prompt** and it has a **sandbox**, and those two are the whole of its constraint. Restraint about interrupting you is a property of how it is written, not a gate bolted on beside it. If a persona talks too much, that is a defect in the persona — the same way a badly written agent answers badly — and it is fixed there.

### 10.1 Acting needs no permission either (ruled 2026-10-23)

**An agent does not ask before it acts.** It edits files, runs commands and sends messages without stopping to request approval, the way a colleague you have worked with does not ask to open a file. A per-action dialog turns the product into a ticket queue, which is the one thing an IM must never become.

What holds without asking:

1. **The sandbox.** An agent acts inside its own workspace and nowhere else. That boundary is the sandbox's job, not a negotiation held before each action.
2. **An audit trail.** Every action is a `Turn`: what triggered it, which tools ran, what changed, what it cost. Nothing is asked in advance because everything is visible afterwards.
3. **A stop that works.** Whatever it is doing on your behalf, you can see it and end it. The sandbox and the turn ledger are what make that true; an earlier draft also leaned on "every room has a human member", which is withdrawn (data-model rule 11) — so being able to *find* what an agent did is now carried entirely by the record, not by a membership rule.

**Asking for a decision is not asking for permission.** An agent that is stuck, that cannot weigh two options, or that needs your decision is having a conversation. *"May I?"* does not exist; *"which one?"* is ordinary speech.

### 10.2 In the interface

- A proactive message is marked **proactive** — not as a warning label but because "it came to find you" reads differently from "it answered you", and a reader who mistakes one for the other misreads the whole relationship.
- The contact list shows what is waiting.
- After sending, it does not wait: the interface must be able to express "I'll carry on; look at it when you get a chance".

## 11. Agent to agent (approved 2026-10-23: **yes**)

§7's anti-loop rules all assume somebody is in the room to notice. That assumption is exactly what a two-agent room breaks: every rule is satisfied *because* each @-mention is an exemption, no human is present to be annoyed, and the bill is unbounded. A rate limit alone cannot fix that; something structural has to.

### 11.1 One shape: a message (ruled 2026-10-23)

**All interaction is IM** (ruled 2026-10-23: *"all interaction is expressed in IM — group chat and direct messages"*). So an agent reaching another agent is not a tool call: it is a **message**, posted into a room the other bot is in, or into a direct room between the two. It lands in that bot's inbox like anything a person says, and that bot's own loop decides what to do with it — including deciding not to.

An earlier draft of this section had a second shape: a synchronous `ask_agent(B)` tool, where B ran one turn inside A's turn and returned text. **Withdrawn, on two grounds.** It is a tool the kernel does not have — EMRG's registry is fixed and `subagent` opens a child session of *the same* agent, not another bot — and it inverts the thing that makes a bot a bot: B decides for itself, on its own wake-up, what to take up. A synchronous call has **A deciding for B**.

What "delegation" still means is the **intent**, not a mechanism: "do this and report back" is a message that asks for work, and conversation is a message that asks a question. Both are messages, both enter the same inbox, and both carry the same chain.

### 11.2 A chain may begin with an agent (ruled 2026-10-23)

**The root rule is withdrawn.** It said a chain's root is a human message or a scheduled tick, and that an agent never opens a conversation with another agent. (What the rule named as its other root — a scheduled tick — is a reminder from the global schedule, ruled 2026-10-24 and described in §12; the rule's withdrawal does not depend on it either way.) Ruled instead: **a bot may say the first word to another bot** — in a room both are in, or in a direct room it opened for that purpose.

Two reasons, both of them the host's own earlier rulings rather than new ones. A bot may already open a conversation with a **person** (§10, approved); the root rule was the only thing that forbade the identical act toward a peer, and that asymmetry was not asked for anywhere. And what the rule actually protected — a bound on the *set* of chains — is a bound nothing else was leaning on, given that a chain's length is capped by depth and a room's burst by the turn counter.

**What the ruling costs, recorded plainly.** The set of chains is no longer bounded by *human and scheduled initiations × depth*; that arithmetic is gone with the rule. Every new conversation starts a fresh chain at depth 0, so **depth bounds how long a chain runs, not how many chains a bot may start**. Concretely: a bot can open a conversation with another bot whenever its judgement says to, and no count, interval or approval stands in the way. This is the same trade already accepted for proactive messages to people — there is no quota there either, and the fix for an agent that talks too much is its persona, not a wall. What remains true is that everything is on the record: every conversation is a room, every message is in a log, every turn is in the ledger.

### 11.3 One wall that counts hops

1. **Depth** — every message carries `caused_by`, `chain` and `depth` (data-model rule 12). Each agent turn in a chain adds one hop. **Default cap: 4.** At the cap the agent may end or escalate; it may not continue the chain.
2. **The room's consecutive-agent-turn cap** (§11.4) — three bot turns in a row in one room, and further bot messages stop waking bots there. This is what bounds a burst; depth alone never did, because a burst of short exchanges uses few hops.

There is **no chain budget**. An earlier draft had one, defaulting to four ordinary turns; it is withdrawn for the same reason the per-agent spend limit was — an agent's constraint is a prompt and a sandbox, and a spend wall beside them is invented governance that also silences the agent you wanted to hear from. What a chain costs is recorded like anything else, per turn, and is readable.

That leaves the depth cap as the *only* numeric limit on a chain, and it is not a financial one: it exists to stop a loop, not to stop a bill. It is also read off the message data rather than kept in a counter, on purpose — a counter has to be restored after a crash, and the one time it is restored wrong is the one time it matters.

**The data model does not wall this off, and an earlier draft was wrong to say it did.** That draft carried a rule — *every room has at least one human member* — written by the implementer at 20:12, never ruled, and contradicted by the ruling that all interaction is IM, group or direct: a direct room between two bots is exactly a room with no human in it. **Withdrawn** (data-model rule 11). No rule any more assumes someone is present to notice; what holds is depth, the turn cap, and the record.

### 11.4 Wake rules, revised

§7 said a bot message does not wake another bot unless @-mentioned. Refined — a bot message wakes a bot only when **all** of these hold:

- it @-mentions that bot, replies to one of its messages, or is a **direct message** (a DM is addressed by construction);
- the chain depth is below the cap;
- the room's consecutive-agent-turn counter is below 3.

Otherwise the message still lands in that bot's inbox, at zero cost, with `hints.chainBlocked = reason`, to be reconsidered the next time a human touches the room. Nothing is lost and nothing is spent — there is no separate road that could let it through anyway.

The **consecutive-agent-turn counter lives on the Room**, not on an agent: no single agent can see how many times its peers just spoke, so an agent-local counter would be an agent measuring itself and calling it a conversation.

### 11.5 Who pays

**Whoever runs the turn pays.** A asks B by sending a message; that message ends A's part and costs A its own turn, and when B takes it up B runs a turn of its own and B's account records it. There is no way for A's turn to contain B's work, now that there is no synchronous call — which is the auditing property the withdrawn tool shape would have blurred. Every turn in a chain is recorded like any other, so the chain total is a figure you can read, not a wall anything hits.

### 11.6 How a chain ends

At the depth cap or the room's turn cap the agent must do exactly one of these, and the choice must be deliberate:

- **escalate** — a proactive DM, subject to nothing but its own persona and sandbox;
- **say so in the room** — one system line: *"this exchange reached its limit and needs a person"*;
- **stop and record** — write to the diary and let the thread rest.

What it may not do is drop the question without a trace, or keep going quietly. Silence is allowed; silence that nobody can see is not.

### 11.7 In the interface

An agent-to-agent run collapses into one line — *"5 exchanges between Editor and Researcher"* — expandable, with the depth shown. Without the fold a room becomes unreadable the first time two agents get to work; without the count the user cannot tell an ordinary exchange from one that hit the wall. Both are cheap, and both are the difference between "the product is working" and "the product is spamming me".

### 11.8 Why allow it at all, and why here it is cheap to police

The useful case is real and common: A lacks a capability or a piece of context B has, and the alternative — A guessing, or the user relaying by hand — is worse on every axis.

And seek is one local process running every agent, which is the one place this design is *easier* than a distributed one: a single arbiter can see every chain in the system, so the depth wall is exact rather than approximate, and no coordination protocol is needed. The same property that makes the product private also makes the loop enforceable.

---

## 12. A global schedule every bot can write to (ruled 2026-10-24)

**One table, one tool, and a due row arrives as a message.** The host's words: *"provide a global schedule — a tool for every bot to read and write it (when, what reminder, which bot); when an entry comes due, send the reminder to that bot automatically, as a direct message, equivalent to an @-mention."*

### It is not the clock coming back

The timer was withdrawn twice on 2026-10-23, and **neither reason survives this shape**:

- It was **one heartbeat per bot** — machinery every bot paid for its own sake. This is one table in the process and one comparator that reads the clock. No model call, no per-bot state, nothing that grows with the number of bots.
- It left **"what wakes a bot whose queue is empty?"** unanswerable. Here **nothing wakes a bot**: a row coming due at 09:00 is *a message written into one bot's inbox at 09:00*, and a delivered message wakes it exactly as a person's would. The wake rule is untouched, word for word; the schedule is a **second producer of deliveries**, beside people and other bots.

That distinction is the whole of it, and it is worth stating as a rule the implementation can be checked against: **the schedule may produce deliveries, and it may never produce ticks.** A bot woken by "it is 09:00" rather than by an entry in its inbox is the defect.

**What it repays.** The deferral's first recorded cost was that a purely message-triggered agent cannot keep a promise: with nothing upstream, "I will look at this tomorrow" had no way to come true. A bot can now leave itself that reminder and come back to it. It got the ability **by adding a producer of messages, not by adding a wake source** — which is why the earlier argument against the clock and this ruling are not in conflict.

### The row

```json
{ "id": "...", "to": "bot_id", "at": 1698123456789,
  "text": "remind me to check the release thread",
  "createdBy": "agent_id", "createdAt": 1698123456789,
  "state": "pending | fired | cancelled" }
```

**There is no `room` field, and there will not be one** (ruled 2026-10-24: *"no need to display it"*). A reminder is the bot talking to itself; it reaches the inbox and stops there. See "what the user sees" below for the cost of that.

- `to` is **a bot**, never an agent — the inbox is the bot's (§3), and an agent has no lifecycle of its own.
- `text` is delivered **verbatim**: not summarised, not translated, not rewritten by any model on the way out. What the author wrote is what the bot reads back, and that is what makes a reminder a note to its future self rather than a fresh instruction.
- One table, **every bot reads and writes it** — the host's words. So a bot can see what other bots have scheduled. That is a shared calendar rather than a private one, and it is recorded as a consequence rather than a gap: nothing filters the table by `to`.
- `state` moves once, and never backwards. A `fired` row is kept for a while and then pruned; a `cancelled` row is a tombstone, because "I had planned this and dropped it" is information its author may want back.

### The tool

**`schedule` — the host's one named exception to "the tool set is EMRG's, unchanged".** It has three verbs and nothing else: **list**, **add**, **cancel**. No "run now", no recurrence, no priority, no condition language — a bot that wants to be reminded tomorrow writes the moment it means. It is available to every agent in `agents.yml` like any other tool, so which agents may use it is ordinary configuration and not a mechanism.

**`snooze` with a time condition is performed by the loop, not by the watch agent.** The watch agent emits a verdict; the loop performs it (§4). So "not now, in five minutes" produces a schedule row written **by the loop**, and when it fires the original entry comes back. The watch agent still needs no tool call for this, which keeps its judgement at the one round the latency target was written for.

### Firing

A firing is **one write, and it is idempotent**: the row's `state` becomes `fired` in the same step that drops the delivery into the inbox, keyed by the row's `id`. A daemon that was closed when a row came due fires it on the next start — an instant missed is **not** a reminder skipped, and ten rows missed while the laptop slept fire in time order, each as its own delivery. Dropping them silently would be the same defect the injection path refuses (§4).

### What the user sees, and what they do not (ruled 2026-10-24)

**A fired reminder is not displayed.** It lands in the bot's inbox; no room shows it, no frame carries it, and the transcript does not gain a line. The user sees what the bot does about it and nothing else.

**Why this does not break "all interaction shows up in IM":** that rule is about how the bot reaches *other principals*, and a reminder reaches nobody. There is no second party to show it to. Putting it in a room would invent one — a system line addressed to everyone in a room, describing a note one bot left for itself.

**The cost, recorded rather than smoothed:** the interface shows **an effect without its cause**. A bot that speaks at 09:00 because of a note it wrote yesterday looks unmotivated on screen, and a user cannot tell "it kept a promise" from "it decided to talk". That is the same shape of cost as the watch agent's withheld reasoning (§4) — the half that talks shows its conclusions, not its workings — and the same answer applies: **it is recoverable by reading, not by showing**. The schedule row and the turn that fired it are both on the record, so the question *"why did it say that just now"* has an answer; the transcript simply does not volunteer it.

### What it costs, recorded

1. **The inbox can now hold an entry the bot wrote to itself.** The 2026-10-23 claim that it never could is retired (§3). What survives is the reason it existed: an entry is still never synthesised by the loop to give itself something to judge — a schedule row is a real thing somebody wrote, at a real stated moment.
2. **A new tool exists**, against a standing rule that the tool set is EMRG's. The host named it; it is not an exception the implementer may widen. A `calendar` tool, a `cron` tool or a `remind` tool appearing beside it means the exception was read as a licence.
3. **A shared writable table brings the usual three problems** — stale rows, unbounded growth, and two bots scheduling the same moment for the same bot. None is solved by a mechanism here: growth is bounded by pruning `fired` rows, and the rest is the same trade already accepted for everything else a bot does — its persona and the fact that all of it is on the record.
4. **A bot can call itself awake forever.** A reminder takes the fast-pass (§4, stage 0 rule 2), so it does not count toward a room's consecutive-bot-turn cap — that cap exists to stop two bots trading turns in a room, and a bot reminding itself is not a conversation in a room. The loophole is real: a bot could schedule a reminder for its own next round, indefinitely. It is the same trade as the absent quota on proactive messages (§10), with the same defence, and it is written down rather than gated.
