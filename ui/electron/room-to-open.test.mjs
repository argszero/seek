/**
 * Which room the chat half opens, and the fact that both arrivals use the same rule.
 *
 * The rule is a function of `src/room-to-open.mjs` rather than a line inside the component
 * for one reason: this is the defect that survived, and it survived because it lived
 * where nothing could reach it. `snapshotOf(null, …)` reporting `rooms: []` is already
 * pinned (`snapshot.test.mjs`); what was never checked is what the *renderer* does with an
 * empty room list arriving first, and then with a full one arriving second.
 *
 * There is no test harness for the renderer, so this file is two things: the rule itself,
 * imported and called, and the wiring, read as text the way `catalogue.test.mjs` reads the
 * views. Neither is a substitute for the other — a correct rule nobody calls fixes nothing,
 * and a call to a broken rule fixes nothing either.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { roomToOpen } from '../src/room-to-open.mjs'

const APP = readFileSync(join(import.meta.dirname, '..', 'src', 'App.jsx'), 'utf8')

const ROOMS = [{ id: 'om_first' }, { id: 'om_second' }]

test('a snapshot with no rooms opens nothing, rather than inventing one', () => {
  // The shape `snapshotOf(null, …)` sends while the store is being opened. There is nothing
  // to open, and opening a room that does not exist would be worse than opening none.
  assert.equal(roomToOpen(null, []), null)
  // A room list whose first entry has no id is the same answer: `undefined` would go on to
  // be compared against room ids that are strings, in a column that then matches nothing.
  assert.equal(roomToOpen(null, [{}]), null)
})

test('the snapshot that carries rooms opens the first, whichever answer came before', () => {
  // **This is the defect.** `start()` makes the window before it awaits the store, so the
  // first snapshot can be the empty one above; the store's opening then sends this. The
  // window has to end up showing a room, not listing them with none open.
  assert.equal(roomToOpen(null, ROOMS), 'om_first')
  // Applying the rule to the arrival after that must not change its mind.
  assert.equal(roomToOpen(roomToOpen(null, ROOMS), ROOMS), 'om_first')
})

test('a room somebody is already reading is never taken from them', () => {
  // The kernel pushes a snapshot every time a bot answers, so this path is not rare: the
  // person is usually somewhere, and the rule fills only a `null`.
  assert.equal(roomToOpen('om_second', ROOMS), 'om_second')
  // Including when the room they are in is not first in the list, and when it is the only
  // one there — a later snapshot must not move a reader to the top of the column.
  assert.equal(roomToOpen('om_second', [{ id: 'om_second' }]), 'om_second')
})

test('the chat half picks its room through this rule, on both arrivals', () => {
  // Read as text because the renderer cannot be imported here. The first half of the claim
  // is that the rule is called at all; the second is that the *same* handler is handed to
  // the first read and to every later push, which is the whole of the fix.
  assert.match(APP, /roomToOpen\(/, 'the chat half does not call the rule at all')
  assert.match(APP, /const adopt = /, 'no single handler holds the snapshot and the room')
  assert.match(APP, /\.then\(adopt\)/, 'the first snapshot bypasses the handler')
  assert.match(APP, /onChanged\(adopt\)/, 'a later snapshot bypasses the handler')

  // Anti-vacuity, and the regression this file exists to stop: the old wiring replaced the
  // snapshot on a later push and left the room selection to the boot answer alone.
  assert.doesNotMatch(
    APP,
    /onChanged\(\s*\(/,
    'a later snapshot is handed straight in, so it can no longer fill an empty selection',
  )
})
