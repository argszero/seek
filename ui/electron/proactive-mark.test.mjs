/**
 * Which of the two things a bot's message is: something it chose to say, or an answer.
 *
 * `docs/design/agent-lifecycle.md` §8 item 2 is the work order — *"proactive messages are
 * marked: not a reply to you, but something it chose to say ... the mark distinguishes 'it came
 * to find you' from 'it answered you'"* — and §10.2 repeats it with the two sentences the
 * window draws. **This file holds the half the window cannot check for itself**: that the
 * snapshot answers the question from the record, that the answer is right for each of the three
 * things that can wake a bot, and that a message the record cannot classify is not given an
 * answer it never gave.
 *
 * **Both wakes are here, because they look alike.** An entry that addresses the bot (`mention`,
 * `reply`, `direct`) and one that merely arrives in its room are both "a person said something",
 * and only the first is an answer. A test that covered only the @-mention would pass with the
 * whole derivation removed, so the ambient one is the case that keeps it honest.
 *
 * **Nothing here writes a message by hand.** The messages come from the kernel's own `say()` —
 * a hand-spelled message is this file's idea of the shape, and a field written that way has
 * stayed green here while being `undefined` on every real one (`snapshot.test.mjs` says the
 * same about `at` and `kind`).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { deliver } from '../../src/delivery.ts'
import { makeWorld } from '../../src/fixtures.ts'
import { runTurn } from '../../src/turn.ts'
import { snapshotOf } from './snapshot.js'

const AT = '2026-10-24T01:00:00.000Z'

/** Every message the window is shown, across the rooms it shows. */
function messagesOf(snapshot) {
  return snapshot.rooms.flatMap((room) => room.messages)
}

/** The one message in the room with this text, as the window draws it. */
function rowSaying(snapshot, text) {
  const row = messagesOf(snapshot).find((message) => message.text === text)
  assert.ok(row, `no message saying ${JSON.stringify(text)} reached the window`)
  return row
}

/**
 * The bot speaks once in its room, woken by whatever the store holds for it.
 *
 * `drain` is the same step the loop takes, and taking it here rather than firing a whole tick
 * keeps the judgement out of these tests: the wake is the thing under test, not the rule or the
 * model that decided to act on it.
 */
async function speaks(world, text) {
  const entries = await world.store.drain(world.botA)
  await runTurn(
    world.store,
    { agentId: world.agentA2, roomId: world.room, entries, now: AT },
    (context) => {
      context.say(world.room, text)
    },
  )
  return snapshotOf(world.store, '/tmp/seek.json')
}

test('a bot that answered something addressed to it says so, and answering does not read as choosing', async () => {
  const world = makeWorld()
  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: '@A can you take this?',
    mentions: [{ id: world.botA, name: 'A' }],
    now: AT,
  })

  const snapshot = await speaks(world, 'on it')
  const row = rowSaying(snapshot, 'on it')
  assert.equal(row.sender, world.botA, 'the row is the bot that spoke')
  // An @-mention is stage 0's row 2: the message woke the bot because it named it, so what it
  // said is an answer and not a remark of its own.
  assert.equal(row.proactive, false)
})

test('a bot that spoke up in a room without being addressed came to find you', async () => {
  const world = makeWorld()
  // Nobody is named: the entry reaches A as kind `message`, which is the ambiguous remainder
  // stage 0 hands to the judgement rather than an addressing the rules settled.
  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: 'the deploy is red again',
    now: AT,
  })

  const snapshot = await speaks(world, 'I will look at it')
  assert.equal(rowSaying(snapshot, 'the deploy is red again').proactive, null)
  assert.equal(rowSaying(snapshot, 'I will look at it').proactive, true)
})

test('one addressed entry in the wake is enough, however much else was read', async () => {
  const world = makeWorld()
  // Two messages land between two ticks: one names the bot, one does not. The turn is woken by
  // both, and it is still an answer — something was said *to* it, and what else arrived in the
  // same second does not turn its reply into a remark of its own.
  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: 'the deploy is red again',
    now: AT,
  })
  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: '@A and while you are there',
    mentions: [{ id: world.botA, name: 'A' }],
    now: '2026-10-24T01:00:01.000Z',
  })

  const snapshot = await speaks(world, 'taking both')
  assert.equal(rowSaying(snapshot, 'taking both').proactive, false)
})

test('a message no turn produced is given no reading at all', async () => {
  const world = makeWorld()
  deliver(world.store, {
    roomId: world.room,
    senderId: world.botA,
    text: 'a message written with no turn behind it',
    now: AT,
  })

  const snapshot = snapshotOf(world.store, '/tmp/seek.json')
  // `null`, never `false`: the record says nothing about why this was said, and the window
  // drawing "it answered you" over it would be reporting a wake that never happened. A person's
  // message is the same absence, for the plainer reason that a wake is a bot's.
  assert.equal(rowSaying(snapshot, 'a message written with no turn behind it').proactive, null)
})

test('every message one turn produced carries the same reading', async () => {
  const world = makeWorld()
  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: '@A two things',
    mentions: [{ id: world.botA, name: 'A' }],
    now: AT,
  })

  const entries = await world.store.drain(world.botA)
  await runTurn(
    world.store,
    { agentId: world.agentA2, roomId: world.room, entries, now: AT },
    (context) => {
      context.say(world.room, 'first')
      context.say(world.room, 'second')
    },
  )

  const snapshot = snapshotOf(world.store, '/tmp/seek.json')
  // The wake is the turn's, not the message's: one entry woke it, and both messages came out of
  // that one answer.
  assert.equal(rowSaying(snapshot, 'first').proactive, false)
  assert.equal(rowSaying(snapshot, 'second').proactive, false)
})
