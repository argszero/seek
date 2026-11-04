/**
 * What a room is called, in the language the window is running in.
 *
 * The reading this file holds is the client's own group list (a screenshot OCR'd on
 * 2026-11-04, not read by eye): a group with no name is titled by **who is in it** — every
 * member, the reader among them, all on one line, separated and with no conjunction. So the
 * three claims here are that a nameless room names its people rather than itself, that it does
 * so in the language's own punctuation, and that a room which *has* a name is never touched.
 *
 * It runs under plain `node --test` with no Electron and no React: the decision was put in
 * `ui/src/room-name.mjs` rather than inside a component so that it can be read here at all.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { catalogueFor } from '../../src/i18n.ts'
import { bindCatalogue, joinList } from '../src/catalogue.mjs'
import { roomTitle } from '../src/room-name.mjs'

/** A room as the snapshot hands it up: a name that may be absent, and the people in it. */
function room(name, members, id = 'oc_f63ba78b67f84769') {
  return { id, name, members: members.map((who) => ({ id: `pr_${who}`, name: who, bot: false })) }
}

const THREE = ['邵安清', '张杰', '李玉峰']

test('a room with a name is called by it, whatever is in it', () => {
  bindCatalogue(catalogueFor('en'))
  assert.equal(roomTitle(room('Reading circle', THREE)), 'Reading circle')
  bindCatalogue(catalogueFor('zh-CN'))
  assert.equal(
    roomTitle(room('Reading circle', THREE)),
    'Reading circle',
    'a name somebody gave is content and is never rewritten (docs/design/i18n.md §2)',
  )
})

test('a room with no name is called by who is in it, the reader included', () => {
  // The reader is a member like anybody else: the client's own list shows the person reading
  // it among the names, which is what `members` carries.
  const nameless = room(null, THREE)

  bindCatalogue(catalogueFor('en'))
  assert.equal(roomTitle(nameless), '邵安清, 张杰, 李玉峰', 'the names, in the order the room holds them')

  bindCatalogue(catalogueFor('zh-CN'))
  assert.equal(roomTitle(nameless), '邵安清、张杰、李玉峰', 'and separated by Chinese punctuation')
})

test('the title is a list of names, not a sentence with a conjunction in it', () => {
  const nameless = room('', THREE)

  bindCatalogue(catalogueFor('en'))
  const english = roomTitle(nameless)
  assert.doesNotMatch(english, / and /, 'nothing is being said, so no conjunction is written')
  assert.notEqual(
    english,
    joinList(THREE),
    'and this is not `joinList()` — that one writes the conjunction a sentence needs',
  )

  bindCatalogue(catalogueFor('zh-CN'))
  const chinese = roomTitle(nameless)
  assert.doesNotMatch(chinese, /和/, 'Chinese writes no conjunction into a title either')
  assert.match(chinese, /、/, 'and it does not run the names together without punctuation')
  assert.notEqual(chinese, THREE.join(''), 'which is what a bare concatenation would give')
})

test('an empty name is no name, and a room with nobody in it is still drawable', () => {
  bindCatalogue(catalogueFor('en'))
  assert.deepEqual(roomTitle(room('', THREE)), roomTitle(room(null, THREE)), 'nothing and empty are one')

  // The kernel refuses a room with no members, so this is a store older than that refusal —
  // and an id is unhelpful where `undefined` would throw inside `t()`.
  assert.equal(roomTitle(room(null, [])), 'oc_f63ba78b67f84769', 'a room with no members keeps its id')
  assert.equal(roomTitle({}), '', 'and a room that is nothing at all does not throw')
})
