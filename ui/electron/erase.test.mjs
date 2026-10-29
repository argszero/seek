/**
 * Taking things back, through the bridge the window actually calls.
 *
 * The kernel's own refusals and stamps are `src/erase.test.ts`; what is measured here is the
 * chain above it: that `host.js` writes the store to disk, that the snapshot the window draws
 * from carries the deletion back, that a deleted room really leaves the list, and that the blob
 * of a deleted picture is handed to the caller who owns the bytes. Measured on a real file in a
 * temporary directory, because "the words are gone" is a claim about the disk, not about a
 * variable a test is still holding.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { applyRoster } from '../../src/roster.ts'
import { seedOneRoom } from '../../src/main.ts'
import { emptyData, SeekStore } from '../../src/store.ts'
import {
  closeHost,
  deleteMessage,
  deleteRoom,
  deleteThread,
  openHost,
  postMessage,
  hostSnapshot,
} from './host.js'

/**
 * Send, and wait for the room to answer.
 *
 * `postMessage()` hands its snapshot back as soon as the message is written, because a bot
 * answers on its own time — that is what keeps the composer usable while it talks
 * (`ui/electron/host.js`). A test about the answer is therefore a test about what happens
 * after that: this waits for the kernel and then reads the room again, which is the same
 * two steps `main.js` takes before it tells the window the facts changed.
 */
async function postAndWait(host, input) {
  await postMessage(host, input)
  await host.kernel.whenIdle()
  return hostSnapshot(host)
}


/** The window's own world: one seeded room, one bot with a work agent that can answer. */
async function world() {
  const dir = await mkdtemp(join(tmpdir(), 'seek-ui-erase-'))
  const storeFile = join(dir, 'seek.json')
  const store = new SeekStore(emptyData(), storeFile)
  const scene = seedOneRoom(store)
  applyRoster(store, [
    { bot: 'Echo', role: 'watch', tools: [] },
    { bot: 'Echo', role: 'work', tools: ['say'] },
  ])
  await store.save()

  const host = await openHost(storeFile)
  return {
    host,
    scene,
    storeFile,
    async done() {
      closeHost(host)
      await rm(dir, { recursive: true, force: true })
    },
  }
}

test('a deleted message is still in the snapshot, and its words are gone from the file', async () => {
  const w = await world()
  try {
    const snapshot = await postAndWait(w.host, { roomId: w.scene.room, text: 'send it before I think' })
    const sent = snapshot.rooms.find((one) => one.id === w.scene.room).messages[0]
    assert.equal(sent.text, 'send it before I think')

    const gone = await deleteMessage(w.host, { messageId: sent.id })
    assert.equal(gone.messageId, sent.id)
    assert.equal(gone.roomId, w.scene.room)
    assert.equal(gone.media, null, 'a text message carries no blob to remove')

    const after = gone.snapshot.rooms.find((one) => one.id === w.scene.room)
    const tombstone = after.messages.find((one) => one.id === sent.id)

    // The row is still there — everything that names this id keeps resolving — and it says it
    // was taken back, which is what the window draws the tombstone from.
    assert.notEqual(tombstone, undefined, 'the row went with the words, and a reply would point at nothing')
    assert.equal(typeof tombstone.deletedAt, 'string')
    assert.equal(tombstone.text, '')

    // And the words are gone from the disk, not just from this process's copy: the claim a
    // deletion makes is about the file a person copies around.
    closeHost(w.host)
    const again = await openHost(w.storeFile)
    try {
      const onDisk = again.store.messagesOf(w.scene.room).find((one) => one.id === sent.id)
      assert.equal(onDisk.text, '')
      assert.equal(typeof onDisk.deleted_at, 'string')
    } finally {
      closeHost(again)
    }
  } finally {
    await w.done()
  }
})

test('a thread is deleted whole through the bridge, and the room it was in still reads', async () => {
  const w = await world()
  try {
    const first = await postAndWait(w.host, { roomId: w.scene.room, text: 'the deploy is red' })
    const root = first.rooms.find((one) => one.id === w.scene.room).messages[0]
    const answered = await postAndWait(w.host, {
      roomId: w.scene.room,
      text: 'which service?',
      rootId: root.id,
    })
    const reply = answered.rooms
      .find((one) => one.id === w.scene.room)
      .messages.find((one) => one.rootId === root.id)
    assert.notEqual(reply, undefined, 'the reply is in the thread the store records')

    const gone = await deleteThread(w.host, { rootId: root.id })

    // Both messages, one instant, and the ids ride back because the snapshot keeps them as
    // tombstones — "which ones did this call take" is not derivable from it.
    assert.deepEqual(gone.messageIds.sort(), [root.id, reply.id].sort())
    const room = gone.snapshot.rooms.find((one) => one.id === w.scene.room)
    for (const id of [root.id, reply.id]) {
      const one = room.messages.find((message) => message.id === id)
      assert.equal(typeof one.deletedAt, 'string')
      assert.equal(one.text, '')
    }
    // The room itself is untouched: a thread is not a room, and deleting one is not leaving.
    assert.equal(room.members.length > 0, true)
  } finally {
    await w.done()
  }
})

test('a deleted room leaves the list, and a message into it is refused', async () => {
  const w = await world()
  try {
    await postAndWait(w.host, { roomId: w.scene.room, text: 'one last thing' })

    const gone = await deleteRoom(w.host, { roomId: w.scene.room })

    assert.equal(gone.roomId, w.scene.room)
    assert.equal(gone.messageIds.length >= 1, true, 'the messages went with the room')
    // The list is the rooms this person is in, and the memberships went with the room — so the
    // window stops offering a room that no longer exists without learning a new rule.
    assert.deepEqual(
      gone.snapshot.rooms.filter((one) => one.id === w.scene.room),
      [],
    )

    // And the refusal says the room is gone rather than "you are not a member", which is true
    // of a deleted room and is not the truth about it.
    await assert.rejects(
      () => postMessage(w.host, { roomId: w.scene.room, text: 'anybody there?' }),
      /was deleted on/,
    )
  } finally {
    await w.done()
  }
})

test('the picture a deleted message carried is handed back, so its bytes can go too', async () => {
  const w = await world()
  try {
    const snapshot = await postAndWait(w.host, {
      roomId: w.scene.room,
      text: '',
      kind: 'image',
      media: { key: 'om-abc123-deadbeef.png', mime: 'image/png' },
    })
    const picture = snapshot.rooms.find((one) => one.id === w.scene.room).messages[0]
    assert.equal(picture.media.key, 'om-abc123-deadbeef.png')

    const gone = await deleteMessage(w.host, { messageId: picture.id })

    // `host.js` never touches a file — `main.js` is the only place that knows where `media/`
    // is — so the reference rides back out and the caller removes it. A caller that dropped
    // this would leave a deleted picture on disk under a message that no longer names it.
    assert.deepEqual(gone.media, { key: 'om-abc123-deadbeef.png' })
    const room = gone.snapshot.rooms.find((one) => one.id === w.scene.room)
    assert.equal(room.messages.find((one) => one.id === picture.id).media, null)
  } finally {
    await w.done()
  }
})

test('a tombstone with no replies does not invite a reply', async () => {
  // The one drawing rule this slice adds, and the renderer has no DOM harness — every assertion
  // about what `App.jsx` draws in this suite is a read of the file (`catalogue.test.mjs` does the
  // same for the words). What is being pinned is the *condition*, not the markup: a message that
  // was taken back has nothing left to answer, while a thread already under it must stay
  // reachable, because those replies are still there.
  const source = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')
  assert.match(source, /\{chip && message\.chain === message\.id && \(!deleted \|\| replies > 0\) && \(/)
  assert.doesNotMatch(source, /\{chip && \(\n/)
})
