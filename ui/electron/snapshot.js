'use strict'

/**
 * What the interface is allowed to see, taken from the kernel's own store.
 *
 * A plain, serialisable read: rooms, the members in them, and each room's messages in
 * the order they were written. It is built on this side because the renderer has no
 * access to the kernel, and it reads through `SeekStore`'s own accessors
 * (`membershipsOf`, `messagesOf`, `principal`) rather than reaching into the shards —
 * so a shard that changes shape changes one caller, not the interface with it.
 */
function snapshotOf(store, storeFile) {
  if (!store) return { rooms: [], me: null, storeFile: null, error: 'the store is not open yet' }

  const rooms = Object.values(store.data.rooms).map((room) => ({
    id: room.id,
    name: room.name,
    kind: room.kind,
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
      at: message.at,
    })),
  }))

  return {
    rooms,
    me: Object.keys(store.data.principals)[0] ?? null,
    storeFile,
  }
}

module.exports = { snapshotOf }
