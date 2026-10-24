# The host's rulings

**What this file is:** every decision the host himself made, each stated as it stands. The design documents mix three kinds of statement — what the host ruled, what the implementer derived from it, and what the implementer invented — and the third kind has been mistaken for the first more than once. Here only the first appears, and it is the source list the other documents are answerable to.

**What this file is not:** the design. Mechanism, cost and reasoning are worked out elsewhere. A derivation or the implementer's own choice is not a ruling and does not appear here.

**This file is the base.** It answers to nothing: every other document is answerable to it, and none of them is cited by it.

## Three rules

1. **Only the host's own words become an entry.** A statement that cannot be traced to a message he sent is a derivation or a proposal, and it is labelled as one rather than written here.
2. **When he decides again on a question, the old entry goes and the new one takes its place.** This file holds what stands. What it used to say is in the git log.
3. **No dates and no times.** An entry is placed by the question it answers, not by when it was answered; the commit that carries it is the date.

Quotations are the host's, translated into English for this repository; the session log holds the original. The implementer's own answers to his questions are never quoted, only his. **Where he answered with a single word, the question it answered is given in brackets and marked as the implementer's** — an answer like "A" stops meaning anything once the date that placed it is gone.

---

## The product

**seek is a multi-agent product.**
*"seek and Feishu may look alike, but it is a multi-agent product: behind seek are bots (agents), not real people. Review how we designed EMRG, and what you learned about Google ADK today."*
The IM shell is a shell. A contact is a bot, and an agent is the thing behind it.

**The name, and the shape it implies.**
*"I Seek You — the original spirit of IM. Typed like ICQ, shaped like the characters you know."*
The name, the tagline, and a constraint on the product's feel: it stays an IM, not a task panel or a workflow editor.

**Design precedes code, and the earlier build is a prototype.**
*"Move the current implementation into the directory a prototype belongs in."* / *"Plan the current directory properly. Do not develop yet — there should be a design and a runnable prototype. This project is going to be open source."* / *"Finish the design documents first."*
The earlier Electron build is archived as `prototype/`; the documents close before the kernel is written; the repository is public.

**English is the project language.**
*"The project must be international-facing. English first."*
English is the language of everything that leaves the repository — issues, pull requests, commits, code comments — and the product's own text is never hard-coded in a component.

**Feishu parity governs interaction.**
*"This part of the design is wrong. Your model must support the product requirement, and the product requirement is that the interaction is identical to Feishu."*
Where a design question has two answers, the one visible in Feishu wins. Its boundary: parity governs how a bot reaches **other principals**; it says nothing about how a bot handles its own note to itself.

**Do it yourself.**
*"Why does it need me to do it — can't you?"*
Work the implementer can do — asset rendering, uploads, tooling — is not handed back to the host.

---

## The agent

**What makes a bot a bot.**
*"Each bot is a complete Agent. What is different: it is long-lived, it observes on its own, it acts on its own. A message in a group that does not @ it is still sent to it, and it keeps it in its own pending observations. Inside it is a main loop, and that loop is the core of its life. Each round it first looks at the observations and decides whether to act — perhaps by rule, by event, by a cheap model, by a local model; that is where the saving is, because a long-lived agent must not burn money when it does not need to. Only after deciding to act does it enter the real agent loop."*
Three properties — long-lived, observes on its own, acts on its own; a per-bot inbox; a two-stage loop with a cheap gate ahead of the expensive one, and the cost argument that forces it.

**A bot may come to find you.**
*"It can."* [asked: *"May an agent open a direct message with you?"* — the implementer's wording.]
A bot may initiate a direct message, on its own initiative. There is no quota, no cooldown and no quiet-hours rule anywhere in the design.

**A bot's only constraints are a prompt and a sandbox.**
*"B, and an Agent has no constraints — much like an EMRG agent: a prompt and a sandbox."*
A seek agent is an EMRG agent, and its whole constraint is its prompt and its sandbox. No quotas, no cooldowns, no quiet hours, no justification lines, no per-action limits. A bot that talks too much has a persona defect, and it is fixed in the persona.

**An agent does not ask before it acts.**
*"No."* [asked: *"Must an agent stop and ask before it acts?"* — the implementer's wording.]
No approval step anywhere. What holds instead: the sandbox, a complete audit trail, and a stop that works. *"May I?"* is gone; *"which one?"* stays, because a choice between options is a conversation and not a permission.

**No spending cap.**
*"A."* [asked: *"Should a bot carry a spending budget it stops at?"* — A: no budget, record the spend and show it. The implementer's wording.]
No cap on spending anywhere: no budget field, no "quiet because spent" state, no limit it stops at. Cost is **recorded** — a turn carries its tokens — and visible. A bot that spends too much has a persona or a gate defect, fixed there. The other bounds the design carries are not spending limits: how long one chain may run, how many bot turns one room may take in a row, and how big an inbox may grow.

---

## The gate

**The gate exists, and must be nearly free.**
*"EMRG is trigger-driven, so as long as nobody talks to it, it spends nothing. In seek the agent is alive, so without a judgement it would spend continuously, and that is not acceptable. So on top of being alive, add a judgement that decides whether the agent's own session and tool chain is really called… ① it must stop meaningless actions ② the judgement itself must be cheap or free. So ideally a small model running locally."*
The gate is architecture, with two requirements: it stops meaningless work, and it costs almost nothing itself. It is not a constraint on the agent's behaviour — it asks one question, whether the agent runs at all, and it is what makes an always-on agent affordable.

**Bundled, small, rules first.**
*"It must be built in — find a small enough model to bundle locally (model file within 300 MB, smaller is better). Together with some rules: if there are no new observations, return at once; if I am @-mentioned, return 'do it'. Only the remainder goes to the small model."*
The watch model ships with the product, ≤300 MB of weights; the two free rules run ahead of it.

**Multilingual and multimodal.**
*"Because it is international, the small model must support Chinese + English + multimodal."*
Both are requirements. They pull against the ≤300 MB target, and the trade is settled at selection time — neither may be quietly dropped.

**Write the requirements, choose later.**
*"Write down the requirements first; choose later. There is no need to go looking now."*

**The verdict needs no fixed form.**
*"Do not restrict it to JSON — as long as it meets the requirements I just described."*
A word, a label or a tiny JSON — whatever the chosen model emits reliably. An unparseable verdict counts as no act.

**No special input pipeline for the watch agent.**
*"There is no need to design one specially, because the Agent itself already has a session history, memory and compaction. The judge's request should be essentially the same as the request the Agent sends when it really runs — it gets the agent's session history, memory and compaction."*
The watch agent sends the same shape of request as any agent. Nothing is summarised on its behalf and no second context is kept in sync.

**The judgement reads a two-part box.**
*"The observation box splits into two parts: the result of the last compaction, and the observations that have arrived since it. Every judgement sends the last compaction's result together with the observations produced after it, plus the time and the result of the last judgement, to the system-one model, and gets a fast verdict."*
Per (bot, room), the judgement input is that box and nothing else: the standing summary, the delta since it, and the previous verdict. The previous verdict goes in as a fact — how long ago it was and what it was — never as an instruction.

**Compaction is triggered by a line, not by every message.**
*"Compaction runs when it is worth running, not on arrival — the host chose the threshold over triggering on every new message."*
The delta crossing a line starts a compaction, and a judgement never waits for one. Compaction is single-flight: at most one runs at a time, and it commits the new summary and the point it consumed to atomically, so a concurrent arrival is either inside the new summary or still in the delta, never lost. The line itself is a default, settled by measurement, not a ruling.

---

## Two agents behind one bot

**The watch agent is an agent.**
*"Let us say the judge is also an Agent, only using a local model."*

**Two agents per bot.**
*"Actually each bot has two Agents: one for fast judgement, one that really does the work."*
The split is between two agents, not two modes of one.

**Two role names: `watch` and `work`.**
*"Fine, B then."* [asked: *"What should the two roles be called?"* — B: `watch` / `work`. The implementer's wording.]
The names come from vocabulary the design already had — the watch queue, the work.

**Separate memories, each readable by the other.**
*"Do not share one memory. Each is independent, and each knows the other exists and can read the other's history, memory and so on."*
Two stores, each compacted against its own window, plus a read path in both directions. The reason it matters: the windows differ by an order of magnitude and compaction is destructive, so a shared log means the small one compacts first and deletes detail the large one can still read. **The read path covers everything either agent writes, including a verdict and the reason behind it** — it is how the work agent can find out why it was woken without that reason being handed to it.

**It has tools — EMRG's set, unchanged.**
*"It has tools — otherwise how would it read and write memory, compress its session?"* / *"Just use the EMRG set."*
Tools are the kernel's registry (bash / read / write / edit / glob / grep / subagent / submit_rant / boss), and which agent may call which is ordinary per-agent configuration in `agents.yml`. No watch-specific tool, no memory tool, no compaction tool: memory writes and compaction are not tools in EMRG — the runtime does both at the end of a turn — so they stay runtime behaviour here, as for any agent. **One exception, named by the host: `schedule`.** A second one beside it would mean the exception was read as a licence.

**The watch agent reads its own outcome, and is not expected to improve.**
*"The judge relies on the observation data: say it judged wrong and the working agent then said nothing in the room — next time the judge sees that it handed this over and nothing was done. Also, do not agonise over the judge learning; it is fine if it never learns."*
No feedback channel is built and nothing is trained. The outcome is read off the record the watch agent already keeps, and nothing downstream may assume it gets better.

**Only the observations are handed over; the reason stays where it was written.**
*"A."* [asked: *"What does the work agent receive when the watch agent decides to act?"* — A: the inbox entries only. The implementer's wording.]
The work agent wakes with the entries and nothing else: the runtime never puts the watch agent's reason into its context, because a reason in a context is a premise rather than advice — where the watch agent is wrong, the work agent would amplify rather than correct it, and the amplification would look like coherence. **It is not sealed, though.** The reason is on the record, and the two agents can read each other's records, so the work agent may go and read it — and then it knows both what was decided and whose sentence it was. What is forbidden is the silent handoff, not the lookup.

---

## Bot and agent as two objects

**Two data models; identity lives on the bot.**
*"A bot is a bot and an Agent is an Agent — two data models. The name and avatar land on the bot, and the bot passes its name down to the two Agents."*
An agent has a `role`, not a name of its own; renaming a bot reaches every agent at once, and a room never sees two contacts where there is one.

**An agent knows which bot it belongs to, and everything about it.**
*"A work agent, in its own system prompt or in a skill, can know which bot it belongs to, and everything about that bot — its name, which agents there are, what each one does, each agent's directory, and so on."*
Every agent of a bot is given the bot's identity and its roster — in its system prompt, or in a skill file it reads: the bot's name, avatar and description, and for each of its agents, itself included, the role, what it does and its own directory. None of it is stored on the agent, so a rename or a new row reaches all of them at once.

**`agents.yml` is a roster of agents.**
*"Each bot can have two rows, that is fine — what is in agents.yml is agents, not bots. In future we may find some bot needs more rows."*
No cap on rows; the file registers agents, and a bot is the grouping.

**The inbox lives on the bot.**
*"As it looks now, the inbox can sit on the bot, which keeps the agent's design simple — close to what EMRG or Google ADK has."*
One queue, one "already handled" state and one tick, all bot-level; an agent stays a runnable.

---

## Messages and delivery

**One path, one loop.**
*"Direct is not skipping the judgement; it is that the judgement notices an @ and lets it through. There is really only one path."*
One delivery path and one loop. An @-mention, a reply and a direct message are a **fast-pass inside stage 0**, not a second road; the double-reply problem does not exist.

**Only a delivery wakes a bot.**
*"It looks a bit complicated, let's drop the clock for now."*
No timer, no clock tick, no `kind: "clock"` entry. A delivery into the inbox is the only thing that starts a tick; with nothing delivered nothing runs, so there is no idle path to defend and no backoff to compute.

**A mid-turn direct message joins the turn it interrupted.**
*"Same as EMRG: when a new direct message arrives, wait for the tool run to finish and then insert the new information."*
The running turn keeps its lock, and the message joins it **at the round boundary** — after this round's tools return, before the next model request. Not a second turn, not an interruption of a running tool, and not held until the turn ends either. Kept from EMRG: the atomic drain of the whole queue, one timestamp written at commit, a refreshed round budget for injected messages, and nothing dropped silently. Absent here, because seek's inbox is written at delivery and *is* the in-flight queue: a client re-send contract and a second pending list.

**A stage-2 turn is an ordinary turn.**
*"What do you mean, when was it decided that three records must be written?"*
It writes nothing extra. It is an ordinary turn with one difference — it opens knowing nobody called it.

---

## The data model

**The data model comes first.**
*"Design the data model first — Agent, room, chat, session, thread and so on. What are the big pieces, and how do they relate. Do not care too much about detail at this stage. You may refer to Feishu, grok, or other similar products you can find."*

**@-mention and reply are bot-level facts.**
*"A."* [asked: *"Is `mentionsMe` computed once per bot at delivery, or per agent?"* — A: once per bot, on the inbox entry. The implementer's wording.]
Derived at delivery and stored on that bot's inbox entry. No agent scans a room for its own name: the bot knows, once, and tells its agent.

**The message stores `mentions[]`, and nothing per reader.**
*"A, look at `mentions` to see whether my own name is in there."*
The message keeps Feishu's own array; `mentionsMe` is **derived** at delivery, per bot, and lives only on that bot's inbox entry. A per-reader boolean on the shared message would force a rewrite or a copy per bot and turn one array scan into stored state that can disagree with what it describes.

---

## Agent to agent

**An agent may find an agent.**
*"Can an agent find an agent? It can."*
Agent-to-agent contact is allowed. Its form is the next entry.

**All interaction is IM.**
*"A: all interaction is expressed in IM — group chat and direct messages."*
An agent reaches another agent by **sending a message**, never by calling a tool. There is no synchronous delegate call: it would have A deciding for B, on A's turn, bypassing the judgement B exists to make. Whoever runs the turn pays, so a delegate's work sits on the delegate's ledger and can never hide inside the caller's.

**A bot may open a room with another bot.**
*"It can."* [asked: *"May a bot open a room with another bot?"* — the implementer's wording.]
Yes, with no approval step; membership is not human-gated. Recorded cost: the left list can grow with conversations the user never started, and the answer to that is the persona, not a gate.

**A bot may say the first word to another bot.**
*"A."* [asked: *"May a chain's root be another bot's message, or must it start with a human?"* — A: a bot may open the conversation. The implementer's wording.]
A chain's root needs no human message and no scheduled tick. A bot may open a conversation with a peer — in a room both are in, or in a direct room it opened for that purpose — exactly as it may with a person. **The number of chains is bounded by nothing structural**, and that cost is recorded rather than smoothed. A chain's length and a room's burst are still bounded, but by two numbers that are not the host's: they are the implementer's defaults, and they are not written here.

**A chain carries no budget.**
*"Delete."* [asked: *"What should bound a chain — keep the chain budget, or delete it?"* — the implementer's wording.]
No financial limit on a chain. Its cost is recorded per turn and readable. What stops a runaway exchange is not money but structure: how long one chain may run, and how many bot turns one room may take in a row.

---

## The schedule

**One global schedule, one tool, and a due row is a delivery.**
*"Provide a global schedule — a tool for every bot to read and write it (when, what reminder, which bot). When a schedule entry comes due, send the reminder to the corresponding bot automatically; it is a direct message, equivalent to an @-mention."*
One table every bot reads and writes; one tool, `schedule`, with three verbs — list, add, cancel — and nothing else; a due row becomes an ordinary inbox entry of `kind: "reminder"` that takes the fast-pass. **This adds a producer of deliveries, not a wake source**: one table plus a comparator rather than a heartbeat per bot, and it wakes nobody, because a row coming due *is* a delivery. The line the implementation is checked against: **the schedule may produce deliveries and may never produce ticks.** It gives a bot a way to keep a promise — "I will look at this tomorrow" can come true — and it closes the time-conditioned `snooze`, which the loop performs by writing a row.

**A fired reminder is not displayed.**
*"No need to display it."*
A reminder reaches the bot's inbox and stops there — no `room` field on the row, no frame, no transcript line. The user sees what the bot does about it and nothing else. **This is where Feishu parity stops**: parity governs how a bot reaches other principals, and a reminder reaches nobody, so there is no second party to show it to. Recorded cost: the interface shows an effect without its cause, which stays recoverable by reading the record rather than by displaying it.

---

## How to work

**One question at a time.**
*"Ask me one question at a time, and keep it plain, focused, logical, no waffle. One question, one answer."* — repeated twice more, the last time with *"say it completely, say it clearly"*.
Each question stands alone: what is being decided, what each option costs, and one recommendation with one reason. A question the host must ask back about has not been asked.

**Attribute nothing to him that he did not say.**
*"When was that rule decided?"* — asked of a rule the implementer had presented as settled.
No statement may be attributed to the host that he did not make. A rule with no traceable source is a proposal and is labelled one. This file exists for that reason.

---

## Documents

**Every document ships in both languages, kept in sync.**
*"All documents come in Chinese and English versions, and the two are kept in sync."*
Two maintained versions, by a `.zh-CN.md` suffix beside each file rather than a parallel tree, and **neither half outranks the other** — a disagreement is a defect in the pair, fixed at once. A change to an English file is unfinished until its Chinese twin changes in the same commit. Two exclusions: `LICENSE` stays English only, because a translated licence is not the licence, and dated reviews keep translations as snapshots of their date.

**A document holds the result, not the process.**
*"No review material in the documents — the documents hold only the final result, with no process in them (what it used to be, what it was changed into and why — none of that; do not show history — history is in the git commit log)."*
A document states what is true now, in the form an implementer can build from. What a rule used to be, what it was changed into and why it changed do not appear; the log carries that.

**This file carries no dates, and no superseded entries.**
*"host-rulings does not need dates. Each time I make a new decision on a question, delete the old one and write in the new — that is all."*
An entry is grouped by the question it answers. The entry it replaces is gone, and the commit that carries the change is where the older decision is found.
