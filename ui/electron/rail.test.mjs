/**
 * The navigation rail: four rows, the theme toggle and settings at the foot, and the numbers
 * the column is drawn with.
 *
 * **What this file changed into (2026-10-27, issue #138).** It used to hold the window's rail
 * against a *second* copy of the window that lived under `prototype/` — `renderRail()` in
 * `prototype/src/js/app.js`, its icon table, its stylesheet. That copy is gone: the demo page
 * now renders `ui/src/App.jsx` over invented data, so there is no second implementation to
 * disagree with and no reason to compare two files that are one. What is left below is the
 * claims that survive that deletion — the rows and their words, the icons and their size, the
 * measured numbers of the column, and the two at the foot — read out of `ui/src`, which is the
 * only place the rail is written now.
 *
 * The three numbers that used to come from the prototype's stylesheet come from the client
 * instead: a live Feishu messenger, read at a 1912×829 window on 2026-10-27 — 156px of column,
 * 8px insets, 32px rows rounded at 8, 16px glyphs, and a 6px gutter beside the list. `#138`
 * deleted the copy; the measurements replaced it as the spec.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { catalogueFor } from '../../src/i18n.ts'
import {
  ADD_MENU,
  ADD_TITLE,
  NAV_ICON,
  RAIL,
  RAIL_TAIL,
  TAIL_ICON,
  THEME_TO_DARK,
  THEME_TO_LIGHT,
} from '../src/rail.mjs'

const HERE = import.meta.dirname
const ROOT = join(HERE, '..', '..')
const read = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8')

const APP = read('ui', 'src', 'App.jsx')
const ICONS = read('ui', 'src', 'icons.jsx')
const SHELL = read('ui', 'src', 'styles', 'shell.css')
const TOKENS = read('ui', 'src', 'styles', 'tokens.css')

/** The slice of a file between an opener and the first closer after it. */
function slice(text, opener, closer) {
  const from = text.indexOf(opener)
  assert.notEqual(from, -1, `${opener} is gone, so this check reads nothing`)
  const to = text.indexOf(closer, from)
  assert.notEqual(to, -1, `${opener} is never closed, so this check reads past it`)
  return text.slice(from + opener.length, to)
}

/**
 * One CSS rule's declarations, by exact selector.
 *
 * The rule ends at its own `}` rather than at the next `\n}`: `.rail > * { … }` is written on
 * one line, so a newline-anchored closer reads past it into whatever rule follows and the
 * value comes back carrying a stray `; }`. These rules are flat — none nests — so the first
 * `}` after the opener is the end of the one being read.
 */
function rule(css, selector) {
  const opener = `${selector} {`
  const from = css.indexOf(opener)
  assert.notEqual(from, -1, `${opener} is gone, so this check reads nothing`)
  const to = css.indexOf('}', from)
  assert.notEqual(to, -1, `${opener} is never closed, so this check reads past it`)
  const declarations = {}
  // **Comments come out before the lines are read.** Skipping lines that *start* with `/*` or `*`
  // is not enough: a wrapped comment's later lines start with prose, and folding those into the
  // previous declaration put English inside a colour value.
  const body = css.slice(from + opener.length, to).replace(/\/\*[\s\S]*?\*\//g, '')
  for (const line of body.split('\n')) {
    const text = line.trim()
    if (text === '') continue
    const at = text.indexOf(':')
    if (at === -1) {
      // **A declaration may be wrapped.** Continuing a long value onto the next line is ordinary
      // CSS, and this parser used to drop that line: the value read back short — every track
      // after the break missing — and a guard built on it compared against half a value. A line
      // with no colon is the rest of the previous declaration, so it goes there.
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

/** Markup compared as shape rather than as formatting: whitespace carries no meaning in it. */
function tidy(markup) {
  return markup
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*\/>/g, '/>')
    .replace(/>\s+</g, '><')
    .replace(/\s+>/g, '>')
    .trim()
}

test('the rail holds four rows, and each one is a word a person reads', () => {
  assert.equal(RAIL.length, 4, 'the rail is four navigation rows')
  assert.equal(new Set(RAIL.map((one) => one.view)).size, 4, 'and no view is named twice')
  assert.equal(new Set(RAIL.map((one) => one.icon)).size, 4, 'and no row draws the same glyph as another')

  // A rail word is a word a person reads, so it comes from the catalogue (§1) and exists in
  // both languages. The English being identical to the Chinese would mean a key that was
  // added to one file and copied into the other.
  const zh = catalogueFor('zh-CN').messages
  const en = catalogueFor('en').messages
  for (const row of [...RAIL, RAIL_TAIL]) {
    assert.equal(typeof zh[row.label], 'string', `${row.label} is a key the Chinese catalogue answers`)
    assert.equal(typeof en[row.label], 'string', `${row.label} is a key the English catalogue answers`)
    assert.notEqual(en[row.label], zh[row.label], `${row.label} is translated, not copied`)
  }

  // The order is the client's own: messages, then the three that are about other people.
  assert.deepEqual(
    RAIL.map((one) => one.view),
    ['chat', 'contacts', 'groups', 'topics'],
    'the rows are in the order the column reads',
  )
  assert.equal(RAIL_TAIL.view, 'settings')
  assert.equal(RAIL_TAIL.icon, 'settings')
})

test('the theme toggle and settings wait at the foot, past the spacer', () => {
  const nav = slice(APP, '<nav className="rail">', '</nav>')

  // The spacer is what keeps the two at the foot: without it the four rows would stack under
  // the avatar and the column would be top-heavy, which is not the shape either client has.
  assert.match(nav, /className="rail-spacer"/, 'the spacer stands between the four and the two')
  assert.match(nav, /data-role="toggle-theme"/, 'the theme toggle is at the foot')
  assert.match(nav, /data-view=\{RAIL_TAIL\.view\}/, 'and settings is the last row')

  // The toggle names what it is about to do, not what it is: a button that said "dark" while
  // the window was dark would be a label for the state it is leaving.
  assert.match(nav, /dark \? THEME_TO_LIGHT : THEME_TO_DARK/, 'the toggle names the change it makes')
  assert.notEqual(THEME_TO_DARK, THEME_TO_LIGHT, 'and the two directions are different words')
  assert.notEqual(zh(THEME_TO_DARK), zh(THEME_TO_LIGHT), 'in the catalogue as well as here')
})

test('the rail draws no rooms, which is what it used to do instead of the four', () => {
  // The regression itself: a button per room sat between the avatar and the navigation, so the
  // column changed size with the store and the room list had two homes. The rooms belong to
  // the conversation list column, and the rail stays four rows wide.
  const nav = slice(APP, '<nav className="rail">', '</nav>')
  assert.doesNotMatch(nav, /snap\.rooms/, 'the rail is fixed navigation, not a room list')
  assert.doesNotMatch(nav, /room\.name/, 'and it does not draw a room')
  assert.doesNotMatch(nav, /⚙|🤖|👥|💬/, 'no emoji stands in for an icon')

  assert.match(nav, /\{RAIL\.map\(/, 'the rows come from `rail.mjs`')
  assert.match(nav, /<Icon name=\{item\.icon\} size=\{NAV_ICON\} \/>/, 'each with its icon at the nav size')
  assert.match(nav, /<span className="rail-label">\{t\(item\.label\)\}<\/span>/, 'and its word beside it')
})

test('every glyph is drawn at the client’s 16px, in the client’s frame', () => {
  // Measured, 2026-10-27: the reference draws a rail glyph at 16px with the word starting 8px
  // after it. The numbers used to be 22 and 20 — the deleted prototype's — which pushed every
  // word 6px to the right of where the client puts it.
  assert.equal(NAV_ICON, 16, 'a navigation row’s glyph is 16px')
  assert.equal(TAIL_ICON, 16, 'and so are the two at the foot')

  const ours = slice(ICONS, 'const ICONS = {', '\n}\n')
  const drawn = new Map([...ours.matchAll(/(\w+):\s*\[([\s\S]*?)\],/g)].map((one) => [one[1], one[2]]))
  const used = [...RAIL.map((one) => one.icon), RAIL_TAIL.icon, 'sun', 'moon']
  for (const name of used) {
    assert.ok(drawn.has(name), `the window draws a ${name} icon`)
    assert.ok(tidy(drawn.get(name)).length > 20, `the ${name} icon has a path, not a placeholder`)
  }

  // And the frame they are painted with: stroked rather than filled, in one 24×24 box.
  assert.match(ICONS, /fill="none"/, 'the rail’s glyphs are stroked')
  assert.match(ICONS, /strokeWidth="1\.6"/, 'at 1.6px')
  assert.match(ICONS, /viewBox="0 0 24 24"/, 'in a 24×24 box')
})

test('the column’s numbers are the ones measured off the client', () => {
  const rail = rule(SHELL, '.rail')
  // 156px wide with 8px insets and a 4px gap between rows; the 56px top is clearance for the
  // traffic lights `titleBarStyle: 'hiddenInset'` draws over this column.
  assert.equal(rail.padding, '56px 8px 12px', 'the column keeps the client’s insets')
  assert.equal(rail.gap, '4px', 'and the 4px between one row and the next')
  assert.equal(rail.background, 'var(--rail-bg)', 'its surface is the rail token, not a literal')
  assert.equal(rail.border, undefined, 'and it has no border of its own — the seam belongs to the list')

  const row = rule(SHELL, '.rail-btn')
  assert.equal(row.height, '32px', 'a row is 32px tall')
  assert.equal(row['border-radius'], '8px', 'rounded at 8')
  assert.equal(row.padding, '0 8px 0 11px', 'with the glyph 11px in and the word 8px after it')
  assert.equal(row.gap, '8px', 'which is the same 8px in gap form')

  // The width is a token, and the token is the measurement: a literal here would be a second
  // place for 156 to drift.
  const width = (name) => {
    const found = TOKENS.match(new RegExp(`--${name}:\\s*([^;]+);`))
    assert.ok(found, `tokens.css declares --${name}`)
    return found[1].trim()
  }
  assert.equal(width('rail-w'), '156px', 'the navigation column is 156px')
  assert.equal(width('list-w'), '448px', 'the conversation list is 448px')
  assert.equal(width('side-w'), '380px', 'the thread panel is 380px')
  assert.equal(width('gutter-w'), '6px', 'and the gutter between the columns is 6px')
})

test('the grid is three columns and a gutter, and the row is the window', () => {
  const grid = rule(SHELL, '.app')['grid-template-columns']
  assert.equal(
    grid,
    'var(--rail-w) var(--gutter-w) var(--list-w) var(--gutter-w) minmax(0, 1fr)',
    'the rail, the list, the gutter, and the room taking what is left',
  )
  assert.equal(
    rule(SHELL, '.app.with-thread')['grid-template-columns'],
    'var(--rail-w) var(--gutter-w) var(--list-w) var(--gutter-w) minmax(0, 1fr) var(--gutter-w) var(--side-w)',
    'and the thread panel is a further column — behind its own seam, so it can be widened too',
  )

  // **The row is the window's height, not the conversation's.** A single implicit row is sized
  // by its content, so before this the room's own height set the row: measured on 2026-10-27, a
  // 556px window had a 785px row, the rail started at −135px, and its last two rows — the theme
  // toggle and settings — were drawn past the bottom edge where nothing could click them.
  assert.equal(rule(SHELL, '.app')['grid-template-rows'], 'minmax(0, 1fr)', 'the row cannot outgrow the window')
  assert.equal(rule(SHELL, '.app').overflow, 'hidden', 'and nothing paints outside the frame')
  assert.equal(rule(SHELL, '.app > *')['min-height'], '0', 'no column keeps its content as its minimum')

  // The gutter is the only thing in this window a pointer drags wider, and it has no line:
  // the two columns beside it share a surface and a hairline here would be a seam the client
  // does not have.
  const gutter = rule(SHELL, '.gutter')
  assert.equal(gutter.width, 'var(--gutter-w)', 'the gutter is the 6px token')
  assert.equal(gutter.cursor, 'col-resize', 'and it says it can be dragged')
  assert.equal(gutter.background, 'transparent', 'with no colour of its own')
})

test('the theme toggle has words before it has a window', () => {
  // Both the rail and the toggle are read before the first frame — the catalogue by
  // `main.jsx`, the theme beside it — because a window that painted light and then repainted
  // is the flash the catalogue's ordering exists to avoid.
  assert.match(read('ui', 'src', 'main.jsx'), /window\.seekHost\.theme\(\)/, 'the theme is asked for at boot')
  assert.match(
    read('ui', 'src', 'main.jsx'),
    /document\.documentElement\.setAttribute\('data-theme'/,
    'and set before the first render',
  )
  assert.match(
    read('ui', 'electron', 'preload.js'),
    /saveTheme: \(theme\) => ipcRenderer\.invoke\('seek:theme-save', theme\)/,
    'and the toggle can remember what it was set to',
  )
  assert.match(
    read('ui', 'electron', 'main.js'),
    /ipcMain\.handle\('seek:theme', async \(\) => \{/,
    'the answer comes from the main process, which is where the file is',
  )
})

test('the add button offers the three things this product can make', () => {
  // Measured off the client (2026-10-27, a 1912×829 messenger): the mark is 24px rounded at 6,
  // 12px in from the column's right edge, and its panel is a 152px sheet hung off the mark's top
  // edge. The client's own menu carries more rows than this product can act on, so the rows here
  // are the three things the window can actually make, and nothing else.
  assert.equal(ADD_MENU.length, 3, 'three rows, because there are three things to make')
  assert.deepEqual(
    ADD_MENU.map((one) => one.view),
    ['groups', 'contacts', 'settings'],
    'a group, a bot, an organization — each in the view that makes it',
  )
  assert.equal(new Set(ADD_MENU.map((one) => one.icon)).size, 3, 'no two rows draw the same glyph')

  const zhWords = catalogueFor('zh-CN').messages
  const enWords = catalogueFor('en').messages
  for (const row of [...ADD_MENU, { label: ADD_TITLE }]) {
    assert.equal(typeof zhWords[row.label], 'string', `${row.label} is a key the Chinese catalogue answers`)
    assert.equal(typeof enWords[row.label], 'string', `${row.label} is a key the English catalogue answers`)
    assert.notEqual(enWords[row.label], zhWords[row.label], `${row.label} is translated, not copied`)
  }

  const nav = slice(APP, '<nav className="rail">', '</nav>')
  const top = nav.indexOf('className="rail-top"')
  const mark = nav.indexOf('data-role="add"')
  assert.ok(top !== -1 && mark > top, 'the mark sits in the column’s top block, beside the avatar')
  assert.match(nav, /\{ADD_MENU\.map\(/, 'the rows come from `rail.mjs`')
  assert.match(nav, /className="rail-menu"/, 'and are drawn as the menu')
  assert.match(nav, /<Icon name=\{item\.icon\} size=\{16\} \/>/, 'each row’s glyph at the client’s 16px')

  // A row is a redirect only if it forgets the form, so `addTo` does both: it switches the view
  // and asks that view for the thing the menu promised. Dismissing rides on the same call.
  assert.match(
    APP,
    /function addTo\(next\) \{\s*setView\(next\)\s*setAsk\(next\)\s*setAddOpen\(false\)/,
    'a row opens the form it promised, and closes the menu',
  )
  // A menu nobody can dismiss is a trap: a press outside it, and Escape.
  assert.match(
    APP,
    /if \(!event\.target\.closest\?\.\('\.rail-add, \.rail-menu'\)\) setAddOpen\(false\)/,
    'a press anywhere else closes it',
  )
  assert.match(APP, /event\.key === 'Escape'/, 'and so does Escape')

  const trigger = rule(SHELL, '.rail-add')
  assert.equal(trigger.width, '24px', 'the mark is 24px wide')
  assert.equal(trigger.height, '24px', 'and 24px tall')
  assert.equal(trigger['border-radius'], '6px', 'rounded at 6')
  assert.equal(trigger.background, 'none', 'with no plate of its own until it is hovered')
  assert.equal(trigger.color, 'var(--rail-icon-muted)', 'and the column’s muted ink')

  const menu = rule(SHELL, '.rail-menu')
  // **152 is a floor, not a width.** The client's own panel measures 152 across because it is
  // sized to *its* words, and those are Chinese; measured in this window, the longest English row
  // needs 185.7px at 14px, so a flat 152 cut the word and gave the excess to the one thing on the
  // row that could give it up. `max-content` with the measured number as a minimum is the same
  // claim the client makes — as wide as the widest row, and never narrower than this.
  assert.equal(menu.width, 'max-content', 'the panel is as wide as its longest row')
  assert.equal(menu['min-width'], 'var(--rail-menu-w)', 'and no narrower than the client’s panel')
  assert.match(TOKENS, /--rail-menu-w:\s*152px;/, 'which is the 152 it was measured at')
  assert.equal(menu.padding, '4px', 'with 4px between its edge and a row')
  assert.equal(menu['border-radius'], 'var(--radius-md)', 'rounded at the medium radius')
  assert.match(TOKENS, /--radius-md:\s*6px;/, 'which is the client’s 6')
  // **The shadow is a measurement too.** The client’s panel carries the layered `s4-down` family,
  // whose first layer is `0 8px 24px 8px` in a 4% ink; the heavier `popup` token draws a visibly
  // darker edge, so borrowing it would have been a number nobody measured.
  assert.equal(menu['box-shadow'], 'var(--shadow-s4-down)', 'the panel wears the client’s shadow')
  assert.match(
    TOKENS,
    /--shadow-s4-down:\s*0px 8px 24px 8px rgba\(31, 35, 41, 0\.04\)/,
    'and that token is the layer the client was measured at',
  )

  const row = rule(SHELL, '.rail-menu button')
  assert.equal(row.height, '32px', 'a row is 32px tall')
  assert.equal(row.padding, '0 8px', 'inset 8px from the panel’s own padding')
  assert.equal(row.gap, '12px', 'the word starts 12px after the glyph')
  assert.equal(row['font-size'], '14px', 'at the client’s 14px')
  // Measured, not assumed: at the flat 152px width the mark on "Create an organization" came back
  // 0px wide — the flex line had taken the row's 20px of excess out of the smallest thing on it,
  // so the word was drawn with no glyph beside it. A row's mark is 16px or the row is wrong.
  assert.equal(rule(SHELL, '.rail-menu button svg').flex, 'none', 'and the glyph cannot be squeezed out')
})

/** One word of the Chinese catalogue, for the comparisons that need a literal. */
function zh(key) {
  return catalogueFor('zh-CN').messages[key]
}
