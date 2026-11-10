/**
 * The window's language: which one it speaks, and what choosing another one does.
 *
 * **The spec, and what was missing.** `docs/design/i18n.md` §2 gives the interface's language the
 * two properties a setting has — it belongs to the application, and changing it "takes effect
 * immediately" — and separates it in the same table from what people and agents typed, which is
 * "never rewritten, never auto-translated". The kernel has read its catalogue from
 * `src/i18n/<tag>.json` by key since the milestone and `catalogueFor()` answers any shipped tag;
 * the window bound one before its first frame. It bound `DEFAULT_LOCALE` every time, because
 * nothing ever asked a person which one they read — `main.js`'s own comment said "this handler is
 * where that choice will land", and until 2026-11-09 nothing landed there. So this file holds the
 * three things that choice needs now that it has a home: the rule, the switch, and the fact that
 * the two catalogues carry its words.
 *
 * **The rule is a function with no I/O, and that is why it is a function.** `languageOf()` is
 * handed the saved value, the shipped list and the fallback; the settings file and the directory
 * are the caller's to read. A rule that read the file itself would need a settings file, a window
 * and a catalogue to test, and a rule that needs three fakes is one nobody writes a test for —
 * which is exactly the shape that let the setting go unimplemented while every suite was green.
 *
 * **The switch is measured by calling it.** `ui/src/language.mjs` touches `window.seekHost` and
 * `document`, and this suite has neither; both are stood up as one-line stubs below, because the
 * claim being made is about *order* — the tag is saved, then the catalogue is fetched, then it is
 * bound, then `<html lang>` says so — and order is the thing a source reading cannot read.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { catalogueFor, locales } from '../../src/i18n.ts'
import { languageOf, refusalToSave } from './language.js'

const HERE = import.meta.dirname
const ROOT = join(HERE, '..', '..')
const read = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8')

/** Every word the third section of the settings page draws. */
const KEYS = [
  'ui.settings.language.title',
  'ui.settings.language.description',
  'ui.settings.language.label',
  'ui.settings.language.note',
  'ui.settings.language.not-saved',
]

/**
 * A host that saves the tag it is given and answers the catalogue for whatever it saved, plus
 * the `document` the switch writes onto. Nothing else — a stub larger than the code it stands in
 * for is a test that measures its own fake.
 */
function wire({ keeps = true } = {}) {
  const asked = []
  let saved = 'en'
  globalThis.window = {
    seekHost: {
      saveLanguage: async (tag) => {
        asked.push(`save:${tag}`)
        if (!keeps || !locales().includes(tag)) return { ok: false, error: 'not kept' }
        saved = tag
        return { ok: true, locale: tag }
      },
      catalogue: async () => {
        asked.push('catalogue')
        return catalogueFor(saved)
      },
    },
  }
  globalThis.document = {
    documentElement: {
      lang: null,
      setAttribute(name, value) {
        if (name === 'lang') this.lang = value
      },
    },
  }
  return { asked }
}

test('a saved language this tree ships is the one spoken', () => {
  assert.equal(languageOf('zh-CN', ['en', 'zh-CN'], 'en'), 'zh-CN', 'exactly the one that was saved')
  assert.equal(languageOf('en', ['en', 'zh-CN'], 'en'), 'en', 'and the fallback is not preferred over it')
})

test('anything else in that key answers the fallback rather than being drawn', () => {
  // A settings file is a person's to edit with a text editor, and this is read during start-up
  // before a window exists. So every shape it could hold is answered, and none of them throws.
  for (const saved of ['de', '', '  ', 'en-GB', 'EN', undefined, null, 0, 3, true, {}, ['en'], { tag: 'en' }]) {
    assert.equal(
      languageOf(saved, ['en', 'zh-CN'], 'en'),
      'en',
      `${JSON.stringify(saved)} is not a language this tree ships, so the window opens in the fallback`,
    )
  }
})

test('a language this tree does not ship is refused in a sentence that names the ones it does', () => {
  assert.equal(refusalToSave('zh-CN', ['en', 'zh-CN']), null, 'a shipped tag goes through')

  const said = refusalToSave('de', ['en', 'zh-CN'])
  assert.match(said, /de/, 'the refusal names what was asked for')
  assert.match(said, /en, zh-CN/, 'and what this build does ship, which is what a reader needs to fix it')

  // The same answer for every shape that is not a shipped tag, because the caller writes this to
  // stderr and a hand-edited file is exactly how a wrong one arrives.
  for (const tag of [undefined, null, 3, {}]) {
    assert.match(refusalToSave(tag, ['en', 'zh-CN']), /not a language this window has/)
  }
})

test('choosing a language saves it, rebinds the words, and says which one the page is in', async () => {
  const { asked } = wire()
  const { switchLanguage } = await import('../src/language.mjs')
  const { bindCatalogue, t } = await import('../src/catalogue.mjs')

  bindCatalogue(catalogueFor('en'))
  assert.equal(t('ui.settings.language.label'), 'Interface language', 'the window starts in English')

  const answer = await switchLanguage('zh-CN')
  assert.deepEqual(answer, { ok: true, locale: 'zh-CN' })

  // The order is the claim: the save, then the words, and nothing before either of them. A
  // catalogue fetched before the save is the old language's, which is a window that repaints in
  // the language it was already in and calls it done.
  assert.deepEqual(asked, ['save:zh-CN', 'catalogue'], 'the tag is saved before the words are read')
  assert.equal(t('ui.settings.language.label'), '界面语言', 'and the window now draws the other language')
  assert.equal(
    globalThis.document.documentElement.lang,
    'zh-CN',
    'and the page says which language it is in, which is what a screen reader reads the text as',
  )
})

test('a save that did not go through changes nothing, and fetches nothing', async () => {
  const { asked } = wire({ keeps: false })
  const { switchLanguage } = await import('../src/language.mjs')
  const { bindCatalogue, t } = await import('../src/catalogue.mjs')

  bindCatalogue(catalogueFor('en'))
  const answer = await switchLanguage('de')

  assert.equal(answer.ok, false, 'the refusal is handed back rather than swallowed')
  assert.deepEqual(asked, ['save:de'], 'no catalogue is fetched when the save was refused')
  assert.equal(t('ui.settings.language.label'), 'Interface language', 'so the window still reads what it was reading')
  assert.equal(globalThis.document.documentElement.lang, null, 'and the page says nothing new either')
})

test('a language is named in the language being read, and falls back to its tag', async () => {
  const { languageName } = await import('../src/language.mjs')

  assert.match(languageName('zh-CN', 'en'), /Chinese/, 'English names the Chinese catalogue in English')
  assert.match(languageName('zh-CN', 'zh-CN'), /中文/, 'and Chinese names it in Chinese')
  assert.match(languageName('en', 'zh-CN'), /英语|英文/, 'the pair is symmetric, not one-way')
  // An identifier is readable in either language, and §7 keeps ids as they are — so a tag the
  // formatter has nothing for is still a name a person can pick.
  assert.equal(languageName('qqq', 'en'), 'qqq', 'a tag nobody has a name for is drawn as itself')
})

test('both catalogues carry the section\u2019s words, translated rather than copied', () => {
  for (const tag of locales()) {
    const messages = catalogueFor(tag).messages
    for (const key of KEYS) {
      assert.equal(typeof messages[key], 'string', `${tag} ships ${key}`)
      assert.notEqual(messages[key].length, 0, `${tag} ${key} is not an empty string`)
    }
  }

  const en = catalogueFor('en').messages
  const zh = catalogueFor('zh-CN').messages
  for (const key of KEYS) {
    assert.notEqual(en[key], zh[key], `${key} says the same thing in both languages: nobody wrote that translation`)
  }
  // The one sentence that is the rule rather than a label: a reader has to be told that the
  // switch moves the chrome and only the chrome (`docs/design/i18n.md` §2).
  assert.match(zh['ui.settings.language.description'], /只有界面|只有.{0,4}界面/, 'Chinese says what moves')
  assert.match(en['ui.settings.language.description'], /chrome/i, 'and English says what moves')
})

test('the settings page draws the switch from the languages the build ships', () => {
  const page = read('ui', 'src', 'Settings.jsx')

  // The list is the host's, not the page's. A `<select>` with an option written here is a build
  // that offers a language `src/i18n/` may not carry — the one thing `locales()` exists to answer.
  assert.match(page, /window\.seekHost[\s\S]{0,40}?\.language\?\.\(\)/, 'the page asks which languages ship')
  assert.match(page, /shipped\.map\(/, 'and draws whatever the answer was')
  assert.match(page, /<select/, 'the control is the list itself')
  assert.doesNotMatch(page, /'zh-CN'|"zh-CN"/, 'no language tag is written into the page')

  // And the words are the catalogue's — `catalogue.test.mjs` scans this file for literals, and
  // these are the keys it reads.
  for (const key of KEYS) {
    assert.ok(page.includes(`'${key}'`), `${key} is drawn by the page`)
  }
})

test('the window\u2019s words come from the language that was saved', () => {
  const main = read('ui', 'electron', 'main.js')
  const from = main.indexOf("ipcMain.handle('seek:catalogue'")
  assert.notEqual(from, -1, 'the catalogue handler is still there, or this reads nothing')
  const body = main.slice(from, main.indexOf('})', from))

  assert.match(body, /languageInUse\(\)/, 'the catalogue handler asks which language was saved')
  assert.match(body, /catalogueFor\(/, 'and answers a catalogue rather than a tag')
  assert.doesNotMatch(
    body,
    /catalogueFor\(DEFAULT_LOCALE\)/,
    'it answers the default unconditionally again — the setting would be written and never read',
  )

  // The rule it asks is the module tested above, not a second copy of it inside the handler.
  assert.match(main, /require\('\.\/language\.js'\)/, 'the handler uses the module rather than its own version')
  assert.match(main, /languageOf\(read\.settings\?\.language, locales\(\), DEFAULT_LOCALE\)/)
})
