/**
 * Why a bot is silent — the second kind, and the one nothing used to say.
 *
 * `docs/design/agent-lifecycle.md` §8 item 5 is the work order: *"'Why is it silent?' has an
 * answer too: a turn that ended without sending is a turn on the record, so the same expansion
 * can say what the bot decided instead of speaking."* The turn was already on the record
 * (`Turn.produced` empty, `turn.ts`); **nothing in the window read it**, so a bot that ran a
 * turn and sent nothing looked exactly like a bot that never woke — which is the same collapse
 * of two different facts that item 4 fixed for `ignore`.
 *
 * **What this file holds is the half the window cannot check**: that the snapshot reaches the
 * turn, that it tells the two silences apart, and that it leaves out the two rows that are not
 * silence at all. Those two are the reason this file exists rather than one assertion — a
 * reading that reported a working bot as a refusing one, or a placeholder as a decision, would
 * pass a test that only checked the happy path.
 *
 * **Nothing here writes a message or a turn by hand.** Both come from the kernel's own
 * `deliver()`, `gate()` and `runTurn()`; a fixture spelled out here would be this file's idea
 * of the shape, and a field written that way has stayed green here while being `undefined` on
 * every real one (`snapshot.test.mjs` says the same about `at` and `kind`).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { deliver } from '../../src/delivery.ts'
import { makeWorld } from '../../src/fixtures.ts'
import { gate } from '../../src/gate.ts'
import { runTurn } from '../../src/turn.ts'
import { snapshotOf } from './snapshot.js'

const AT = '2026-10-24T01:00:00.000Z'

/** What a decision reports having spent when it called a model and sent nothing. */
const SPENT = { input_tokens: 41, output_tokens: 0 }

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
 * The bot is handed the room, calls a model, and sends nothing.
 *
 * `drain` is the same step the loop takes, so the turn is woken by the entries the store holds
 * for this bot rather than by a list this file made up. The reported spend is the fact that
 * separates this turn from one that ran no model at all.
 */
async function spendsAndSaysNothing(world) {
  const entries = await world.store.drain(world.botA)
  return runTurn(world.store, { agentId: world.agentA2, roomId: world.room, entries, now: AT }, () => SPENT)
}

test('a bot that ran a turn and sent nothing is on the record, and the window says so', async () => {
  const world = makeWorld()
  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: '@A did you get to it?',
    mentions: [{ id: world.botA, name: 'A' }],
    now: AT,
  })

  const { turn } = await spendsAndSaysNothing(world)
  assert.deepEqual(turn.produced, [], 'the turn chose to send nothing — that is the fact under test')

  const row = rowSaying(snapshotOf(world.store, '/tmp/seek.json'), '@A did you get to it?')
  assert.deepEqual(row.silent, [{ id: world.botA, name: 'A', because: 'nothing-sent' }])
})

test('a turn that spoke is not a silence, and the message it sent is not one either', async () => {
  const world = makeWorld()
  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: '@A can you take this?',
    mentions: [{ id: world.botA, name: 'A' }],
    now: AT,
  })

  const entries = await world.store.drain(world.botA)
  await runTurn(world.store, { agentId: world.agentA2, roomId: world.room, entries, now: AT }, (context) => {
    context.say(world.room, 'on it')
    return SPENT
  })

  const snapshot = snapshotOf(world.store, '/tmp/seek.json')
  const asked = rowSaying(snapshot, '@A can you take this?')
  assert.deepEqual(asked.silent, [], 'a bot that answered is not a bot that stayed out')
  assert.equal(rowSaying(snapshot, 'on it').proactive, false, 'and what it said is an answer')
})

test('a turn still deciding is not a silence — working is not refusing', async () => {
  const world = makeWorld()
  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: '@A still there?',
    mentions: [{ id: world.botA, name: 'A' }],
    now: AT,
  })

  await spendsAndSaysNothing(world)
  // `turn.ts` writes `ended_at` in its `finally`, so a turn that has not closed is exactly a row
  // without it. Nothing else about the row changes, which is the point: this test removes the
  // one field that says "the decision is in", and the reading must follow it.
  delete world.store.data.turns.at(-1).ended_at

  const row = rowSaying(snapshotOf(world.store, '/tmp/seek.json'), '@A still there?')
  assert.deepEqual(row.silent, [], 'a bot in the middle of a turn has not decided anything yet')
})

test('a turn that ran no model is not a silence, because nothing decided there', async () => {
  const world = makeWorld()
  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: '@A have a look?',
    mentions: [{ id: world.botA, name: 'A' }],
    now: AT,
  })

  // The shipped placeholder: `runTurn` with no decision calls no model, so the row keeps the
  // zeros it was created with and spent nothing. Nothing was weighed, so there is no decision
  // to report — the same `null` the proactive mark gives a message no turn produced.
  const entries = await world.store.drain(world.botA)
  const { turn } = await runTurn(world.store, {
    agentId: world.agentA2,
    roomId: world.room,
    entries,
    now: AT,
  })
  assert.equal(turn.input_tokens + turn.output_tokens, 0, 'no model ran, so no tokens were spent')

  const row = rowSaying(snapshotOf(world.store, '/tmp/seek.json'), '@A have a look?')
  assert.deepEqual(row.silent, [], 'a turn that asked no model has no decision to report')
})

test('the two silences are told apart on the same message', async () => {
  const world = makeWorld()
  const sent = deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: '@A, what do the two of you think?',
    mentions: [{ id: world.botA, name: 'A' }],
    now: AT,
  })

  // B is not named and has muted the room, so the rules settle it as `ignore` without any
  // model: the first kind of silence, and the one §8 item 4 already drew. Naming B as well
  // would have been the wrong case — a mention acts before the mute is read (`gate.ts`, row
  // 2, the rule that guards the whole room from a mention being judged away).
  for (const membership of Object.values(world.store.data.memberships)) {
    if (membership.principal_id === world.botB) membership.muted = true
  }
  gate(world.store, world.botB, world.store.pending(world.botB))

  // A is addressed, so the rules fast-pass it; its turn then runs and sends nothing. Same
  // message, a different fact, and the window has to say which is which.
  await spendsAndSaysNothing(world)

  const row = rowSaying(snapshotOf(world.store, '/tmp/seek.json'), sent.message.text)
  assert.equal(row.silent.length, 2, 'both bots stayed out, and both are on the list')
  const quiet = row.silent.find((one) => one.id === world.botB)
  const mute = row.silent.find((one) => one.id === world.botA)
  assert.equal(quiet.because, 'not-addressed', 'B never ran a turn: the message was not for it')
  assert.equal(mute.because, 'nothing-sent', 'A ran one and sent nothing')
  assert.equal(quiet.name, 'B')
  assert.equal(mute.name, 'A')
})
