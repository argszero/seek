/**
 * The groups list draws one line per group.
 *
 * **What this file is for.** On 2026-11-05 the client's own 我的群组 was measured against ours
 * and the rows did not agree: the client's list is a directory of rooms — the group's title and
 * nothing under it, rows 54 device px apart — while ours drew the title and, beneath it, the
 * member count, in rows 62px apart. `feishu-groups-3.png` answers both halves of the question
 * before anything is written: the reference row carries **no second line at all**, and the
 * element that draws one, `.conv-last`, is the same element the chat list uses for a message
 * preview. So the second line goes from this view only, and the chat list keeps its own.
 *
 * **Pitch, not height, is what was measurable.** A screenshot of unhighlighted rows yields the
 * distance between two avatars and not the box each sits in, so the number this file pins is
 * that distance: 54, which is 52 for the row plus the 2px the list already puts between rows.
 *
 * **The count is not lost with the line.** It is still drawn twice on this screen — in the card
 * beside the list (`ui.groups.card.members`) and in the room header — so a reader who wants it
 * opens the group rather than reading it off a directory.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const HERE = import.meta.dirname
const ROOT = join(HERE, '..', '..')
const read = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8')

const GROUPS = read('ui', 'src', 'Groups.jsx')
const APP = read('ui', 'src', 'App.jsx')
const CONTACTS = read('ui', 'src', 'Contacts.jsx')
const TOPICS = read('ui', 'src', 'Topics.jsx')
const SHELL = read('ui', 'src', 'styles', 'shell.css')

/** One rule's declarations, read the way `composer.test.mjs` reads them. */
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
    declarations[text.slice(0, at).trim()] = text.slice(at + 1).replace(/[;\s]+$/, '').trim()
  }
  return declarations
}

/** Every occurrence of a shape, so a failure reports a number rather than the file. */
const count = (haystack, needle) => haystack.split(needle).length - 1

/** The markup of one group row: the whole button, from its tag to its end. */
function row() {
  const at = GROUPS.indexOf('data-group-row=')
  assert.notEqual(at, -1, 'the groups list no longer marks its rows, so this reads nothing')
  const from = GROUPS.lastIndexOf('<button', at)
  assert.notEqual(from, -1, 'the marked row has no opening tag, so this reads nothing')
  const to = GROUPS.indexOf('</button>', at)
  assert.notEqual(to, -1, 'the group row has no end, so this reads the whole file')
  return GROUPS.slice(from, to)
}

test('a group row is its title, and nothing under it', () => {
  // The reference, read on 2026-11-05: every row in 我的群组 is one line, so the second line
  // this view drew has no counterpart to match — and the count it carried is drawn in the card
  // beside the list and in the room header, neither of which this removes.
  const group = row()
  assert.equal(count(group, 'conv-last'), 0, 'the row draws a line under the title again')
  assert.equal(count(group, 'ui.members'), 0, 'the member count is back in the row: it belongs to the card and the room header')
  assert.match(
    group,
    /className=\{`conv single-line/,
    'the row says what it is: one line, so the sheet can size it as one',
  )
})

test('a group row stands 54px from the next, as the client’s directory does', () => {
  // 54 is the distance between two avatars in `feishu-groups-3.png`, measured twice: on the
  // full screenshot and on the 1:1 crop of it, both 54.0 across seven rows.
  const rowStyle = rule(SHELL, '.conv.single-line')
  assert.equal(rowStyle.height, '52px', 'the row is 52 tall, so that it and the list’s gap make 54')
  const gap = rule(SHELL, '.conv-list > li + li')
  assert.equal(gap['margin-top'], '2px', 'the list puts two pixels between two rows')
})

test('the line under a conversation stays where it was', () => {
  // `.conv-last` is one class shared by four lists, and only one of them is a directory: the
  // chat list draws a message preview with it, the topics list which room a thread is in and
  // how much was said, the contacts list what it knows about a person. Removing the line from
  // the groups view must not take theirs with it.
  for (const [source, what] of [
    [APP, 'the chat list’s preview of the last message'],
    [TOPICS, 'the topics list’s room and count'],
    [CONTACTS, 'the contacts list’s line under a person'],
  ]) {
    assert.match(source, /className="conv-last"/, `${what} is gone with the groups view’s line`)
  }
  assert.equal(count(GROUPS, 'conv-last'), 0, 'and the groups view draws none of its own')
})
