/**
 * The one write the interface makes: a person sends a message, the kernel answers.
 *
 * This is the slice's whole claim, so it is measured where it happens — through the
 * kernel's real `deliver()`, the real `Kernel` and a real file on disk — rather than by
 * asserting that a function was called. `openHost` runs under plain `node --test`; no
 * Electron is involved, which is why `host.js` exists apart from `main.js`.
 *
 * The answer is the kernel's stub (`STUB_REPLY`), not a model's: no model is wired to
 * the interface yet, and a test that pretended otherwise would be the one lie here.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { applyRoster } from '../../src/roster.ts'
import { seedOneRoom, STUB_REPLY } from '../../src/main.ts'
import { emptyData, SeekStore } from '../../src/store.ts'
import { closeHost, createRoom, openHost, postMessage } from './host.js'

/**
 * A store with the kernel's own seeded world beside a roster that gives its bot a work
 * agent able to speak — the same two pieces `runFirstMilestone` composes.
 */
async function world() {
  const dir = await mkdtemp(join(tmpdir(), 'seek-ui-host-'))
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

test('a message the person sends is in the store, and the bot in the room answers it', async () => {
  const w = await world()
  try {
    const snapshot = await postMessage(w.host, { roomId: w.scene.room, text: 'the deploy is red' })
    const room = snapshot.rooms.find((one) => one.id === w.scene.room)

    assert.equal(room.messages.length, 2, 'what was typed, and the answer to it')
    assert.equal(room.messages[0].text, 'the deploy is red')
    assert.equal(room.messages[0].sender, w.scene.me, 'the message is the person\'s')
    assert.notEqual(room.messages[0].at, undefined, 'and it carries the time it was written')

    assert.equal(room.messages[1].sender, w.scene.bot, 'the answer comes from the bot')
    assert.equal(room.messages[1].text, STUB_REPLY, "and it is the kernel's own stub line")
  } finally {
    await w.done()
  }
})

/**
 * The product's thesis is that the data stays local and outlives the process, so the
 * answer has to be on disk before the window draws it — not only in memory.
 */
test('the message and its answer are on disk, in that order, before anything is drawn', async () => {
  const w = await world()
  try {
    await postMessage(w.host, { roomId: w.scene.room, text: 'is anyone there' })

    const reloaded = await SeekStore.load(w.storeFile)
    const messages = reloaded.messagesOf(w.scene.room)
    assert.deepEqual(
      messages.map((message) => message.sender_id),
      [w.scene.me, w.scene.bot],
      'reopening the file gives the same conversation in the same order',
    )
    assert.equal(messages[1].text, STUB_REPLY)
  } finally {
    await w.done()
  }
})

/** A send into a room that does not exist must say so, and must not write anything. */
test('a message for a room that does not exist is refused, and nothing is written', async () => {
  const w = await world()
  try {
    await assert.rejects(
      () => postMessage(w.host, { roomId: 'oc_not_a_room', text: 'hello' }),
      /unknown room/,
    )
    assert.equal(w.host.store.messagesOf(w.scene.room).length, 0, 'the store is untouched')
  } finally {
    await w.done()
  }
})

/** Pressing Enter in an empty box is not a message; sending one would put a blank line in the room. */
test('an empty message is refused rather than delivered', async () => {
  const w = await world()
  try {
    await assert.rejects(() => postMessage(w.host, { roomId: w.scene.room, text: '   ' }), /empty message/)
    assert.equal(w.host.store.messagesOf(w.scene.room).length, 0)
  } finally {
    await w.done()
  }
})

/**
 * A picture is either delivered or refused by the kernel — never dropped on the floor here.
 * `media` on a text message is the kernel's to judge (`mediaFor`: "only 'image' carries a
 * picture"), so this file forwards the reference verbatim and lets that sentence reach the
 * caller. Dropping it instead would answer `ok` to a send whose bytes went nowhere, and a
 * picture that vanishes with no sentence is the exact failure this slice exists to prevent
 * (`docs/decisions.md` row 17).
 */
test('a picture sent on a text message is refused by the kernel, not dropped in silence', async () => {
  const w = await world()
  try {
    await assert.rejects(
      () =>
        postMessage(w.host, {
          roomId: w.scene.room,
          text: 'here it is',
          media: { key: 'media/never-written.png', mime: 'image/png' },
        }),
      /only 'image' carries a picture/,
    )
    assert.equal(w.host.store.messagesOf(w.scene.room).length, 0, 'the store is untouched')
  } finally {
    await w.done()
  }
})

/**
 * The thread panel's whole claim: answering a message in it is the same write, with the
 * parent named — and the kernel turns that one fact into the rest of the thread
 * (`root_id`, `chain`, one hop more `depth`). Measured on the file, because a thread that
 * exists only in the window is a thread a restart loses.
 */
test('a reply posted under a message lands in that message\'s thread, on disk', async () => {
  const w = await world()
  try {
    const first = await postMessage(w.host, { roomId: w.scene.room, text: 'the deploy is red' })
    const parent = first.rooms.find((one) => one.id === w.scene.room).messages[0]

    const second = await postMessage(w.host, {
      roomId: w.scene.room,
      text: 'looking into it',
      rootId: parent.id,
    })
    const reply = second.rooms
      .find((one) => one.id === w.scene.room)
      .messages.find((message) => message.text === 'looking into it')

    assert.equal(reply.rootId, parent.id, 'the reply names the message it answers')
    assert.equal(reply.chain, parent.chain, 'and belongs to the chain that message roots')
    assert.equal(reply.depth, parent.depth + 1, 'one hop further from that root')

    const reloaded = await SeekStore.load(w.storeFile)
    const onDisk = reloaded.messagesOf(w.scene.room).find((message) => message.id === reply.id)
    assert.equal(onDisk.root_id, parent.id, 'reopening the file gives the thread back')
    assert.equal(onDisk.chain, parent.chain)
  } finally {
    await w.done()
  }
})

/**
 * A reply to a message that is not in this room is the kernel's refusal to make, not a
 * message this file quietly promotes to the top of the room: the thread would be wrong
 * and nothing would say so.
 */
test('a reply naming a message that is not in the room is refused, and nothing is written', async () => {
  const w = await world()
  try {
    await assert.rejects(
      () => postMessage(w.host, { roomId: w.scene.room, text: 'replying to nothing', rootId: 'om_not_a_message' }),
      /unknown message/,
    )
    assert.equal(w.host.store.messagesOf(w.scene.room).length, 0, 'the store is untouched')
  } finally {
    await w.done()
  }
})

/**
 * Stage 0 settles some entries for free and opens no turn for the rest; a bot that is
 * not in the room gets no entry at all. Both are the kernel's rules, and the interface
 * must not be able to talk a bot into answering a room it is not in.
 */
test('a stubbed interface still respects who is in the room', async () => {
  const w = await world()
  try {
    const snapshot = await postMessage(w.host, { roomId: w.scene.room, text: 'hello room' })
    const room = snapshot.rooms.find((one) => one.id === w.scene.room)
    const bots = room.members.filter((member) => member.bot).map((member) => member.id)
    assert.deepEqual(bots, [w.scene.bot], 'one bot, and it is the seeded one')
    assert.equal(snapshot.me, w.scene.me, 'and the interface spoke as the person')
  } finally {
    await w.done()
  }
})

/**
 * The second write: a person makes a room, and everybody they chose is in it.
 *
 * The seeded world is one room, so before this the room list was a constant and the
 * product's own premise — several conversations, some of them with a bot and some without —
 * was unreachable from the window. What is measured here is the whole path the renderer
 * takes: `host.createRoom()` → the kernel's `createRoom()` → `store.save()` → a snapshot
 * that already contains the room.
 *
 * **`roomId` is why the host returns more than a snapshot.** "The room that was just made"
 * is not derivable from a room list that may already have held one under that name, and the
 * window has to be able to go into the room it just made rather than stay where it was.
 */
test('a room made through the interface is in the snapshot, in the store, and everyone is in it', async () => {
  const w = await world()
  try {
    const made = await createRoom(w.host, {
      // Padded on purpose: a person who types a trailing space asked for the name, not
      // for the spaces, and `Room.name` is a display string the window draws verbatim.
      name: '  the second room  ',
      members: [w.scene.me, w.scene.other, w.scene.bot],
    })

    assert.equal(typeof made.roomId, 'string')
    assert.equal(made.snapshot.rooms.length, 2, 'the seeded room, and this one')
    const room = made.snapshot.rooms.find((one) => one.id === made.roomId)
    assert.equal(room.name, 'the second room')
    assert.deepEqual(
      room.members.map((member) => member.id),
      [w.scene.me, w.scene.other, w.scene.bot],
      'in the order they were chosen, which is the order the kernel wrote them',
    )
    assert.deepEqual(room.messages, [], 'and a new room has said nothing yet')

    // On disk before the snapshot was handed back — the same rule a message follows. A room
    // drawn but not saved would vanish on the next open, after the person believed it was made.
    const reloaded = await SeekStore.load(w.storeFile)
    const rows = reloaded.membershipsOf(made.roomId)
    assert.deepEqual(
      rows.map((row) => row.principal_id),
      [w.scene.me, w.scene.other, w.scene.bot],
    )
    assert.equal(
      rows.find((row) => row.principal_id === w.scene.me).role,
      'owner',
      'the person the window speaks as is the owner, as in the seeded room',
    )
    assert.equal(
      rows.find((row) => row.principal_id === w.scene.bot).role,
      'member',
      'and everybody else, bots included, is a member',
    )
  } finally {
    await w.done()
  }
})

/**
 * A second room is a room, not a row: the bot in it answers, which is the same kernel
 * path the first room takes. If it did not, "the window made a room" would be true only
 * of the room list.
 */
test('the room the interface made is one the bot answers in, like any other', async () => {
  const w = await world()
  try {
    const made = await createRoom(w.host, {
      name: 'a room with the bot',
      members: [w.scene.me, w.scene.bot],
    })
    const snapshot = await postMessage(w.host, { roomId: made.roomId, text: 'anyone here' })
    const room = snapshot.rooms.find((one) => one.id === made.roomId)

    assert.deepEqual(
      room.messages.map((message) => message.sender),
      [w.scene.me, w.scene.bot],
      'what was typed, and the bot in this room answering it',
    )
    assert.equal(room.messages[1].text, STUB_REPLY)
  } finally {
    await w.done()
  }
})

/**
 * A name of nothing but spaces is no name at all.
 *
 * `Room.name` is optional and `snapshotOf` already draws a nameless room by its id, so this
 * is the host formatting what was typed rather than refusing it — an unnamed room is a state
 * the data model has.
 */
test('a name of only spaces makes a room with no name, not a room called spaces', async () => {
  const w = await world()
  try {
    const made = await createRoom(w.host, { name: '   ', members: [w.scene.me] })
    const room = made.snapshot.rooms.find((one) => one.id === made.roomId)
    assert.equal(room.name, made.roomId, 'draws by its id, as any nameless room does')

    const reloaded = await SeekStore.load(w.storeFile)
    assert.equal(reloaded.data.rooms[made.roomId].name, undefined, 'and no name was written')
  } finally {
    await w.done()
  }
})

/**
 * The three refusals, each with the kernel's own sentence and an unchanged store.
 *
 * **The interface re-checks none of them**, which is the point of measuring them here: a
 * second opinion in the window could pass what the kernel then refuses, or refuse in wording
 * no document carries. So each of these asserts two halves — the sentence came from
 * `src/rooms.ts`, and a refusal wrote nothing, because a half-made room is the one outcome
 * that cannot be repaired by trying again.
 */
async function refused(w, input, expected) {
  const before = await SeekStore.load(w.storeFile)
  const roomsBefore = Object.keys(before.data.rooms).length
  const membersBefore = Object.keys(before.data.memberships).length

  await assert.rejects(() => createRoom(w.host, input), expected)

  const after = await SeekStore.load(w.storeFile)
  assert.equal(Object.keys(after.data.rooms).length, roomsBefore, 'no room was written')
  assert.equal(
    Object.keys(after.data.memberships).length,
    membersBefore,
    'and no membership either',
  )
}

test('a room with nobody in it is refused in the kernel\'s words, and nothing is written', async () => {
  const w = await world()
  try {
    await refused(w, { name: 'nobody', members: [] }, /a room with no members/)
  } finally {
    await w.done()
  }
})

/**
 * The same refusal, reached the way a renderer can reach it: an input list whose entries are
 * not strings names no principal at all, so it is an empty room rather than a `TypeError`
 * raised in the interface. `docs/host-rulings.md` gives a bot's room no approval step, but it
 * does not make a room nobody can speak in a room.
 */
test('members that name nobody are an empty room, not a crash in the window', async () => {
  const w = await world()
  try {
    await refused(w, { members: [null, 42, ''] }, /a room with no members/)
  } finally {
    await w.done()
  }
})

test('one principal named twice is refused, because the count is what a direct message reads', async () => {
  const w = await world()
  try {
    await refused(
      w,
      { members: [w.scene.me, w.scene.me] },
      /named twice in one room/,
    )
  } finally {
    await w.done()
  }
})

test('a member nobody in this store has heard of is refused by name', async () => {
  const w = await world()
  try {
    await refused(w, { members: [w.scene.me, 'ou_nobody'] }, /unknown principal: ou_nobody/)
  } finally {
    await w.done()
  }
})
