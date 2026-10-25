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
 * Which stage 1 the window is looking at, in the two facts the interface may show.
 *
 * `server` is the origin the bot's judgement is bound to, or `null` when the run is the
 * kernel's placeholder; `refusal` is why a server that *was* named is not in use. They are
 * two different readings and the window must not draw them as one: nothing named is a
 * state — this build has no model until someone configures one — while a server that was
 * named and not used is a failure, and a window showing both as "no model" would hide the
 * second (`docs/decisions.md` row 20).
 *
 * Both are strings or `null`, so the renderer holds no error object and no stack: what it
 * draws is a sentence somebody wrote, passed through unchanged.
 */
function stageOneOf(stage1) {
  return {
    server: typeof stage1?.server === 'string' && stage1.server !== '' ? stage1.server : null,
    refusal: typeof stage1?.refusal === 'string' && stage1.refusal !== '' ? stage1.refusal : null,
  }
}

/**
 * Which stage 2 the window is looking at — the same two facts, for the other half.
 *
 * The halves refuse independently: a store whose watch row is served and whose work row
 * claims a model the work server does not serve is a real state, and drawing one strip
 * for both would let the good half hide the broken one. Nothing named is a state; named
 * and not used is a failure (`docs/decisions.md` row 27, one half over).
 */
function stageTwoOf(stage2) {
  return {
    server: typeof stage2?.server === 'string' && stage2.server !== '' ? stage2.server : null,
    refusal: typeof stage2?.refusal === 'string' && stage2.refusal !== '' ? stage2.refusal : null,
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
function peopleOf(store) {
  const people = [
    ...Object.values(store.data.principals),
    ...Object.values(store.data.bots),
  ].map((who) => ({
    id: who.id,
    name: typeof who.name === 'string' && who.name !== '' ? who.name : who.id,
    bot: Boolean(store.data.bots[who.id]),
  }))
  return people
}

function snapshotOf(store, storeFile, stage1 = null, stage2 = null) {
  if (!store) {
    return {
      rooms: [],
      people: [],
      me: null,
      storeFile: null,
      stage1: stageOneOf(stage1),
      stage2: stageTwoOf(stage2),
      error: 'the store is not open yet',
    }
  }

  const rooms = Object.values(store.data.rooms).map((room) => ({
    id: room.id,
    // A room's name is optional in the kernel's own type, and a room the roster
    // created may have none — drawing `undefined.slice` would throw on it.
    name: typeof room.name === 'string' && room.name !== '' ? room.name : room.id,
    // `chat_mode` is the field; it is stored and never branched on
    // (`src/README.md` line 32), which is why the interface may show it.
    kind: room.chat_mode,
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
      // (`docs/decisions.md` row 17): `kind: 'image'` with one `{key, mime}` reference in
      // `media`, present exactly when the kind is `image`. The interface draws a picture
      // when it sees `image` and never infers it from the text, because a message whose
      // kind says `image` and whose bytes nothing can find is a claim, not a fact.
      kind: message.kind,
      media: message.media ? { key: message.media.key, mime: message.media.mime } : null,
      // The kernel's field is `created_at`; `at` is this snapshot's own name for it.
      at: message.created_at,
      // Who this message addresses, in the kernel's own pairs: `mentions` is Feishu's field,
      // `{id, name}` each, and rule 15 of `docs/design/data-model.md` says it is "what the
      // interface draws as blue @-text" — so a snapshot without it is a window that cannot
      // draw a mention at all, and the message would keep carrying one where nothing reads
      // it. The pair is copied off the message rather than looked up in the roster, because
      // a mention records who was named when it was said: renaming somebody afterwards does
      // not rewrite a message that is already written, which is what "an immutable shared
      // fact" means. `[]` and never `undefined`, for the reason `media` is `null`: a
      // renderer facing two kinds of nothing draws whatever `undefined` does.
      mentions: message.mentions.map((mention) => ({ id: mention.id, name: mention.name })),
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
    me: meOf(store),
    storeFile,
    stage1: stageOneOf(stage1),
    stage2: stageTwoOf(stage2),
  }
}

module.exports = { meOf, peopleOf, snapshotOf }
