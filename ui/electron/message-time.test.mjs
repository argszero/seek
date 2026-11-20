/**
 * A message in a chat transcript shows when it was said.
 *
 * The work order is the host's own sentence (`docs/host-rulings.md`, "The window"): the
 * transcript shows a message's time. What this file holds is the half a screenshot cannot:
 * that the row asks the window's formatter for the message's **own** instant rather than for
 * the moment it was drawn, and that the form it asks for is the one carrying a day.
 *
 * **That second half is the whole reason the form is named here.** The window has two ways to
 * write an instant — `when()` and `whenShort()` — and they differ in exactly the case a
 * transcript meets: `whenShort()` drops the clock for anything that did not happen today, so
 * a row using it would answer "which morning was this" with a date and "were these two said
 * together" with nothing. `catalogue.mjs` writes the narrow one for a list of conversations;
 * the transcript is the other case.
 *
 * There is no harness for the renderer, so this file is two things, the way
 * `topics-of.test.mjs` is: the formatter, imported and called, and the wiring, read as text.
 * A correct form nobody calls draws nothing; a call to the wrong one draws the wrong thing.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { catalogueFor, locales } from '../../src/i18n.ts'
import { bindCatalogue, when, whenShort } from '../src/catalogue.mjs'

const APP = readFileSync(join(import.meta.dirname, '..', 'src', 'App.jsx'), 'utf8')

/** An instant on a day that is not today, which is what a transcript is full of. */
const OLD = '2026-10-24T01:00:00.000Z'

/**
 * The name line of a message row: what the row says about the message before its box opens.
 * Cut from the file rather than matched across it, so the assertions below are about the row
 * and not about some other place in the same 2,700 lines that happens to name a time.
 */
function senderLine() {
  const from = APP.indexOf('className="msg-sender"')
  assert.ok(from > 0, 'the message row no longer has a name line')
  const to = APP.indexOf('className="msg-bubble"', from)
  assert.ok(to > from, 'the name line no longer ends where the box begins')
  return APP.slice(from, to)
}

test('a message row draws its own time, through the window formatter', () => {
  const line = senderLine()
  assert.match(line, /className="msg-time"/, 'the name line draws no time')
  assert.match(
    line,
    /\{when\(message\.at\)\}/,
    "the row does not draw `when()` of the message's own `at`",
  )
  // The instant the row reads is the snapshot's `at`, which `snapshot.test.mjs` pins to the
  // kernel's `created_at`. What is refused here is the other clock a row could reach for: the
  // moment of drawing.
  assert.doesNotMatch(
    line,
    /new Date\(|Date\.now\(/,
    'the row reads the clock instead of the message',
  )
})

test('the form a transcript uses carries the day, which the list form drops', () => {
  for (const locale of locales()) {
    bindCatalogue(catalogueFor(locale))
    const stamp = when(OLD)
    assert.ok(stamp.length > 0, `${locale}: an instant drew nothing`)
    // Not a spelling of the string: a comparison of what each form can say. For a day that is
    // not today the narrow form is a date with no time on it, so the transcript's form is the
    // longer of the two whatever the locale and whatever zone the runner is in.
    assert.ok(
      stamp.length > whenShort(OLD).length,
      `${locale}: the transcript's form says no more than the list's (${stamp} vs ${whenShort(OLD)})`,
    )
    // And the day is genuinely part of it: two instants a month apart are not one stamp.
    assert.notEqual(when(OLD), when('2026-11-24T01:00:00.000Z'), `${locale}: a month apart drew one stamp`)
    // An instant nobody can read is no time to show, rather than the word for an invalid one.
    assert.equal(when('not a date'), '', `${locale}: an unreadable instant drew something`)
    assert.equal(when(''), '', `${locale}: an empty instant drew something`)
  }
})
