/**
 * The bridge between the kernel and the interface.
 *
 * `snapshotOf` is the only thing the renderer ever sees, so what it decides is what the
 * interface can show: which rooms exist, who is in them, and what was said. It runs
 * under plain `node --test` — no Electron — because the whole point of the split is
 * that this mapping is ordinary code, not something only a running app can exercise.
 *
 * The store is the real one (`src/store.ts`), not a hand-written stand-in: a fixture
 * that copies the shard shape would be a second copy of it, and the day the shape
 * changes it would agree with itself while the kernel disagreed with both.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { emptyData, SeekStore } from '../../src/store.ts'
import { snapshotOf } from './snapshot.js'

/** A store with one room, one person, one bot and two messages. */
function seeded() {
  const store = new SeekStore(emptyData())
  store.data.principals['pr_me'] = { id: 'pr_me', name: 'argszero' }
  store.data.bots['bo_watch'] = { id: 'bo_watch', name: 'watch-bot', created_at: '2026-10-25T00:00:00.000Z' }
  store.data.rooms['rm_ops'] = { id: 'rm_ops', name: 'Ops room', kind: 'group', created_at: '2026-10-25T00:00:00.000Z' }
  store.data.memberships['mb_1'] = { id: 'mb_1', room_id: 'rm_ops', principal_id: 'pr_me', joined_at: '2026-10-25T00:00:00.000Z' }
  store.data.memberships['mb_2'] = { id: 'mb_2', room_id: 'rm_ops', principal_id: 'bo_watch', joined_at: '2026-10-25T00:00:00.000Z' }
  store.messagesOf('rm_ops').push(
    { id: 'om_1', room_id: 'rm_ops', sender_id: 'pr_me', text: 'the deploy is red', at: '2026-10-25T01:00:00.000Z' },
    { id: 'om_2', room_id: 'rm_ops', sender_id: 'bo_watch', text: 'looking at it now', at: '2026-10-25T01:01:00.000Z' },
  )
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

/** The interface draws a different avatar for a bot, so the flag has to be true where it is. */
test('a bot is marked as a bot and a person is not', () => {
  const room = snapshotOf(seeded(), '/tmp/seek.json').rooms[0]
  const byId = Object.fromEntries(room.members.map((m) => [m.id, m]))
  assert.equal(byId.bo_watch.bot, true)
  assert.equal(byId.pr_me.bot, false)
  assert.equal(byId.bo_watch.name, 'watch-bot', 'the name comes from the roster row, not the id')
})

/** A store with nothing in it is a state the interface has to render, not an error. */
test('an empty store is an empty room list, not a failure', () => {
  const snapshot = snapshotOf(new SeekStore(emptyData()), '/tmp/seek.json')
  assert.deepEqual(snapshot.rooms, [])
  assert.equal(snapshot.error, undefined, 'an empty store is not an error')
})

/** The main process may ask before the store is open; the interface must not get a crash. */
test('a store that is not open yet says so instead of throwing', () => {
  const snapshot = snapshotOf(null, null)
  assert.deepEqual(snapshot.rooms, [])
  assert.match(snapshot.error, /not open yet/)
})
