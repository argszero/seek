/**
 * The composer: one field, and the marks inside it.
 *
 * **What this file is for.** On 2026-10-27 the host put our composer beside the client's and
 * said the difference was still large (这里和飞书的差别还是比较大). It was: the client draws one
 * 48px field with a row of 18px marks at its right end and an arrow to send with, and we drew
 * four bordered boxes in a row holding the words `@`, "Picture" and "Send". Two of those words
 * name a picture badly and the third is a slab of blue the client does not have.
 *
 * Every number below was measured off the client's own composer on that day — its DOM, not a
 * screenshot — and is checked against `ui/src` rather than against another copy of the window.
 * The shapes that are **not** here are as deliberate as the ones that are: the client's `Aa`,
 * `☺`, `⊕` and `⤢` are four things this product cannot do, and a mark that does nothing is
 * worse than a mark that is missing.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { catalogueFor } from '../../src/i18n.ts'

const HERE = import.meta.dirname
const ROOT = join(HERE, '..', '..')
const read = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8')

const APP = read('ui', 'src', 'App.jsx')
const SHELL = read('ui', 'src', 'styles', 'shell.css')
const ICONS = read('ui', 'src', 'icons.jsx')

/** The declarations of one rule, with its comments taken out first. */
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
      if (previous !== undefined) declarations[previous] += ` ${text.replace(/[;\s]+$/, '')}`
      continue
    }
    declarations[text.slice(0, at).trim()] = text.slice(at + 1).replace(/[;\s]+$/, '').trim()
  }
  return declarations
}

/** Every occurrence of a markup shape, so "how many" is answerable. */
const count = (haystack, needle) => haystack.split(needle).length - 1

test('the composer is one field, with the marks inside it', () => {
  // 48px tall, a `--N400` hairline, rounded 8, and the client's own padding — measured on
  // 2026-10-27, where the box read `48`, `1px solid rgb(187, 191, 196)`, `8px` and
  // `0px 2px 0px 8px`.
  const box = rule(SHELL, '.composer-box')
  assert.equal(box['min-height'], '48px', 'the field is 48px tall')
  assert.equal(box.border, '1px solid var(--N400)', 'and drawn with the component border, not a divider')
  assert.equal(box['border-radius'], 'var(--radius-lg)', 'rounded at 8')
  assert.equal(box.padding, '0 2px 0 8px', 'the client’s insets: 2px at the marks’ end, 8px where the text starts')

  // The editor itself has no border of its own any more: it is inside the field, so a border
  // here is a box drawn in a box. This is the assertion that fails if the old four-box row comes
  // back.
  const input = rule(SHELL, '.composer-input')
  assert.equal(input.border, '0', 'the editor draws no border: the field around it is the border')
  assert.equal(input.background, 'transparent', 'and no fill of its own, for the same reason')
  assert.equal(input['line-height'], '22px', 'the text sits on the client’s 22px line')
  assert.equal(input.padding, '12px 5px', '13px down from the field’s edge, 13px in from its left')
})

test('the marks are pictures at the client’s size, not words in boxes', () => {
  // 26×26 hit areas holding 18px glyphs, 4px apart, grey, rounded 6 — read off the client's
  // toolbar row, where five items sat at x=1690…1810 thirty pixels apart.
  const tool = rule(SHELL, '.composer-tool')
  assert.equal(tool.width, '26px', 'a mark is a 26px hit area')
  assert.equal(tool.height, '26px', 'square, so the pointer target does not depend on the glyph')
  assert.equal(tool['border-radius'], '6px', 'rounded at 6')
  assert.equal(tool.background, 'transparent', 'and carries no fill until it is hovered')
  assert.equal(tool.color, 'var(--N600)', 'drawn in the client’s grey')
  assert.equal(rule(SHELL, '.composer-tools').gap, '4px', '4px between one mark and the next')

  // One number for all three, because a send arrow at a different size from the two beside it
  // is the one that looks wrong.
  assert.match(APP, /const COMPOSER_ICON = 18/, 'the marks are 18px, named once')
  assert.equal(count(APP, '<Icon name="mention" size={COMPOSER_ICON} />'), 2, 'a mention mark in both composers')
  assert.equal(count(APP, '<Icon name="picture" size={COMPOSER_ICON} />'), 2, 'a picture mark in both')
  assert.equal(count(APP, '<Icon name="send" size={COMPOSER_ICON} />'), 2, 'and the arrow in both')

  // The glyphs are the client's own paths, filled, in its 24×24 frame.
  for (const name of ['mention', 'picture', 'send']) {
    assert.match(ICONS, new RegExp(`\\b${name}: \\[`), `icons.jsx carries a ${name} glyph`)
  }

  // **The words are gone from the buttons.** They are titles now, which is where the client
  // keeps them too — so the check is that neither composer still draws `ui.chat.picture` or the
  // send word as button text.
  const composers = APP.slice(APP.indexOf('<form\n              className="composer"'))
  assert.doesNotMatch(composers, /t\('ui\.chat\.picture'\)/, 'no button wears the word “Picture”')
  assert.doesNotMatch(
    composers,
    />\s*\{t\('ui\.chat\.send'\)\}\s*</,
    'and none wears the word “Send” — the arrow is the word',
  )
  // But they still say what they are: a picture and a name are not decorations.
  assert.match(APP, /title=\{t\('ui\.chat\.send'\)\}/, 'the send keeps its title')
  assert.match(APP, /aria-label=\{t\('ui\.chat\.send'\)\}/, 'and a name a screen reader can read')
})

test('the send is the client’s arrow, in its two states', () => {
  // 18px, 13px in from the button's left end and 4px from its right, in a 35px button that stops
  // 8px short of the field's edge: that is how the client's arrow lands 15px inside the field.
  const send = rule(SHELL, '.composer-send')
  assert.equal(send.width, '35px', 'the button is wider than the glyph')
  assert.equal(send.height, '26px', 'and as tall as the marks beside it')
  assert.equal(send.padding, '0 4px 0 13px', 'the glyph sits 13px in, as the client draws it')
  assert.equal(send['margin-right'], '8px', 'and the button stops short of the field’s edge')
  assert.equal(send.background, 'transparent', 'no filled slab: the client has none')
  assert.equal(send.color, 'var(--B600)', 'blue when there is something to send')
  assert.match(
    SHELL,
    /\.composer-send:disabled \{ color: var\(--N600\)/,
    'and the client’s grey when the box is empty — the arrow greys, the button does not fade',
  )
  // The rule before it is the send button's own `::before`, which is where the client draws it,
  // rather than an element of its own between two gaps.
  const marker = rule(SHELL, '.composer-send::before')
  assert.equal(marker.width, '1px', 'a hairline')
  assert.equal(marker.height, '18px', '18px tall')
  assert.equal(marker.background, 'var(--line-divider-default)', 'in the divider colour')
  assert.doesNotMatch(APP, /composer-divider/, 'and nothing in the markup draws a second one')
})

test('both composers are the same field', () => {
  // The thread is narrower than the room, not a different control: one box each, the same two
  // marks, the same arrow. Before this the panel had its own 36px row with its own "Send".
  assert.equal(count(APP, 'className="composer-box"'), 2, 'the room and the thread each draw the field')
  assert.equal(count(APP, 'className="composer-tools"'), 2, 'with a row of marks')
  assert.equal(count(APP, 'className="composer-send"'), 2, 'and one send each')
  const panel = rule(SHELL, '.thread-composer')
  assert.equal(panel['border-top'], '1px solid var(--line-divider-default)', 'the panel keeps its own top rule')
  assert.doesNotMatch(SHELL, /\.thread-composer-input/, 'and no longer a second editor style')
  assert.doesNotMatch(SHELL, /\.thread-send/, 'nor a second send')
})

test('every word the two new buttons carry is in both languages', () => {
  // The dialog and the marks name themselves out of the catalogue, so a language that ships the
  // window has to ship those keys. This is the one direction `catalogue.test.mjs` cannot check
  // for a string built here.
  const zh = catalogueFor('zh-CN').messages
  const en = catalogueFor('en').messages
  for (const key of ['ui.chat.attach', 'ui.chat.send', 'ui.chat.reply', 'ui.chat.mention-hint']) {
    assert.equal(typeof zh[key], 'string', `zh-CN answers ${key}`)
    assert.equal(typeof en[key], 'string', `en answers ${key}`)
    assert.notEqual(zh[key], en[key], `${key} is translated, not copied`)
  }
})
