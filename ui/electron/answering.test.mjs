/**
 * The other half of "why did it ignore me?" — that someone else is answering.
 *
 * `docs/design/agent-lifecycle.md` §8 item 4 spells the whole sentence: *"'Why did it ignore
 * me?' is expandable: translate the `reason` into plain language ('this was not addressed to
 * me, and someone else is already answering')"*. The first clause reached the screen when the
 * silence line landed; **the second half was never read**, so a room with an answer on its way
 * looked exactly like a room where nobody was coming. A bot in the middle of a turn has sent
 * nothing yet — §8 item 3 makes that structural, a message appears whole rather than token by
 * token — so the record is the only place the fact exists.
 *
 * **What this file holds is the join, and its trap.** "Someone is answering" could be read as
 * *someone in this room is working*, which is nearly right and wrong on the screen: two
 * messages in one room, one being answered and one passed on, would both print a sentence
 * claiming help was coming. So the trap is the case that fails when the join is per room
 * instead of per message, and it is here rather than in a happy-path assertion.
 *
 * **Nothing here writes a turn or a verdict by hand.** The verdict comes from the kernel's own
 * `gate()`, the turn from its own `runTurn()`, and "still deciding" is `ended_at` deleted off
 * the row `turn.ts` wrote — the field it sets in its `finally` and the one field that means the
 * decision has not come in. A fixture that spelled any of it out would be this file's idea of
 * the shape, which is the drift `snapshot.test.mjs` and `silent-turn.test.mjs` both record.
 *
 * **The rule that keeps the two halves apart** is `ended_at`: `nothing-sent` is a turn that
 * closed and produced no message, `answering` is a turn that has not closed. They partition the
 * ledger, so one turn can never say both. The last test asserts that too.
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

/** The message with this text, as the window draws it. */
function rowSaying(snapshot, text) {
  const row = snapshot.rooms.flatMap((room) => room.messages).find((one) => one.text === text)
  assert.ok(row, `no message saying ${JSON.stringify(text)} reached the window`)
  return row
}

/** A bot that has muted the room is settled `ignore` by the rules, with no model and no turn. */
function mute(world, botId) {
  for (const membership of Object.values(world.store.data.memberships)) {
    if (membership.principal_id === botId) membership.muted = true
  }
}

/** The bot drained the entries it holds and is in that turn now — `ended_at` is not written. */
async function midTurn(world, botId, agentId) {
  const entries = await world.store.drain(botId)
  await runTurn(world.store, { agentId, roomId: world.room, entries, now: AT }, () => SPENT)
  // `turn.ts` writes `ended_at` in its `finally`, so the open turn is exactly the row that has
  // it removed. Nothing else about the row changes, which is the point: one field decides
  // whether a turn is a fact or a silence, and both readings must follow it.
  delete world.store.data.turns.at(-1).ended_at
}

test('a bot in a turn on this message is named on the one that passed on it', async () => {
  const world = makeWorld()
  mute(world, world.botA)

  const first = deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: 'morning, both of you',
    now: AT,
  })
  // B wakes, takes the entry, and starts nothing: the second message must be the one it is
  // answering, or the trap below would pass for the wrong reason.
  await world.store.drain(world.botB)

  const second = deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: 'B, can you look at the build?',
    mentions: [{ id: world.botB, name: 'B' }],
    now: AT,
  })

  gate(world.store, world.botA, world.store.pending(world.botA))
  await midTurn(world, world.botB, world.agentB1)

  const snapshot = snapshotOf(world.store, '/tmp/seek.json')

  // The message B is answering: A passed on it, and the window can say who is answering.
  assert.deepEqual(rowSaying(snapshot, second.message.text).silent, [
    {
      id: world.botA,
      name: 'A',
      because: 'not-addressed',
      answering: [{ id: world.botB, name: 'B' }],
    },
  ])

  // **The trap.** B is working in this room, but not on this message, so nobody is answering
  // *this* — and a join that asked the room instead of the message would put B's name here.
  assert.deepEqual(
    rowSaying(snapshot, first.message.text).silent,
    [{ id: world.botA, name: 'A', because: 'not-addressed', answering: [] }],
    'a bot busy with another message is not answering this one',
  )
})

test('once the turn closes, nobody is answering — and the closed turn says so its own way', async () => {
  const world = makeWorld()
  mute(world, world.botA)

  const sent = deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: 'B, can you look at the build?',
    mentions: [{ id: world.botB, name: 'B' }],
    now: AT,
  })

  gate(world.store, world.botA, world.store.pending(world.botA))
  await midTurn(world, world.botB, world.agentB1)

  // The same row, with the one field `turn.ts` writes back: the decision is in. A finished turn
  // that produced no message is §8 item 5's silence, so B moves to the other kind of row rather
  // than staying on this one as "answering" for ever.
  world.store.data.turns.at(-1).ended_at = AT

  assert.deepEqual(rowSaying(snapshotOf(world.store, '/tmp/seek.json'), sent.message.text).silent, [
    { id: world.botA, name: 'A', because: 'not-addressed', answering: [] },
    { id: world.botB, name: 'B', because: 'nothing-sent' },
  ])
})
