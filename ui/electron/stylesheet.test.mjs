/**
 * The stylesheet, and the surfaces it is the only owner of.
 *
 * The reading it closes: `ui/src/styles/shell.css` was rewritten whole while the rail was
 * redrawn — 1,150 lines came out as 301, and 862 lines of window styles went with them. Both
 * suites stayed green. `ui/electron/rail.test.mjs` does read the sheet, but for one purpose:
 * the numbers the rail is drawn at — the 156px column, its 8px insets, the 32px rows rounded
 * at 8, the 16px glyphs and the 6px gutter — read out of `.rail`, `.rail-btn` and `.gutter`
 * and from the tokens those rules name. The message column, the composer, the store, the
 * thread panel and the settings page had no reader at all, so nothing in the repository would
 * have noticed had the loss been theirs instead.
 *
 * A deleted CSS rule is not like a deleted function. Nothing imports it, so nothing fails to
 * resolve; the component still renders and it renders unstyled — no error, no warning, a
 * window that looks wrong and a suite that says it is right. That is a shape only a count of
 * the file can hold, because nothing else in the tree has an opinion about it.
 *
 * What is counted, and why each one:
 *
 * - **The surfaces.** Eighteen classes that each name a region of the window, asserted to
 *   still open a rule. This is the check that fails on the incident's shape: one region's
 *   rules going away entirely while its markup stays.
 * - **The bulk.** Two floors, rules and declarations, set well below what the sheet holds
 *   today (**193** and **786**) and far above what the truncated file had. Floors rather than
 *   pins because rules are added and retired as the window grows, and a pin would turn every
 *   ordinary edit into a two-file change; a floor still fails when a whole region goes.
 * - **The import.** The sheet is styles only once `main.jsx` reads it, and a commented-out
 *   import is the same accident one layer up — every surface drawn, nothing applied.
 *
 * **The list is the sheet's, not a guess about what a window ought to contain.** `.side-col`,
 * `.modal`, `.toast` and `.lightbox` are the prototype's names; this window has no rule for
 * any of them, so naming them here would have been a guard failing on a tree that is right.
 * Every class below was read out of the file. One correction to the issue's own list:
 * `.settings-col` has no rule of its own — it is `.main-col` in the markup (`Settings.jsx:204`)
 * plus one descendant rule — so it is counted as a surface by that descendant rule and
 * nothing more.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const HERE = import.meta.dirname
const ROOT = join(HERE, '..', '..')
const read = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8')

const SHEET = read('ui', 'src', 'styles', 'shell.css')

/** The sheet without its comments: a selector quoted in a comment draws nothing. */
const CODE = SHEET.replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * Every top-level rule's selector list, in file order.
 *
 * The sheet is flat — no at-rule, no nesting — so a rule is exactly the text between the
 * previous `}` and its own `{`. That flatness is asserted below rather than assumed: the day
 * someone wraps a block in `@media`, this reader would start returning declaration text as
 * though it were a selector, and a guard that has quietly stopped reading is worse than none.
 */
function selectorLists(css) {
  return css
    .split('}')
    .map((part) => {
      const at = part.indexOf('{')
      return at === -1 ? '' : part.slice(0, at).replace(/\s+/g, ' ').trim()
    })
    .filter((one) => one !== '')
}

const RULES = selectorLists(CODE)
const DECLARATIONS = CODE.match(/[-A-Za-z][-A-Za-z0-9]*\s*:\s*[^;{}]+;/g) ?? []

/**
 * The floors, and they are deliberately not the counts of today.
 *
 * A change that retires a region of the window crosses one of these, and lowering it belongs
 * in that same commit with a line saying which region went. The property being held is that
 * losing a region cannot be silent — not that the sheet may never shrink.
 */
const FLOOR_RULES = 180
const FLOOR_DECLARATIONS = 700

/**
 * The window's surfaces, each with the class whose rules make it look like itself.
 *
 * Read off the sheet, one line per region the window actually draws — the frame, the rail, the
 * conversation list, the room and its messages, the composer, the store and the weights, the
 * thread panel, and the settings page.
 */
const SURFACES = [
  ['the window frame', '.app'],
  ['the rail', '.rail'],
  ['a rail button', '.rail-btn'],
  ['the conversation list', '.list-col'],
  ['the room column', '.main-col'],
  ['the messages', '.messages'],
  ['the composer', '.composer'],
  ['the store panel', '.store'],
  ['the weights', '.weights'],
  ['the thread list', '.thread-list'],
  ['the settings pane', '.pane'],
  ['a settings card', '.card'],
  ['the settings column', '.settings-col'],
  ['a field', '.field-input'],
  ['a button', '.btn'],
  ['a chip', '.chip'],
]

/**
 * Does this class open one of the selectors a rule applies to?
 *
 * The class has to name the selector, or a compound of it — `.app`, `.app.with-thread` and
 * `.settings-col .main-head h2` all count — while `.application` is a different class and must
 * not be taken for `.app`. Compound and descendant forms are how this sheet says "the same
 * region, in another state", so refusing them would reject the file as it is written.
 */
function opensSelector(list, className) {
  return list.split(',').some((one) => {
    const selector = one.trim()
    if (!selector.startsWith(className)) return false
    const next = selector.charAt(className.length)
    return next === '' || '. : [ > + ~'.includes(next)
  })
}

test('the sheet is flat, which is what makes a rule readable at all', () => {
  // The reader above is the thing being checked first: it splits at braces, so an at-rule or
  // a nested block would make it count the wrong text and every check below would then be
  // measuring something other than the file.
  assert.doesNotMatch(
    CODE,
    /(^|\n)\s*@/,
    'an at-rule is here now, so `selectorLists()` no longer reads rules and this file needs its reader updated',
  )
  assert.equal(
    CODE.split('{').length,
    CODE.split('}').length,
    'the braces are balanced, so every rule the reader found is a whole one',
  )
  assert.ok(
    RULES.length > 100,
    `the sheet was read as ${RULES.length} rules, which is too few to be a window's stylesheet`,
  )
})

test('every surface of the window still has a rule of its own', () => {
  const orphaned = SURFACES.filter(([, className]) => !RULES.some((list) => opensSelector(list, className)))
  assert.deepEqual(
    orphaned.map(([surface, className]) => `${surface} (${className})`),
    [],
    'a surface with no rule renders unstyled and nothing else in the tree notices',
  )
})

test('the sheet still holds a window’s worth of rules', () => {
  assert.ok(
    RULES.length >= FLOOR_RULES,
    `the sheet holds ${RULES.length} rules, below the floor of ${FLOOR_RULES}: a region of the ` +
      'window went with it. If that was meant, lower FLOOR_RULES in this file and say which region went.',
  )
})

test('and a window’s worth of declarations inside those rules', () => {
  // The other half of the incident: rules kept, contents gone. A rule count cannot see it, so
  // the declarations are counted separately.
  assert.ok(
    DECLARATIONS.length >= FLOOR_DECLARATIONS,
    `the sheet holds ${DECLARATIONS.length} declarations, below the floor of ${FLOOR_DECLARATIONS}: ` +
      'the rules are still there but what they say is not. If that was meant, lower FLOOR_DECLARATIONS in this file.',
  )
})

test('the window still reads the sheet, both halves of it', () => {
  // `shell.css` gets its colours from `tokens.css` and nothing in it invents one, so losing
  // either import leaves every `var(--N…)` unresolved — a window drawn, and grey or invisible.
  const main = read('ui', 'src', 'main.jsx')
  assert.match(main, /^import '\.\/styles\/shell\.css'$/m, 'the window imports the shell')
  assert.match(main, /^import '\.\/styles\/tokens\.css'$/m, 'and the palette the shell names')
})
