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

/**
 * **Every file that draws a dialog, not just the one that had the defect.**
 *
 * This list was `App.jsx` alone, and the organization form inside it, until 2026-10-27. That was
 * the surface where the unstyled input was found, and guarding only it would have been the
 * narrow version of the lesson: the bot form and the group form moved into the same card the
 * same day (宿主: 创建机器人、创建群组，都使用弹窗吧), so the classes now come from four files,
 * and a class with no rule in any of them draws as the browser's own element wherever the card
 * is opened from. `Dialog.jsx` is the card itself; the three other files are its callers.
 */
const DIALOG_SURFACES = [
  ['ui', 'src', 'Dialog.jsx'],
  ['ui', 'src', 'App.jsx'],
  ['ui', 'src', 'Contacts.jsx'],
  ['ui', 'src', 'Groups.jsx'],
]

/**
 * The organization form's markup: from the block that opens it to the `</Dialog>` that closes it.
 *
 * It was sliced to a `</form>` until 2026-10-27, when this form stopped drawing its own mask and
 * became the fourth caller of `Dialog.jsx` — the shared card every one of these four forms is
 * now, which is the thing the host asked for (创建机器人、创建群组，都使用弹窗吧).
 */
function dialogMarkup() {
  const from = APP.indexOf('{orgForm && (')
  assert.notEqual(from, -1, 'the dialog is gone from App.jsx, so this file checks nothing')
  const cardEnd = APP.indexOf('</Dialog>', from)
  assert.notEqual(cardEnd, -1, 'the organization form is not drawn by the shared card, so this file reads the wrong block')
  return APP.slice(from, cardEnd)
}

/** Every class a file says, as a literal `className="…"`. */
function saidClasses(source) {
  const used = new Set()
  for (const [, list] of source.matchAll(/className="([^"]+)"/g)) {
    for (const name of list.split(/\s+/)) if (name !== '') used.add(name)
  }
  return used
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

test('every class the four dialog files draw is a class the stylesheet knows', () => {
  const known = selectors(SHELL)
  const wrong = {}
  for (const parts of DIALOG_SURFACES) {
    const used = saidClasses(read(...parts))
    // Anti-vacuity, per file: the scan really read a dialog's own parts, so an empty result
    // below is the sheet's answer and not a file this check failed to open.
    assert.ok(
      used.has('dialog-input') || used.has('dialog-mask'),
      `${parts.join('/')} says no dialog class at all (${[...used].slice(0, 6).join(', ')}), so the scan read the wrong file`,
    )
    const unstyled = [...used].filter((name) => !known.has(name))
    if (unstyled.length > 0) wrong[parts.join('/')] = unstyled
  }
  assert.deepEqual(
    wrong,
    {},
    'these classes are in a dialog’s markup with no rule at all, so they draw as the browser’s own elements',
  )
})

test('every dialog has its refusal, its note, and its hint drawn by the sheet', () => {
  // The three refusals read the same inside the card: the bot's, the group's and the room's all
  // use `.dialog-err`. The room's used `.composer-err` until it moved into the dialog, where the
  // composer's margins (`0 8px 10px`, shaped for the strip under a message list) put it 8px in
  // from a card that pads 24 — a form's refusal at the composer's margin, in a form.
  for (const parts of [['ui', 'src', 'App.jsx'], ['ui', 'src', 'Contacts.jsx'], ['ui', 'src', 'Groups.jsx']]) {
    const source = read(...parts)
    assert.match(source, /className="dialog-err"/, `${parts.at(-1)} draws its refusal in the card's own shape`)
    assert.doesNotMatch(
      source,
      /className="composer-err"[^>]*data-(new-room|new-group|new-bot)="refused"/,
      `${parts.at(-1)} answers a dialog form with a composer refusal`,
    )
  }

  const err = rule(SHELL, '.dialog-err')
  assert.equal(err.color, 'var(--R600)', 'a refusal is the window’s error colour')
  assert.equal(err['font-size'], '12px', 'at the caption size, like every other sentence in the card')
})

/**
 * The body of the `onChange` that belongs to one field, found from the attribute the window
 * reads that field by. Braces are counted rather than matched by pattern, because these
 * handlers are arrow functions with a block body.
 */
function handlerFor(source, marker) {
  const at = source.indexOf(marker)
  assert.notEqual(at, -1, `${marker} is gone, so this check reads nothing`)
  const from = source.indexOf('onChange={', at) + 'onChange={'.length
  assert.ok(from > 'onChange={'.length, `${marker} has no onChange, so the form cannot be fixed`)
  let depth = 1
  let i = from
  while (i < source.length && depth > 0) {
    if (source[i] === '{') depth += 1
    if (source[i] === '}') depth -= 1
    i += 1
  }
  return source.slice(from, i - 1)
}

test('a refusal goes when the person fixes the field it named', () => {
  // Measured in the window on 2026-10-27: `a group needs a name` was still standing under a
  // field that now said `Reading circle`, and the same was true of the bot's and the room's.
  // A refusal is a sentence about what is on screen; the keystroke that makes it untrue is
  // where it stops being true, not the next press of Create.
  const cases = [
    { parts: ['ui', 'src', 'App.jsx'], marker: 'data-new-room="name"', clears: 'forgetNewRoom()', sets: 'setNewName(' },
    { parts: ['ui', 'src', 'Groups.jsx'], marker: 'data-new-group="name"', clears: 'forget()', sets: 'setName(' },
    { parts: ['ui', 'src', 'Contacts.jsx'], marker: 'data-new-bot="name"', clears: 'setStopped(null)', sets: 'setName(' },
  ]
  for (const one of cases) {
    const source = read(...one.parts)
    const body = handlerFor(source, one.marker)
    assert.ok(body.includes(one.sets), `${one.parts.at(-1)}’s handler still sets the field (read: ${body.trim().slice(0, 60)})`)
    assert.ok(
      body.includes(one.clears),
      `${one.parts.at(-1)} keeps its refusal while the field it named is being fixed`,
    )
  }

  // The group form's clearer is one function, so the checkbox rows take the same path.
  const groups = read('ui', 'src', 'Groups.jsx')
  const forget = groups.slice(groups.indexOf('function forget()'))
  assert.match(forget.slice(0, 120), /setStopped\(null\)/, 'forget() is the one place that clears it')
  const toggle = groups.slice(groups.indexOf('function toggle('))
  assert.match(toggle.slice(0, 120), /forget\(\)/, 'a member tick clears the count refusal too')
  assert.match(
    groups,
    /data-new-group-member[\s\S]{0,200}onChange=\{\(\) => toggle\(/,
    'and the checkbox rows are what reach it',
  )

  // **And the room's is narrow.** `error` on the chat screen is every refusal that screen
  // shows; typing a room's name must not wipe the composer's.
  const app = read('ui', 'src', 'App.jsx')
  const clearer = app.slice(app.indexOf('function forgetNewRoom()'))
  assert.match(clearer.slice(0, 200), /was\?\.where === 'new-room'/, 'the room form clears only its own refusal')
  assert.doesNotMatch(clearer.slice(0, 200), /setError\(null\)/, 'a blanket clear would take the composer’s sentence with it')
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
  assert.ok(markup.includes('<Dialog'), 'the organization form is the shared card, not a mask of its own')
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

test('a card says the words of the row that opened it', () => {
  // Four cards, four rows in the rail's add menu, and the same words on both — because the row
  // is where the person pressed. Three of them disagreed until 2026-10-27: the group's card
  // said `New group` where the row said `Create a group`, and the bot's said `Add a bot` where
  // the row said `Create a bot`.
  const wants = [
    { parts: ['ui', 'src', 'App.jsx'], marker: '{orgForm && (', key: 'ui.rail.add-organization' },
    { parts: ['ui', 'src', 'App.jsx'], marker: 'name="room"', key: 'ui.rail.add-room' },
    { parts: ['ui', 'src', 'Contacts.jsx'], marker: 'name="bot"', key: 'ui.rail.add-bot' },
    { parts: ['ui', 'src', 'Groups.jsx'], marker: 'name="group"', key: 'ui.rail.add-group' },
  ]
  for (const one of wants) {
    const source = read(...one.parts)
    const at = source.indexOf(one.marker)
    assert.notEqual(at, -1, `${one.marker} is gone from ${one.parts.at(-1)}, so this check reads nothing`)
    const near = source.slice(at, at + 400)
    assert.ok(
      near.includes(`title={t('${one.key}')}`),
      `the card at ${one.marker} does not take its title from ${one.key}`,
    )
  }

  // And the row a card is named after is a row the add menu really offers: a title taken from a
  // key nobody draws would be a card that opens from nowhere.
  const rail = read('ui', 'src', 'rail.mjs')
  for (const one of wants) {
    assert.ok(rail.includes(one.key), `the add menu has no row labelled ${one.key}`)
  }
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
