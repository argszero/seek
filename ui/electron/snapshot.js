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
    pending: pendingOf(stage2?.pending),
    // A missing weights directory starves both halves, so stage 2 reads them the same way stage
    // 1 does — the words half survives when somebody named one, and it still has to say why the
    // model itself is not there.
    weights: weightsOf(stage2?.weights),
  }
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
 * Who may be put in a room: everyone the store holds except a bot that has been deleted.
 *
 * The list must not *offer* such a bot — nothing may be sent to it and it may not be added —
 * while the history it left may still *name* it. That is the whole difference between this
 * answer and `namedOf` below, and both read `everyoneOf`.
 */
function peopleOf(store) {
  const { people, stamped } = everyoneOf(store)
  return people.filter((one) => !stamped.has(one.id))
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
 */
function spendByRoom(store) {
  const roomOfSession = new Map()
  for (const sessions of Object.values(store.data.sessions)) {
    for (const session of sessions) roomOfSession.set(session.id, session.room_id)
  }

  const byRoom = new Map()
  for (const turn of store.data.turns) {
    const roomId = roomOfSession.get(turn.session_id)
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
        name: bot && typeof bot.name === 'string' && bot.name !== '' ? bot.name : botId,
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
 * What the interface is allowed to see, in one plain object.
 *
 * `storeRefusal` is why the kernel would not open the store, as the kernel said it, or
 * `null` when nothing was refused. **It is not `error`.** `error` says "not open yet" — a
 * reading that is true for a moment on every start and means nothing is wrong — while a
 * refusal means the app will not work until somebody acts on that sentence. A window that
 * drew the second as the first would show a broken install as a slow one, and the person
 * would wait for a store that is never coming (the design's reasoning, one
 * layer down). Both are strings or `null`, so the renderer still holds no error object.
 */
function snapshotOf(store, storeFile, stage1 = null, stage2 = null, storeRefusal = null) {
  if (!store) {
    return {
      rooms: [],
      people: [],
      me: null,
      storeFile: null,
      stage1: stageOneOf(stage1),
      stage2: stageTwoOf(stage2),
      storeRefusal,
      // The rule a person is shown on the bot's card is a fact about the product, not about
      // this store, so it is here even on a window that never opened one: a refusal is when a
      // reader most needs to know what the app is for.
      firstLaw: FIRST_LAW,
      error: 'the store is not open yet',
    }
  }

  const spent = spendByRoom(store)
  // **The list is the rooms this person is in.** It was every room in the store, which was the
  // same list while a membership could only be *added*; `removeMember()` and the panel's `Leave`
  // (2026-10-27) made a room somebody is not in reachable, and the window went on listing the
  // room it had just left and offering it a composer — a write `deliver()` refuses, because the
  // sender is not a member. Measured the same day: after leaving a three-member group the room
  // stayed in the column with `2 members` in the store and nobody of them the reader.
  const me = meOf(store)
  const mine = new Set(
    Object.values(store.data.memberships)
      .filter((row) => row.principal_id === me)
      .map((row) => row.room_id),
  )
  const rooms = Object.values(store.data.rooms)
    .filter((room) => mine.has(room.id))
    .map((room) => ({
    id: room.id,
    // A room's name is optional in the kernel's own type, and a room the roster
    // created may have none — drawing `undefined.slice` would throw on it.
    name: typeof room.name === 'string' && room.name !== '' ? room.name : room.id,
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
    })),
  }))

  return {
    rooms,
    people: peopleOf(store),
    // A message may name someone no longer in the room, so the window gets the names that are
    // not offers as well — see `namedOf`.
    named: namedOf(store),
    me,
    storeFile,
    stage1: stageOneOf(stage1),
    stage2: stageTwoOf(stage2),
    // A store that opened has nothing to refuse; the field is present so a window reading
    // it never has to ask whether its absence means "fine" or "not asked".
    storeRefusal: null,
    // Quoted, not written here: one sentence with three screens reading it (`law.js`).
    firstLaw: FIRST_LAW,
  }
}

module.exports = { meOf, peopleOf, namedOf, snapshotOf }
