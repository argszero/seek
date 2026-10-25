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

function snapshotOf(store, storeFile) {
  if (!store) return { rooms: [], me: null, storeFile: null, error: 'the store is not open yet' }

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
    })),
  }))

  return {
    rooms,
    me: meOf(store),
    storeFile,
  }
}

module.exports = { meOf, snapshotOf }
