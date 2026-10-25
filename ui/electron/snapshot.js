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

function snapshotOf(store, storeFile, stage1 = null) {
  if (!store) {
    return {
      rooms: [],
      me: null,
      storeFile: null,
      stage1: stageOneOf(stage1),
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
      // The kernel's field is `created_at`; `at` is this snapshot's own name for it.
      at: message.created_at,
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
    me: meOf(store),
    storeFile,
    stage1: stageOneOf(stage1),
  }
}

module.exports = { meOf, snapshotOf }
