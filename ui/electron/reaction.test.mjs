/**
 * The window's fifth write: a reaction on one message — and the forward, which is the fourth
 * write reaching outside its own room.
 *
 * Both arrive through the hover toolbar, and both are the kernel's own calls: `toggleReaction()`
 * and `deliver()`'s `forwardOf` (`src/delivery.ts`). What this file measures is the half a
 * window cannot show on its own — that the reaction reaches the **store**, not only the
 * snapshot the window draws, and that a forward's original is read out of the room it names
 * rather than out of the room being posted to.
 *
 * Two facts about reactions are worth pinning here rather than in the kernel's own suite,
 * because they are facts about *this* path: the same call both adds and takes back (`seek:react`
 * has no twin channel), and a row whose last operator leaves is deleted rather than left as an
 * empty entry — so nothing on disk says `reactions` about a message nobody reacted to.
 *
 * Nothing here starts a model or an Electron: `openHost` runs under plain `node --test`, which
 * is why a posted message is answered by the kernel's `STUB_REPLY` and not worth asserting on.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { seedOneRoom } from '../../src/main.ts'
import { applyRoster, parseRoster } from '../../src/roster.ts'
import { emptyData, SeekStore } from '../../src/store.ts'
import { closeHost, createRoom, openHost, postMessage, reactToMessage } from './host.js'

/**
 * A store with the seeded world and a roster beside it.
 *
 * The roster is a file because `openHost` reads one on every open, and a bot with no `work`
 * row makes the kernel's own turn throw — a harness without it would be measuring the branch
 * where posting a message fails before a reaction could be recorded.
 */
const ROSTER_YAML = `agents:
  - bot: Echo
    role: watch
    tools: []
  - bot: Echo
    role: work
    tools: [say]
`

async function world() {
  const dir = await mkdtemp(join(tmpdir(), 'seek-ui-react-'))
  const storeFile = join(dir, 'seek.json')
  const rosterFile = join(dir, 'agents.yml')
  const store = new SeekStore(emptyData(), storeFile)
  const scene = seedOneRoom(store)
  await writeFile(rosterFile, ROSTER_YAML, 'utf8')
  applyRoster(store, parseRoster(ROSTER_YAML, rosterFile))
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

/** One room out of a snapshot, and its newest message. */
function roomIn(snapshot, roomId) {
  const room = snapshot.rooms.find((one) => one.id === roomId)
  assert.ok(room, `the snapshot holds ${roomId}`)
  return room
}

function messageIn(snapshot, roomId, messageId) {
  const message = roomIn(snapshot, roomId).messages.find((one) => one.id === messageId)
  assert.ok(message, `the snapshot holds ${messageId}`)
  return message
}

test('a reaction lands in the store and comes back in the snapshot', async () => {
  const w = await world()
  try {
    const posted = await postMessage(w.host, { roomId: w.scene.room, text: 'look at this' })
    const messageId = roomIn(posted, w.scene.room).messages.at(-1).id

    const after = await reactToMessage(w.host, {
      roomId: w.scene.room,
      messageId,
      emojiType: 'OK',
    })

    // The snapshot says what the store says, and the shape is the kernel's: one entry per
    // emoji holding the people who reacted. No count travels (`snapshot.js`), because a count
    // and a list are the same fact and only one of them can name two people out of four.
    assert.deepEqual(messageIn(after, w.scene.room, messageId).reactions, [
      { emojiType: 'OK', operators: [after.me] },
    ])

    // Saved, not merely held: `reactToMessage` awaits the store's own save, so a window that
    // showed a reaction and crashed would still find it on the next open.
    const stored = await readFile(w.storeFile, 'utf8')
    assert.ok(stored.includes('"OK"'), 'the emoji reached the file beside the store')
  } finally {
    await w.done()
  }
})

test('the same emoji again takes the reaction back and leaves no row behind', async () => {
  const w = await world()
  try {
    const posted = await postMessage(w.host, { roomId: w.scene.room, text: 'second thoughts' })
    const messageId = roomIn(posted, w.scene.room).messages.at(-1).id
    const react = () =>
      reactToMessage(w.host, { roomId: w.scene.room, messageId, emojiType: 'THUMBSUP' })

    const once = await react()
    assert.equal(messageIn(once, w.scene.room, messageId).reactions.length, 1)

    // One call, two directions: `seek:react` has no `unreact` beside it because a second press
    // *is* the undo (`toggleReaction()` in `src/delivery.ts`).
    const twice = await react()
    assert.deepEqual(messageIn(twice, w.scene.room, messageId).reactions, [])

    // And nothing is written for a reaction nobody holds — not an empty array, not a zero row.
    const stored = await readFile(w.storeFile, 'utf8')
    assert.equal(stored.includes('reactions'), false, 'no row is left for a reaction taken back')
  } finally {
    await w.done()
  }
})

test('a reaction with no emoji is refused in the kernel’s own words', async () => {
  const w = await world()
  try {
    const posted = await postMessage(w.host, { roomId: w.scene.room, text: 'react to what?' })
    const messageId = roomIn(posted, w.scene.room).messages.at(-1).id

    await assert.rejects(
      () => reactToMessage(w.host, { roomId: w.scene.room, messageId, emojiType: '   ' }),
      /emoji/i,
    )
    // A refused reaction writes nothing, so the message is exactly as it was.
    const after = await reactToMessage(w.host, {
      roomId: w.scene.room,
      messageId,
      emojiType: 'SMILE',
    })
    assert.deepEqual(
      messageIn(after, w.scene.room, messageId).reactions.map((one) => one.emojiType),
      ['SMILE'],
    )
  } finally {
    await w.done()
  }
})

test('a forward names the room its original is in and carries its words', async () => {
  const w = await world()
  try {
    const posted = await postMessage(w.host, {
      roomId: w.scene.room,
      text: 'the numbers are in the sheet',
    })
    // The person's own line, found by its words: posting wakes the bot, so the newest message
    // in the room by the time this call returns is the answer rather than what was said.
    const original = roomIn(posted, w.scene.room).messages.find(
      (one) => one.text === 'the numbers are in the sheet',
    )
    assert.ok(original, 'the original is in the room it was said in')

    const made = await createRoom(w.host, {
      name: 'elsewhere',
      members: [posted.me, w.scene.bot],
    })

    // An empty box and nothing else: a forward's words are the original's, so this is the one
    // post that must get past the composer's "an empty message is not a message".
    const forwarded = await postMessage(w.host, {
      roomId: made.roomId,
      text: '',
      forwardOf: { roomId: w.scene.room, messageId: original.id },
    })

    // Found by the fact this test is about rather than by position: the bot in the target room
    // answers the arrival, so the newest message there is its reply, not the forward.
    const copy = roomIn(forwarded, made.roomId).messages.find(
      (one) => one.forwardedFrom?.messageId === original.id,
    )
    assert.ok(copy, 'the forward landed in the other room')
    assert.equal(copy.text, 'the numbers are in the sheet', 'the words are copied, not retyped')
    assert.deepEqual(copy.forwardedFrom, { messageId: original.id, name: 'me' })
    assert.equal(copy.quoted, null, 'a forward quotes nothing')

    // The original is still where it was: forwarding adds a message, it does not move one.
    assert.equal(roomIn(forwarded, w.scene.room).messages.length, roomIn(posted, w.scene.room).messages.length)
  } finally {
    await w.done()
  }
})

test('a half forward address is refused rather than sent as an empty message', async () => {
  const w = await world()
  try {
    const posted = await postMessage(w.host, { roomId: w.scene.room, text: 'something' })
    const original = roomIn(posted, w.scene.room).messages.at(-1)

    await assert.rejects(
      () => postMessage(w.host, { roomId: w.scene.room, text: '', forwardOf: { messageId: original.id } }),
      /names both the room it is in and the message/,
    )
    await assert.rejects(
      () => postMessage(w.host, { roomId: w.scene.room, text: '', forwardOf: { roomId: w.scene.room } }),
      /names both the room it is in and the message/,
    )
  } finally {
    await w.done()
  }
})
