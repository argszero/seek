# Long-lived agent design (seek kernel)

> **Every bot is alive.** It differs from an ordinary agent in three ways: **long-lived, observes on its own, acts on its own**. A message in a room that does not mention it is still delivered to it and lands in its **watch queue**. The bot has a **main loop**, and that loop is the core of its life — **the only loop there is**. A tick happens when something is delivered, never on a timer. Every tick it first decides from the watch data whether to act: rules first, then one call to a local model. That is where the money is saved, because a permanently alive bot must not burn tokens when nothing is called for. A direct message or an @-mention is not a separate road out of this loop — the gate sees it and passes it straight through.

---

## 0. In one sentence

**A bot = one identity + one inbox + one main loop, in two stages; an agent = a model, a prompt, tools and a memory, called by that loop.**
The first stage spends only what is affordable to look; the second spends what is affordable to act.
All the saving lives in the first stage: **the overwhelming majority of messages die there, and dying there costs nothing.**

Keeping the inbox and the loop on the bot is what keeps an agent small. An agent is not a process with a life of its own — it is a **runnable**: a model, a system prompt, a tool list and a memory, executed when the bot's loop calls it. That is the same shape as an EMRG session or an ADK `LlmAgent`. Everything alive — watching, deciding, waking, spending, being muted — belongs to the bot.

### Why the first stage exists at all

EMRG is **trigger-driven**: nothing runs until something calls it, so an idle agent costs nothing by construction. An agent in seek is **alive** — it keeps watching rooms, and rooms keep producing messages nobody addressed to it. Aliveness is the product; it is also, without a gate, an open tap.

So the watch stage is not an optimisation on a design that would work without it. **It is what makes aliveness affordable**, and it answers two requirements at once:

1. **It must stop meaningless work.** A room full of other people talking about something that has nothing to do with it is the normal state of a busy room, and every one of those messages must cost nothing to disregard.
2. **It must itself be almost free.** A gate that costs a little per message is not a gate, it is a smaller bill.

### Behind every bot there is one agent, and a judgement that is not one

**The two roles are named `watch` and `work`**, taken from vocabulary the design already had: the bot's inbox is the **watch queue**, the bot keeps watching rooms, and the expensive agent's job is the **work**. `work` names the agent. `watch` names the decision the bot takes before it wakes that agent — **not a second runnable**: no model of its own, no prompt, no store, no session, no tools. The bot's main loop makes it, and a bot's roster therefore has one row, not two.

**One of the two runs; the other answers.** The work side is a chat model that generates, runs tools and speaks into a room. The watch side is a local decision model read through the box, and all it produces is an answer drawn from options declared in advance. They are not two kinds of runnable, because only one of them is a runnable at all.

| | the judgement (`watch`) | the agent (`work`) |
|---|---|---|
| Model | `model.watch` — local, bundled, small, decision-only | the model this machine is configured with |
| Window | small (thousands of tokens) | large (as much as the model offers) |
| What it does | answers named questions in one forward pass, generating nothing | does the work and speaks by calling the speaking tool, addressed to a room |
| What it costs | wall-clock, tens to low hundreds of milliseconds | money |
| What it keeps | nothing of its own — it reads the bot's box and holds no session | its sessions, its diary, and the compaction it writes into the box |

**Why the summary has one writer: the half that can write, writes.** A decision model emits a choice, a score or a probability and no text, so a summary of its own is not something it could produce. Resolving it the other way — giving the watch side a small chat model so it could compact itself — buys a paragraph at the price of a generation on every wake, which is the latency the gate exists to avoid. **One writer also removes a collision instead of managing it**: two writers of one summary is a disagreement that only shows up when they differ.

**Why the reason never reaches the agent's context: a reason handed over is a premise, not advice.** The failure to design against is the split-brain one — the acting half repeats what the judgement got wrong, and the repetition looks like coherence. So the judgement's sentence is never assembled into a work turn. **It is not hidden, though**: the verdict and the reason behind it sit on the entry they were written on, and the work agent may go and read them. What is forbidden is the silent handoff, not the lookup.

**Reading that record is not free.** It is billed tokens on whatever model the machine is configured with, so it is **on demand, never injected into every turn** — pulled when it matters (a person asks why the bot stayed quiet; it is about to speak in a room it has been ignoring).

**There is no watch-specific input pipeline — there is the bot's box, and the judgement is read off it.** What the judgement reads is that bot's **two-part box** (§3): the last compaction and the observations that have arrived since, plus the last verdict. That is the whole of its input: nothing is assembled for it at decision time, no second context has to be kept in sync, and it reads as it stands even when the compaction is empty. The one thing the watch side does not do is write — the compaction is the work agent's, because a decision model produces no text (§3).

The watch model is **shipped with the product** — no download step, no dependence on what the user's machine happens to have installed.

Rules run first and settle most messages for nothing:

| Order | Check | Cost | Verdict |
|---|---|---|---|
| 1 | **No new observations at all** | nothing | **Return.** There is nothing to look at; the tick ends here |
| 2 | **@ me, a reply to my message, a direct message, or my own reminder coming due** | nothing | **Act.** Straight to stage 2 — there is nothing to decide |
| 3 | Muted room, my own message, another bot's broadcast | nothing | Ignore |
| 4 | Everything else | one small-model call | The model decides |

The ordering is the whole economy of the design: the two cases that are both **certain and free** are settled before anything runs, so the model is only ever asked about the genuinely ambiguous remainder — a group of people talking near it, without naming it.

#### What the watch model must be

| # | Requirement | Why |
|---|---|---|
| 1 | **Multilingual: Chinese and English at minimum**, more is better | The product is international from the first screen, and a room's shape follows its people, not a setting. A watch side that reads only English is blind in exactly the rooms where it is needed |
| 2 | **Multimodal: it must see images** | Messages carry screenshots, photos, diagrams and tool cards. Deciding "is this about me?" from alt text alone is guessing |
| 3 | **Bundled, not downloaded** | The gate is what makes aliveness affordable; making it depend on the user fetching anything means it silently is not there |
| 4 | **Shippable inside an app** — as it stands one weight file, 1.72 GiB | Installers are the first thing a user meets |
| 5 | **Runs on a plain CPU, quantised** | It runs per message per agent on ordinary laptops, not on a GPU |
| 6 | **Fast enough that looking is invisible** — low hundreds of milliseconds | A gate slower than the thing it gates is not a gate |

**Requirement 4 used to be a target of 300 MB, and measurement withdrew it.** The target was set before any candidate was run. On real room traffic a model that size does not judge: `LFM2.5-VL-450M` (219 MB) scores **AUC 0.477** on act-or-not — chance — and `Qwen3.5-0.8B` (508 MB) scores **0.484**. The 3B class scores **0.96–1.00**, in both languages, across three disjoint case sets. The size target was standing in for "cheap enough to bundle", and a bundled model that cannot judge is the more expensive mistake: the gate then either wakes the bot for everything or for nothing.

**What ships is `d1-2B`** — one file of 1.72 GiB, and not a chat model at all: a decision model that is asked a typed question and answers with one probability per declared answer. In a room of four bots it reads **16 of 16** — the named bot at 0.88–0.95, the three that were not named at 0.26–0.41, and a prompt that names nobody under 0.58 for all four — and on set4 it separates **24 of 24** at the shipped cut, the lowest `act` at 0.625 against the highest of everything else at 0.582. A judgement takes 45–61 ms and repeats itself to the digit.

**What that measurement does and does not cover.** It covers **text**, and only text: 76 hand-written room cases, 44 of them Chinese, judged against labels written before the prompts were chosen. Two things are therefore still open rather than settled. **Requirement 2 is unmet, and no longer merely unmeasured**: the model that ships declares `modalities.vision: false` and the endpoint takes the box as a string, so a picture has nowhere to go — and the judgement does not guess at it from a caption either, it refuses the entry and says why. Nothing here may be read as saying images are unnecessary. And a small model's discrimination is **sensitive to the exact wording** of the question: on the same model, changing one prompt moved AUC from 0.09 to 0.77, and the 450 MB model inverted between English and Chinese. So the question below is part of the specification, not a detail of whoever writes the prompt.

#### How the judgement is put to the model

- **One typed question, to an endpoint built for one.** The judgement posts the box and one named question to `llama.cpp`'s `/v1/systemone` and reads back one calibrated probability per declared answer — `answers.respond.probabilities.act`. Nothing is generated: the endpoint reports no output tokens, so there is no first token to read and nothing to sum. `act` and `ignore` are the whole of what it can answer; `later` is written by the loop when a turn schedules a reminder and `keep` when the bot already has that room in flight — neither is a question to ask, because the answer is one of the options that were declared or nothing at all.
- **The two answers have to mean something.** *This message is for me — it asks me, or it is my job to handle it*, against *This message is not for me — it is for someone else, or it is just chatter*. A vaguer pair — *I should respond* / *I should not respond* — asks about the bot's disposition instead of about the message, and had chatter answered yes.
- **The room's other bots are named.** One line saying which bots are in the room is what makes "for me" answerable at all: without it the named bot and the chatter collapse into one distribution — the lowest `act` rose to 0.823 while the highest `ignore` rose to 0.810 — and no cut separates them.
- **The box is not decorated.** Markdown headings and section labels cost a small model more than they give it; the box reads as labelled lines and the question sits last.
- **The threshold is calibrated, never 0.5.** A small model's usable cut sits far from even — measured between 0.6 and 0.98 — so the operating point comes from a labelled set.
- **Nothing is kept warm.** The call carries no context on the server: a judgement sends the box whole and comes back in 45–61 ms, which is what makes a resident per-room context unnecessary rather than merely unbuilt.


---

## 1. One path, one loop

There is **one** delivery path and **one** loop. A message to a room is delivered into every member **bot's** inbox and costs nothing to receive. The loop then runs; stage 0 reads the inbox and decides what to do with it. An @-mention, a reply to its own message, a direct message or a reminder coming due is not a second road — it is **a fast-pass inside stage 0**: the gate recognises it and sends it straight to stage 2, skipping the watch, because there is nothing to decide.

| What arrives | Where it lands | What stage 0 does |
|---|---|---|
| A DM, an @-mention, a reply to its own message | The inbox, like everything else | **Pass** — straight to stage 2, no watch call |
| A room message that names nobody | The inbox | Everything else: rules, then the watch side |
| A reminder the bot scheduled, coming due | The inbox, as an entry of `kind: "reminder"` | **Pass** — same as an @-mention (§12) |

**One wake source: a delivery.** A delivery into the inbox starts a tick; with nothing delivered, nothing runs at all. Nothing wakes a bot on a timer, and nothing wakes one "to check whether there is anything to do".

Two roads would let the same message be answered twice — once by the direct road and once by a later tick that finds it still in the inbox. With one road there is nothing to reconcile, no "mark it handled" bookkeeping, and no ordering rule between two runners.

**Receiving never spends anything.** That is the cost foundation of the whole design. An implementation where an un-addressed message triggers a model call is already wrong.

---

## 2. The two objects

Everything alive sits on the bot; everything that runs sits on an agent.

```
Bot                                     ← the contact: what a room shows and @-mentions
├─ Identity
│   id / name / avatar / description    ← the only copy of the identity; pushed down to agents
│   gender / position / personality     ← the card a person fills in when adding a bot
├─ Attention
│   rooms[]        ← which rooms it watches
│   interests[]    ← keywords / topics / "answer when someone asks about X" subscriptions
├─ Watch queue (the inbox, see §3)      ← ONE queue per bot, whatever runs behind it
├─ Life state
│   state: asleep | watching | working | needy (waiting on your decision)
│   lastSpoke[room] / lastTick
│   spent: tokens, observed and reported — a number, never a limit
└─ agents[]  ──▶  each is a runnable the loop calls (see below)

Agent                                   ← a runnable, not a process
├─ id / bot / role                     ← which bot it belongs to, and which job it does there
├─ model                               ← its own: the model this machine is configured with
├─ prompt + persona                    ← how it speaks, which is all "who it is" means
├─ tools[] / sandbox                   ← EMRG's existing registry, unchanged; which tools
│                                        a given agent is allowed is ordinary per-agent
│                                        configuration, not a new mechanism
├─ reads[] / readableBy[]              ← the mutual read path
├─ home / directory                    ← its own workspace: its persona, its skills and
│                                        its memory; its sessions open here unless a
│                                        session was given another
├─ memory
│   diary (its own markdown memory, across sessions and rooms)
│   roomDigest[room] (the box's summary — rolling, per room, its own memory)
└─ Sessions
    session[room] (its own stretch of work in each room; a new one starts when it
    changes workspace — private bookkeeping, never shown to the user)
```

**The split falls where the kernel already falls.** A model, a system prompt, a tool list and a history are exactly what an EMRG session holds and what an ADK `LlmAgent` holds; a clock, a queue, a state machine and a token count are what a long-lived process holds. Putting the second half on the agent would give every agent a lifecycle to design; putting it on the bot means an agent is only ever "the thing that runs when called".

The one gap this leaves today: the daemon presses "identity" and "runtime" into the same `EmrgServer`, and the busy table, cancel table and contexts are all keyed by session. Running many agents in one process needs another layer keyed by agent. That work is real.

### A bot is N agents, and a bot is not an agent

**Bot and Agent are two entities with two jobs.** The bot is the contact and the living thing: it owns the name, the avatar and the description, it owns the inbox and the loop, and it is what a room shows and what an @-mention names. The agents are the runnables behind it: each owns a persona, a model, a session and a memory, and runs when the bot's loop calls it. **The bot pushes its identity down to its agents** — an agent has no name of its own, only a `role` — so renaming a bot reaches every agent at once, and the room never sees two contacts where there is one.

**An agent is told whose it is.** Every agent's system prompt carries the bot it belongs to — its name and avatar, and the card a person fills in when adding it: what it is, what it does in its organization and how it talks and works — and the roster of that bot: for each agent, itself included, its `role`, what it does and its home directory. The same text may be handed over as a skill file the agent reads, which is what keeps it current without the agent asking for it. **It is pushed, not stored:** the agent holds no copy of the bot's identity or of its siblings, so a rename or a new row reaches every agent of that bot at once. A bot that later has a third agent needs no migration for the two that were there first.

**`agents.yml` registers agents, not bots.** A bot has one row today — the one that works — and nothing stops a second: a bot that later needs another role gets another row. This is cheap because each row is a plain runnable: a model, a prompt, tools, a memory. No lifecycle to write for it, because the lifecycle is the bot's.

**The split runs through the whole model**: membership, @-mention, a room's list of people, the inbox, the tick and the state machine are **bot-level** (so a bot has one queue and one loop however many agents work behind it); session, memory, turn and cost are **agent-level** (so the audit trail says exactly which worker acted, and the bill is per worker). `data-model.md` rule 13 states the cardinality.

**One inbox is what removes the hard problem.** With a queue per agent, every message would be delivered N times, each agent would keep its own "already handled" state, and the loop would have to reconcile N of them. With one queue on the bot, delivery is a single write, the tick is a single loop, and stage 0 decides once — then the loop calls whichever agent the decision names.

**Agent ≠ Session.** EMRG presses the identity into the session (the session is that cwd, that model, that history), so one identity cannot live in three rooms at once. Here the **bot** sits above the sessions, and an agent's sessions are its stretches of work — which is what lets one contact be present in three rooms at once while each agent keeps one continuous thread per room.

**A session is never user-visible either.** The room's timeline is continuous, the way a chat is in Feishu; five agents in one room have five private spans over the same shared log. That is not a display decision but the load-bearing one: it is what makes "messages shared, context private" true by construction.

---

## 3. Watch queue (the inbox) — one per bot

**The inbox belongs to the bot, not to an agent.** A message to a room is delivered once, into the bot's watch queue; the bot's loop reads that queue and decides, and only then does an agent run. agent does not watch rooms — the bot does, and the judgement is the step it takes before it wakes one.

That is the whole reason the queue is here: delivery is one write per (bot, message) instead of one per (agent, message), there is one "already handled" state instead of N, and the loop stays one loop instead of a fan of loops to reconcile.

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

- **Every entry is a delivery, and deliveries have two producers**: a message from a person or another bot, or a schedule row coming due (§12). Either way one entry lands in one inbox and the tick that follows is the same tick. An entry is never synthesised by the loop to give itself something to judge.
- `hints` are scored **by the producer, not by a model**: @ detection, question marks, whether it replies to me, keyword matches, message density. All of it is string and counting work that costs nothing.
- **`mentionsMe` and `repliesToMe` are bot-level facts.** They are computed once, when the message lands, against the bot — not per agent. No agent scans a room for its own name, and the watch side could not: it is not addressable, so "an @ to me" is a question only the bot can answer. That is what makes stage 0's fast-pass a rule rather than a model call.
- **`mentionsMe` is derived, not stored on the message.** The message carries Feishu's own field, `mentions[]` — the principals it names, `{id, name}` each — and that is the only stored form. Delivery finds **this bot's id** in that array and records the boolean here, on this bot's entry. Nothing in `hints` is ever written back onto the message, and the next bot derives its own answer from the same bytes.
- State machine: `new → watched (act | ignore | snooze | keep) → consumed`; `snooze` carries a condition. An entry that stage 0 fast-passes skips `watched` and goes `new → consumed`, including one injected into a turn already running (§4).
- **The inbox is also the running turn's queue.** There is no second, in-memory pending list: every entry is on disk before any turn starts, and a message that arrives mid-turn is the same entry, read again at the next round boundary (§4). One queue, one "already handled" state, nothing to reconcile.
- **Capacity is the box, not a cap on the inbox** (§3, "The observation box"). The inbox may hold what arrives; what stays bounded is the part a judgement reads — the observations since the last compaction. When those have piled up the judgement says so and the work agent compacts them, so the inbox never has to become a second message log and no entry has to be silently dropped to keep it small.
- The inbox is append-only and the writer **never blocks** (room fan-out must not stall because one bot is busy).
- A verdict is written on the entry, and it is written by the **loop**, not by the agent that produced it — the watch side only answers; the loop performs (§4).

### The observation box — what a judgement actually reads

One box per bot. **Not per room**: it travels with the bot, and what the bot gathered in another room is in it. It is the name of files on the disk, and what it offers is exactly two operations — **write an observation** and **read the observations**. A read returns the last compaction together with every observation after it; how those two are kept, and that there are two of them at all, is the box's business and never the caller's.

| Part | What it holds | Written by | How often |
|---|---|---|---|
| **Compaction** | the whole history written again: what is being worked on and how far along each thing is | the work agent — the half that can write — by overwriting | rare, when the judgement says the observations have piled up |
| **Observations** | everything that arrived after the compaction, each carrying its room, who spoke, when and what | whoever gathers one, by appending | every arrival |
| **Last verdict** | when it was taken, what it was, and the reason if one came back | the loop | every tick |
| **Question set** | the named questions the judgement answers, with their options | the prompt artifact, per version | static |

- **The question set is the prompt artifact's, not the roster's.** `watch-v3` declares one choice question as the assembly's last part, with two named answers, and the shipped cut is a threshold on the probability the endpoint answers with — so the question, its two answer names and the threshold are one artifact. A bot that needs a different question needs a different artifact with its own labelled cases, not a row in `agents.yml`: the roster has no field for one, and a per-bot question would move what a cut means without moving the number.

- **The judgement is a decision model, so it writes nothing.** It answers named questions over a state and produces no text and no tokens, which is what makes it cost a forward pass instead of a generation. The consequence is owed an answer rather than hidden: **it cannot write the summary it reads.** The summary is written by the work agent, and the watch side never keeps a session of its own to compact.

- **The observations are the box's own, written when they arrive.** Each carries which room it came from, who said it, when and what was said, which is what lets one box hold several rooms without confusing them. A bot's own words are observations like anyone's — without them the judgement would take an answered message for an unanswered one and wake the work agent again. Its `hints` — mentions me, asks a question, replies to me, how long the room has been quiet, how many images — are the same string and counting work already done at delivery.
- **The state handed to the model is structured, not prose.** A summary paragraph is one field of it. Everything else is fields: how many observations, who spoke, how stale the last verdict is. Decision models are asked with a state that may be any JSON value; handing them a paragraph would throw away the only cheap signal there is.
- **A judgement never waits for a compaction.** It reads whatever box exists — possibly an empty compaction and a long tail of observations — and returns. Compaction is background work, single-flight, committing the new summary and its consumed-to point in one atomic write, so an arrival during compaction is either inside the new compaction or still among the observations after it, and is never dropped.
- **Compaction is a runtime action, not a turn.** It produces no message, so it is not a proactive turn: it is not marked as one, and it does not open a work session's stretch of work. Without this, a busy room that never needs a word said could never be compacted at all — which is the hole a model-written summary would otherwise leave.
- **The judgement is asked whether to compact, and that is one of its three answers.** It reads the box, sees too much in it, and calls the work agent to compact; that is a road out of a judgement, not arithmetic performed by the runtime. Nothing compacts per message, and a compaction the judgement did not ask for does not start.
- **The box handed over always fits.** The runtime fills it newest-first until the model's window is reached and records how many observations were left beyond it — *"80 of 300 read; 220 unread"*. A judgement therefore never faces a box it cannot read, which is what keeps its failure mode a wrong verdict rather than a guess dressed as a verdict. Compaction normally keeps it from ever being reached; when compaction cannot run at all — no model configured, offline, a call that keeps failing — the box degrades visibly, backs off instead of re-firing every tick, and the unread count is what shows it.
- **The last verdict goes in as a fact, never as an instruction.** "You kept this twelve observations ago and have said nothing since" is a fact about the record. "You should keep this" would be the box arguing with the judgement, and it is what would make a stale decision self-perpetuating.
- **This is what makes the box worth having: `keep` and `snooze` become re-openable.** A room that was kept once is looked at again against a box that now says how long it has been and what changed, instead of being re-judged from scratch or never re-judged at all.

---

## 4. The main loop: two stages

```
the bot's loop, per tick:
  ┌ Stage 0 · rules only, no model (settles everything that is certain and free)
  │  1. No new observations?   → end of tick, before anything else is considered
  │  2. Rule says act? (@-mentioned / replied to / DM / my own reminder coming
  │     due — read off the bot's own hints, computed at delivery; "@-mentioned"
  │     means this bot's id appears in the message's mentions[]) → stage 2
  │  3. Rule says ignore? (my own message / another bot's broadcast / muted room)
  │                            → mark them ignore, end of tick
  │  4. Everything else → stage 1 (call the watch side)
  │
  ├ Stage 1 · the loop makes the judgement (a decision model: one forward pass, no tools)
  │  input: the bot's observation box (§3) — the last compaction, the observations
  │         since it, and the last verdict as a fact — plus the question the artifact
  │         declares, put last, read-only; never the whole inbox: the box is fitted to
  │         the window
  │  model: model.watch — local, bundled, one pass, no tokens generated
  │  output: an answer per named question — a choice, a score or a probability over
  │          declared options. A word, a label or a tiny JSON all work, as long as the
  │          answer space was declared in advance. Unparseable counts as no act
  │  effect: act → stage 2, carrying the box itself
  │          compact → the work agent compacts the box, then the tick ends
  │          no act → record the verdict and the reason if one came back, end of tick
  │
  └ Stage 2 · run the work agent (expensive)
     Stage 2 calls the work agent and lets it run — one ordinary turn: full context,
     tools, memory write at the end. What it opens with is the box: the last
     compaction and every observation since it, whichever room each came from. The
     judgement's reason is the one thing not in it — it stays on the record, where the
     work agent may go and read it if it wants to (see "what crosses the line").
     **To say anything it must call the speaking tool** — `say(room, text)`, where a
     direct chat is a room like any other. Text it emits is its own working record, and
     it never becomes a message: nothing is posted on its behalf, and a turn that ends
     without that call has said nothing at all.

     That is the whole delivery rule, and it has three consequences worth stating: the
     agent cannot speak by accident, a turn can say several things (three calls, three
     messages), and the room may see nothing at all when the agent decided there was
     nothing worth saying.
     
     One difference from an ordinary turn: it opens with "you decided to say this
     yourself; nobody called you", because nothing called it and the reason it woke is
     context, not a request.
```

### Why two stages

Because **the work agent spends money and the watch side does not.**

The watch side is a local decision model on the user's machine: one forward pass, no generated tokens, nothing billed. The work agent runs the model this machine is configured with, and every call is billed. That moves the watch side's budget from money to **wall-clock** — which is why a verdict in the low hundreds of milliseconds is not a nicety but the real constraint, and why the answer must stay small: an answer drawn from declared options is a logit read, while a model asked to write a sentence is a model that makes the app stutter.

It is also why the judgement is not handed to the model that works: **they are not the same kind of model.** The watch side answers a fixed set of questions in a single pass and reads a box fitted to a small window; the work side generates, runs tools and carries a large one. Asking the large model the gate's question costs money on every message, and asking the small one to do the work is a 4k window trying to hold a 200k job.

It raises a risk honestly: a weak local model can produce a confident wrong verdict. Two answers: **what the watch side ignored is reviewable** — every verdict is recorded with the entry it watched, so a deaf gate is visible rather than silent — and **the work agent can read that record**, so a wrong call is discoverable by the half that talks to the user.

### How the watch side finds out it was wrong

**It reads the outcome off the record it already has.** When the watch side forwards an observation and the work agent then sends nothing in that room, that is visible: the entry it dispatched has no message after it. This is the easy case by construction — silence is the default, since speaking costs a tool call — so "nothing came of it" needs no inference. That is a fact about the record, and the box carries it forward — next time the watch side meets the same room, the box's last-verdict field says how long ago it forwarded and that nothing followed, and it can weigh that before deciding again.

No new machinery is built for this. The outcome is not reported to the watch side by anyone: **it is already on the board**, because a turn that produced no message is a fact of the same data model everything else reads.

**And it is not learning.** The weights do not move; nothing is trained; no rule is written down for the future. At most the watch side accumulates its own observations, exactly as any agent's memory does.

**It is also fine if it learns nothing.** Nothing downstream may depend on the watch side getting smarter — no decay schedule, no "wait until it has seen enough", no accuracy target. A weak judgement with a visible record is acceptable; a hidden one is not.

### Three ways to decide not to act

- `ignore`: this is not about me. Consume the entry.
- `snooze`: not now, but possibly later. Re-queue with a condition ("when this gets a reply" / "in five minutes", the second performed through the schedule, §12).
- `keep`: no need to speak, but I should remember. Take no action; keep the line.

`keep` matters: it makes an agent "present but not interrupting", which is the most human thing about being permanently alive.

**The watch side does not perform its own verdicts.** It emits a decision; the loop performs the consequence — `ignore` consumes, `snooze` re-queues, `keep` appends the line. That is why the verdict's shape is free: a word is enough, because the runtime already knows what each one means.

**The tool set is EMRG's, unchanged, plus the two the host named.** There is no watch-specific tool, no memory tool and no compaction tool to build — the registry is the one already in the kernel, plus `schedule` (§12) and the speaking tool. Which tools a given agent may use is ordinary per-agent configuration in `agents.yml`, and today one answer is "none": a decision model makes no tool call.

**The speaking tool is the only way into a room, and that is why it exists.** It is `say(room, text)` — a bare single word like the rest of the register, chosen so that it cannot be read as `write`, which is files, or as a Feishu message type. There is no path from a turn's output to a message: the runtime does not post the agent's answer, does not post a streamed fragment, and does not post a summary of what it did. So a bot's every word in a room was something it chose to send, addressed to a room it named — which is also what makes a silent turn meaningful, and what keeps "it said nothing there" a readable fact rather than a guess about what a stream meant.

**Memory writes and compaction are not tools, and they will not be here.** They are what the runtime does when a turn ends, and an agent does not choose to do them.

### What crosses the line from watch to work

**The box is handed over; the reasoning stays on the record.**

When the watch side decides to act, the work agent is woken with the bot's box — the last compaction and every observation since it, whichever room each one came from — and not the line the watch side wrote about why they mattered. It reads that box, its own history and its own memory, and decides for itself what, if anything, to say.

**Why not pass the reason: the work agent would start depending on a 300 MB model's judgement without knowing it.** A reason in the context is not advice, it is a premise — the expensive model reads it as a fact about the world and builds on it. Where the watch side is wrong, the work agent would not correct it, it would amplify it, and the amplification would look like coherence.

**The cost, stated plainly:** sometimes the work agent will look at the entries and cannot tell why it was called at all. It may then say something slightly flat-footed, or ask what the point was. That is a real cost and it is the right side of the trade.

**The reason is still recorded** — on the observation entry, next to the verdict — because it is what makes a bad call reviewable, and because the work agent may read it back.

**It is not handed over; it is not sealed either.** The runtime never puts it in the work agent's context, and the work agent may go and read it, because the verdict and its reason sit on the entry they were written on — the lookup is a lookup, not a special channel. That is the difference between an invisible premise and an answerable one: having read it, the work agent knows both what was decided and whose sentence it was, so a wrong judgement carries a name instead of quietly shaping the reply.

### How slow a judgement is

**The latency target is a target, not a guarantee.** The judgement is one forward pass with no generation and no tool round: tens of milliseconds on a desktop, low hundreds on a slow machine. That is the reason the watch side is a decision model rather than a small chat model — a 300 MB model writing a sentence, with a tool round on top, would be seconds, and the verdict would be latency in the app.

### A message that arrives while the agent is running

**A new direct message is inserted at the round boundary** — after the current round's tools have returned, before the next model request. One turn therefore looks like:

```
model → tools run → [inject] → model → tools run → [inject] → … → done
```

never `tools run → the message interrupts`, and never `the turn ends → a new turn starts`.

1. **One turn per bot, by a lock.** A second message never starts a second turn; it queues.
2. **Arrival while busy is queued per bot, FIFO**, and the sender is told its position — so "queued" is visible, not guessed.
3. **The drain is one atomic pop of the whole queue**, never read-then-clear. Anything appended while the drain waits on a broadcast lands in a fresh list and goes in at the next boundary. Read-then-clear silently loses exactly the message that arrived during the window.
4. **Each injected message becomes a real record in the history**, written once with its timestamp at commit, and the interface is told the same stamp. Compaction rebuilding from history keeps it, and nobody has to invent a time for it later.
5. **The round budget is refreshed for the injected messages, not spent on them.** If the turn has exhausted its round cap and the queue is not empty, the new messages get a fresh budget instead of being stranded; only an *empty* queue produces "Exceeded maximum rounds". A message can therefore lengthen a turn, and nothing caps it.
6. **Nothing is ever dropped silently.** A turn that ends with the inbox still holding something it was woken for is a defect; the loop reads the inbox again and starts the next turn.

**The in-flight queue is the inbox.** Delivery wrote the entry to disk before any turn started, so there is no separate pending list and no re-send contract: the turn ends, the loop reads the inbox again, and if anything is left that the gate would act on, the next turn starts at once.

**An injected message is marked `consumed` at the moment it is injected.** The entry is already a fact on disk and the message is visible in the room either way, so "this was taken up" is the honest record.

**Which arrivals are injected at all.** The injected set is stage 0's **fast-pass set** — an @-mention, a reply to its own message, a direct message, its own reminder — not every arrival. A plain room message waits in the inbox for the next turn: an entry nobody has judged must not land in the middle of a job.

### Concurrency

A bot runs exactly **one** stage 2 at a time — one turn, held by a lock. When several rooms want it at once, the entries wait in the inbox, ordered: @-mention > someone waiting for an answer > high salience > the room it has been silent in the longest.
The reason is not performance but **identity consistency**: two parallel conversations would make its persona and memory fight each other.

---

## 5. Cost, worked out

The point of this section is not frugality. It is that **an alive agent is only viable if looking is nearly free**, so the gate's cost per message is a design constraint, not a tuning knob.

Assume 10 agents, 5 rooms, 500 messages an hour.

| Approach | Tokens per hour | Outcome |
|---|---|---|
| Every message to the expensive model (the naive port) | 500 × ~1500 = **750k billed** | broke within a day |
| Every message to the local watch side only (no stage 0) | 500 × ~300 = 150k **local, unbilled** | no bill — but one local inference per message, and each one is latency in the app |
| **This design**: 90% stopped free, 10% watched locally, 5% of those act | 50 × 300 local (unbilled) + 2.5 × 3000 = **≈7.5k billed** | affordable |
| Leaner: watch only when a batch has piled up | another order of magnitude down | at the cost of slower reactions |
| **Idle** | **zero** — no delivery, no tick, no call | nothing runs when nothing arrives |

**There is no idle path to defend.** A bot with nothing delivered and nothing due is not running, so nothing has to be argued about what an idle tick may call.

One correction to the table's denominator: traffic arrives **per message**, but a message costs work **per bot in the room** — ten bots and one message is ten inbox entries. The figures above hold only because stage 0 is free per bot; the moment any per-bot step costs a call, the multiplication matters and the table understates it.

**The schedule comparator is the one background cost in the design, and it is not on this table** because it is not tokens: it reads the clock, compares it with the next due row and sleeps otherwise, calling no model and touching no bot. The moment the comparator calls a model to find out that nothing is due, this table is wrong by a factor of sixty per bot per hour.

(Order-of-magnitude estimates, not measurements.)

Because the watch side is a decision model, **watch tokens are not money and there are none to count**: no generation happens, so the billed column is only stage 2. What replaced the watch cost is wall-clock — one forward pass per watched batch, off the GPU, while the room is live. And one cost that is easy to miss: **compaction is a work-agent call, so a busy room is billed on compaction even when its bot says nothing.** That is the price of a summary written by the half that can write it.

**The gate's hit rate is the product's cost curve.** So it must be observable and tunable: every agent records `watched` (batches watched), `acted` (hits), `ratio` (hit rate) and `spent` (tokens). A hit rate that suddenly jumps to 50% means a persona is written wrong or a room has been flooded by bots — and that has to be visible in the interface.

---

## 6. How it meets the EMRG kernel

| Component | What exists today | What is new |
|---|---|---|
| Agent identity | `projects.yml` → `agents.yml` | the fields in §2 |
| Main loop | `TaskHandler` (`scheduler.py:982`): heartbeat, interval/backoff, bounded cycles, stop/trigger/status, resume after restart | a new task type that runs stages 0 and 1 — **driven by delivery, not by the scheduler's heartbeat**; a bot must never be woken by a beat |
| Schedule | `TaskHandler`'s timer infrastructure, `_heartbeat_interval` | a **comparator over one global table** (§12) whose only output is a delivery. It runs on a timer; the timer's fingerprints must not reach a bot — nothing a bot sees may say "a beat happened" |
| Stage 2 · action | today's session turn (`_run_tool_loop_locked`) | open with "you chose to speak"; nothing else |
| Delivery into the inbox | room fan-out as a frame broadcast, but only to connected clients | server-side **fan-out into every member bot's inbox** (persisted, not in memory) — the one road in, for every kind of message |
| The judgement (not an agent) | `llm.py` already selects a model per session, and `session.compact()` already keeps a history per session | a **call the bot's loop makes, not a roster row**: the box replaces a session history, the named questions replace a persona's instructions, and the answer is read off the declared options instead of generated. It calls no tools, keeps no session and holds no memory of its own; the compaction it reads is written by the work agent's `session.compact()`. Any unparseable verdict counts as no act |
| Memory compaction | `session.compact()` rewrites the session's history in place | nothing to change *in kind*: each agent already has its own session file, and the box is the bot's, so the two are separate by construction. What must be checked is that no code path compacts across them |
| Memory | `memory_store`: session and project levels | add an **agent level** (across rooms and sessions) |
| State visibility | frame broadcast | a new frame: `agent_state` (watching / working / asleep / needy) |

---

## 7. Avoiding the ways this kind of system dies

| Failure | Mechanism |
|---|---|
| **Two bots wake each other and never stop** | ① a bot message does not wake another bot unless it @-mentions it, replies to it, or is a direct message ② a cap on consecutive bot turns per room — **3**, held on the Room, which is what bounds a burst ③ the depth cap, which bounds how long one chain runs (§11). A bot may open a conversation with another bot, so the *number* of chains is bounded by judgement and the record, not by a rule |
| The watch side is too cheap → deaf and blind | hit rate observable; what it ignored can be reviewed (entries and reasons are kept) |
| The watch side is too expensive → burning money | `spent` is recorded and visible per agent, so a runaway bill is *seen* rather than silently capped. There is no self-stop: a bill that climbs is a defect in the persona or the gate, and it is fixed there |
| The observations outgrow what the judgement can read | the box handed over always fits — the newest observations, with an unread count for the rest — so the verdict degrades visibly instead of silently. Compaction normally prevents it; when compaction cannot run, it backs off rather than re-firing every tick |
| Inbox explosion | the judgement reads a fixed-size box: when the observations have piled up it asks for a compaction that folds them into it, so what is spent per judgement stays flat however busy the room gets |
| Long-lived means creeping corruption | checkpoint at the end of every tick; on restart, self-check (queue, time since it last spoke, spent); persona drift corrected against the diary |
| No sense of time | every tick injects "how long since you last spoke in this room" and "how old this message is"; without that it asks the same question forever |

---

## 8. What the interface must show

1. **A state dot**: watching / working / asleep / needy, as an avatar badge.
2. **Proactive messages are marked**: not a reply to you, but something it chose to say. Every message is deliberate — speaking is a tool call — so the mark distinguishes "it came to find you" from "it answered you", not "it meant it" from "it didn't".
3. **A message appears whole, never token by token.** The agent writes into its turn, then sends; there is nothing to stream into a room, and a half-sent sentence would be a message nobody chose to finish. While it is working, the state dot is what shows it.
4. **"Why did it ignore me?" is expandable**: translate the `reason` into plain language ("this was not addressed to me, and someone else is already answering"). This is both the product difference and the only way to debug the thing.
5. **"Why is it silent?" has an answer too**: a turn that ended without sending is a turn on the record, so the same expansion can say what the bot decided instead of speaking.
6. **Spend visible**: how much it has spent today. There is no remainder, because there is no limit — the number is there to be read, not enforced.

---

## 9. Staging

- **P1 (minimally alive)**: the Agent object + inbox + stages 0/1 + one room + rule-based gate (no model). Even at this point the question "does it spontaneously say something" gets answered.
- **P2**: the judgement (a local decision model the bot's loop calls, reading the bot's box, verdict on the record) + the three ways not to act + the state frame on screen.
- **P3**: multi-room concurrency and the action queue + the diary + a hit-rate panel.
- **P4**: multi-agent group chat (bounded turns, @-wake) + delegation trees in threads.

---

## 10. Proactive direct messages

The ladder: **observe → speak in a room → open a thread → direct message → must-reach**.

Speaking in a room is being *present*; a direct message is *coming to find you*. An agent may do both, including the second — toward a person and, since §11.2, toward another bot, with the same absence of quota.

**There is no quota, no cooldown and no quiet-hours rule.** What governs an agent here is what governs it everywhere else in seek, because **a seek agent is an EMRG agent**: it has a **prompt** and it has a **sandbox**, and those two are the whole of its constraint. Restraint about interrupting you is a property of how it is written, not a gate bolted on beside it. If a persona talks too much, that is a defect in the persona, and it is fixed there.

### 10.1 Acting needs no permission either

**An agent does not ask before it acts.** It edits files, runs commands and sends messages without stopping to request approval, the way a colleague you have worked with does not ask to open a file. A per-action dialog turns the product into a ticket queue, which is the one thing an IM must never become.

What holds without asking:

1. **The sandbox.** An agent acts inside its own workspace and nowhere else.
2. **An audit trail.** Every action is a `Turn`: what triggered it, which tools ran, what changed, what it cost. Nothing is asked in advance because everything is visible afterwards.
3. **A stop that works.** Whatever it is doing on your behalf, you can see it and end it.

**Asking for a decision is not asking for permission.** An agent that is stuck, that cannot weigh two options, or that needs your decision is having a conversation. *"May I?"* does not exist; *"which one?"* is ordinary speech.

### 10.2 In the interface

- A proactive message is marked **proactive** — "it came to find you" reads differently from "it answered you", and a reader who mistakes one for the other misreads the whole relationship.
- The contact list shows what is waiting.
- After sending, it does not wait: the interface must be able to express "I'll carry on; look at it when you get a chance".

---

## 11. Agent to agent

The anti-loop rules in §7 all assume somebody is in the room to notice. A two-agent room breaks that assumption, so a rate limit alone cannot hold it; something structural has to.

### 11.1 One shape: a message

**All interaction is IM.** So an agent reaching another agent is not a tool call: it is a **message**, posted into a room the other bot is in, or into a direct room between the two. It lands in that bot's inbox like anything a person says, and that bot's own loop decides what to do with it — including deciding not to.

There is no synchronous delegate call, and the reason is structural rather than stylistic: a call would have **A deciding for B**, on A's turn, bypassing the judgement B exists to make. A message leaves that judgement where it belongs.

What "delegation" means is the **intent**, not a mechanism: "do this and report back" is a message that asks for work, and conversation is a message that asks a question. Both enter the same inbox and both carry the same chain.

### 11.2 A chain may begin with an agent

**A bot may say the first word to another bot** — in a room both are in, or in a direct room it opened for that purpose. There is no rule requiring a chain's root to be a human message.

A bot may already open a conversation with a **person**; forbidding the identical act toward a peer would be an asymmetry nothing asks for. And a chain's length is capped by depth, a room's burst by the turn counter — neither of which needs a human at the root.

**What this costs**: the set of chains is bounded by nothing structural. Every new conversation starts a fresh chain at depth 0, so **depth bounds how long a chain runs, not how many chains a bot may start**. A bot can open a conversation whenever its judgement says to, and no count, interval or approval stands in the way. This is the same trade accepted for proactive messages to people, and the same defence: everything is on the record.

### 11.3 One wall that counts hops

1. **Depth** — every message carries `caused_by`, `chain` and `depth` (data-model rule 11). Each agent turn in a chain adds one hop. **Cap: 4.** At the cap the agent may end or escalate; it may not continue the chain.
2. **The room's consecutive-agent-turn cap** (§11.4) — twenty-four bot turns in a row in one room, and further bot messages stop waking bots there. This is what bounds a burst; depth alone never did, because a burst of short exchanges uses few hops.

There is **no chain budget**. A chain's cost is recorded like anything else, per turn, and is readable — but nothing stops it. The depth cap is the only numeric limit on a chain, and it is not a financial one: it exists to stop a loop, not a bill. It is read off the message data rather than kept in a counter, on purpose — a counter has to be restored after a crash, and the one time it is restored wrong is the one time it matters.

The **consecutive-agent-turn counter lives on the Room**, not on an agent: no single agent can see how many times its peers just spoke, so an agent-local counter would be an agent measuring itself and calling it a conversation.

### 11.4 Wake rules

**A bot wakes another bot by naming it.** A bot message starts a wake for a bot only when **all** of these hold:

- it @-mentions that bot;
- the chain depth is below the cap;
- the room's consecutive-agent-turn counter is below twenty-four.

Otherwise the message still lands in that bot's inbox, at zero cost, marked `hints.chainBlocked = reason`, to be reconsidered the next time a human touches the room. Nothing is lost and nothing is spent.

**Why a naming and not a reply.** The three edges — mention, reply, direct — are what makes an entry *addressed*, and `gate.ts` row 2 still fast-passes an addressed entry, so a reply or a DM is not ignored when the bot is woken by something else. What a reply cannot be is the thing that starts the wake. Measured, with all three edges waking: two bots settle a plan, one answers the other, and the answer is a reply — which wakes its author, whose answer is a reply in turn. Eight minutes and twelve messages later the room was still going, no message named anybody, and the same three commitments had been agreed six times. A room ends when somebody has the last word, and a reply edge makes the last word impossible: every closing sentence wakes the person it closes with.

So the reply and the direct edges still address an entry, and only a name calls one back.

### 11.5 Who pays

**Whoever runs the turn pays.** A asks B by sending a message; that message ends A's part and costs A its own turn, and when B takes it up B runs a turn of its own and B's account records it. No turn can contain another bot's work, so every turn in a chain is recorded like any other and the chain total is a figure you can read.

### 11.6 How a chain ends

At the depth cap or the room's turn cap the agent does exactly one of these, deliberately:

- **escalate** — a send to a direct room, subject to nothing but its own persona and sandbox;
- **say so in the room** — one system line: *"this exchange reached its limit and needs a person"*;
- **stop and record** — write to the diary and let the thread rest.

What it may not do is drop the question without a trace, or keep going quietly. Silence is allowed; silence that nobody can see is not.

### 11.7 In the interface

An agent-to-agent run collapses into one line — *"5 exchanges between Editor and Researcher"* — expandable, with the depth shown. Without the fold a room becomes unreadable the first time two agents get to work; without the count the user cannot tell an ordinary exchange from one that hit the wall.

### 11.8 Why allow it at all

The useful case is real and common: A lacks a capability or a piece of context B has, and the alternative — A guessing, or the user relaying by hand — is worse on every axis.

And seek is one local process running every agent, which is the one place this design is *easier* than a distributed one: a single arbiter can see every chain in the system, so the depth wall is exact rather than approximate, and no coordination protocol is needed. The same property that makes the product private also makes the loop enforceable.

---

## 12. A global schedule every bot can write to

**One table, one tool, and a due row arrives as a message.** Every bot reads and writes the same schedule: **when, what reminder, which bot**. When a row comes due, its text is delivered to that bot automatically, as a direct message — equivalent to an @-mention.

### A schedule is not a clock

The design has no timer that wakes a bot, and this does not add one. Two properties keep them distinct:

- It is **one table in the process plus one comparator** that reads the clock — not a heartbeat per bot. No model call, no per-bot state, nothing that grows with the number of bots.
- **Nothing wakes a bot**: a row coming due at 09:00 is *a message written into one bot's inbox at 09:00*, and a delivered message wakes it exactly as a person's would. The wake rule stands word for word; the schedule is a **second producer of deliveries**, beside people and other bots.

The rule the implementation is checked against: **the schedule may produce deliveries, and it may never produce ticks.** A bot woken by "it is 09:00" rather than by an entry in its inbox is the defect.

**What it buys.** A purely message-triggered agent cannot keep a promise: with nothing upstream, "I will look at this tomorrow" has no way to come true. A bot can now leave itself that reminder and come back to it, and it gets the ability **by adding a producer of messages, not by adding a wake source**.

### The row

```json
{ "id": "...", "to": "bot_id", "at": 1698123456789,
  "text": "remind me to check the release thread",
  "createdBy": "agent_id", "createdAt": 1698123456789,
  "state": "pending | fired | cancelled" }
```

**There is no `room` field.** A reminder is the bot talking to itself; it reaches the inbox and stops there.

- `to` is **a bot**, never an agent — the inbox is the bot's (§3).
- `text` is delivered **verbatim**: not summarised, not translated, not rewritten by any model on the way out. What the author wrote is what the bot reads back, and that is what makes a reminder a note to its future self rather than a fresh instruction.
- One table, **every bot reads and writes it**, so a bot can see what other bots have scheduled. That is a shared calendar rather than a private one: nothing filters the table by `to`.
- `state` moves once, and never backwards. A `fired` row is pruned after a while; a `cancelled` row is a tombstone, because "I had planned this and dropped it" is information its author may want back.

### The tool

**`schedule`** — one tool with three verbs and nothing else: **list**, **add**, **cancel**. No "run now", no recurrence, no priority, no condition language — a bot that wants to be reminded tomorrow writes the moment it means. It is available like any other tool, so which agents may use it is ordinary configuration in `agents.yml`.

**`snooze` with a time condition is performed by the loop, not by the watch side.** The watch side emits a verdict; the loop performs it (§4). So "not now, in five minutes" produces a schedule row written **by the loop**, and when it fires the original entry comes back. The watch side needs no tool call for this, which keeps its judgement at the one round the latency target was written for.

### Firing

A firing is **one write, and it is idempotent**: the row's `state` becomes `fired` in the same step that drops the delivery into the inbox, keyed by the row's `id`. A daemon that was closed when a row came due fires it on the next start — an instant missed is **not** a reminder skipped, and ten rows missed while the laptop slept fire in time order, each as its own delivery. Dropping them silently is the same defect the injection path refuses (§4).

### What the user sees, and what they do not

**A fired reminder is not displayed.** It lands in the bot's inbox; no room shows it, no frame carries it, and the transcript does not gain a line. The user sees what the bot does about it and nothing else.

**This does not break "all interaction shows up in IM":** that rule is about how the bot reaches *other principals*, and a reminder reaches nobody. There is no second party to show it to. Putting it in a room would invent one — a system line addressed to everyone in a room, describing a note one bot left for itself.

**The cost**: the interface shows **an effect without its cause**. A bot that speaks at 09:00 because of a note it wrote yesterday looks unmotivated on screen, and a user cannot tell "it kept a promise" from "it decided to talk". That is the same shape of cost as the watch side's withheld reasoning (§4), and the same answer applies: **it is recoverable by reading, not by showing**. The schedule row and the turn that fired it are both on the record, so *"why did it say that just now"* has an answer; the transcript simply does not volunteer it.

### What it costs

1. **The inbox can hold an entry the bot wrote to itself.** That follows from the row being a real thing somebody wrote, at a real stated moment — not from the loop inventing work to judge.
2. **One more tool exists**, and it is the only addition to EMRG's registry. Nothing beside it: a `calendar`, `cron` or `remind` tool would be a second exception and is not licensed by this one.
3. **A shared writable table brings the usual three problems** — stale rows, unbounded growth, and two bots scheduling the same moment for the same bot. Growth is bounded by pruning `fired` rows; the rest is the same trade accepted everywhere else a bot acts — its persona, and the fact that all of it is on the record.
4. **A bot can call itself awake forever.** A reminder takes the fast-pass (§4, stage 0 rule 2), so it does not count toward a room's consecutive-bot-turn cap — that cap exists to stop two bots trading turns in a room, and a bot reminding itself is not a conversation in a room. A bot could schedule a reminder for its own next round, indefinitely. It is the same trade as the absent quota on proactive messages (§10), with the same defence.
