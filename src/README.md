# src — implementation (not started)

Nothing is written here yet. By rule 1 in `docs/decisions.md`: **settle the data model before the interface.**

## Before the first line of code

- [ ] Every open item in `docs/decisions.md` ("Not decided yet") is closed
- [ ] The on-disk shape is fixed: `principals / rooms / memberships / sessions / messages / observations / turns / memories` — messages sharded by room, observations sharded by agent
- [ ] String externalisation is set up before the first screen: no user-visible literal in code (see `docs/design/i18n.md`)
- [ ] The first milestone is **kernel only**: Agent object + watch queue + gate (pure rules, no model) + one room, **no interface**
      — what is being tested is whether "it spontaneously says something" holds up, not how it looks
- [ ] Before any two agents can address each other, the chain arbiter is in place: `caused_by` / `chain` / `depth` written on every message, the root rule, the depth cap, the per-chain budget, and the room's consecutive-agent-turn counter (`agent-lifecycle.md` §11). All agents run in one process, so this is exact rather than approximate — the moment it is policed per-agent instead, it stops being enforceable

## Relationship to the prototype

`prototype/` is a reference for layout and styling only. Its data model must not be carried over; the reasons are in `prototype/README.md`.
