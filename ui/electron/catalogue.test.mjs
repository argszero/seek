/**
 * The window's words, held to the kernel's.
 *
 * `src/i18n.ts` is the implementation the renderer's lookup copies, and it cannot be imported
 * into the page — that module reads its catalogue with `node:fs`. So the rules are written
 * twice, and this file is the reason the copy cannot drift in silence: the same key, the same
 * count, the same language, and the two must produce the same string.
 *
 * The second thing it holds is the other direction — a component may not ask for a key nobody
 * shipped. `documentation.test.mjs` makes the same shape of claim about the bridge, and for
 * the same reason: a table nobody reads is a claim nobody checks.
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { DEFAULT_LOCALE, catalogueFor, locales, translator } from '../../src/i18n.ts'
import { bindCatalogue, catalogueBound, t } from '../src/catalogue.mjs'

const HERE = import.meta.dirname
const RENDERER = join(HERE, '..', 'src')

/** The counts a count-bearing label is drawn for, including the ones the trap is about. */
const COUNTS = [0, 1, 2, 3, 5, 11, 21, 1000]

/** Every `ui.*` key the renderer asks for, read out of the components themselves. */
function asked() {
  const keys = new Set()
  for (const name of readdirSync(RENDERER)) {
    if (!name.endsWith('.jsx') && !name.endsWith('.mjs')) continue
    const source = readFileSync(join(RENDERER, name), 'utf8')
    for (const [, key] of source.matchAll(/\bt\(\s*'(ui\.[a-zA-Z.-]+)'/g)) keys.add(key)
  }
  return [...keys].sort()
}

test('the window asks for keys every language ships, and asks for more than none', () => {
  const keys = asked()

  // Anti-vacuity: an empty list would satisfy the loop below without reading a component.
  assert.ok(keys.length >= 4, `the scan found ${keys.length} keys — the pattern is broken`)

  for (const tag of locales()) {
    const shipped = catalogueFor(tag).messages
    for (const key of keys) {
      assert.ok(
        shipped[key] !== undefined,
        `${tag} ships no ${key}, and the window draws it — a language added by writing a file ` +
          'has to carry every key the components ask for',
      )
    }
  }
})

test('the window and the kernel put the same words around the same count', () => {
  const keys = asked()

  for (const tag of locales()) {
    const catalogue = catalogueFor(tag)
    const theirs = translator(catalogue)
    bindCatalogue(catalogue)

    for (const key of keys) {
      const plural = typeof catalogue.messages[key] === 'object'
      if (!plural) {
        assert.equal(t(key), theirs(key), `${tag} ${key}`)
        continue
      }
      for (const count of COUNTS) {
        assert.equal(
          t(key, { count }),
          theirs(key, { count }),
          `${tag} ${key} at ${count}: the renderer and the kernel disagree about the words`,
        )
      }
    }
  }
})

test('the category is the language’s, so a count of one is not the rule', () => {
  // The shipped pair cannot prove this on its own: English has `one`/`other` and Chinese only
  // `other`, and `count === 1 ? one : other` answers both of them correctly. A language with
  // three plural categories is where the shortcut and the locale disagree — Russian puts 21 in
  // `one`, 2 in `few` and 5 in `many` — so the shapes are handed in directly rather than added
  // to what ships.
  const shapes = {
    one: 'ONE {count}',
    few: 'FEW {count}',
    many: 'MANY {count}',
    other: 'OTHER {count}',
  }
  const catalogue = { locale: 'ru', messages: { 'ui.members': shapes } }
  bindCatalogue(catalogue)
  const theirs = translator(catalogue)

  for (const count of [1, 2, 5, 11, 21, 100, 1.5]) {
    assert.equal(
      t('ui.members', { count }),
      theirs('ui.members', { count }),
      `at ${count} the renderer and the kernel disagree about the category`,
    )
  }

  assert.match(t('ui.members', { count: 2 }), /^FEW/, 'two is few in Russian')
  assert.match(t('ui.members', { count: 5 }), /^MANY/, 'five is many')
  assert.match(t('ui.members', { count: 21 }), /^ONE/, 'twenty-one is one, and count === 1 says otherwise')
})

test('a count of one is singular only where the language has a singular', () => {  bindCatalogue(catalogueFor('en'))
  assert.equal(t('ui.members', { count: 1 }), '1 member')
  assert.equal(t('ui.members', { count: 2 }), '2 members')
  assert.equal(t('ui.reactions', { count: 1 }), '1 reaction')

  // Chinese carries one category, so the same count is the same template — which is the whole
  // reason the comparison `count === 1` cannot be the rule (`docs/design/i18n.md` §4).
  bindCatalogue(catalogueFor('zh-CN'))
  assert.equal(t('ui.members', { count: 1 }), t('ui.members', { count: 2 }).replace('2', '1'))
  assert.equal(t('ui.members', { count: 1 }), '1 位成员')
})

test('the count labels the window used to write itself are gone, and stay gone', () => {
  const app = readFileSync(join(RENDERER, 'App.jsx'), 'utf8')

  for (const [shape, what] of [
    [/count === 1 \?/, 'the `count === 1 ?` comparison'],
    [/replies === 1 \?/, 'the `replies === 1 ?` comparison'],
    [/\}\s*members\b/, 'the `{n} members` concatenation'],
  ]) {
    assert.doesNotMatch(
      app,
      shape,
      `${what} is back: a plural is the language's to pick, and the catalogue is where the ` +
        'language says which one (docs/design/i18n.md §4)',
    )
  }

  assert.match(app, /t\('ui\.members', \{ count:/, 'the member count is drawn by key')
  assert.match(app, /t\('ui\.replies', \{ count:/, 'the thread chip is drawn by key')
})

test('nothing is drawn before a catalogue is bound, and the refusal says why', async () => {
  // A fresh instance, because binding is module state and the tests above have bound one.
  const fresh = await import(`../src/catalogue.mjs?unbound=${Date.now()}`)

  assert.equal(fresh.catalogueBound(), false, 'a module that has not been bound is not bound')
  assert.throws(() => fresh.t('ui.members', { count: 1 }), /no catalogue is bound yet/)

  fresh.bindCatalogue(catalogueFor(DEFAULT_LOCALE))
  assert.equal(fresh.catalogueBound(), true, 'binding is what makes the words drawable')
  assert.equal(fresh.t('ui.members', { count: 1 }), '1 member')
})

test('the catalogue the window is handed is the one the kernel prints its report from', () => {
  const asked = catalogueFor(DEFAULT_LOCALE)

  assert.equal(asked.locale, DEFAULT_LOCALE, 'the window speaks the kernel default until told otherwise')
  assert.deepEqual(
    asked.messages,
    catalogueFor(DEFAULT_LOCALE).messages,
    'the same call twice is the same catalogue',
  )
  // The kernel's own report keys travel with it: one file, two surfaces.
  assert.ok(asked.messages['report.title'] !== undefined, 'the report keys are in the same catalogue')
})
