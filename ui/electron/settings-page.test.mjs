/**
 * The settings page's two sections, and which of them the model belongs to.
 *
 * **What this holds in place.** The host ruled on 2026-10-27 that a model is set once for this
 * machine and is no organization's property; the page said otherwise by layout — organizations
 * first, models under them, one heading apart and nothing between — and he read it that way
 * twice, sentence or no sentence. So the layout was changed to say it instead: the machine's
 * section first, the organizations' after it, a hairline between them.
 *
 * A test is here because that shape is one edit away from reverting. Two headings in one column
 * is the ordinary way to write a settings page, an editor tidying the file will restore that
 * order without noticing, and no other test in this repository reads this page's sections at
 * all: `settings.test.mjs` is about `settings.json`, and the stylesheet guard (issue #135) asks
 * whether a class has any rule, never where the class is used.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { catalogueFor } from '../../src/i18n.ts'

const HERE = import.meta.dirname
const ROOT = join(HERE, '..', '..')
const read = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8')

const PAGE = read('ui', 'src', 'Settings.jsx')
const SHELL = read('ui', 'src', 'styles', 'shell.css')

/** One CSS rule's declarations, by exact selector. Flat rules only, which is what this file reads. */
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

test('the machine comes first, and the organizations after it', () => {
  const machine = PAGE.indexOf("t('ui.settings.machine.title')")
  const organizations = PAGE.indexOf("t('ui.settings.organizations.title')")
  assert.notEqual(machine, -1, 'the page draws a machine section')
  assert.notEqual(organizations, -1, 'and an organizations section')
  assert.ok(
    machine < organizations,
    'the model is above the organization, because it is the machine’s and not the list’s — ' +
      'with organizations first the model reads as a property of whichever one is open',
  )

  // Two sections, each wrapping its own heading: the wrapper is what lets the pair be separated
  // by something other than a heading, which is all the page had before.
  const sections = PAGE.split('className="settings-section"').length - 1
  assert.equal(sections, 2, 'the pane is cut into exactly two sections')
  const machineSection = PAGE.indexOf('className="settings-section"')
  const secondSection = PAGE.indexOf('className="settings-section"', machineSection + 1)
  assert.ok(machineSection < machine && machine < secondSection, 'the model sits in the first')
  assert.ok(secondSection < organizations, 'and the organizations in the second')

  // The old heading is gone rather than left beside the new one: two headings for one section is
  // how a page ends up saying "models" twice and meaning two different places.
  assert.equal(PAGE.includes("t('ui.settings.models.title')"), false, 'the old section heading is gone')
})

test('the two sections are separated by a line, not only by a heading', () => {
  // A heading was what the page already had while the host read the model as belonging to the
  // organization, so a heading is not the separation this asks for.
  const divider = rule(SHELL, '.settings-section + .settings-section')
  assert.equal(divider['border-top'], '1px solid var(--line-border-card)', 'a hairline divides them')
  assert.equal(divider['margin-top'], '28px', 'with the gap a section break needs')
  assert.equal(divider['padding-top'], '24px', 'and room above the second heading')
})

test('the section is a heading a person reads, in both languages', () => {
  const zh = catalogueFor('zh-CN').messages
  const en = catalogueFor('en').messages
  const key = 'ui.settings.machine.title'
  assert.equal(typeof zh[key], 'string', 'the Chinese catalogue answers the heading')
  assert.equal(typeof en[key], 'string', 'and so does the English one')
  assert.notEqual(en[key], zh[key], 'translated, not copied')
  assert.match(en[key], /machine/i, 'and it says whose the section is, in words')
  assert.match(zh[key], /机器/, 'in both languages')
})

/**
 * **The weights row draws sizes, never the facts object it is handed.**
 *
 * `stage1.pending` is `{received, total, file}` — three facts, because the sentence that used to
 * be composed in the main process had its language fixed before the window had one. This page
 * kept interpolating the whole value, which is legal React right up until the value exists: with
 * no weights on the machine the object reached the renderer as a child, React threw #31, and the
 * throw took the page with it. Measured on the shipped `v0.1.8` download: `#root` empty, a fresh
 * install opening on nothing. No suite caught it because nothing renders this component.
 */
test('the weights row draws a size, not the object the kernel hands over', () => {
  // The old shape, both ways it was written: `?? <words>` falling back, and a bare interpolation
  // of the object. Either one puts an object where a child belongs the moment weights are pending.
  assert.equal(
    /stage1\?\.pending \?\?/.test(PAGE),
    false,
    'the row must not fall back from the whole object — that is the shape that blanked the window',
  )
  assert.equal(
    PAGE.includes('{snapshot?.stage1?.pending}'),
    false,
    'and it must not interpolate the object directly either',
  )

  // What it does instead: both numbers through the formatting layer, which is where §4 puts a
  // size. Reading the two field names is what makes this a check on the fix rather than on intent.
  assert.match(PAGE, /size\(snapshot\??\.stage1\??\.pending\.received\)/, 'the bytes received go through size()')
  assert.match(PAGE, /size\(snapshot\??\.stage1\??\.pending\.total\)/, 'and so do the bytes expected')

  // The words are the catalogue's, and both placeholders survive — a translation that dropped one
  // would read as a sentence with a hole in it.
  const zh = catalogueFor('zh-CN').messages
  const en = catalogueFor('en').messages
  const key = 'ui.settings.decides.downloading'
  for (const [name, messages] of [['en', en], ['zh-CN', zh]]) {
    assert.equal(typeof messages[key], 'string', `the ${name} catalogue answers the row`)
    assert.match(messages[key], /\{got\}/, `the ${name} row says how much arrived`)
    assert.match(messages[key], /\{all\}/, `and how much is expected`)
  }
  assert.notEqual(en[key], zh[key], 'translated, not copied')
})

/**
 * **The organizations panel is drawn by rules that exist** (issue #137).
 *
 * The page has always marked the panel up as `.organization-list`, `.organization-row`,
 * `.organization-av` and `.organization-name`, and the stylesheet had no rule for any of the
 * four — not lost, never written. What that draws is a browser's default `<ul>`: a bullet, a
 * 40px indent on top of the card's own padding, and the avatar letter, the name, the "open" chip
 * and three buttons flowing as one line of text with the buttons on top of the name. Measured
 * on this window on 2026-10-27, which is how it was noticed at all.
 *
 * The fix is one of the two answers the issue holds open — rules shaped after `.people-list` /
 * `.people-row`, markup untouched. The other answer (re-marking the panel onto `.card-rows` and
 * deleting these four classes) would fail the last assertion here, on purpose: whoever takes it
 * has to say so by editing this test, not by deleting the rules.
 */
test('the organizations panel has rules of its own, one row per world', () => {
  for (const name of ['organization-list', 'organization-row', 'organization-av', 'organization-name']) {
    assert.match(PAGE, new RegExp(`className="${name}"`), `.${name} is still what the page draws`)
  }

  const list = rule(SHELL, '.organization-list')
  assert.equal(list['list-style'], 'none', 'the list is a list of rows, not a bulleted <ul>')
  assert.equal(list.padding, '0', 'and its indent is the card’s, not the browser’s')

  const row = rule(SHELL, '.organization-row')
  assert.equal(row.display, 'flex', 'a row lays its four parts out rather than flowing them')
  assert.equal(row['align-items'], 'center', 'with the avatar, the name and the buttons on one line')

  const avatar = rule(SHELL, '.organization-av')
  assert.equal(avatar['border-radius'], '50%', 'the initial is drawn as an avatar')
  assert.equal(avatar.width, '24px', 'at the size the roster uses for the same thing')

  const nameRule = rule(SHELL, '.organization-name')
  assert.equal(nameRule.flex, '1', 'a long name takes the room the buttons do not')
  assert.equal(nameRule['text-overflow'], 'ellipsis', 'and ends in an ellipsis rather than pushing them out')
})
