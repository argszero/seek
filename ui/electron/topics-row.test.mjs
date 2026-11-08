/**
 * A topic row says its words and, at the other end of the same line, when it was last spoken in.
 *
 * **What this file is for.** On 2026-11-08 the topics view was measured in a real window, after
 * three probes established that the client has no topics screen to copy (`话题` appears in its
 * messenger only as a thread under one message). So the reference for this row is the project's
 * own prototype, which it calls the shape this view keeps: its topics branch drew the root's
 * words with `chat-time` of `last_reply` beside them, then the room and the reply count under
 * them. This window drew the words and the two facts under them and **no time at all**, while
 * `Topics.jsx`'s own docstring said every row carried a date and a time — a claim with nothing
 * under it, and the chat list drawing exactly that time in exactly that place.
 *
 * **The instant is the last reply's, and that is the half worth a test.** A thread was spoken in
 * more recently than it was started, so a row driven by the root's `created_at` would put an old
 * date beside the newest thing in the list — a difference one test can catch and a screenshot
 * cannot, because both numbers are plausible on their own.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const HERE = import.meta.dirname
const ROOT = join(HERE, '..', '..')
const read = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8')

const TOPICS = read('ui', 'src', 'Topics.jsx')
const APP = read('ui', 'src', 'App.jsx')
const SHELL = read('ui', 'src', 'styles', 'shell.css')

/** One rule's declarations, read the way `groups-row.test.mjs` reads them. */
function rule(css, selector) {
  const opener = `${selector} {`
  const from = css.indexOf(opener)
  assert.notEqual(from, -1, `${opener} is gone, so this check reads nothing`)
  const to = css.indexOf('}', from)
  const body = css.slice(from + opener.length, to).replace(/\/\*[\s\S]*?\*\//g, '')
  const declarations = {}
  for (const line of body.split('\n')) {
    const text = line.trim()
    if (text === '') continue
    const at = text.indexOf(':')
    if (at === -1) {
      const previous = Object.keys(declarations).at(-1)
      if (previous !== undefined) declarations[previous] += ` ${text.replace(/[;\s;]+$/, '')}`
      continue
    }
    declarations[text.slice(0, at).trim()] = text.slice(at + 1).replace(/[;\s;]+$/, '').trim()
  }
  return declarations
}

/** Every occurrence of a shape, so a failure reports a number rather than the file. */
const count = (haystack, needle) => haystack.split(needle).length - 1

/** The markup of one topic row: the whole button, from its tag to its end. */
function row() {
  const at = TOPICS.indexOf('data-topic-row=')
  assert.notEqual(at, -1, 'the topics list no longer marks its rows, so this reads nothing')
  const from = TOPICS.lastIndexOf('<button', at)
  assert.notEqual(from, -1, 'the marked row has no opening tag, so this reads nothing')
  const to = TOPICS.indexOf('</button>', at)
  assert.notEqual(to, -1, 'the topic row has no end, so this reads the whole file')
  return TOPICS.slice(from, to)
}

test('a topic row puts a time at the other end of its first line', () => {
  // The arrangement is the chat list's (`.conv-top` = name then time, the CSS note on it says
  // which one gives up width first), and the prototype's topics branch drew the same two things
  // on the same line.
  const topic = row()
  assert.equal(count(topic, 'conv-top'), 1, 'the row wraps its first line in .conv-top again')
  assert.equal(count(topic, 'conv-name'), 1, 'the row draws its words once')
  assert.equal(count(topic, 'conv-time'), 1, 'the row draws a time again, as the prototype did')
  // Both views draw their first line through the same wrapper, so a change to one arrangement
  // is a change to both rather than two shapes that drift apart.
  assert.match(APP, /className="conv-top"/, 'the chat list draws its first line the same way')
})

test('the time a topic row shows is the last reply’s, not when the thread started', () => {
  const topic = row()
  assert.match(topic, /whenShort\(topic\.replies\.at\(-1\)\.at\)/, 'the row reads the root’s time')
  // The rule, stated as what must not be there: the root's own `at` puts an old date beside the
  // newest thread in a list sorted by last reply.
  assert.doesNotMatch(topic, /when(?:Short)?\(topic\.root\.at\)/, 'the root’s time is in the row')
})

test('a topic row stands 62px from the next, and the name gives up width first', () => {
  // Measured in the window on 2026-11-08: 60 for the row plus the 2px the list puts between
  // rows. The topics row is two lines, so it keeps `.conv`'s own height rather than the groups
  // view's 52 — the groups row is a directory of one line, this one is not.
  assert.equal(rule(SHELL, '.conv').height, '60px', 'the two-line row is 60 tall')
  assert.equal(rule(SHELL, '.conv-list > li + li')['margin-top'], '2px', 'the list puts two pixels between two rows')
  // The name truncates and the time does not, which is the note above `.conv-top` in the sheet.
  // `.conv-time` is written on one line, so it is read as one — `rule()` above splits a body by
  // line and would report the four declarations there as a single value.
  const at = SHELL.indexOf('.conv-time {')
  assert.notEqual(at, -1, 'the .conv-time rule is gone, so this check reads nothing')
  assert.match(SHELL.slice(at, SHELL.indexOf('}', at)), /flex:\s*none/, 'the time is the one that stays readable in full')
})
