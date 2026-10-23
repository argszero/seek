# src — implementation (not started)

Nothing is written here yet. By rule 1 in `docs/decisions.md`: **settle the data model before the interface.**

## Before the first line of code

- [ ] Every open item in `docs/decisions.md` ("Not decided yet") is closed
- [ ] The on-disk shape is fixed: `bots / agents / principals / rooms / memberships / sessions / messages / observations / turns / memories` — messages sharded by room, observations sharded by bot, sessions by agent. **`bots` and `agents` are separate shards**: the bot owns name/avatar/description, the agents inherit them and own sessions, memory, turns and cost
- [ ] Bot-level and agent-level are not mixed anywhere. **Bot-level**: identity, membership, @-mention, the participant list, the observation queue, the tick, the state machine. **Agent-level**: model, prompt, tools, session, memory, turn, cost. Two failure modes to watch: a UI list built from agents (shows one bot as two contacts) and an inbox per agent (N deliveries and N "already handled" states instead of one)
- [ ] An agent is only ever a **runnable** — model, prompt, tools, memory — with no clock, no queue and no state of its own; if an agent starts owning a timer or a queue, that lifecycle belongs on the bot
- [ ] String externalisation is set up before the first screen: no user-visible literal in code (see `docs/design/i18n.md`)
- [ ] The judge is **a second row in `agents.yml`**, not a classifier and not a field inside the working agent: its own session, its own memory, its own local model, and a read path to its sibling (and one back). `agents.yml` is a roster of agents, not of bots — a bot may hold more than two, so nothing may assume exactly two. Two things signal the design going wrong: a summary layer built *for the judge* (it sends its own history like any agent), and any code path that lets one agent's compaction reach another's store
- [ ] Compaction is **per-agent**, because agents have different windows: verify that one agent compacting can never remove detail from another's history — this is the silent-amnesia defect the two-store rule exists to prevent
- [ ] The judge model is chosen by measurement, not by size alone: it must be **multilingual (zh + en at minimum) and multimodal (it must see images)**, bundled, CPU-viable and fast; scored on real judgement cases (a room's chatter that concerns it versus chatter that does not), because a model too weak to tell those apart is not cheaper — it is an agent that either misses everything or answers everything. It is evaluated on latency as much as quality, since its tokens are free but its milliseconds are not. The ≤300 MB target and the multimodal requirement conflict; resolve the trade explicitly, do not quietly drop one
- [ ] The first milestone is **kernel only**: Agent object + watch queue + gate (pure rules, no model) + one room, **no interface**
      — what is being tested is whether "it spontaneously says something" holds up, not how it looks
- [ ] Before any two agents can address each other, the chain arbiter is in place: `caused_by` / `chain` / `depth` written on every message, the root rule, the depth cap, and the room's consecutive-agent-turn counter (`agent-lifecycle.md` §11). All agents run in one process, so this is exact rather than approximate — the moment it is policed per-agent instead, it stops being enforceable

## Relationship to the prototype

`prototype/` is a reference for layout and styling only. Its data model must not be carried over; the reasons are in `prototype/README.md`.
