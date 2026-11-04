'use strict'

/**
 * What the interface is allowed to see, taken from the kernel's own store.
 *
 * A plain, serialisable read: rooms, the members in them, and each room's messages in
 * the order they were written. It is built on this side because the renderer has no
 * access to the kernel, and it reads through `SeekStore`'s own accessors
 * (`membershipsOf`, `messagesOf`, `principal`) rather than reaching into the shards —
 * so a shard that changes shape changes one caller, not the interface with it.
 *
 * **Every key here names a field the kernel actually writes.** The snapshot renames
 * some of them (`created_at` → `at`), and a rename read off the wrong source is
 * `undefined` on every message the kernel has ever written — invisible, because a
 * renderer that has not drawn the field yet shows the same nothing either way. That
 * is exactly how two of them lived here: `message.at` and `room.kind`, neither of
 * which exists on the kernel's types. The test beside this file now builds its
 * messages by calling `deliver()`, so the kernel's shape is the only shape in play.
 */

const { FIRST_LAW } = require('./law.js')

/**
 * The person the interface speaks as.
 *
 * There is no account and no login in this product, so the store holds no "the user"
 * — the first person in it stands in for one. Bots keep their own map
 * (`data.bots`), so this can never resolve to a bot; the day a user is actually
 * chosen, this function is the one place that changes.
 */
function meOf(store) {
  const [first] = Object.keys(store.data.principals)
  return first ?? null
}

/**
 * How far the download has got, as three facts.
 *
 * `{received, total, file}`, and never a finished sentence. A sentence built where the download
 * is measured has picked a language and a decimal separator before any catalogue is consulted
 * (`docs/design/i18n.md` §1, §4) — which is exactly what a window drew on a first run:
 * `0.2 GB of 2.2 GB — LFM2.5-VL-3B-Q4_0.gguf` under a heading the catalogue had already put
 * into the language it was running in. So the numbers travel and the window writes the words.
 *
 * `file` is this snapshot's own name for the reading's `name`, the way `at` is its name for
 * `created_at`: in here `name` already means a person's, and one field cannot mean both. A
 * string is refused rather than passed on — that is the old shape, and drawing it would put
 * English back on a strip that can ask.
 */
function pendingOf(value) {
  if (value === null || typeof value !== 'object') return null
  const received = Number(value.received)
  const total = Number(value.total)
  if (!Number.isFinite(received) || !Number.isFinite(total)) return null
  return { received, total, file: textOrNull(value.name) }
}

/**
 * Why the weights are not here, as the facts the window words itself.
 *
 * Three shapes, because there are three things to say and they are not the same sentence:
 * `{kind: 'no-host', repo}` is a configuration mistake and entirely ours; `{kind: 'refused',
 * words}` is one host's own sentence, and `docs/design/i18n.md` §2 forbids rewriting what a
 * sender said — a host that answered is a sender; `{kind: 'hosts', hosts: [{host, words}]}` is
 * the list of them, whose frame and whose joining are the language's (§4).
 *
 * **A field of its own rather than a shape of `refusal`.** `refusal` is `modelServerRefusal` and
 * the store's refusal, both of them the kernel's own sentences and both of them strings. An
 * object for one producer and a string for another is the polymorphism this file refuses
 * everywhere else, and it is what stops the window from ever being able to word one of them.
 *
 * Like `pendingOf`, this validates rather than trusts: a reading whose shape is wrong is no
 * reading, and the renderer is handed plain data — no Error, no stack, nothing it has to
 * interrogate.
 */
function weightsOf(value) {
  if (value === null || typeof value !== 'object') return null
  if (value.kind === 'no-host') {
    const repo = textOrNull(value.repo)
    return repo === null ? null : { kind: 'no-host', repo }
  }
  // **Nothing a host or the runtime said reaches the page.** `docs/host-rulings.md`, "The window
  // does not speak to a developer": what the window draws is what a person can act on, and
  // `fetch failed` — Node's own words — is not that. So the words are dropped here rather than
  // left for a component to decline to draw, and what crosses is which places were tried: a
  // person who named a host learns that their host is the one that did not answer. The sentences
  // go to stderr, where `describe()` in `weights-fetch.js` writes them.
  if (value.kind === 'refused') {
    const host = textOrNull(value.host)
    return host === null ? { kind: 'stopped', hosts: [] } : { kind: 'stopped', hosts: [host] }
  }
  if (value.kind === 'hosts') {
    if (!Array.isArray(value.hosts) || value.hosts.length === 0) return null
    const hosts = []
    for (const one of value.hosts) {
      const host = textOrNull(one?.host)
      if (host === null) return null
      hosts.push(host)
    }
    return { kind: 'stopped', hosts }
  }
  return null
}

/**
 * A list of names as a reading: strings, no duplicates, `[]` when there is nothing to say.
 *
 * Validated rather than trusted, like everything else on this edge — a name that is not a
 * string is no name, and the renderer is handed a list it can join without asking what is
 * in it.
 */
function namesOf(value) {
  if (!Array.isArray(value)) return []
  const names = []
  for (const one of value) {
    const name = textOrNull(one)
    if (name === null || names.includes(name)) continue
    names.push(name)
  }
  return names
}

/**
 * What a missing model costs, in the two things a person can tell apart.
 *
 * **Not one fact per half, and not one fact for both.** Which half of the kernel a bot is
 * missing is a developer's distinction (`docs/host-rulings.md`, "The window does not speak
 * to a developer"), but what it costs the person is not: a bot with no words **cannot
 * answer at all**, while a bot with no judgement answers whatever is addressed to it and
 * nothing else, because a direct room, a mention and a reply to its own message are settled
 * by the rules (`gate.ts` row 2). Two sentences follow from that and both are true; a single
 * sentence would have to be wrong about one of them.
 *
 * A bot both halves left out is counted once, in the stronger group — it cannot answer.
 * `null` when every bot is served, so a window with a working model draws nothing extra.
 */
function modelNotReadyOf(one, two) {
  const cannotAnswer = two.quiet
  const namedOnly = one.quiet.filter((name) => !cannotAnswer.includes(name))
  if (cannotAnswer.length === 0 && namedOnly.length === 0) return null
  return { cannotAnswer, namedOnly }
}

/**
 * Which stage 1 the window is looking at, in the two facts the interface may show.
 *
 * `server` is the origin the bot's judgement is bound to, or `null` when the run is the
 * kernel's placeholder; `refusal` is why a server that *was* named is not in use. They are
 * two different readings and the window must not draw them as one: nothing named is a
 * state — this build has no model until someone configures one — while a server that was
 * named and not used is a failure, and a window showing both as "no model" would hide the
 * second.
 *
 * `server` and `refusal` are strings or `null`, so the renderer holds no error object and no
 * stack: what it draws is a sentence somebody wrote, passed through unchanged. `pending` is the
 * third reading and the one that is not prose — see `pendingOf`.
 */
function stageOneOf(stage1) {
  return {
    server: typeof stage1?.server === 'string' && stage1.server !== '' ? stage1.server : null,
    refusal: typeof stage1?.refusal === 'string' && stage1.refusal !== '' ? stage1.refusal : null,
    // **Which bots this half has nothing for.** Not a refusal and not a failure of the
    // store: an install with no model named is a state, and the names are what the window
    // needs to say so about the bots it affects (`namesOf`).
    quiet: namesOf(stage1?.quiet),
    // A third reading, and it is not a failure: the weights are still arriving, and this is how
    // far. It is a field of its own rather than a soft refusal because the window draws the two
    // in different colours, and a download in progress painted in the error colour would report
    // the app as broken for the first ten minutes of its life. Facts rather than a sentence —
    // `pendingOf` says why.
    pending: pendingOf(stage1?.pending),
    // And the fourth: why the weights never arrived. Facts like `pending`, and unlike `refusal`
    // — see `weightsOf` for why the two must not be one field.
    weights: weightsOf(stage1?.weights),
  }
}

/**
 * Which stage 2 the window is looking at — the same two facts, for the other half.
 *
 * The halves refuse independently: a store whose watch row is served and whose work row
 * claims a model the work server does not serve is a real state, and drawing one strip
 * for both would let the good half hide the broken one. Nothing named is a state; named
 * and not used is a failure (one half over).
 */
function stageTwoOf(stage2) {
  return {
    server: typeof stage2?.server === 'string' && stage2.server !== '' ? stage2.server : null,
    refusal: typeof stage2?.refusal === 'string' && stage2.refusal !== '' ? stage2.refusal : null,
    quiet: namesOf(stage2?.quiet),
    pending: pendingOf(stage2?.pending),
    // A missing weights directory starves both halves, so stage 2 reads them the same way stage
    // 1 does — the words half survives when somebody named one, and it still has to say why the
    // model itself is not there.
    weights: weightsOf(stage2?.weights),
  }
}

/**
 * The model-server facts, merged into the snapshot the host built and validated on the way in.
 *
 * `snapshotNow()` in `ui/electron/main.js` adds what the host cannot know — a download under
 * way, why it stopped, a server that died while the window was open. It used to add them there,
 * by spreading each half and overwriting `pending` and `weights` with the reading exactly as it
 * was measured, one line after the host's own validated reading had arrived. Those two readings
 * do not travel in the window's shape: `weights-fetch.js` names a file `name` and reports a
 * failure as `{kind: 'refused', host, words}`, while the window reads `file` and
 * `{kind: 'stopped', hosts}`. So the validated fields were thrown away immediately after being
 * built, and a first run — which draws this line while it fetches the weights — handed the
 * renderer `undefined` where a file's name goes. The catalogue's guard is what caught it, by
 * throwing: the window drew nothing at all, for as long as the download took.
 *
 * **It lives here because it can be run here.** `main.js` is an Electron main process, which no
 * test imports — the reason a disagreement on this edge survived a whole green suite. What
 * cannot be imported cannot be held to anything.
 *
 * **Validated after the merge, and only once.** The readings arrive raw and leave in the shape
 * `pendingOf` and `weightsOf` produce, so exactly one place names a field. Neither validator is
 * idempotent — `pendingOf` reads `name` and writes `file` — which is why the merge must never
 * hand a validated value back through them, and why nothing else may write these four fields.
 *
 * The order they win is the one `main.js` stated when it owned this: a download under way is the
 * newest fact, the reason it stopped is the next, and a server that died is the last.
 */
function withServerFacts(snapshot, { pending = null, weights = null, refusal = null } = {}) {
  const half = (stage) => {
    if (pending !== null) {
      return { ...stage, pending: pendingOf(pending), refusal: null, weights: null }
    }
    if (weights !== null) {
      return { ...stage, pending: null, refusal: null, weights: weightsOf(weights) }
    }
    if (refusal !== null) return { ...stage, pending: null, refusal }
    return stage
  }
  return { ...snapshot, stage1: half(snapshot.stage1), stage2: half(snapshot.stage2) }
}

/**
 * Everyone the store knows, so a room that does not exist yet can be given members.
 *
 * A room's own `members` answer "who is in this room"; making one needs the other
 * question — "who is there to put in it" — and until this existed the window could not
 * ask it: the only members it ever saw were the ones already somewhere.
 *
 * A person and a bot are the same kind of thing here, which is the kernel's own model
 * (`store.principal()` reads `principals` and `bots` together, and `docs/design/data-model.md`
 * joins both by `Membership`). `bot` is carried because the interface draws the two
 * differently, not because membership treats them differently — a room whose only member
 * is a bot is an ordinary room.
 *
 * Read through `Object.values` and not sorted: the store's order is the order they were
 * written in, and a list that reorders itself between two snapshots would move under a
 * person's cursor while they are choosing.
 */
function everyoneOf(store) {
  // **A bot deleted from the organization is still someone this store named.** Its row stays
  // because every message it wrote points at it (`Bot.deleted_at`), so the two answers below
  // read one list and differ in the one place that matters: who this organization *has*, and
  // who may still be *named*. Filtered on the stamp and not on a flag beside it, for the reason
  // `deleted_at` is a stamp. One name is read here rather than two because `openHost` adopts
  // the earlier spelling of it when the store is opened (`adoptBotDeletions`, `src/bots.ts`).
  const stamped = new Set(
    Object.values(store.data.bots)
      .filter((bot) => bot.deleted_at !== undefined)
      .map((bot) => bot.id),
  )
  const people = [...Object.values(store.data.principals), ...Object.values(store.data.bots)].map((who) => {
    const isBot = Boolean(store.data.bots[who.id])
    return {
      id: who.id,
      name: typeof who.name === 'string' && who.name !== '' ? who.name : who.id,
      bot: isBot,
      // The two kinds read different fields, and neither is invented here. A person has a
      // `description` and no four-part card; a bot has the four the host asked for
      // (`src/types.ts`, `Bot`) and every one of them may be absent on a bot written before
      // those fields existed — so each is `null` rather than missing, and the window can draw
      // "not said" without asking whether absence means that or a rename that went wrong.
      kind: isBot ? 'bot' : 'human',
      description: textOrNull(who.description),
      gender: isBot ? textOrNull(who.gender) : null,
      position: isBot ? textOrNull(who.position) : null,
      personality: isBot ? textOrNull(who.personality) : null,
    }
  })
  return { people, stamped }
}

/**
 * Who may be put in a room: this organization's reader, and its bots.
 *
 * **Not "everyone the store knows".** An organization holds exactly one person — the one the
 * window speaks as (`meOf`) — and bots; nobody here is ever made, invited or deleted. So the
 * only roster a room's member list should offer is that person and the bots, and a human the
 * store happens to hold is not on it.
 *
 * A store can hold one anyway: the first seed wrote a second person called `someone else`, to
 * make the room they landed in a group. Offering them here put a row in every member picker
 * that no screen could take out again — measured on the create-a-chat card, 2026-10-27, after
 * the bots list had already stopped showing them.
 *
 * A deleted bot is not offered either — nothing may be sent to it and it may not be added —
 * while the history it left may still *name* it. That is the whole difference between this
 * answer and `namedOf` below, and both read `everyoneOf`.
 */
function peopleOf(store) {
  const { people, stamped } = everyoneOf(store)
  const me = meOf(store)
  return people.filter((one) => !stamped.has(one.id) && (one.bot || one.id === me))
}

/**
 * Everyone the store has ever named, by id — the deleted bots included.
 *
 * **This is what a message's author is looked up in.** A line whose sender has left the room or
 * the organization is still a line somebody wrote, and the window used to fall back to the raw
 * id (`ou_447c1cba8e4d4bee`) when the author was not a member any more: the sentence survived
 * and lost its signature. Measured 2026-10-27 after taking a bot out of a room it had spoken in.
 */
function namedOf(store) {
  const { people } = everyoneOf(store)
  return Object.fromEntries(people.map((one) => [one.id, one]))
}

/** A stored string, or `null` when it is absent, empty or not a string at all. */
function textOrNull(value) {
  return typeof value === 'string' && value !== '' ? value : null
}

/** A bot as a person reads it, falling back to the id a nameless one is recorded by. */
function nameOfBot(bot, id) {
  return bot !== undefined && typeof bot.name === 'string' && bot.name !== '' ? bot.name : id
}

/**
 * The room each session worked in, by session id.
 *
 * A turn names its session and a session names its room (`src/types.ts`), so this is the whole
 * join between a ledger row and a room a window draws. Two readings need it — what a room spent
 * and who went quiet in it — and neither of them keeps a counter beside it, because two
 * accountings of one fact are two answers that can disagree.
 *
 * A reminder's session has no room (§12: a bot's own work is not a contribution to a room), so
 * it is absent from this map rather than mapped to nothing.
 */
function roomOfSession(store) {
  const roomOf = new Map()
  for (const sessions of Object.values(store.data.sessions)) {
    for (const session of sessions) roomOf.set(session.id, session.room_id)
  }
  return roomOf
}

/** Every observation in the store by id — the join a turn's `entries` are read through. */
function entriesById(store) {
  const byId = new Map()
  for (const entries of Object.values(store.data.observations)) {
    for (const entry of entries) byId.set(entry.id, entry)
  }
  return byId
}

/**
 * The calendar day the reader is living in, for an instant the record holds.
 *
 * `docs/design/agent-lifecycle.md` §8 item 6 asks for what a room has spent **today**, so
 * the day this answers for is the reader's own: somebody looking at a room header at 09:00
 * wants the morning's turns, not the ones since midnight UTC. That is a different question
 * from the one `src/archive.ts`'s `dayOf()` answers when it names a day file, where the cut
 * is deliberately the recorded instant's own — an entry is filed under the day it arrived,
 * and converting that would file one day's messages under another's name. Both are small;
 * neither is the other's rule.
 *
 * An instant the record should not hold — a hand-edited store — gives `null` rather than
 * throwing. This is read while a window is being drawn, and one unreadable row must not
 * take the window down with it.
 */
function readingDayOf(at) {
  const when = new Date(at)
  if (Number.isNaN(when.getTime())) return null
  const pad = (value) => String(value).padStart(2, '0')
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`
}

/**
 * What the bots in each room have spent, read off the ledger the kernel already keeps.
 *
 * `docs/host-rulings.md` — "No spending cap" — settles this whole shape: cost is
 * **recorded and visible, never enforced**. So this is a read and only a read. There is
 * no budget to compare against, no remaining figure, and nothing here that could make a
 * window draw a limit, because the ruling forbids a limit existing at all. A percentage
 * of anything would be an invention.
 *
 * **Every number comes from a turn.** `Turn` carries `input_tokens` and `output_tokens`
 * (`src/types.ts`), `turn.ts` writes them from the model server's own report, and a turn
 * that ran no model leaves zeros — so `0` is a real reading (the placeholder path spends
 * nothing) and not missing data. Nothing here estimates a spend the ledger does not hold.
 *
 * The join is the kernel's own three facts rather than a counter kept beside them: a turn
 * names its session, a session names its agent and its room, and an agent names its bot.
 * A reminder's turn has no room (§12 — it is the bot's own work, not a contribution to a
 * room), so it is counted against no room; a room's figure is therefore what was spent
 * *in* it, which is the only thing a room's header can honestly show.
 *
 * **Today, not ever.** §8 item 6's own words are "how much it has spent today", and the day
 * comes off `turn.started_at` — an instant the kernel already writes. A turn from an earlier
 * day is left out of the figure rather than aged into it, and `readingDayOf()` above is the
 * one place that says which day a given instant belongs to.
 */
function spendByRoom(store, today) {
  const roomOf = roomOfSession(store)

  const byRoom = new Map()
  for (const turn of store.data.turns) {
    // §8 item 6 asks for today, so a turn from an earlier day is not this figure's business.
    // The header used to carry every turn the room had ever had, which is the one reading the
    // design does not ask for: a room that talked all of last week showed a number no reader
    // could attribute to anything they had done.
    if (readingDayOf(turn.started_at) !== today) continue
    const roomId = roomOf.get(turn.session_id)
    if (roomId === undefined) continue

    const agent = store.data.agents[turn.agent_id]
    const botId = agent ? agent.bot_id : null
    const spend = byRoom.get(roomId) ?? { turns: 0, input_tokens: 0, output_tokens: 0, bots: [] }
    spend.turns += 1
    spend.input_tokens += turn.input_tokens
    spend.output_tokens += turn.output_tokens

    // Per bot as well as per room, because the figure a reader wants when a room costs
    // something is *who* spent it — the ruling sends that reader to the bot's persona or
    // its gate, and neither is reachable from one total.
    const row = spend.bots.find((own) => own.id === botId) ?? null
    if (row) {
      row.turns += 1
      row.input_tokens += turn.input_tokens
      row.output_tokens += turn.output_tokens
    } else {
      const bot = botId === null ? undefined : store.data.bots[botId]
      spend.bots.push({
        id: botId,
        name: nameOfBot(bot, botId),
        turns: 1,
        input_tokens: turn.input_tokens,
        output_tokens: turn.output_tokens,
      })
    }

    byRoom.set(roomId, spend)
  }
  return byRoom
}

/** A room nothing has been spent in: no turns, and therefore no tokens. */
const NOTHING_SPENT = { turns: 0, input_tokens: 0, output_tokens: 0, bots: [] }

/**
 * Who is in the middle of answering each message — the second half of §8 item 4.
 *
 * The work order spells the whole sentence out: *"'Why did it ignore me?' is expandable:
 * translate the `reason` into plain language ('this was not addressed to me, and someone else
 * is already answering')"*. The first clause has been on the screen since the silence line
 * landed; **the second one is the fact the record holds and nothing read**. A bot that is
 * working has sent nothing yet, so a room where an answer is on its way looked exactly like a
 * room where nobody was coming — and the reader's next move, asking again, is what that
 * mistake costs.
 *
 * **Unfinished is the whole test.** `turn.ts` writes `ended_at` in its `finally`, so a row
 * without it is a decision that has not come in yet. This is the same field `silenceByRoom`
 * reads the other way round for `nothing-sent` (there: closed, and produced no message), so one
 * turn can never answer both — the two readings partition the ledger rather than overlapping.
 *
 * **The join is the ledger's own, not a counter beside it.** A turn names the entries that woke
 * it (`src/turn.ts`, `Turn.entries`) and an entry names its message (`src/delivery.ts`), so
 * "which message is this bot answering" is a read. A turn woken by several entries is answering
 * all of them, which is the same multiplicity the `ignore` reading has.
 *
 * Read once per snapshot, for the reason `silenceByRoom` is: the inbox is unbounded, so asking
 * this per message would be quadratic in a room's life.
 */
function answeringByRoom(store) {
  const roomOf = roomOfSession(store)
  const entryById = entriesById(store)

  const byRoom = new Map()
  for (const turn of store.data.turns) {
    if (turn.ended_at !== undefined) continue
    const roomId = roomOf.get(turn.session_id)
    if (roomId === undefined) continue

    const agent = store.data.agents[turn.agent_id]
    const bot = agent === undefined ? undefined : store.data.bots[agent.bot_id]
    if (bot === undefined) continue
    // A bot that has left the room is not answering in it: its turn may still be on the
    // record, but "it is answering you" over a room that does not hold it is a sentence about
    // someone who is not there.
    if (!store.membershipsOf(roomId).some((own) => own.principal_id === bot.id)) continue

    const byMessage = byRoom.get(roomId) ?? new Map()
    for (const id of Array.isArray(turn.entries) ? turn.entries : []) {
      const entry = entryById.get(id)
      if (entry === undefined || entry.message_id === undefined) continue
      const row = byMessage.get(entry.message_id) ?? []
      if (row.some((one) => one.id === bot.id)) continue
      row.push({ id: bot.id, name: nameOfBot(bot, bot.id) })
      byMessage.set(entry.message_id, row)
    }
    byRoom.set(roomId, byMessage)
  }
  return byRoom
}

/**
 * Who read a message and said nothing, per room and per message.
 *
 * A bot that did not answer leaves no message behind, so nothing in the room's log says it was
 * ever there. **Two different things leave that same hole, and §8 asks for both**
 * (`docs/design/agent-lifecycle.md`): item 4 — *"why did it ignore me?"* — and item 5 — *"why
 * is it silent? ... a turn that ended without sending is a turn on the record, so the same
 * expansion can say what the bot decided instead of speaking."* They are not the same reading,
 * so every entry says which one it is in `because`:
 *
 * - `not-addressed` — the judgement wrote `ignore` on the entry it read (`gate.ts` for the
 *   rules, `watch.ts` for the model). No turn ran and nothing was spent. **`ignore` is the
 *   whole test here**: `act` is a bot that is answering, and an entry with no verdict is one
 *   the rules fast-passed (a mention, a reply, a direct message) or one no half has reached
 *   yet — neither is a silence, and drawing either as one would report a bot that is working
 *   as a bot that refused.
 * - `nothing-sent` — a turn ran, closed, and produced no message (`Turn.produced` empty). The
 *   bot was handed the room and sent nothing: either it chose nothing to say, or its answer
 *   never became a message — a model that writes prose instead of calling `say` is a case this
 *   repository has measured (`seek-work-model-cannot-call`). Both look identical from outside,
 *   so the sentence the window draws says what the record says and no more.
 *
 * **Two turns that are not silences.** One still deciding has no `ended_at` — `turn.ts` writes
 * it in its `finally` — and reading it as silence would report a bot that is working as a bot
 * that refused. One that ran no model spent nothing (the row keeps the zeros it was created
 * with), and a turn where nothing decided is not a decision: that is the same `null` the
 * proactive mark draws for a message no turn produced.
 *
 * **The message is the reader's unit, the turn is where the second kind lives.** A turn may be
 * woken by several entries, and every one of them was handed to the bot that then sent nothing,
 * so it is drawn under each of them — the same multiplicity the `ignore` reading already has,
 * one line per message a bot passed on.
 *
 * **Read once per room, not once per message.** The inbox is unbounded — "no entry has to be
 * silently dropped to keep it small" — so asking this per message is quadratic in a room's
 * life; this is the index that makes it one pass.
 *
 * **A bot no longer in the room is not read.** Its verdict and its turn are still on the
 * record, but "it stayed out of this" printed over a room that does not hold it is a sentence
 * about someone who is not there.
 *
 * **A `not-addressed` entry also carries who is answering instead** (`answeringByRoom`), and a
 * `nothing-sent` one does not. That is not a gap: §8 item 4's sentence is the only one with a
 * slot for it ("… this was not addressed to me, and someone else is already answering"), while
 * a bot that ran a turn and closed it has already decided — another bot's open turn explains
 * nothing about it, and carrying a list the only sentence for that row cannot name would be a
 * second reading of one fact that can disagree with the first.
 */
function silenceByRoom(store) {
  const answering = answeringByRoom(store)

  const byRoom = new Map()
  for (const room of Object.values(store.data.rooms)) {
    const byMessage = new Map()
    for (const membership of store.membershipsOf(room.id)) {
      const bot = store.data.bots[membership.principal_id]
      if (bot === undefined) continue
      for (const entry of store.inbox(bot.id)) {
        if (entry.verdict !== 'ignore' || entry.message_id === undefined) continue
        const row = byMessage.get(entry.message_id) ?? []
        if (row.some((one) => one.id === bot.id)) continue
        // Everyone mid-turn on this message, minus this bot: a bot cannot be silent here and
        // answering there, but the filter costs one line and keeps the sentence true if that
        // ever changes.
        const elsewhere = (answering.get(room.id)?.get(entry.message_id) ?? []).filter(
          (one) => one.id !== bot.id,
        )
        row.push({
          id: bot.id,
          name: nameOfBot(bot, bot.id),
          because: 'not-addressed',
          answering: elsewhere,
        })
        byMessage.set(entry.message_id, row)
      }
    }
    byRoom.set(room.id, byMessage)
  }

  // §8 item 5's half, read off the same ledger and appended to the same index.
  const roomOf = roomOfSession(store)
  const entryById = entriesById(store)
  for (const turn of store.data.turns) {
    if (turn.ended_at === undefined) continue
    if (Array.isArray(turn.produced) && turn.produced.length > 0) continue
    if ((turn.input_tokens ?? 0) + (turn.output_tokens ?? 0) <= 0) continue
    const roomId = roomOf.get(turn.session_id)
    const byMessage = roomId === undefined ? undefined : byRoom.get(roomId)
    if (byMessage === undefined) continue
    const agent = store.data.agents[turn.agent_id]
    const bot = agent === undefined ? undefined : store.data.bots[agent.bot_id]
    if (bot === undefined) continue
    if (!store.membershipsOf(roomId).some((own) => own.principal_id === bot.id)) continue
    for (const id of Array.isArray(turn.entries) ? turn.entries : []) {
      const entry = entryById.get(id)
      if (entry === undefined || entry.message_id === undefined) continue
      const row = byMessage.get(entry.message_id) ?? []
      if (row.some((one) => one.id === bot.id)) continue
      row.push({ id: bot.id, name: nameOfBot(bot, bot.id), because: 'nothing-sent' })
      byMessage.set(entry.message_id, row)
    }
  }

  return byRoom
}

/**
 * What each bot in a room has done with what reached it — how many it took on, and how many it
 * passed on.
 *
 * `docs/design/agent-lifecycle.md` §3 gives an arrival two endings that are recorded: the rules
 * or the judgement settle it as `ignore`, or it opens a turn. This turns those two endings into
 * the one reading a reader of a room wants about a bot — *is it picking things up, or is it
 * letting the room talk past it* — and it reads two things the kernel already writes rather
 * than keeping a third counter beside them.
 *
 * **Why the verdict alone cannot supply the first number.** `entry.verdict === 'act'` is written
 * on one path only: the judgement's. The rules' fast pass — an @-mention, a reply, a direct
 * message, a due reminder (`src/gate.ts`, row 2) — is certain and free, so it consumes the entry
 * **without writing a verdict at all** (`data-model.md`, the Observation row, says exactly
 * that). A count of `'act'` verdicts would therefore report a bot that answers every message
 * addressed to it as having acted on none of them. What that half reads instead is the turn:
 * `src/inbox.ts` opens one with the entries that survived the gate, and `Turn.entries` names
 * them (`src/turn.ts`), so "this entry opened a turn for that bot" is already on the record.
 *
 * **Passed on is the verdict and nothing else.** `ignore` is written by `gate.ts` for a muted
 * room or another bot's broadcast and by `watch.ts` for a judgement that said no, and to a
 * reader both mean the same thing: it read this, and this was not for it. `snooze` and `keep`
 * are the other two members of `Verdict` and nothing writes either today, so neither is
 * counted — a row drawn for a state no entry can be in is the same shape as the fourth state
 * dot §8 item 1 does not have.
 *
 * **The two are disjoint by construction**, which is why one entry is one number: an entry
 * settled `ignore` opens no turn, and an entry that opened a turn was not ignored. The `Set`
 * below is belt and braces against the one shape that could break that — an entry the chain
 * wall put back (§11.4) and a later turn then opened with.
 *
 * A reminder has no room (§12: a bot's own work is not a contribution to a room), so it is
 * counted for no room and reaches no row.
 */
function judgedByRoom(store) {
  const byRoom = new Map()
  const rowFor = (roomId, botId) => {
    let room = byRoom.get(roomId)
    if (room === undefined) {
      room = new Map()
      byRoom.set(roomId, room)
    }
    let row = room.get(botId)
    if (row === undefined) {
      row = { acted: 0, passed: 0 }
      room.set(botId, row)
    }
    return row
  }

  for (const entries of Object.values(store.data.observations)) {
    for (const entry of entries) {
      if (entry.verdict !== 'ignore' || entry.room_id === undefined) continue
      rowFor(entry.room_id, entry.bot_id).passed += 1
    }
  }

  const roomOf = roomOfSession(store)
  const entryById = entriesById(store)
  const counted = new Set()
  for (const turn of store.data.turns) {
    const roomId = roomOf.get(turn.session_id)
    if (roomId === undefined) continue
    const agent = store.data.agents[turn.agent_id]
    const botId = agent === undefined ? undefined : agent.bot_id
    if (botId === undefined) continue
    for (const id of Array.isArray(turn.entries) ? turn.entries : []) {
      const entry = entryById.get(id)
      // The entry's own room is what this row is about. A session's room is where the turn ran,
      // and the two can only disagree on a store somebody edited by hand.
      if (entry === undefined || entry.room_id !== roomId) continue
      const seen = `${botId}\u0000${id}`
      if (counted.has(seen)) continue
      counted.add(seen)
      rowFor(roomId, botId).acted += 1
    }
  }

  return byRoom
}

/**
 * Which of a bot's messages were its own idea, per message id.
 *
 * `docs/design/agent-lifecycle.md` §8 item 2 asks the window to mark "proactive messages ...
 * not a reply to you, but something it chose to say", and §10.2 draws the consequence: *"it
 * came to find you" reads differently from "it answered you"*. **Nothing in this file decides
 * which of the two a message is.** The facts are on the record twice over: the turn names the
 * entries that woke it (`src/turn.ts`, `Turn.entries`), and each of those entries carries the
 * kind delivery computed for it — `mention`, `reply` and `direct` are the three ways a message
 * addresses this bot (`src/gate.ts`, row 2), while `message` is a room talking near it and
 * `reminder` is the bot's own note to itself (§12). So "was this addressed" is a read, and the
 * mark is the answer to it.
 *
 * **The message is the reader's unit, the turn is where the fact lives.** A turn may say
 * several things, and every one of them came out of the same wake: all of them answered, or
 * none of them did. Reading it per message instead of per turn is what lets a row draw it.
 *
 * **`null` is a third answer and the honest one.** A message no turn produced (a seed, a
 * fixture, anything written before this field existed) has no recorded wake, and a window that
 * read that as "it answered you" would be claiming something the record does not say. Absent
 * therefore draws nothing at all.
 *
 * Read once per snapshot, not once per message: the inbox is append-only and unbounded
 * ("no entry has to be silently dropped to keep it small"), so asking per message would be
 * quadratic in a room's life — the same reason `silenceByRoom` is one pass.
 */
function proactiveByMessage(store) {
  const ADDRESSED = new Set(['mention', 'reply', 'direct'])
  const entryById = entriesById(store)

  const byMessage = new Map()
  for (const turn of store.data.turns) {
    const woke = (Array.isArray(turn.entries) ? turn.entries : [])
      .map((id) => entryById.get(id))
      .filter((entry) => entry !== undefined)
    // A turn naming no entry says nothing about why it ran, so it is not a reading.
    if (woke.length === 0) continue
    // One addressed entry is enough: the turn was woken by something said to it, and the
    // rest of what it read does not make the answer less of an answer.
    const answered = woke.some((entry) => ADDRESSED.has(entry.kind))
    for (const id of Array.isArray(turn.produced) ? turn.produced : []) {
      byMessage.set(id, !answered)
    }
  }
  return byMessage
}

/**
 * What every bot in this organization is doing, as the kernel reported it.
 *
 * `docs/design/agent-lifecycle.md` §8 item 1 asks the window for "a state dot: watching /
 * working / asleep / needy, as an avatar badge", and §2 lists `state` among a bot's life
 * facts. **None of those four words is stored, and none of them is invented here either.**
 * The kernel answers two readings — which bots are in a turn, which have a wait armed — and
 * this maps them onto the vocabulary; a bot in neither reading is asleep. The derivation
 * belongs at this seam for the reason `mentionsMe` and `depth` do: the record holds facts,
 * the window holds words.
 *
 * **`needy` is not among the answers, because nothing produces it.** It means "waiting on
 * your decision", and the kernel has no path that asks a person for one and waits: a bot
 * either reads what arrived or it does not. A fourth word drawn here would be a state no
 * bot can be in — the same shape as the `reason` a silent bot never has (`src/llama.ts`
 * writes no sentence), which the design's own §8 item 4 has to state rather than draw.
 *
 * **Every bot the store still offers is in the answer**, asleep included. A missing entry
 * therefore means "not a bot here any more" — the author of a message no longer in the
 * organization — and a window drawing a dot for one of those would be reporting on a bot
 * that has left.
 */
function botStatesOf(activity, people) {
  const states = {}
  const listed = (value) => (Array.isArray(value) ? value : [])
  for (const person of people) {
    if (person.bot) states[person.id] = 'asleep'
  }
  if (!activity || typeof activity !== 'object') return states
  for (const id of listed(activity.watching)) {
    if (id in states) states[id] = 'watching'
  }
  // Working last, so a bot that is somehow in both readings is drawn as the one that is
  // spending a turn: the wait is over the moment the tick it ends in opens.
  for (const id of listed(activity.working)) {
    if (id in states) states[id] = 'working'
  }
  return states
}

/**
 * What the interface is allowed to see, in one plain object.
 *
 * `storeRefusal` is why the kernel would not open the store, as the kernel said it, or
 * `null` when nothing was refused. **It is not `error`.** `error` says "not open yet" — a
 * reading that is true for a moment on every start and means nothing is wrong — while a
 * refusal means the app will not work until somebody acts on that sentence. A window that
 * drew the second as the first would show a broken install as a slow one, and the person
 * would wait for a store that is never coming (the design's reasoning, one
 * layer down). Both are strings or `null`, so the renderer still holds no error object.
 *
 * `activity` is the kernel's own answer to "what is each bot doing" — `Kernel.activity()`'s
 * two lists, handed over by the caller that holds the kernel, because nothing in this file
 * may read one. It is the sixth argument rather than a fact hung off the store for the reason
 * the store holds no such field: the reading is true for a moment and would go stale by the
 * next write.
 */
function snapshotOf(
  store,
  storeFile,
  stage1 = null,
  stage2 = null,
  storeRefusal = null,
  activity = null,
  today = null,
) {
  // Read once, so the halves and the one fact drawn from both cannot disagree — a window
  // that listed a quiet bot in one field and not the other would be two readings of one
  // state.
  const one = stageOneOf(stage1)
  const two = stageTwoOf(stage2)
  const modelNotReady = modelNotReadyOf(one, two)

  if (!store) {
    return {
      rooms: [],
      people: [],
      me: null,
      storeFile: null,
      stage1: one,
      stage2: two,
      modelNotReady,
      storeRefusal,
      // The rule a person is shown on the bot's card is a fact about the product, not about
      // this store, so it is here even on a window that never opened one: a refusal is when a
      // reader most needs to know what the app is for.
      firstLaw: FIRST_LAW,
      // A store that never opened has no bots, so there is nothing to be doing anything.
      activity: {},
      error: 'the store is not open yet',
    }
  }

  // The day the header's figure is about (§8 item 6's "today"), named by the caller when it has
  // one so that a test — or a window drawing the day it was opened on — is not at the mercy of
  // the clock being read mid-snapshot.
  const spent = spendByRoom(store, today ?? readingDayOf(Date.now()))
  // Read once, for the same reason `spent` is: one table read beats one read per message.
  const silences = silenceByRoom(store)
  // §8 item 2, read off the record once for the same reason.
  const proactives = proactiveByMessage(store)
  // What each bot has taken on and passed on here — one pass for the same reason as `spent`.
  const judged = judgedByRoom(store)
  // **The list is the rooms this person is in.** It was every room in the store, which was the
  // same list while a membership could only be *added*; `removeMember()` and the panel's `Leave`
  // (2026-10-27) made a room somebody is not in reachable, and the window went on listing the
  // room it had just left and offering it a composer — a write `deliver()` refuses, because the
  // sender is not a member. Measured the same day: after leaving a three-member group the room
  // stayed in the column with `2 members` in the store and nobody of them the reader.
  const me = meOf(store)
  // Read once, like `spent` and `silences`: the state table and the list of bots it is about
  // must not be two reads of one store.
  const people = peopleOf(store)
  const mine = new Set(
    Object.values(store.data.memberships)
      .filter((row) => row.principal_id === me)
      .map((row) => row.room_id),
  )
  const rooms = Object.values(store.data.rooms)
    .filter((room) => mine.has(room.id))
    .map((room) => ({
    id: room.id,
    // **A room's name is the store's, or it is nothing.** It is optional in the kernel's own
    // type and a room made from a name of only spaces has none. This answered `room.id` for
    // both, which put a machine's identifier where the interface draws a title — measured in a
    // real window on 2026-11-03: an unnamed group was listed as `oc_f63ba78b67f84769`. `null`
    // is the fact, and what to call such a room is the window's answer
    // (`ui/src/room-name.mjs`), because it is the members' names and how a language separates
    // names is a format (`docs/design/i18n.md` §4) — a decision this layer, holding no locale,
    // cannot make. `null` and not `undefined` for the reason `description` is: the two kinds of
    // nothing would otherwise draw differently.
    name: typeof room.name === 'string' && room.name !== '' ? room.name : null,
    // `chat_mode` is the field; it is stored and never branched on
    // (`src/README.md` line 32), which is why the interface may show it.
    kind: room.chat_mode,
    // What the room says about itself, in the kernel's own three fields (`Room`). `null` and
    // never `undefined`, for the reason `media` is `null`: a renderer facing two kinds of
    // nothing draws whatever `undefined` does — and here the two kinds are real, because a
    // room nobody has written about and a room whose text a person cleared are both absent in
    // the store and both mean "say something" in the window.
    description: textOrNull(room.description),
    announcement: textOrNull(room.announcement),
    tag: textOrNull(room.tag),
    // When the room was made, so the panel that answers "what is this room" can say it. The
    // window words the moment itself (`catalogue.mjs` `when()`), because a date is a format.
    createdAt: room.created_at,
    // What the bots in this room have spent, as the ledger holds it — a number to read,
    // with nothing to compare it against (`docs/host-rulings.md`, "No spending cap").
    spend: spent.get(room.id) ?? NOTHING_SPENT,
    members: store.membershipsOf(room.id).map((membership) => {
      const who = store.principal(membership.principal_id)
      const isBot = Boolean(store.data.bots[membership.principal_id])
      return {
        id: membership.principal_id,
        name: who && typeof who.name === 'string' ? who.name : membership.principal_id,
        bot: isBot,
        // What this bot has taken on and passed on **in this room**, or `null` for a person —
        // who has no inbox for it to be counted from — and for a bot nothing here has been
        // settled about yet, where a pair of zeros would claim a reading the record does not
        // hold. `judgedByRoom()` decides; the window words it.
        judged: judged.get(room.id)?.get(membership.principal_id) ?? null,
      }
    }),
    messages: store.messagesOf(room.id).map((message) => ({
      id: message.id,
      sender: message.sender_id,
      text: message.text,
      // `kind` and `media` are the kernel's own two fields for a picture
      // `kind: 'image'` with one `{key, mime}` reference in
      // `media`, present exactly when the kind is `image`. The interface draws a picture
      // when it sees `image` and never infers it from the text, because a message whose
      // kind says `image` and whose bytes nothing can find is a claim, not a fact.
      kind: message.kind,
      media: message.media ? { key: message.media.key, mime: message.media.mime } : null,
      // **The attachment, in the four facts a row draws.** `kind: 'file'` names one
      // `MessageFile` (`src/types.ts`): a key, the person's own name for the file, its size
      // and its mime. The key is opaque, so the name is the only thing that can say *which*
      // file a row is about; the size is what lets the row say how big it is without opening
      // it; the mime is what the main process needs to hand it to the right application.
      // `null` and never `undefined`, for the reason `media` is `null` — a renderer facing
      // two kinds of nothing draws whatever `undefined` does.
      file: message.file
        ? {
            key: message.file.key,
            name: message.file.name,
            size: message.file.size,
            mime: message.file.mime,
          }
        : null,
      // The kernel's field is `created_at`; `at` is this snapshot's own name for it.
      at: message.created_at,
      // When the message was taken back, or `null` while it stands. It reaches the window
      // because a deleted message is still in this list — its row is what every reference to
      // it resolves to — and the window has to know to draw a tombstone rather than an empty
      // message. `null` and never `undefined`, for the reason `media` is `null`.
      deletedAt: message.deleted_at ?? null,
      // Who this message addresses, in the kernel's own pairs: `mentions` is the field,
      // `{id, name}` each, and rule 15 of `docs/design/data-model.md` says it is "what the
      // interface draws as blue @-text" — so a snapshot without it is a window that cannot
      // draw a mention at all, and the message would keep carrying one where nothing reads
      // it. The pair is copied off the message rather than looked up in the roster, because
      // a mention records who was named when it was said: renaming somebody afterwards does
      // not rewrite a message that is already written, which is what "an immutable shared
      // fact" means. `[]` and never `undefined`, for the reason `media` is `null`: a
      // renderer facing two kinds of nothing draws whatever `undefined` does.
      mentions: message.mentions.map((mention) => ({ id: mention.id, name: mention.name })),
      // The three things a message carries besides its own words, in the kernel's own
      // shape (`src/types.ts`): `reactions` is one emoji and `operators[]`, `quoted` is
      // the snapshot a reply kept and `forwarded_from` the one a forward kept. No `count`
      // and no "mine" travel: the count is `operators.length` and "mine" is one reader's
      // viewpoint of a shared log — the same two reasons `mentions` carries no
      // `mentionsMe`. `[]` and `null` rather than absent, so a renderer never has two
      // kinds of nothing to tell apart.
      reactions: (message.reactions ?? []).map((reaction) => ({
        emojiType: reaction.emoji_type,
        operators: reaction.operators.slice(),
      })),
      quoted: message.quoted
        ? {
            messageId: message.quoted.message_id,
            name: message.quoted.name,
            text: message.quoted.text,
          }
        : null,
      forwardedFrom: message.forwarded_from
        ? {
            messageId: message.forwarded_from.message_id,
            name: message.forwarded_from.name,
          }
        : null,
      // A thread, in the kernel's own three facts (`src/types.ts`): `root_id` is the
      // message this one answers and is absent on a message that answers nothing;
      // `chain` is the root of the run this message belongs to — a message that caused
      // nothing roots its own chain — and `depth` is how many hops from that root
      // (`src/delivery.ts`). The interface groups by `chain` and never by anything it
      // computes itself, so "which messages are one thread" has one answer.
      rootId: message.root_id ?? null,
      chain: message.chain,
      depth: message.depth,
      // **Who read this and said nothing, and why — the two answers §8 asks for.** A bot that
      // stayed out leaves no message, so this list is the only trace of it the room's log can
      // carry, and each entry names which reading it is: `not-addressed` (the judgement wrote
      // `ignore`, and the message was not for that bot) or `nothing-sent` (a turn ran, closed
      // and produced no message — §8 item 5). A `not-addressed` entry also names who is
      // answering instead (`answering`), which is item 4's second clause: the bot that is
      // working has sent nothing yet, so without it a room with an answer on the way drew the
      // same nothing as a room where nobody was coming. The words are the catalogue's; this
      // layer carries the fact and the window chooses the sentence. See `silenceByRoom`, which
      // also says what it deliberately leaves out: a turn still deciding, and one that ran no
      // model.
      silent: silences.get(room.id)?.get(message.id) ?? [],
      // **Whether the bot chose to speak, or answered something said to it** — §8 item 2,
      // §10.2. `true` is "it came to find you", `false` is "it answered you", and `null` is
      // "the record does not say": a message no turn produced has no recorded wake, and a
      // window told `false` there would print an answer to a question nobody asked. See
      // `proactiveByMessage`, which also says why nothing here decides it.
      proactive: proactives.get(message.id) ?? null,
    })),
  }))

  return {
    rooms,
    people,
    // What each of those bots is doing, in the four words of §8 item 1 as far as anything
    // produces them — see `botStatesOf`, which also says why the fourth is not here.
    activity: botStatesOf(activity, people),
    // A message may name someone no longer in the room, so the window gets the names that are
    // not offers as well — see `namedOf`.
    named: namedOf(store),
    me,
    storeFile,
    stage1: one,
    stage2: two,
    // The two facts above, put into the shapes the window words itself: the bots that cannot
    // answer, the bots that answer only when named, or `null` when every bot is served.
    modelNotReady,
    // A store that opened has nothing to refuse; the field is present so a window reading
    // it never has to ask whether its absence means "fine" or "not asked".
    storeRefusal: null,
    // Quoted, not written here: one sentence with three screens reading it (`law.js`).
    firstLaw: FIRST_LAW,
  }
}

module.exports = { meOf, peopleOf, namedOf, snapshotOf, readingDayOf, withServerFacts }
