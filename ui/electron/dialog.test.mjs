/**
 * The small form over the window: **every class in its markup has a rule, and the field has the
 * numbers the bot form gave it.**
 *
 * **What this file exists for, in one line of history.** On 2026-10-27 the host said the dialog
 * that makes an organization was ugly (创建组织的弹窗太难看了). It was, and not because of taste:
 * the card was drawn by hand and the input inside it carried `className="dialog-input"`, a class
 * the stylesheet had never heard of. So it rendered as the browser's own `<input>` — measured at
 * **153×21, a 2px `#767676` border, 13.33px text** inside a 360px card, with the placeholder cut
 * off mid-sentence. That is the same defect as issue #137 one surface over (markup marked with
 * classes the sheet has no rules for), and I introduced it myself in the commit that added this
 * form, hours after filing #137 about the same thing elsewhere.
 *
 * So the first test below is not about this dialog's looks: it is the check that would have
 * caught the defect when it was written, run over the one surface that has already failed it.
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

/** The dialog's own markup: from the block that opens it to the `</form>` that closes it. */
function dialogMarkup() {
  const from = APP.indexOf('{orgForm && (')
  assert.notEqual(from, -1, 'the dialog is gone from App.jsx, so this file checks nothing')
  const formEnd = APP.indexOf('</form>', APP.indexOf('data-org-save', from))
  assert.notEqual(formEnd, -1, 'the dialog has no </form>, so this file is reading the wrong block')
  return APP.slice(from, formEnd)
}

/** Every class name that appears as a selector anywhere in the sheet, media queries included. */
function selectors(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const names = new Set()
  for (const [, header] of clean.matchAll(/([^{}]+)\{/g)) {
    for (const [, name] of header.matchAll(/\.([A-Za-z0-9_-]+)/g)) names.add(name)
  }
  return names
}

/**
 * One rule's declarations, by exact selector.
 *
 * Split on `;` rather than on newlines: this sheet writes a short rule on one line
 * (`.dialog-hint { margin: …; color: …; font-size: 12px; }`), and a line-based reader takes only
 * the first declaration of such a rule and reports the rest as absent — which is how this file
 * first failed, on a rule that was right there.
 */
function rule(css, selector) {
  const opener = `${selector} {`
  const from = css.indexOf(opener)
  assert.notEqual(from, -1, `${opener} is gone, so this check reads nothing`)
  const to = css.indexOf('}', from)
  assert.notEqual(to, -1, `${opener} is never closed, so this check reads past it`)
  const declarations = {}
  for (const piece of css.slice(from + opener.length, to).replace(/\/\*[\s\S]*?\*\//g, '').split(';')) {
    const at = piece.indexOf(':')
    if (at === -1) continue
    declarations[piece.slice(0, at).trim()] = piece.slice(at + 1).trim()
  }
  return declarations
}

test('every class the dialog draws is a class the stylesheet knows', () => {
  const markup = dialogMarkup()
  const used = new Set()
  for (const [, list] of markup.matchAll(/className="([^"]+)"/g)) {
    for (const name of list.split(/\s+/)) if (name !== '') used.add(name)
  }
  // Anti-vacuity: the block was found and it does carry the form's own parts.
  assert.ok(used.has('dialog-input') && used.has('dialog-actions'), `the scan found ${[...used].join(', ')}`)

  const known = selectors(SHELL)
  const unstyled = [...used].filter((name) => !known.has(name))
  assert.deepEqual(
    unstyled,
    [],
    'these classes are in the dialog’s markup with no rule at all, so they draw as the browser’s own elements',
  )
})

test('the field is 36px of the window’s own input, not a browser default', () => {
  const input = rule(SHELL, '.dialog-input')
  assert.equal(input.width, '100%', 'the field takes the card’s width — 153px is what it measured unstyled')
  assert.equal(input.height, '36px', 'and the height the bot form’s fields are near')
  assert.equal(input['border-radius'], 'var(--radius-md)', 'rounded like every other field in the window')
  assert.equal(input['font-size'], '14px', 'at the window’s body size, not the browser’s 13.33px')
  assert.equal(input.padding, '0 12px', 'with room for the text to start inside it')

  // The label above it is a real label, bound to the field it names: the bot form's pairing.
  const markup = dialogMarkup()
  assert.match(markup, /<label className="field-label" htmlFor="organization-name">/, 'the field is labelled')
  assert.match(markup, /id="organization-name"/, 'and the label points at something')
})

test('the hint under the field is the caption, and it says what a name is for', () => {
  const hint = rule(SHELL, '.dialog-hint')
  assert.equal(hint['font-size'], '12px', 'one step down from the field')
  assert.equal(hint.color, 'var(--N500)', 'in the caption colour rather than the body’s')

  // The sentence is the one the host ruled on: a name labels this list and never becomes the
  // name of the person inside the world. It is the catalogue's, in both languages, and translated.
  const en = catalogueFor('en').messages
  const zh = catalogueFor('zh-CN').messages
  for (const key of ['ui.rail.organization-name', 'ui.rail.organization-name-hint', 'ui.settings.organizations.name-hint']) {
    assert.equal(typeof en[key], 'string', `the English catalogue answers ${key}`)
    assert.equal(typeof zh[key], 'string', `and so does the Chinese one`)
    assert.notEqual(en[key], zh[key], `${key} is translated, not copied`)
  }
  assert.match(APP, /className="dialog-hint"/, 'the page draws the hint')
})

test('the card is a card: padded, rounded, lifted, and never flush against the window', () => {
  const mask = rule(SHELL, '.dialog-mask')
  assert.equal(mask.padding, '24px', 'the card cannot touch the window’s edge on a narrow window')

  const card = rule(SHELL, '.dialog')
  assert.equal(card.width, '400px', 'wide enough for the hint to sit on one line')
  assert.equal(card.padding, '24px', 'and padded like the settings cards')
  assert.equal(card['border-radius'], 'var(--radius-lg)', 'the window’s large radius, not a square corner')
  assert.ok(card['box-shadow'].includes('var(--shadow-popup)'), 'lifted off the mask it covers')

  const actions = rule(SHELL, '.dialog-actions')
  assert.equal(actions['justify-content'], 'flex-end', 'the two answers sit at the right, where a form ends')
  assert.equal(actions.gap, '8px', 'and 8px apart')
})
