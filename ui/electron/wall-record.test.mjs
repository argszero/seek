/**
 * Where a thread stopped — §11.6's third ending, on the panel a person opens to ask what a room is.
 *
 * `docs/design/agent-lifecycle.md` §11.6 is the work order: at the depth cap or the room's turn cap
 * an agent *"stop[s] and record[s] — write to the diary and let the thread rest"*, and the sentence
 * that makes it a rule rather than a hope is the one after it: *"Silence is allowed; silence that
 * nobody can see is not."* The kernel's half is `src/diary.ts` and its own test is
 * `src/diary.test.ts`. **What this file holds is the half the kernel cannot check**: that the
 * snapshot hands the fact to the window at all, that the two rows which are not a record of a wall
 * are left out, and that the panel is not drawn over a list nothing wrote.
 *
 * **The rows come from the kernel's own turns.** `runTurn()` is what writes them, wall and all, for
 * the reason `silent-turn.test.mjs` gives about messages: a row spelled out here would be this
 * file's idea of the shape, and an idea of the shape is what has stayed green in this repository
 * while the real one was `undefined`. The two exceptions are marked below and are the two rows no
 * kernel path can produce.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { AGENT_TURN_CAP } from '../../src/chain.ts'
import { deliver } from '../../src/delivery.ts'
import { makeWorld } from '../../src/fixtures.ts'
import { runTurn } from '../../src/turn.ts'
import { snapshotOf } from './snapshot.js'

const HERE = import.meta.dirname
const ROOT = join(HERE, '..', '..')
const read = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8')

const APP = read('ui', 'src', 'App.jsx')
const SHELL = read('ui', 'src', 'styles', 'shell.css')

const AT = '2026-10-24T03:00:00.000Z'
const LATER = '2026-10-24T04:00:00.000Z'

/** Enough bot turns in the world's room to reach the room's own cap, all ending at `at`. */
async function turnsToTheCap(world, at) {
  for (let turn = 0; turn < AGENT_TURN_CAP; turn += 1) {
    await runTurn(world.store, { agentId: world.agentA2, roomId: world.room, entries: [], now: at })
  }
}

/** The one room the snapshot hands over. */
function theRoom(world) {
  const snapshot = snapshotOf(world.store)
  const room = snapshot.rooms.find((one) => one.id === world.room)
  assert.ok(room, 'the room this file is about did not reach the window')
  return room
}

/** One rule's declarations, comments removed. */
function rule(css, selector) {
  const opener = `${selector} {`
  const from = css.indexOf(opener)
  assert.notEqual(from, -1, `the sheet has no rule for ${selector}`)
  const to = css.indexOf('}', from)
  const body = css.slice(from + opener.length, to).replace(/\/\*[\s\S]*?\*\//g, '')
  const declarations = {}
  for (const line of body.split('\n')) {
    const text = line.trim().replace(/;$/, '')
    if (text === '' || !text.includes(':')) continue
    const at = text.indexOf(':')
    declarations[text.slice(0, at).trim()] = text.slice(at + 1).trim()
  }
  return declarations
}

test('a room nothing has been stopped in hands over no wall rows at all', () => {
  const world = makeWorld()
  assert.deepEqual(theRoom(world).walls, [])
})

test('the turn that takes the room to its cap puts one row on the room: who, which wall, and when', async () => {
  const world = makeWorld()
  await turnsToTheCap(world, AT)

  const walls = theRoom(world).walls
  assert.equal(walls.length, 1)
  assert.equal(walls[0].bot, world.botA, 'the bot whose work agent ran the turn')
  // The code the entry's own `hints.chainBlocked` carries, worded by the window and by nothing here.
  assert.equal(walls[0].reason, 'room_agent_turns')
  assert.equal(walls[0].at, AT)
})

test('two walls in one room are listed newest first, and a person speaking lets the room reach one again', async () => {
  const world = makeWorld()
  await turnsToTheCap(world, AT)

  // §11.3: a person's message breaks the run of bot turns, so the room can reach its cap again —
  // and the second crossing is a second row rather than an overwrite of the first.
  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: '@B back to this',
    mentions: [{ id: world.botB, name: 'B' }],
    now: LATER,
  })
  await turnsToTheCap(world, '2026-10-24T05:00:00.000Z')

  const walls = theRoom(world).walls
  assert.equal(walls.length, 2)
  assert.equal(walls[0].at, '2026-10-24T05:00:00.000Z', 'the one that just happened is first')
  assert.equal(walls[1].at, AT)
})

test('a row with no room and a row with no sentence behind it are both left out', () => {
  const world = makeWorld()
  // The two rows no kernel path produces, and the reason this test writes them by hand: a reminder
  // writes its diary with no room at all (§12), and a code outside `ChainBlockReason` can only be a
  // store somebody edited. Neither has a sentence on this boundary, so neither may reach it.
  world.store.data.memories[world.agentA2] = [
    { id: 'mm_roomless', agent_id: world.agentA2, level: 'diary', body: 'room_agent_turns', updated_at: AT },
    { id: 'mm_unknown', agent_id: world.agentA2, level: 'diary', room_id: world.room, body: 'something_else', updated_at: AT },
    // And the box's own note is not a diary: it is the summary a work turn opens with, kept in the
    // same per-agent shard.
    { id: 'mm_digest', agent_id: world.agentA2, level: 'box_digest', room_id: world.room, body: 'a note', updated_at: AT },
  ]

  assert.deepEqual(theRoom(world).walls, [])
})

test('the panel draws the record, and only draws it where there is one to read', () => {
  // **The gate is the point.** Nothing is written until a thread reaches a limit, so a card that
  // was always there would tell every ordinary room that something had been recorded about it —
  // the one shape this panel may not take. Asserted as the condition itself rather than as the
  // absence of a string, so a card drawn unconditionally fails here.
  assert.match(APP, /\{active\.walls\.length > 0 && \(/)
  assert.ok(APP.includes('data-room-wall={wall.reason}'), 'no row is marked with the wall it was')
  assert.ok(APP.includes('data-room-wall-bot={wall.bot}'), 'no row is marked with who stopped it')
  // And the sentence is the catalogue's, one lookup per wall, so the card has words in every
  // language the window ships rather than an English literal — and so each key sits inside a
  // `t()` call, which is the only place `catalogue.test.mjs` can read one from.
  for (const key of ['ui.room.wall.title', 'ui.room.wall.depth', 'ui.room.wall.turns']) {
    assert.ok(APP.includes(`t('${key}'`), `the panel never looks up ${key}`)
  }

  // Every class those rows are drawn with has a rule behind it — the defect this repository has
  // shipped twice is a class with no rule, an unstyled element the browser draws its own way.
  for (const selector of ['.room-walls', '.room-wall', '.room-wall-what', '.room-wall-when']) {
    rule(SHELL, selector)
  }
  // The moment sits at the end of the row and does not move when the sentence wraps: a long bot
  // name must shorten the words, never the time.
  assert.equal(rule(SHELL, '.room-wall-when')['margin-left'], 'auto')
  assert.equal(rule(SHELL, '.room-wall-when')['flex'], 'none')
})
