/**
 * The bridge between the kernel and the interface.
 *
 * `snapshotOf` is the only thing the renderer ever sees, so what it decides is what the
 * interface can show: which rooms exist, who is in them, and what was said. It runs
 * under plain `node --test` — no Electron — because the whole point of the split is
 * that this mapping is ordinary code, not something only a running app can exercise.
 *
 * **The messages are made by the kernel's own `deliver()`, not written out here.** A
 * fixture that spells a message out by hand is this file's idea of the shape, and two
 * fields had already drifted apart under exactly that: this file wrote `at` and
 * `kind`, the kernel writes `created_at` and `chat_mode`, so `snapshotOf` reading the
 * wrong name was `undefined` on every real message while these tests stayed green. The
 * store is the real one (`src/store.ts`) for the same reason.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { deliver } from '../../src/delivery.ts'
import { emptyData, SeekStore } from '../../src/store.ts'
import { snapshotOf } from './snapshot.js'

const AT = '2026-10-25T01:00:00.000Z'

/** A store with one room, one person, one bot and two messages it actually delivered. */
function seeded() {
  const store = new SeekStore(emptyData())
  store.data.principals['pr_me'] = { id: 'pr_me', kind: 'human', name: 'argszero' }
  store.data.bots['bo_watch'] = { id: 'bo_watch', name: 'watch-bot' }
  store.data.rooms['rm_ops'] = { id: 'rm_ops', name: 'Ops room', chat_mode: 'group', created_at: AT }
  store.data.memberships['mb_1'] = {
    id: 'mb_1',
    room_id: 'rm_ops',
    principal_id: 'pr_me',
    joined_at: AT,
    role: 'owner',
  }
  store.data.memberships['mb_2'] = {
    id: 'mb_2',
    room_id: 'rm_ops',
    principal_id: 'bo_watch',
    joined_at: AT,
    role: 'member',
  }
  deliver(store, { roomId: 'rm_ops', senderId: 'pr_me', text: 'the deploy is red', now: AT })
  deliver(store, {
    roomId: 'rm_ops',
    senderId: 'bo_watch',
    text: 'looking at it now',
    now: '2026-10-25T01:01:00.000Z',
  })
  return store
}

test('a room reaches the interface with its members, its bots marked, and its messages in order', () => {
  const snapshot = snapshotOf(seeded(), '/tmp/seek.json')

  assert.equal(snapshot.rooms.length, 1, 'one room is one room')
  const room = snapshot.rooms[0]
  assert.equal(room.id, 'rm_ops')
  assert.equal(room.name, 'Ops room')
  // The order messages were written in is the order the interface shows them in; a
  // reader that sorted by anything else would put the reply above its cause.
  assert.deepEqual(room.messages.map((m) => m.text), ['the deploy is red', 'looking at it now'])
  assert.deepEqual(room.members.map((m) => m.id), ['pr_me', 'bo_watch'], 'both members are visible')
})

/**
 * A rename read off the wrong source is `undefined` on every message, and nothing
 * complains — which is how `message.at` and `room.kind` lived here. Both are pinned to
 * the value the kernel wrote, so the next drift is red rather than invisible.
 */
test('the fields the interface renames carry what the kernel wrote', () => {
  const room = snapshotOf(seeded(), '/tmp/seek.json').rooms[0]

  assert.equal(room.messages[0].at, AT, "`at` is the message's `created_at`")
  assert.equal(room.messages[1].at, '2026-10-25T01:01:00.000Z', 'and a later message is later')
  assert.equal(room.kind, 'group', "`kind` is the room's `chat_mode`")
})

/** The interface draws a different avatar for a bot, so the flag has to be true where it is. */
test('a bot is marked as a bot and a person is not', () => {
  const room = snapshotOf(seeded(), '/tmp/seek.json').rooms[0]
  const byId = Object.fromEntries(room.members.map((m) => [m.id, m]))
  assert.equal(byId.bo_watch.bot, true)
  assert.equal(byId.pr_me.bot, false)
  assert.equal(byId.bo_watch.name, 'watch-bot', 'the name comes from the roster row, not the id')
})

/**
 * The composer speaks as this id, so it must be a person: a store whose first entry were
 * taken for the user would have a bot signing the messages a human typed.
 */
test('the interface speaks as a person, never as a bot', () => {
  const store = seeded()
  assert.equal(snapshotOf(store, '/tmp/seek.json').me, 'pr_me')
  assert.equal(store.data.bots.pr_me, undefined, 'and that id is not in the bots map')
})

/**
 * A thread is the kernel's own three facts, and the interface groups by nothing else:
 * `root_id` names the message a reply answers, `chain` names the root of the run it
 * belongs to, and `depth` says how many hops from that root it sits. Read off the wrong
 * field, every message would look like a root — one thread per message, no error
 * anywhere — which is the failure this pins.
 *
 * The reply is made by `deliver()` with a `rootId`, so the chain under test is the one
 * the kernel writes, not one this file composed.
 */
test('a reply reaches the interface inside the thread the kernel put it in', () => {
  const store = seeded()
  const [root, other] = store.messagesOf('rm_ops')
  deliver(store, {
    roomId: 'rm_ops',
    senderId: 'pr_me',
    text: 'in the thread',
    rootId: root.id,
    now: '2026-10-25T01:02:00.000Z',
  })

  const messages = snapshotOf(store, '/tmp/seek.json').rooms[0].messages
  assert.equal(messages[0].rootId, null, 'a message that answers nothing has no parent')
  assert.equal(messages[0].chain, messages[0].id, 'and it roots a chain of its own')
  assert.equal(messages[0].depth, 0, 'at the top of it')
  assert.equal(messages[1].chain, other.id, 'a second message that answers nothing roots its own too')
  assert.equal(messages[2].rootId, root.id, 'the reply names the message it answers')
  assert.equal(messages[2].chain, root.id, "and belongs to that message's chain")
  assert.equal(messages[2].depth, 1, 'one hop from the root it joined')
})

/** A store with nothing in it is a state the interface has to render, not an error. */
test('an empty store is an empty room list, not a failure', () => {
  const snapshot = snapshotOf(new SeekStore(emptyData()), '/tmp/seek.json')
  assert.deepEqual(snapshot.rooms, [])
  assert.equal(snapshot.error, undefined, 'an empty store is not an error')
})

/** A room may carry no name at all, and the rail draws the first character of it. */
test('a room with no name is drawn by its id rather than throwing', () => {
  const store = new SeekStore(emptyData())
  store.data.rooms['oc_1'] = { id: 'oc_1', chat_mode: 'group', created_at: AT }
  assert.equal(snapshotOf(store, '/tmp/seek.json').rooms[0].name, 'oc_1')
})

/** The main process may ask before the store is open; the interface must not get a crash. */
test('a store that is not open yet says so instead of throwing', () => {
  const snapshot = snapshotOf(null, null)
  assert.deepEqual(snapshot.rooms, [])
  assert.match(snapshot.error, /not open yet/)
})
