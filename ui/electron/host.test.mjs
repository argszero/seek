/**
 * The one write the interface makes: a person sends a message, the kernel answers.
 *
 * This is the slice's whole claim, so it is measured where it happens — through the
 * kernel's real `deliver()`, the real `Kernel` and a real file on disk — rather than by
 * asserting that a function was called. `openHost` runs under plain `node --test`; no
 * Electron is involved, which is why `host.js` exists apart from `main.js`.
 *
 * **The bot's half is handed in, and that is what makes these tests about this layer.** What
 * each one measures is a room, a membership or a delete — what this interface does with a
 * verdict — and none of them is a measurement of a model. So `openHost` is given the kernel's
 * own placeholders (`stubJudge` acts on everything, `stubDecide` says `STUB_REPLY`), exactly
 * as a test hands it a transport with `fetch`; the real model path and the silence a missing
 * one leaves behind are `model-wiring.test.mjs`'s subject.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { applyRoster } from '../../src/roster.ts'
import { seedOneRoom, STUB_REPLY, stubDecide, stubJudge } from '../../src/main.ts'
import { emptyData, SeekStore } from '../../src/store.ts'
import { addMember, closeHost, createRoom, deleteBot, openHost, hostSnapshot, postMessage } from './host.js'


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

/**
 * A second person, for the tests about a room that holds somebody besides the reader and the
 * bot.
 *
 * **The seed does not write one.** A first launch is one person, one bot and the room they
 * talk in — a direct message, which is what a room of two members is (`src/main.ts`) — so a
 * test that needs a stranger writes one: a principal with no membership, which is exactly
 * what the interface holds when it asks to add somebody to a room.
 */
const OTHER = 'ou_a_second_person'

/**
 * A store with the kernel's own seeded world beside a roster that gives its bot a work
 * agent able to speak — the same two pieces `runFirstMilestone` composes.
 */
async function world(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'seek-ui-host-'))
  const storeFile = join(dir, 'seek.json')
  const store = new SeekStore(emptyData(), storeFile)
  const scene = seedOneRoom(store)
  store.data.principals[OTHER] = { id: OTHER, kind: 'human', name: 'a second person' }
  applyRoster(store, [
    { bot: 'Echo', role: 'watch', tools: [] },
    { bot: 'Echo', role: 'work', tools: ['say'] },
  ])
  await store.save()

  const host = await openHost(storeFile, { judge: stubJudge, decide: stubDecide, ...options })
  return {
    host,
    scene,
    other: OTHER,
    storeFile,
    async done() {
      closeHost(host)
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/**
 * Timers a test fires by hand.
 *
 * The room's tempo is real time — a bot waits a minute and a half before it reads what
 * arrived — so a test about it cannot wait for a timer. This hands the kernel the timers
 * instead, and `fireAll()` is what the world does when the minute is up.
 */
function manualTimers() {
  const armed = []
  const pending = new Map()
  let next = 0
  return {
    armed,
    set(delayMs, run) {
      const handle = (next += 1)
      armed.push(delayMs)
      pending.set(handle, run)
      return handle
    },
    clear(handle) {
      pending.delete(handle)
    },
    fireAll() {
      const waiting = [...pending.values()]
      pending.clear()
      for (const run of waiting) run()
    },
  }
}

test('a message the person sends is in the store, and the bot in the room answers it', async () => {
  const w = await world()
  try {
    const snapshot = await postAndWait(w.host, { roomId: w.scene.room, text: 'the deploy is red' })
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
    await postAndWait(w.host, { roomId: w.scene.room, text: 'is anyone there' })

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
 * from happening.
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
 * An attachment, all the way through: the main process hands the kernel four facts, the store
 * keeps them on the message, and the snapshot the window draws from carries them back.
 *
 * This is the half the demo cannot prove. `prototype/src/fake-host.js` invents an attachment so
 * the row can be looked at; the question here is whether the real host, the real store and the
 * real snapshot agree — so the file is posted into a store on disk, read back off the disk, and
 * the snapshot is asked what the window would be given.
 */
test('an attached file goes into the store and comes back out of the snapshot', async () => {
  const w = await world()
  try {
    const file = {
      key: 'om-lq3k2-8f1a.pdf',
      name: 'design-notes.pdf',
      size: 18_432,
      mime: 'application/pdf',
    }
    const snapshot = await postAndWait(w.host, { roomId: w.scene.room, text: '', kind: 'file', file })
    const room = snapshot.rooms.find((one) => one.id === w.scene.room)
    const sent = room.messages[0]

    // A file with no words is still a message: the caption is optional, exactly as it is for a
    // picture, and `postMessage` refuses an empty one only when there is nothing at all.
    assert.equal(sent.kind, 'file')
    assert.equal(sent.text, '')
    assert.deepEqual(sent.file, file, 'the four facts the row draws came back unchanged')

    // The same facts read off the disk, because a message that is only in memory is one a
    // restart loses — and because a store is a file a person edits by hand.
    assert.equal(w.host.store.messagesOf(w.scene.room)[0].file.name, 'design-notes.pdf')
  } finally {
    await w.done()
  }
})

test('an attachment on a text message is refused by the kernel, not dropped in silence', async () => {
  const w = await world()
  try {
    await assert.rejects(
      () =>
        postMessage(w.host, {
          roomId: w.scene.room,
          text: 'here it is',
          file: { key: 'om-a.pdf', name: 'a.pdf', size: 1, mime: 'application/pdf' },
        }),
      /only 'file' carries one/,
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
    const first = await postAndWait(w.host, { roomId: w.scene.room, text: 'the deploy is red' })
    const parent = first.rooms.find((one) => one.id === w.scene.room).messages[0]

    const second = await postAndWait(w.host, {
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
    const snapshot = await postAndWait(w.host, { roomId: w.scene.room, text: 'hello room' })
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
      members: [w.scene.me, w.other, w.scene.bot],
    })

    assert.equal(typeof made.roomId, 'string')
    assert.equal(made.snapshot.rooms.length, 2, 'the seeded room, and this one')
    const room = made.snapshot.rooms.find((one) => one.id === made.roomId)
    assert.equal(room.name, 'the second room')
    assert.deepEqual(
      room.members.map((member) => member.id),
      [w.scene.me, w.other, w.scene.bot],
      'in the order they were chosen, which is the order the kernel wrote them',
    )
    assert.deepEqual(room.messages, [], 'and a new room has said nothing yet')

    // On disk before the snapshot was handed back — the same rule a message follows. A room
    // drawn but not saved would vanish on the next open, after the person believed it was made.
    const reloaded = await SeekStore.load(w.storeFile)
    const rows = reloaded.membershipsOf(made.roomId)
    assert.deepEqual(
      rows.map((row) => row.principal_id),
      [w.scene.me, w.other, w.scene.bot],
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
    const snapshot = await postAndWait(w.host, { roomId: made.roomId, text: 'anyone here' })
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

/**
 * The third write: somebody joins a room that already exists.
 *
 * Until this existed the kernel's `addMember()` had no caller anywhere in the product — a room
 * could be made with its people and then never gain another, so "two bots in one room" was
 * reachable only by making the room with both of them. What is measured here is the same whole
 * path the renderer takes: `host.addMember()` → the kernel's `addMember()` → `store.save()` →
 * a snapshot that already has the new member.
 */
test('a person added through the interface is in the room, in it as a member, and on disk', async () => {
  const w = await world()
  try {
    // A room that does not hold the third person yet, so the add is what puts them there.
    // The reader is in it, because the snapshot hands over the rooms they are in — a room of
    // the bot's alone would be a room this window could not see, which is the point of the
    // filter in `snapshotOf()`.
    const made = await createRoom(w.host, { name: 'not everyone', members: [w.scene.me, w.scene.bot] })
    const joined = await addMember(w.host, { roomId: made.roomId, principalId: w.other })

    const room = joined.rooms.find((one) => one.id === made.roomId)
    assert.deepEqual(
      room.members.map((member) => member.id),
      [w.scene.me, w.scene.bot, w.other],
      'the reader, the bot it was made with, and the person who just joined',
    )

    // On disk before the snapshot was handed back, as a message and a room are. A membership
    // drawn but not saved is a room that loses somebody on the next open, silently.
    const reloaded = await SeekStore.load(w.storeFile)
    const row = reloaded
      .membershipsOf(made.roomId)
      .find((membership) => membership.principal_id === w.other)
    assert.ok(row, 'the row is in the store, not only in the snapshot')
    assert.equal(
      row.role,
      'member',
      'the kernel default, because the interface asks for no role',
    )

    // **A room made with the reader in it, and adding somebody does not touch that row.** The
    // person who joined gets `member`; the row that was already there keeps the role it was
    // made with, because an add is one membership written and nothing reworded.
    const mine = room.members.filter((member) => member.id === w.scene.me)
    assert.equal(mine.length, 1, 'the reader is in the room once, not twice')
    const rows = reloaded.membershipsOf(made.roomId)
    assert.equal(rows.length, 3, 'two rows were made with the room, and this adds exactly one')
    // A role is the kernel's, not the snapshot's: `members` carries who is in the room, and the
    // row itself is where the role is written.
    assert.equal(
      rows.find((membership) => membership.principal_id === w.scene.me).role,
      'owner',
      'the row that was already there keeps the role it was made with',
    )
  } finally {
    await w.done()
  }
})

/**
 * A membership is a rule about who may speak, so the test is whether the bot answers.
 *
 * This is the room the kernel's own docstring names — one bot joined to a room somebody else
 * made — and it is measured by behaviour rather than by counting rows: before the add the bot
 * is not in the room and stage 0 opens no entry for it, so nothing answers; after the add the
 * same message gets an answer.
 */
test('a bot added to a room answers in it, which is what a membership is for', async () => {
  const w = await world()
  try {
    const made = await createRoom(w.host, { name: 'me alone', members: [w.scene.me] })

    const before = await postAndWait(w.host, { roomId: made.roomId, text: 'anyone here' })
    assert.deepEqual(
      before.rooms.find((one) => one.id === made.roomId).messages.map((m) => m.sender),
      [w.scene.me],
      'the bot is not in this room, so it is not woken and does not answer',
    )

    await addMember(w.host, { roomId: made.roomId, principalId: w.scene.bot })

    const after = await postAndWait(w.host, { roomId: made.roomId, text: 'and now' })
    const messages = after.rooms.find((one) => one.id === made.roomId).messages
    assert.deepEqual(
      messages.slice(-2).map((message) => message.sender),
      [w.scene.me, w.scene.bot],
      'and now the bot in this room answers',
    )
    assert.equal(messages.at(-1).text, STUB_REPLY)
  } finally {
    await w.done()
  }
})

/**
 * The three refusals, each in the kernel's words and each writing nothing.
 *
 * `host.addMember()` re-checks none of them, which is what makes these worth measuring here:
 * the sentence has to come from `src/rooms.ts`, and a refused membership must leave the store
 * exactly as it was — a row that says somebody is in a room they are not in is worse than the
 * refusal, because nothing later can tell it from a membership somebody meant.
 */
async function memberRefused(w, input, expected) {
  const before = await SeekStore.load(w.storeFile)
  const membershipsBefore = Object.keys(before.data.memberships).length

  await assert.rejects(() => addMember(w.host, input), expected)

  const after = await SeekStore.load(w.storeFile)
  assert.equal(
    Object.keys(after.data.memberships).length,
    membershipsBefore,
    'no membership was written',
  )
}

test('adding somebody to a room this store does not have is refused by name', async () => {
  const w = await world()
  try {
    await memberRefused(
      w,
      { roomId: 'oc_nothing', principalId: w.scene.me },
      /unknown room: oc_nothing/,
    )
  } finally {
    await w.done()
  }
})

test('adding somebody this store has never heard of is refused by name', async () => {
  const w = await world()
  try {
    await memberRefused(
      w,
      { roomId: w.scene.room, principalId: 'ou_nobody' },
      /unknown principal: ou_nobody/,
    )
  } finally {
    await w.done()
  }
})

/**
 * The refusal that protects the one number two other rules read: two rows for one principal is
 * one person counted twice, and `direct` in `deriveHints` **is** that count — so a duplicated
 * member would turn a two-member room, which is a direct message, into a group the gate then
 * asks a model about.
 *
 * The bot is used because it is in the seeded room: the seed writes nobody else, so the second
 * person the other tests hold is not a member of anything.
 */
test('adding somebody who is already in the room is refused, because a second row is a wrong count', async () => {
  const w = await world()
  try {
    await memberRefused(
      w,
      { roomId: w.scene.room, principalId: w.scene.bot },
      /already a member of/,
    )
  } finally {
    await w.done()
  }
})

/**
 * Who the message addresses, reaching the store through the interface's own write.
 *
 * This is the half the window could not do at all: `deliver()` has taken `mentions` since the
 * first kernel slice, and the renderer's one write passed every other field of a message but
 * that one — so a person could not name anybody, and `mentionsMe` had no human author in the
 * product. What is measured here is the whole path: `host.postMessage()` → `deliver()` → one
 * `store.save()` → a snapshot that draws the pair, and the file that outlives the process.
 *
 * The name is passed through rather than resolved, which is what makes `@Echo` said today stay
 * `@Echo`: the kernel stores the pair the sender gave it (`src/types.ts`, `Mention`).
 */
test('a message the person addresses to a bot carries the mention into the store and the snapshot', async () => {
  const w = await world()
  try {
    const snapshot = await postAndWait(w.host, {
      roomId: w.scene.room,
      text: 'are you there',
      mentions: [{ id: w.scene.bot, name: 'Echo' }],
    })
    const first = snapshot.rooms.find((one) => one.id === w.scene.room).messages[0]
    assert.deepEqual(first.mentions, [{ id: w.scene.bot, name: 'Echo' }], 'the snapshot draws it')

    const reloaded = await SeekStore.load(w.storeFile)
    assert.deepEqual(
      reloaded.messagesOf(w.scene.room)[0].mentions,
      [{ id: w.scene.bot, name: 'Echo' }],
      'and it is on disk, where the only reader that deletes a name cannot reach it',
    )
  } finally {
    await w.done()
  }
})

/**
 * A mention that names nobody is no mention at all.
 *
 * The renderer sends whatever its picker holds, and a picker is a piece of UI; the kernel's
 * own type says a mention is a pair of strings. Copying only the pairs — the way `mediaOf`
 * copies only `key` and `mime` — keeps a broken entry out of a message that is meant to be
 * immutable, without inventing a refusal no document states.
 */
test('a mention that names nobody is stored as no mention rather than as a broken pair', async () => {
  const w = await world()
  try {
    const snapshot = await postAndWait(w.host, {
      roomId: w.scene.room,
      text: 'nobody in particular',
      mentions: [{ id: 42 }, null, 'x', { name: 'no-id' }],
    })
    const first = snapshot.rooms.find((one) => one.id === w.scene.room).messages[0]
    assert.deepEqual(first.mentions, [], 'the message carries an empty list, not four broken ones')
  } finally {
    await w.done()
  }
})

/**
 * A deleted bot stays deleted when the store was written under the older spelling of the stamp.
 *
 * The window used to say 移出这个组织 — take this bot out of the organization — and the row it wrote
 * says `removed_at`. A bot is not somebody who exists in several organizations, so the action is a
 * deletion and the stamp is `deleted_at`; but rows written under the old name are on people's disks
 * right now, and a store keeps keys it does not know on purpose (`src/store.ts`). Opening one must
 * therefore read both spellings, or a bot somebody deleted comes back as somebody the organization
 * still has — offered for a room, and its messages unsigned.
 */
test('a bot the store stamped with the older spelling is still deleted when the store is opened', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'seek-ui-host-'))
  const storeFile = join(dir, 'seek.json')
  const store = new SeekStore(emptyData(), storeFile)
  const scene = seedOneRoom(store)
  applyRoster(store, [
    { bot: 'Echo', role: 'watch', tools: [] },
    { bot: 'Echo', role: 'work', tools: ['say'] },
  ])
  await store.save()

  const first = await openHost(storeFile)
  const gone = await deleteBot(first, { botId: scene.bot })
  assert.equal(
    gone.snapshot.people.some((one) => one.id === scene.bot),
    false,
    'a deleted bot is not offered as somebody this organization has',
  )
  closeHost(first)

  // Put the row back the way the build that said 移出这个组织 wrote it: one fact, the other name.
  const written = JSON.parse(await readFile(storeFile, 'utf8'))
  written.bots[scene.bot].removed_at = written.bots[scene.bot].deleted_at
  delete written.bots[scene.bot].deleted_at
  await writeFile(storeFile, JSON.stringify(written))

  const second = await openHost(storeFile)
  try {
    const snapshot = await postAndWait(second, { roomId: scene.room, text: 'is anybody there' })
    assert.equal(
      snapshot.people.some((one) => one.id === scene.bot),
      false,
      'the older spelling of the stamp keeps it out of the people list too',
    )

    const settled = JSON.parse(await readFile(storeFile, 'utf8'))
    assert.equal(
      typeof settled.bots[scene.bot].deleted_at,
      'string',
      'and the next write moves the row onto the name this build uses',
    )
    assert.equal(
      'removed_at' in settled.bots[scene.bot],
      false,
      'the old name does not stay beside it, so the row carries one fact under one name',
    )
  } finally {
    closeHost(second)
    await rm(dir, { recursive: true, force: true })
  }
})

/**
 * The note a room is compacted into, through the interface's own write path.
 *
 * The host settled the line on 2026-10-28 — 「超过20条新消息，就压缩」 — and what this test
 * measures is that the number reaches the kernel at all: `RoomCompactor.due()` answers false
 * before it counts anything when no writer is bound, so before this wiring existed a room's
 * box grew forever and every judgement read the whole conversation.
 *
 * The writer is handed in the way `judge` and `decide` are — a function that says what the
 * bot's model would have said — because what is being measured is the interface's wiring and
 * not a model. What it returns is deliberately recognisable: a test that only counted the
 * write would pass with the delta's own text written back.
 */
async function worldWithNote(note) {
  const dir = await mkdtemp(join(tmpdir(), 'seek-ui-note-'))
  const storeFile = join(dir, 'seek.json')
  const store = new SeekStore(emptyData(), storeFile)
  const scene = seedOneRoom(store)
  applyRoster(store, [
    { bot: 'Echo', role: 'watch', tools: [] },
    { bot: 'Echo', role: 'work', tools: ['say'] },
  ])
  await store.save()

  const asked = []
  const host = await openHost(storeFile, {
    judge: stubJudge,
    decide: stubDecide,
    summarise: async (input) => {
      asked.push(input)
      return note
    },
  })
  return {
    host,
    scene,
    asked,
    async done() {
      closeHost(host)
      await rm(dir, { recursive: true, force: true })
    },
  }
}

test('a room of more than twenty new observations is compacted into a note', async () => {
  const w = await worldWithNote('the batch is still failing; nobody has looked at the queue')
  try {
    for (let i = 1; i <= 21; i += 1) {
      await postAndWait(w.host, { roomId: w.scene.room, text: `message ${i}` })
    }

    assert.equal(w.asked.length, 1, 'one compaction ran, and it ran once')
    const digest = w.host.store
      .memoriesOf(w.asked[0].agentId)
      .filter((row) => row.level === 'room_digest')
    assert.equal(digest.length, 1, 'the room has exactly one note')
    assert.equal(digest[0].room_id, w.scene.room)
    assert.equal(digest[0].body, 'the batch is still failing; nobody has looked at the queue')
    // The consumed-to point is the note's own claim about how much it covers, and it is
    // what makes the box stop growing: the delta is read from after it (`deltaFor`).
    assert.ok(digest[0].consumed_to !== undefined && digest[0].consumed_to !== '')
  } finally {
    await w.done()
  }
})

test('a room of a few observations has no note, and none is invented', async () => {
  const w = await worldWithNote('a note nobody should have asked for')
  try {
    for (let i = 1; i <= 5; i += 1) {
      await postAndWait(w.host, { roomId: w.scene.room, text: `message ${i}` })
    }
    assert.equal(w.asked.length, 0, 'five observations are under the line')
    const digests = Object.values(w.host.store.data.memories ?? {}).filter(
      (row) => row.level === 'room_digest',
    )
    assert.equal(digests.length, 0, 'and no empty note stands in for one')
  } finally {
    await w.done()
  }
})

/**
 * The tempo, measured where a person meets it: a send answers at once, and the bot answers
 * when a person would have read the message.
 *
 * This is the defect the host reported in the room of four — every bot told in the same
 * millisecond, so four answers arrived together and then nobody spoke again. The send must
 * not wait for the pause (that is `postMessage`'s own rule, measured in
 * `send-does-not-wait.test.mjs`), and the answer must arrive when the pause ends.
 */
test('the bot reads the message after the room’s tempo, not in the instant it was sent', async () => {
  const timers = manualTimers()
  const arrivals = []
  const w = await world({
    timers,
    wakeDelay: (arrived) => {
      arrivals.push(arrived.addressed)
      return 90_000
    },
  })
  try {
    await postMessage(w.host, { roomId: w.scene.room, text: 'the deploy is red' })

    const sent = hostSnapshot(w.host)
    const quiet = sent.rooms.find((one) => one.id === w.scene.room)
    assert.equal(quiet.messages.length, 1, 'the person’s line, and no answer yet')
    assert.deepEqual(timers.armed, [90_000], 'the bot is waiting, and for the tempo’s length')
    assert.deepEqual(arrivals, [true], 'a room of two is somebody being spoken to directly')

    timers.fireAll()
    await w.host.kernel.whenIdle()

    const answered = hostSnapshot(w.host)
    const room = answered.rooms.find((one) => one.id === w.scene.room)
    assert.equal(room.messages.length, 2, 'and the answer is there once the wait ends')
    assert.equal(room.messages[1].sender, w.scene.bot)
  } finally {
    await w.done()
  }
})
