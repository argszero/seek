/**
 * The rail is the prototype's, and this file is what makes that a claim rather than a comment.
 *
 * The reading it closes: `ui/src/App.jsx` carried a button per **room** in the navigation
 * column and no *messages* row at all, each drawn with an emoji, under a comment that said
 * 「This is the prototype's rail row」. The comment was wrong and nothing checked it — the
 * column had drifted into a different window while every test stayed green, because no test
 * had ever compared the two.
 *
 * So the comparisons here are made against `prototype/` itself, read out of the tree at test
 * time rather than copied beside it: the prototype is the spec (`docs/host-rulings.md`, §Design
 * precedes code), and the host named this column by name on 2026-10-27 — 左侧头像／消息／
 * 机器人／话题导航、图标、位置, all of it from there. A copy would be a second opinion; reading
 * the file means the spec cannot be restated wrongly here.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { catalogueFor } from '../../src/i18n.ts'
import { NAV_ICON, RAIL, RAIL_TAIL, TAIL_ICON } from '../src/rail.mjs'

const HERE = import.meta.dirname
const ROOT = join(HERE, '..', '..')
const read = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8')

const PROTOTYPE_JS = read('prototype', 'src', 'js', 'app.js')
const PROTOTYPE_ICONS = read('prototype', 'src', 'js', 'icons.js')
const PROTOTYPE_CSS = read('prototype', 'src', 'css', 'app.css')

const APP = read('ui', 'src', 'App.jsx')
const ICONS = read('ui', 'src', 'icons.jsx')
const SHELL = read('ui', 'src', 'styles', 'shell.css')

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
  for (const line of css.slice(from + opener.length, to).split('\n')) {
    const text = line.trim()
    if (text === '' || text.startsWith('/*') || text.startsWith('*')) continue
    const at = text.indexOf(':')
    if (at === -1) continue
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
    .replace(/\/>,\s*</g, '/><')
    .replace(/>\s+</g, '><')
    .replace(/\s+>/g, '>')
    .replace(/[\s,]+$/, '')
    .trim()
}

test('the rail holds the prototype’s four rows, in the prototype’s order', () => {
  const declared = slice(PROTOTYPE_JS, 'const RAIL = [', ']')
  const prototype = [...declared.matchAll(/\{\s*view:\s*'([^']+)',\s*icon:\s*'([^']+)',\s*label:\s*'([^']+)'\s*\}/g)].map(
    (one) => ({ view: one[1], icon: one[2], label: one[3] }),
  )
  assert.equal(prototype.length, 4, 'the prototype declares four navigation rows, and this reads them')

  assert.deepEqual(
    RAIL.map((one) => ({ view: one.view, icon: one.icon })),
    prototype.map((one) => ({ view: one.view, icon: one.icon })),
    'the window draws the prototype’s four views, with the prototype’s icons, in its order',
  )

  // The words are the prototype's too, and this is the assertion that would have caught the
  // rail the window actually had: no *messages* row, so no word for it anywhere.
  const zh = catalogueFor('zh-CN').messages
  const en = catalogueFor('en').messages
  RAIL.forEach((row, at) => {
    assert.equal(
      zh[row.label],
      prototype[at].label,
      `the row for ${prototype[at].view} must say what the prototype says (${prototype[at].label})`,
    )
    assert.notEqual(en[row.label], zh[row.label], `${row.label} is translated, not copied`)
  })

  // And the foot of the column: a theme toggle past a spacer, then settings. Two buttons the
  // prototype draws at 20px, not part of the four.
  assert.match(PROTOTYPE_JS, /data-role="toggle-theme"/, 'the prototype has a theme toggle')
  assert.match(PROTOTYPE_JS, /data-view="settings"/, 'and settings at the foot')
  assert.equal(RAIL_TAIL.view, 'settings')
  assert.equal(RAIL_TAIL.icon, 'settings')
  assert.equal(zh[RAIL_TAIL.label], '设置', 'and it says what the prototype says')
})

test('every icon is the prototype’s shape, character for character', () => {
  // The prototype's `PATHS`, read out of the file: name → the markup that draws it.
  const paths = slice(PROTOTYPE_ICONS, 'const PATHS = {', '\n  }\n')
  const prototype = new Map([...paths.matchAll(/(\w+):\s*'([^']*)'/g)].map((one) => [one[1], one[2]]))
  assert.ok(prototype.size > 20, 'the prototype declares a full icon set, and this reads it')

  const ours = slice(ICONS, 'const ICONS = {', '\n}\n')
  const drawn = new Map([...ours.matchAll(/(\w+):\s*\[([\s\S]*?)\],/g)].map((one) => [one[1], one[2]]))

  // The five the column uses, plus the moon that the toggle swaps to. A name here that the
  // prototype does not carry would be an icon this file invented.
  const used = [...RAIL.map((one) => one.icon), RAIL_TAIL.icon, 'sun', 'moon']
  for (const name of used) {
    assert.ok(drawn.has(name), `the window draws a ${name} icon`)
    assert.ok(prototype.has(name), `the prototype has a ${name} icon`)
    assert.equal(
      tidy(drawn.get(name)),
      tidy(prototype.get(name)),
      `the ${name} icon is the prototype’s own shape — a redrawn glyph is a different icon, ` +
        'and a screenshot cannot tell the two apart',
    )
  }

  // And the frame the prototype's `icon()` paints them with: stroked, not filled.
  assert.match(ICONS, /fill="none"/, 'these seven are stroked')
  assert.match(ICONS, /strokeWidth="1\.6"/, 'at the prototype’s 1.6px')
  assert.match(ICONS, /viewBox="0 0 24 24"/, 'in the prototype’s 24×24 box')

  // The sizes are `renderRail()`'s, and they are read off that function rather than agreed here.
  assert.match(PROTOTYPE_JS, new RegExp(`icon\\(item\\.icon, ${NAV_ICON}\\)`), 'the four draw at 22px')
  assert.match(PROTOTYPE_JS, new RegExp(`icon\\(dark \\? 'sun' : 'moon', ${TAIL_ICON}\\)`), 'the toggle at 20px')
  assert.match(PROTOTYPE_JS, new RegExp(`icon\\('settings', ${TAIL_ICON}\\)`), 'settings at 20px')
})

test('the rail draws no rooms, which is what it used to do instead of the four', () => {
  // The regression itself: a button per room sat between the avatar and the navigation, so the
  // column changed size with the store and the room list had two homes. The prototype gives the
  // rooms to the conversation list column (`chatRow()`), and the rail stays four rows wide.
  const nav = slice(APP, '<nav className="rail">', '</nav>')
  assert.doesNotMatch(nav, /snap\.rooms/, 'the rail is fixed navigation, not a room list')
  assert.doesNotMatch(nav, /room\.name/, 'and it does not draw a room')
  assert.doesNotMatch(nav, /⚙|🤖|👥|💬/, 'no emoji stands in for an icon')

  // The four rows are the prototype's data, and the window walks it rather than restating it.
  assert.match(nav, /\{RAIL\.map\(/, 'the rows come from `rail.mjs`')
  assert.match(nav, /<Icon name=\{item\.icon\} size=\{NAV_ICON\} \/>/, 'each with its icon at the nav size')
  assert.match(nav, /className="rail-spacer"/, 'with the spacer the prototype puts between the two halves')
  assert.match(nav, /data-role="toggle-theme"/, 'and the theme toggle at the foot')
})

test('the column’s numbers are the stylesheet’s numbers', () => {
  // Read off the prototype's rules rather than written here twice, so a change there shows up
  // as a failure rather than as a window that quietly kept the old measurement.
  const prototypeRail = rule(PROTOTYPE_CSS, '.rail')
  const ourRail = rule(SHELL, '.rail')
  for (const property of ['padding', 'gap', 'background']) {
    assert.equal(
      ourRail[property],
      prototypeRail[property],
      `.rail keeps the prototype’s ${property} (${prototypeRail[property]})`,
    )
  }
  assert.equal(ourRail['-webkit-app-region'], 'drag', 'the column is part of the title bar, as there')
  assert.equal(rule(SHELL, '.rail > *')['-webkit-app-region'], 'no-drag', 'and its children are not')

  const prototypeBtn = rule(PROTOTYPE_CSS, '.rail-btn')
  const ourBtn = rule(SHELL, '.rail-btn')
  for (const property of [
    'width',
    'height',
    'border-radius',
    'color',
    'position',
    'display',
    'align-items',
    'justify-content',
    'transition',
  ]) {
    assert.equal(ourBtn[property], prototypeBtn[property], `.rail-btn keeps the prototype’s ${property}`)
  }

  // The fill, the hand, the zeroed padding and the missing border are not `.rail-btn`'s own:
  // they are the prototype's global `button` reset (`prototype/src/css/app.css:29`), which this
  // window has no equivalent of, so this one button carries them itself. Same four answers is
  // the point — a filled tile in the rail is the difference being guarded against, and it is
  // the reset, not the rule, that says there is no fill.
  const reset = rule(PROTOTYPE_CSS, 'button')
  assert.equal(reset['background'], 'none', 'the prototype takes the fill off every button')
  assert.equal(reset['cursor'], 'pointer', 'and gives it the hand, which `.rail-btn` does not restate')
  for (const property of ['background', 'cursor', 'padding', 'border']) {
    assert.equal(ourBtn[property], reset[property], `.rail-btn carries the prototype’s button reset (${property})`)
  }
  assert.equal(
    rule(SHELL, '.rail-btn.active')['color'],
    rule(PROTOTYPE_CSS, '.rail-btn.active')['color'],
    'a row that is showing is a stronger ink, not a different button',
  )
  assert.equal(rule(SHELL, '.rail-btn:hover')['background'], rule(PROTOTYPE_CSS, '.rail-btn:hover')['background'])

  // Where the avatar sits: the prototype's 32px box around a 28px face, its green dot, and no
  // hand cursor — it is who this is, not a way to switch.
  const prototypeAvatar = rule(PROTOTYPE_CSS, '.rail-avatar')
  const ourAvatar = rule(SHELL, '.rail-avatar')
  for (const property of ['width', 'height', 'margin-bottom', 'cursor']) {
    assert.equal(ourAvatar[property], prototypeAvatar[property], `.rail-avatar keeps the prototype’s ${property}`)
  }
  const prototypeDot = rule(PROTOTYPE_CSS, '.rail-avatar .presence')
  const ourDot = rule(SHELL, '.rail-avatar .presence')
  for (const property of ['width', 'height', 'border-radius', 'background']) {
    assert.equal(ourDot[property], prototypeDot[property], `the presence dot keeps the prototype’s ${property}`)
  }
})

test('the three columns are the widths the prototype declares', () => {
  // `--rail-w: 64px`, `--list-w: 300px`, `--side-w: 380px` in `prototype/src/css/tokens.css`.
  // Two of them were measured off a screenshot here instead — 288 and 340 — which is 「位置」
  // drifting while every test stayed green.
  const tokens = read('prototype', 'src', 'css', 'tokens.css')
  const width = (name) => {
    const found = tokens.match(new RegExp(`--${name}:\\s*(\\d+px)`))
    assert.ok(found, `the prototype declares --${name}`)
    return found[1]
  }
  const grid = rule(SHELL, '.app')['grid-template-columns']
  assert.equal(grid, `${width('rail-w')} ${width('list-w')} minmax(0, 1fr)`, 'the three columns in a room')
  const threaded = rule(SHELL, '.app.with-thread')['grid-template-columns']
  assert.equal(
    threaded,
    `${width('rail-w')} ${width('list-w')} minmax(0, 1fr) ${width('side-w')}`,
    'and with the thread panel open, which the prototype calls --side-w',
  )
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
