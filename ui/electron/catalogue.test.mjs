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

/**
 * A sample value for every placeholder the shipped catalogues name.
 *
 * Read off the template rather than listed per key: a key that starts naming a placeholder the
 * test has no sample for fails here, rather than being skipped because this table never heard
 * of it — a value the test forgot is a key the test stopped comparing.
 */
const SAMPLES = {
  path: '/tmp/seek-i18n/store.json',
  name: 'Design',
  model: 'a-model',
  tail: '0f3c',
  length: 33,
  words: 'the endpoint said no',
  // The search box's own two: what was typed into it, and the rule a bot is shown under.
  query: 'Design',
  law: 'a bot belongs to its organization',
  // The topic list's: the room a thread started in.
  room: 'Design',
}

function paramsFor(template) {
  const params = {}
  for (const [, name] of template.matchAll(/\{(\w+)\}/g)) {
    // `count` is not a sample: a plural entry is drawn for every count in `COUNTS` below, so
    // this walk supplies the other placeholders and the loop supplies that one.
    if (name === 'count') continue
    assert.ok(name in SAMPLES, `this test has no sample value for {${name}}`)
    params[name] = SAMPLES[name]
  }
  return params
}

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
      const message = catalogue.messages[key]
      const plural = typeof message === 'object'
      if (!plural) {
        const params = paramsFor(message)
        assert.equal(t(key, params), theirs(key, params), `${tag} ${key}`)
        continue
      }
      const params = paramsFor(message.other)
      for (const count of COUNTS) {
        assert.equal(
          t(key, { ...params, count }),
          theirs(key, { ...params, count }),
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

test('the settings page says nothing a catalogue did not say', () => {
  const source = readFileSync(join(RENDERER, 'Settings.jsx'), 'utf8')

  // The gap this closed: sixty strings, every one of them written in that page. The scan is the
  // mechanical form of `docs/design/i18n.md` §1 — a text node between `>` and `<` is drawn as it
  // stands, so a word in one is a word no language but English can change.
  const prose = [...source.matchAll(/>([^<>{}]*)</g)]
    .map((match) => match[1].trim())
    .filter((text) => /[A-Za-z]{2}/.test(text))
  assert.deepEqual(prose, [], 'a text node carries words of its own instead of a key')

  // The same claim for the attributes a person reads: a field hint is chrome too.
  const attributes = [...source.matchAll(/\b(?:placeholder|title|aria-label)="([^"]*)"/g)]
    .map((match) => match[1])
    .filter((text) => /[A-Za-z]{2}/.test(text))
  assert.deepEqual(attributes, [], 'an attribute carries words of its own instead of a key')

  // Anti-vacuity: two empty lists above are exactly what a broken scan also produces.
  const keys = [...source.matchAll(/\bt\(\s*'(ui\.settings\.[a-zA-Z.-]+)'/g)].map(
    (match) => match[1],
  )
  assert.ok(keys.length >= 55, `the scan found ${keys.length} lookups — the pattern is broken`)
  assert.ok(new Set(keys).size >= 55, 'the page looks its words up rather than repeating a few')

  // And the shapes that were there. A return here is the whole page speaking English again.
  for (const [shape, what] of [
    [/<h2>Settings<\/h2>/, 'the page title written into the markup'],
    [/placeholder="a name/, 'the organization field hint written into the markup'],
    [/\$\{answer\.models\.length\} models/, 'a count joined to the word `models`'],
    [/'saved — this half uses it/, 'the sentence after a save written into the handler'],
    [/count === 1 \?/, 'the `count === 1 ?` comparison'],
  ]) {
    assert.doesNotMatch(source, shape, `${what}: it is the catalogue's to say`)
  }

  // A count on this page too, in the language where the shortcut cannot be the rule: Chinese
  // carries one category, so the numeral changes and the sentence does not.
  bindCatalogue(catalogueFor('zh-CN'))
  assert.equal(
    t('ui.settings.models.none-listed', { count: 1 }).replace('1', 'N'),
    t('ui.settings.models.none-listed', { count: 7 }).replace('7', 'N'),
    'one Chinese sentence, whatever the count',
  )
  bindCatalogue(catalogueFor('en'))
  assert.notEqual(
    t('ui.settings.models.none-listed', { count: 1 }),
    t('ui.settings.models.none-listed', { count: 2 }),
    'English changes form at two, and that change is the catalogue saying so',
  )
})

test('the contacts view says nothing a catalogue did not say', () => {
  const source = readFileSync(join(RENDERER, 'Contacts.jsx'), 'utf8')

  // The same scan the settings page is held to, for the same reason: a text node between `>`
  // and `<` is drawn as it stands, so a word in one is a word no language but English can
  // change (`docs/design/i18n.md` §1).
  const prose = [...source.matchAll(/>([^<>{}]*)</g)]
    .map((match) => match[1].trim())
    .filter((text) => /[A-Za-z]{2}/.test(text))
  assert.deepEqual(prose, [], 'a text node carries words of its own instead of a key')

  // And the attributes a person reads: a list row's title and a field's hint are chrome too.
  const attributes = [...source.matchAll(/\b(?:placeholder|title|aria-label)="([^"]*)"/g)]
    .map((match) => match[1])
    .filter((text) => /[A-Za-z]{2}/.test(text))
  assert.deepEqual(attributes, [], 'an attribute carries words of its own instead of a key')

  // Anti-vacuity: two empty lists above are exactly what a broken scan produces.
  const keys = [...source.matchAll(/\bt\(\s*'(ui\.contacts\.[a-zA-Z.-]+)'/g)].map(
    (match) => match[1],
  )
  assert.ok(keys.length >= 25, `the scan found ${keys.length} lookups — the pattern is broken`)
  assert.ok(new Set(keys).size >= 20, 'the view looks its words up rather than repeating a few')

  // And the shapes that were here. The gender values are the one thing that stays a literal,
  // because they are what the store writes (`Bot.gender`), not what the window says.
  for (const [shape, what] of [
    [/<h1>Bots<\/h1>/, 'the list heading written into the markup'],
    [/placeholder="search/i, 'the search hint written into the markup'],
    [/>\s*not said\s*</, 'the empty field word written into the markup'],
    [/'请输入姓名'/, 'the empty name refusal written into the code'],
    [/pick a bot/, 'the empty pane written into the markup'],
  ]) {
    assert.doesNotMatch(source, shape, `${what}: it is the catalogue's to say`)
  }

  // The view the components route to is the prototype's `contacts`, and the rail no longer
  // offers a `bots` view beside it — one list of people, not two.
  const app = readFileSync(join(RENDERER, 'App.jsx'), 'utf8')
  assert.match(app, /view === 'contacts'/, 'the main screen routes to the contacts view')
  assert.doesNotMatch(app, /data-view="bots"/, 'the bots view is gone, not renamed in place')
  assert.doesNotMatch(app, /<BotsView/, 'no component draws the deleted view')
})

test('the groups view says nothing a catalogue did not say', () => {
  const source = readFileSync(join(RENDERER, 'Groups.jsx'), 'utf8')

  // The same two scans the contacts view is held to: text nodes and the attributes a person
  // reads are chrome, so a word in either is a word no other language can change.
  const prose = [...source.matchAll(/>([^<>{}]*)</g)]
    .map((match) => match[1].trim())
    .filter((text) => /[A-Za-z]{2}/.test(text))
  assert.deepEqual(prose, [], 'a text node carries words of its own instead of a key')

  const attributes = [...source.matchAll(/\b(?:placeholder|title|aria-label)="([^"]*)"/g)]
    .map((match) => match[1])
    .filter((text) => /[A-Za-z]{2}/.test(text))
  assert.deepEqual(attributes, [], 'an attribute carries words of its own instead of a key')

  // Anti-vacuity: two empty lists above are exactly what a broken scan produces.
  const keys = [...source.matchAll(/\bt\(\s*'(ui\.groups\.[a-zA-Z.-]+)'/g)].map(
    (match) => match[1],
  )
  assert.ok(keys.length >= 18, `the scan found ${keys.length} lookups — the pattern is broken`)
  assert.ok(new Set(keys).size >= 15, 'the view looks its words up rather than repeating a few')

  // What makes a room a group here is the headcount, because that is the kernel's own
  // definition of a direct message (`deriveHints()`: `membershipsOf(room).length === 2`).
  // `chat_mode` is stored and never branched on, so a view that filtered rows by it would be
  // the prototype's rule running against a store that does not keep what it filters on.
  assert.match(source, /\.length !== 2/, 'a group is decided by the headcount, as the kernel does')
  assert.doesNotMatch(
    source,
    /chat_mode\s*[=!]==/,
    'a mode comparison is the prototype rule this store cannot support',
  )

  for (const [shape, what] of [
    [/<h1>Groups<\/h1>/, 'the list heading written into the markup'],
    [/placeholder="search/i, 'the search hint written into the markup'],
    [/'请输入群名称'/, 'the empty name refusal written into the code'],
    [/还没有群聊/, 'the empty list written into the markup'],
  ]) {
    assert.doesNotMatch(source, shape, `${what}: it is the catalogue's to say`)
  }

  // And the way in: the rail offers it, and the main screen draws it.
  const app = readFileSync(join(RENDERER, 'App.jsx'), 'utf8')
  assert.match(app, /view === 'groups'/, 'the main screen routes to the groups view')
  assert.match(app, /data-view="groups"/, 'the rail offers the way in')
})

test('the topics view says nothing a catalogue did not say', () => {
  const source = readFileSync(join(RENDERER, 'Topics.jsx'), 'utf8')

  // The same two scans the other views are held to: a text node and a readable attribute are
  // both chrome, so a word in either is a word no other language can change.
  const prose = [...source.matchAll(/>([^<>{}]*)</g)]
    .map((match) => match[1].trim())
    .filter((text) => /[A-Za-z]{2}/.test(text))
  assert.deepEqual(prose, [], 'a text node carries words of its own instead of a key')

  const attributes = [...source.matchAll(/\b(?:placeholder|title|aria-label)="([^"]*)"/g)]
    .map((match) => match[1])
    .filter((text) => /[A-Za-z]{2}/.test(text))
  assert.deepEqual(attributes, [], 'an attribute carries words of its own instead of a key')

  // Anti-vacuity: two empty lists above are exactly what a broken scan produces.
  const keys = [...source.matchAll(/\bt\(\s*'(ui\.topics\.[a-zA-Z.-]+)'/g)].map(
    (match) => match[1],
  )
  assert.ok(keys.length >= 14, `the scan found ${keys.length} lookups — the pattern is broken`)
  assert.ok(new Set(keys).size >= 14, 'the view looks its words up rather than repeating a few')

  // And every key it names is one of those lookups. A key written inside an expression —
  // `t(one ? 'ui.x.a' : 'ui.x.b')` — is a key the scan above cannot see, and therefore one
  // the two language-wide tests never check; the equality is what closes that hole.
  const named = [...source.matchAll(/'(ui\.topics\.[a-zA-Z.-]+)'/g)].map((match) => match[1])
  assert.deepEqual(
    [...new Set(named)].sort(),
    [...new Set(keys)].sort(),
    'a key is written where the scan cannot read it, so nothing checks that it is shipped',
  )

  // What makes a message a topic is the kernel's own three facts. `chain` is the root of the
  // run and a message that caused nothing roots its own chain (`src/delivery.ts`), so the
  // view groups by `chain` — the same field the thread panel groups by — and never by a
  // counter, a `root_id` chain of one hop, or a room's `chat_mode`.
  assert.match(source, /\.chain !== m?\w*\.id|chain !== message\.id/, 'a root is its own chain')
  assert.doesNotMatch(
    source,
    /chat_mode\s*[=!]==/,
    'a room\'s mode is not what makes a topic: chat_mode is stored and never branched on',
  )

  for (const [shape, what] of [
    [/<h1>Topics<\/h1>/, 'the list heading written into the markup'],
    [/placeholder="search/i, 'a search box the prototype does not have'],
    [/'还没有话题'/, 'the empty list written into the code'],
    [/pick one/i, 'the empty pane written into the markup'],
  ]) {
    assert.doesNotMatch(source, shape, `${what}: it is the catalogue's to say`)
  }

  // And the way in: the rail offers it, and the main screen draws it.
  const app = readFileSync(join(RENDERER, 'App.jsx'), 'utf8')
  assert.match(app, /view === 'topics'/, 'the main screen routes to the topics view')
  assert.match(app, /data-view="topics"/, 'the rail offers the way in')
  assert.match(app, /function openTopic/, 'the way into a thread is the chat screen\'s')
})

test('every word the window draws is translated, not copied', () => {
  // The reading an English run cannot give. A Chinese page still carrying English chrome looks
  // finished when the language is English — nothing in it is out of place — which is the same
  // shape as the `count === 1` shortcut that only bites under a language with three plural
  // categories. So the claim is made where it is cheap: one key, two languages, and the two
  // must not say the same thing.
  //
  // The exception is not a hole. It names the same thing in both languages because it is a
  // shape rather than a sentence, and a translated one would be worse than the original.
  const SAME_IN_BOTH = new Set(['ui.settings.models.address-hint'])

  const en = catalogueFor('en').messages
  const zh = catalogueFor('zh-CN').messages
  const keys = asked().filter((key) => !SAME_IN_BOTH.has(key))

  assert.ok(keys.length > 0, 'no key was compared, so this proves nothing')
  for (const key of keys) {
    assert.notDeepEqual(
      en[key],
      zh[key],
      `${key} says the same thing in both languages: that is a translation nobody wrote, ` +
        'and it reads as finished from the base language',
    )
  }
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
