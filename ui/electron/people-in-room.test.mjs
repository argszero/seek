/**
 * Who a room's people panel lists: its members, then whoever else may be put in it.
 *
 * The rule lives in `src/people-in-room.mjs` rather than in a line inside the component
 * because the defect it fixes is a *shape*: the panel mapped `snapshot.people`, so it answered
 * "who may join" and drew it as "who is here". While the two lists agreed nothing showed; they
 * stopped agreeing the moment `peopleOf()` became "the reader and the bots" — a store written
 * by an older seed holds a second human, and the older seed also put them in the first room.
 *
 * Like `room-to-open.test.mjs`, this file is two things: the rule, imported and called, and the
 * wiring, read as text the way `catalogue.test.mjs` reads the views. A correct rule nobody
 * calls fixes nothing.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { peopleInRoom } from '../src/people-in-room.mjs'

const APP = readFileSync(join(import.meta.dirname, '..', 'src', 'App.jsx'), 'utf8')

const OFFERED = [
  { id: 'pr_me', name: 'me', bot: false },
  { id: 'bo_echo', name: 'Echo', bot: true },
]

test('a member the store no longer offers still gets a row', () => {
  // The store's own shape: a room whose membership names somebody `peopleOf()` does not offer.
  // They are counted by the room's header (`members` is the memberships), so a panel that
  // dropped them would show a room of more people than it lists — and no way to take one out.
  const room = {
    id: 'rm_first',
    members: [
      { id: 'pr_me', name: 'me', bot: false },
      { id: 'pr_stray', name: 'someone else', bot: false },
    ],
  }

  assert.deepEqual(
    peopleInRoom(room, OFFERED).map((person) => person.id),
    ['pr_me', 'pr_stray', 'bo_echo'],
    'the room’s own members first, in the kernel’s order, then what may be added',
  )
  assert.equal(
    peopleInRoom(room, OFFERED)[1].name,
    'someone else',
    'under the name this room already resolved, not the id',
  )
})

test('nobody is listed twice, however they arrived', () => {
  const room = { id: 'rm_first', members: [{ id: 'bo_echo', name: 'Echo', bot: true }] }
  const listed = peopleInRoom(room, OFFERED).map((person) => person.id)

  assert.deepEqual(listed, ['bo_echo', 'pr_me'], 'the offer already in the room is not repeated')
  assert.equal(new Set(listed).size, listed.length, 'one row per principal')
})

test('a bot is still marked as a bot, from either list', () => {
  const room = { id: 'rm_first', members: [{ id: 'bo_echo', name: 'Echo', bot: true }] }
  const rows = peopleInRoom(room, OFFERED)

  assert.equal(rows[0].bot, true, 'the member row carries it, or the panel loses the chip')
  assert.equal(rows[1].bot, false, 'and a person is not marked as one she is not')
})

test('with no room open the panel is the offers alone, and it never throws', () => {
  assert.deepEqual(peopleInRoom(null, OFFERED).map((person) => person.id), ['pr_me', 'bo_echo'])
  assert.deepEqual(peopleInRoom(undefined, undefined), [])
})

test('the panel draws that list, not the snapshot’s offers', () => {
  assert.match(
    APP,
    /const roomPeople = peopleInRoom\(active, snap\?\.people \?\? \[\]\)/,
    'the list is computed from the open room and the offers',
  )
  assert.match(APP, /\{roomPeople\.map\(\(person\) => \{/, 'and the panel maps it')
  assert.doesNotMatch(
    APP,
    /className="people-list">\s*\n\s*\n?\s*\{\(snap\.people/,
    'the people list is not mapped straight off the snapshot again',
  )
})
