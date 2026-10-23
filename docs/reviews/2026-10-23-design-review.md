# Design review — 2026-10-23

> Reviewing `docs/design/data-model.md`, `docs/design/agent-lifecycle.md`, `docs/design/i18n.md` and `docs/decisions.md`.
> Written the same day they were settled, before any code. Findings are ordered by what they cost if found later, not by how wrong they are.
>
> **Terminology note.** This review is left in its original wording. Two roles named here were renamed later the same day: *the judge* is now the **watch agent** (`model.watch`), and *the working agent* is now the **work agent** (`model.work`). Read old names as new ones; the findings themselves stand as written.

## Verdict

The two load-bearing claims are right, and they are right for the right reason:

- **Messages are shared, context is private** — this is what makes five agents in one room possible at all, and it is correctly placed as the model's first sentence.
- **All the saving lives in stage 0, and dying there must cost nothing** — correctly placed as the loop's first sentence.

The structure around them holds up too: Agent ≠ Session, Member as a projection, thread as a message tree rather than a room, no headcount classification.

But the model is **not yet "settled"** in the sense `src/README.md` demands, and that demand is the project's own: "every open item is closed; the on-disk shape is fixed" before code. Four promises made in `decisions.md` have no entity to live in, and two contradictions between `data-model.md` and `agent-lifecycle.md` will be resolved by accident, differently, in two places.

Five items below block P1. None of them is a taste question; each is "this promise cannot be implemented as written".

---

## Blocking

### 1. Approval has nowhere to be stored

> **Resolved 2026-10-23, in the opposite direction: there is no approval, so there is nothing to store.** The host ruled that an agent does not ask before it acts; a per-action dialog would turn an IM into a ticket queue. What replaces it is a bounded reach, a complete audit trail (`Turn`), and a working stop. The finding was still correct as a finding — the promise had no entity — but the answer was to withdraw the promise. What survives is the distinction the old wording blurred: asking *"may I?"* (gone) versus asking *"which one?"* (indelible, and §10's first and fifth cases).

`decisions.md`: *"Saying is free; doing requires permission… any action with side effects is asked first."*
`agent-lifecycle.md` §2: agent state includes `blocked (waiting for approval)`.

`data-model.md` has **no approval entity** — the word does not appear in the document. So the single most important safety promise in the product has a state name and no record. Missing with it:

- what a pending request stores: the tool, the exact arguments, a human-readable preview, the expiry, the reason it is asking;
- who may approve (see §16 — the human is defined as having "no privileges");
- what happens when it expires or the process dies mid-request;
- whether an approval is one-shot or standing (`allow this tool in this workspace` is a different object from `allow this call`).

This is the entity to design first, before Session. Everything else is a conversation model; this is the part that can lose the user's data.

### 2. Session has two owners, and no cost reaches it

Three statements cannot all be true:

- `data-model.md` §4.3: **Room 1 : N Session** — a session belongs to the room.
- `agent-lifecycle.md` §2: `session[room]` — *"one session per room"* — but an agent living in a room for months has hundreds of sessions, not one.
- `data-model.md` §4.4: **Session 1 : 1 Workspace, fixed once chosen** — but a group room holds N agents, each working in a different directory. One session cannot bind one workspace for all of them.

Then a fourth problem, independent of the above: `Session` is called *"the unit of billing and of where we left off"* (§2.3), yet **`Turn` has no edge to `Session`** — not in §3's diagram, not in §4's ten rules. The cheapest thing to fix and the most expensive to discover late: cost currently has an agent, a trigger and a message list, and no place to be summed.

Also: stage 1's judge call produces no `Turn` and no `Message`, so the money spent deciding *not* to speak — the majority of the product's spend — appears in no ledger at all. If `Turn` is "the atomic unit of cost and audit", either the judge calls are `Turn`s too, or a tick gets its own record.

> **Resolved 2026-10-23.** The question was framed wrong — that is what the conflict exposed. The requirement is that the interaction match Feishu's, and Feishu shows no session at all, so a Session must not be a unit the user can see; asking whether it belongs to the room or to the agent was asking the wrong layer. It is now the agent's private span of work in a room (data-model rule 3), the room's timeline is continuous (rule 13), and a Turn records the span it belongs to. That also makes "context is private" true by construction rather than by discipline. The judge-call accounting point stands and is still open.

### 3. The interruption budget has no home

> **Resolved 2026-10-23: there is no budget, so it needs no home.** The host withdrew the invented limits entirely — no daily cap, no spacing, no quiet hours. An agent's constraint is a prompt and a sandbox, as with any EMRG agent. The finding correctly identified that the budget had no entity; the answer was that it should not exist. The other half of this item — the room-level bot-turn counter — is resolved separately: it now lives on `Room`.

§10 budgets proactive DMs in **interruptions** (3/day, 30-minute spacing, quiet hours, halve after three unanswered).
§2's `budget` field is **tokens per hour and per day**. Those are different units with different lifetimes and different owners.

Nothing stores: the per-day count, the last-sent timestamp, the `unanswered` streak, the halved flag. And the dedupe key in §10.3 (`subject + room + counterpart`) implies these counters are per **(agent, counterpart)** pair, not per agent — a table that exists nowhere.

Same class of gap: **the room-level bot-turn streak** (§7's cap of 3 consecutive bot turns). That counter is a property of the room, enforced by whoever owns the room's state; an individual agent cannot know how many times its peers just spoke. It belongs on `Room`, or on a room-level watchdog that is not in the model.

### 4. `keep` is impossible as specified

> **Resolved 2026-10-23.** The contradiction came from one word doing two jobs. The judge *decides*; the loop *performs*. `keep` is a verdict like any other — the runtime appends the line, the judge only names it. That also frees the verdict's shape: since the runtime already knows what each verdict means, one word is enough, and the strict-JSON requirement is gone (the implementation uses whatever form the chosen small model produces reliably; unparseable is treated as no act and counted as a judge failure).

§4 says stage 1's judge has **no tools**, a capped `max_tokens`, and a strict-JSON reply; and that `act=0` ends the tick, *"what this step cost is the whole bill"*.
§4 also defines `keep` as *"write one line into the diary, take no action"*.

The judge has no way to write. The one branch that costs nothing is the one branch that needs a write. Either the judge's JSON carries the diary line as a field (then it is a write, and the `max_tokens` cap must account for it), or `keep` is applied at the start of the *next* stage 2 (then it is not "no action"), or `keep` is dropped and the "present but not interrupting" quality is lost.

This is the cheapest of the five to resolve — but it is a contradiction inside a single document, so it will be resolved differently by whoever implements it first.

### 5. The cost table counts messages, not agent-message pairs

§5: 10 agents, 5 rooms, 500 messages/hour, "90% stopped by the gate, 10% judged" → `50 × 300 + 2.5 × 3000 ≈ 23k`.

But path B delivers **every room message to every member agent's inbox**. With 10 agents over 5 rooms, that 500/hour is roughly 1,000–2,000 *deliveries* per hour, and the gate runs per delivery, not per message. If the 10% survives per agent, the judge line is 2–4× the stated figure; if the 10% is meant per message, the table needs the fan-out factor stated.

The conclusion (an order of magnitude below the naive port) probably survives, but the table is the document's most quotable claim and its denominator is unstated. **State the unit**: *judgements per (agent, message) pair per hour*.

---

## Design flaws to settle before P2

### 6. Degrading a private matter into a room

> **Moot 2026-10-23**: the degradation existed only because a quota could be spent. There is no quota.

§10.4: *"When the quota is spent, it degrades to a room message."*

The five whitelisted cases are all private by nature — *"blocked: without a decision it cannot go on"*, *"something it cannot judge"*. Moving that into a group room publishes the thing the DM existed to keep private, and it does so exactly when the agent is most blocked. Degrade to a visible *wanting to speak* badge on the contact instead; the user can ask it to say it in the room if they choose.

### 7. The spender can rewrite the gate — **closed 2026-10-23: the rule it attacked was never decided**

§4 stage 2 must end by recording *"how to judge the same situation next time"*. That is a self-authored update to the rules that govern future spend, written by the most expensive model in the system, with no schema, no cap, no review and no rollback. A single bad entry ("this room matters, always check it") inflates the cost curve permanently, and the curve is the product's viability.

It also makes §7's *"persona drift corrected against the diary"* circular: the diary is written by the same drifting persona.

Needs: a defined store with a schema, a rate limit on writes, a diff the user can see, and a rule that machine-written guidance can only ever be *stricter* than the persona, never more permissive.

> **Closed 2026-10-23.** The requirement this item attacks — *"stage 2 must end by recording how to judge the same situation next time"* — was the implementer's, not the host's. It entered with the first design commit and was never stated by anyone else; the host asked on 2026-10-23 where it came from, and there is no answer. It is withdrawn: stage 2 ends with an ordinary memory write, as an EMRG turn does, and no agent writes down rules for its own future gating. The circularity this item found was real, and it is fixed by removing the thing that caused it rather than by governing it.

### 8. No timezone exists anywhere

`agent-lifecycle.md` contains no mention of time zones; its time-sensitive machinery is large: quiet hours 22:00–08:00, a 30-minute minimum spacing, exponential backoff up to 8 hours, *"how long since you last spoke"*, message age.

Every one of those assumes a single wall clock. They break for a travelling user, for a room whose other members are elsewhere, and at DST boundaries. `i18n.md` covers locale formatting but **never time zones** — and it is the document that would own it.

Minimum: store the quiet window as a local time plus an IANA zone id, resolve at evaluation time, and say which zone the "day" in "3 per day" resets on.

### 9. One @-mention can produce two replies

> **Resolved 2026-10-23, by dissolving the premise.** The host pointed out that there is only ever one path: the direct road was never a bypass, it is the gate recognising an @-mention and waving it through. Since no second runner exists, no message can be picked up twice and there is no "mark it handled" bookkeeping to get wrong. Section 1 of `agent-lifecycle.md` now says one path and one loop.

Path A (DM / @ / reply) runs the full loop. Stage 0 rule 5 also says: *"@-mentioned → go straight to stage 2"*.

Nothing states that path A **consumes** the matching inbox entries. A plausible implementation does both and the agent answers twice. One sentence fixes it: path A marks its triggering entries `handled` before it starts, and the gate skips anything already handled.

### 10. `roomDigest` is maintained by nobody, at no cost

The inbox collapse (§3) pushes overflow *"into one line inside `roomDigest`"*; stage 1 reads it as cheap context. But a rolling per-(agent, room) summary is a model-written artifact: who writes it, how often, with which model, at what token cost? It appears in the cost table as zero, and it is not zero.

### 11. Two sources of truth for "which rooms does it watch"

`Membership` carries *"whether it is observing"* (§2.2), and the Agent carries `rooms[]` under Attention (§2). Remove one and the other goes stale. Pick one — the membership is the better home, because leaving the room should end the watching in the same write.

---

## Cheap fixes and bookkeeping

12. **Agent id prefix is ambiguous.** §2.1 makes an Agent a Principal (`kind=agent`), §4.10 gives `ou_` for principals *and* `ag_` for agents. One id per principal, with `kind` carrying the difference, or two id spaces with a stated rule for `sender`.
13. **Message immutability is asserted, not modelled.** No reactions (Feishu's signature gesture), no edit or recall (Feishu has both), no `state: draft | partial | final` — so an agent that dies mid-generation leaves a message that reads as complete. Also no per-room monotonic `seq`; `ts` alone will not give one shared log a total order.
14. **`hints.roomTemperature` is a room property frozen into a message.** It is stale by the time it is judged. Split per-message facts from per-judgement context.
15. **`Session "may bind a task"`** (§2.3) refers to an entity that is not among the eleven.
16. **The Human has "no privileges"** (§2.1) while being the only possible approver (§1 above). Both are right in their own layer; the document should say which layer each lives in.
17. **Pruning is not safe yet.** Messages are "prunable by room"; threads root at old messages, observations reference message ids, and the *reason* line on a proactive DM is an audit trail. Pruning needs tombstones, or the audit trail dies with the message it explains.
18. **P1 contradicts §4.** P1 is "rule-based gate (no model)" while stage 1 *is* the model call. Say P1 = stage 0 plus a rule stand-in for the judge.
19. **`decisions.md` "Not decided yet" is incomplete.** `data-model.md` §7 still carries open questions that are not listed there: whether a session is user-visible (#2), and whether an agent has a default workspace (#4). Two lists means neither is authoritative — and `src/README.md` points at the shorter one.
20. **i18n: bidi text is not "RTL layout".** Deferring RTL is reasonable; deferring `dir="auto"` on message bodies is not — one message containing Arabic or Hebrew renders wrong today in an LTR app, and the fix is an attribute, not a layout system.
21. **i18n: the message format is undecided.** §4 says "ICU-style plural categories", which implies ICU MessageFormat, but a JSON-flat-with-interpolation choice would fail §4 silently. Pick the format, since `src/README.md` makes externalisation a pre-code gate.
22. **The zh-CN copies will drift.** `CONTRIBUTING.md` says a stale translation is deleted; the directory is a full 1:1 copy with no date or commit pinned. Either mark each file with the commit it mirrors, or delete them while they are still accurate.

---

## The question no document answers

**Can an agent address another agent?** §10 is written entirely for the agent→human case; §7's anti-loop rules ("bot messages do not wake bots unless @-mentioned") assume rooms. A 2-person room with two bots and no human is the one place where the anti-loop rules can be satisfied *while looping forever*: each @-mention is an exemption, no human is present to notice, and the room's bot-turn cap is the only thing standing between the design and an unbounded bill.

This needs an explicit ruling: whether agent-to-agent addressing exists at all in v1, and if so, what the cap is that does not depend on a human being in the room.

> **Resolved 2026-10-23, approved: yes.** The ruling and the mechanism are now in `decisions.md` and `agent-lifecycle.md` §11. The shape it took is worth noting against the question as asked: the cap does not depend on a human being in the room because **a room without a human member is no longer permitted** (data-model rule 11). The root rule (no chain without a human or a scheduled tick behind it) and the depth cap then bound the set of chains rather than policing each message. Three walls, and the structural one is in the data model, not in a counter. The rest of this review stands.
