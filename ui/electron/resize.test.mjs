/**
 * Every column a person can widen, and the bounds that keep one from eating the other.
 *
 * **What this holds.** The window is a grid of columns and the seams between them are what a
 * pointer grabs. Only one seam existed — the list's, in the chat view — so the roster, the topics
 * list and the thread panel were pinned at whatever width the tokens gave them; the grid still
 * reserved a 6px track in the roster and the topics list, and nothing occupied it, so those
 * columns started 6px early. The host asked for all of them (2026-10-27): every pane that has a
 * column beside it should let that edge move.
 *
 * **Why the arithmetic is tested rather than the drag.** A drag can only be wrong in one way that
 * a reader would notice — the column goes where it should not — and that is decided entirely by
 * `clampWidth`. The pointer plumbing around it is a `pointerdown`, two window listeners and a
 * token write; a test that simulated one would be testing the test.
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { PANES, clampWidth } from '../src/resize.mjs'

const HERE = import.meta.dirname
const ROOT = join(HERE, '..', '..')
const read = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8')

const SHELL = read('ui', 'src', 'styles', 'shell.css')
const TOKENS = read('ui', 'src', 'styles', 'tokens.css')

/**
 * One rule out of a stylesheet, declarations read past comments and wrapped lines.
 *
 * The same reading `rail.test.mjs` uses, and for the same reason: a declaration that wraps onto
 * a second line is ordinary CSS, and a parser that reads line by line returns half a value.
 */
function rule(css, selector) {
  const opener = `${selector} {`
  const from = css.indexOf(opener)
  assert.notEqual(from, -1, `${opener} is gone, so this check reads nothing`)
  const to = css.indexOf('}', from)
  const declarations = {}
  const body = css.slice(from + opener.length, to).replace(/\/\*[\s\S]*?\*\//g, '')
  for (const line of body.split('\n')) {
    const text = line.trim()
    if (text === '') continue
    const at = text.indexOf(':')
    if (at === -1) {
      const previous = Object.keys(declarations).at(-1)
      if (previous !== undefined) {
        declarations[previous] = `${declarations[previous]} ${text}`.replace(/[;\s]+$/, '').trim()
      }
      continue
    }
    declarations[text.slice(0, at).trim()] = text.slice(at + 1).replace(/[;\s]+$/, '').trim()
  }
  return declarations
}

test('a column stops at its own bounds, and the column beside it keeps its floor', () => {
  const list = PANES.list
  /** What the seam stands on: the column that gives way, and where the dragged one starts. */
  const room = (beside, start) => ({ beside, start })

  assert.equal(clampWidth(100, list, room(900, 448)), list.min, 'narrower than the minimum is the minimum')
  assert.equal(clampWidth(10_000, list, room(900, 448)), list.max, 'and wider than the maximum is the maximum')

  // The floor is the neighbour's, and it bites before the pane's own maximum: a room of 320px has
  // 40px of slack above a 280px floor, so a 448px list stops at 488 however far the pointer goes.
  assert.equal(
    clampWidth(10_000, list, room(320, 448)),
    448 + (320 - list.keep),
    'the drag spends the room\'s slack and no more',
  )

  // A room already at its floor gives up nothing, and one under its floor is not squeezed further.
  // This is the reading the first version of this bound missed: it compared the pane against the
  // whole window, so a drag took the room to 124px — one word per line — while the list sat at
  // its comfortable 448. Measured in the prototype window on 2026-10-27.
  assert.equal(clampWidth(10_000, list, room(list.keep, 448)), 448, 'no slack above the floor, no growth')
  assert.equal(clampWidth(10_000, list, room(120, 448)), 448, 'a room under the floor is not squeezed further')

  // The other direction is unbounded by the neighbour: narrowing the pane only gives the room room.
  assert.equal(clampWidth(0, list, room(120, 448)), list.min, 'and the minimum still holds going the other way')

  // A drag that reports no number — a synthetic event, a cancelled gesture — lands on the floor
  // rather than writing `NaNpx` into the grid, which would silently drop the whole track list.
  assert.equal(clampWidth(Number.NaN, list, room(900, 448)), list.min, 'and a number that is not one is the floor')
  assert.equal(clampWidth(448.6, list, room(900, 448)), 449, 'the width is a whole number of pixels')
})

test('the seam beside a column reads the drag with the sign of the side it is on', () => {
  // The list's seam is to its right, so rightward widens it; the thread panel's is to its left,
  // so the same rightward drag narrows the panel. One sign each, and they are opposites — a copy
  // of the list's handler for the panel would have grown it in the wrong direction.
  assert.equal(PANES.list.dir, 1, 'the list grows as the pointer moves away from the rail')
  assert.equal(PANES.side.dir, -1, 'the thread panel grows as the pointer moves toward the room')
  assert.notEqual(PANES.list.token, PANES.side.token, 'they write different tokens')
})

test('each pane writes a width token the stylesheet actually reads', () => {
  for (const [name, pane] of Object.entries(PANES)) {
    assert.match(TOKENS, new RegExp(`${pane.token}: \\d+px`), `tokens.css declares ${pane.token} for ${name}`)
    assert.ok(
      SHELL.includes(`var(${pane.token})`),
      `the grid reads ${pane.token} — a token nothing reads is a drag that moves nothing`,
    )
    assert.equal(pane.column, pane.column.trim(), 'the selector is written without padding')
    assert.ok(pane.min < pane.max, `${name} has an interval to move in`)
    assert.ok(pane.keep > 0, `${name} leaves the column beside it a floor to stand on`)
  }
})

test('every view with two columns draws a seam between them', () => {
  // Read off the tree rather than listed by hand: the first version of this test named three
  // files, and the groups view — a list beside a card, drawn exactly like the other two — was
  // missing its seam and invisible to the assertion. A list of files is a list that goes stale
  // the moment a fourth one is written.
  const sources = readdirSync(join(ROOT, 'ui', 'src')).filter((name) => name.endsWith('.jsx'))
  const split = sources.filter((name) => read('ui', 'src', name).includes('className="list-col"'))
  assert.ok(split.length >= 4, `the scan found ${split.length} two-column views — the pattern is broken`)

  for (const name of split) {
    const source = read('ui', 'src', name)
    assert.match(
      source,
      /<Gutter pane="list" \/>/,
      `${name} draws a list column but no seam beside it: the grid reserves the 6px track and ` +
        'nothing occupies it, so the column starts 6px early and its edge cannot be grabbed',
    )
  }

  // The chat view also has the thread panel, which appears beside the room rather than in the
  // component's own tree.
  const APP = read('ui', 'src', 'App.jsx')
  assert.match(APP, /<Gutter pane="side" \/>/, 'and the thread panel from the room')

  // And the rail, which is the one column every view has — drawn once, above the view branches,
  // so the settings page (one column, no list) still has the rail's edge to grab.
  assert.match(APP, /<Gutter pane="rail" \/>/, 'the navigation rail can be widened too')
  const afterNav = APP.indexOf('</nav>')
  const firstView = APP.indexOf('<Settings', afterNav)
  assert.notEqual(firstView, -1, 'the settings view is drawn after the rail')
  assert.match(
    APP.slice(afterNav, firstView),
    /<Gutter pane="rail" \/>/,
    'the rail seam is drawn once, after the rail and before whichever view is open',
  )

  // The seam is one component rather than a copy per view: four copies of a pointerdown is four
  // places for the bounds to drift apart.
  const gutter = read('ui', 'src', 'Gutter.jsx')
  assert.match(gutter, /beginResize\(event, pane\)/, 'the seam is the shared one')
  assert.match(gutter, /role="separator"/, 'and it says what it is to a screen reader')
  assert.match(gutter, /aria-orientation="vertical"/, 'a vertical split')
})

test('every layout the rail appears in reserves a track for its seam', () => {
  // A gutter track in the template and no seam in the markup is a 6px hole; a seam and no track
  // is a seam drawn on top of the list. All three layouts are checked, because the settings page
  // and the thread view are the two that were written apart from the chat view.
  for (const selector of ['.app', '.app.with-thread', '.app.with-settings']) {
    const tracks = rule(SHELL, selector)['grid-template-columns']
    assert.match(tracks, /^var\(--rail-w\) var\(--gutter-w\)/, `${selector} gives the rail a seam track`)
  }
  assert.match(rule(SHELL, '.app.with-settings')['grid-template-columns'], /var\(--gutter-w\) minmax\(0, 1fr\)$/)
})

test('a seam is grabbable and says so', () => {
  const at = SHELL.indexOf('.gutter {')
  assert.notEqual(at, -1, 'the stylesheet has a rule for the seam')
  const body = SHELL.slice(at, SHELL.indexOf('}', at))
  assert.match(body, /cursor: col-resize/, 'the pointer says this edge can be dragged')
  assert.match(body, /touch-action: none/, 'and a drag is not read as a scroll by anything under it')
  assert.match(body, /-webkit-app-region: no-drag/, 'the seam is not the window title bar')

  // The room keeps a seam on each side once a thread is open, or one of the two columns beside it
  // has an edge nothing can grab.
  const threadGrid = SHELL.slice(SHELL.indexOf('.app.with-thread {'))
  const tracks = threadGrid.slice(0, threadGrid.indexOf('}'))
  assert.equal(
    (tracks.match(/var\(--gutter-w\)/g) ?? []).length,
    3,
    'three seams: the rail, the list, and the thread panel',
  )
})

test('the drag measures the column that gives way, not the window', () => {
  // The bound above is only as good as the number it is given. The first version handed
  // `clampWidth` the width of `.app` and subtracted a constant from it, which read as a floor and
  // behaved as nothing: the room beside the seam went to 124px while the floor it was supposed to
  // have was 360. So the source has to be read too — a corrected `clampWidth` fed by a window
  // width is a bound that still does not look at what it is protecting.
  const source = read('ui', 'src', 'resize.mjs')
  assert.match(source, /querySelector\('\.main-col'\)/, 'the seam reads the width of the room it stands on')
  assert.match(source, /getBoundingClientRect\(\)\.width/, 'and that width is the one being measured')
  assert.doesNotMatch(source, /containerWidth/, 'the window width is not what a pane is bounded by')
})
