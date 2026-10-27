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

import { DEFAULT_LOCALE, catalogueFor, joinList as kernelJoinList, locales, translator } from '../../src/i18n.ts'
import {
  bindCatalogue,
  catalogueBound,
  joinList as rendererJoinList,
  size,
  t,
  weightsReason,
} from '../src/catalogue.mjs'

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
  // The chat page's strips name the origin a half came from — a shape rather than a sentence,
  // which is why it is a sample here and not a key.
  origin: 'http://127.0.0.1:8080',
  // The download line's three: two sizes already written in the language's form (`size()` in
  // `catalogue.mjs` is what writes them) and the file's own name, which stays an identifier.
  got: '0.2 GB',
  all: '2.2 GB',
  file: 'LFM2.5-VL-3B-Q4_0.gguf',
  // The weights refusal's. `repo` is the download a build with no host cannot make; `host` is
  // one host as a person names it (no scheme — that part they did not choose) and `hosts` is
  // the same several of them already joined by `joinList()`, because a list is this layer's shape
  // and the placeholder receives the phrase rather than the array.
  repo: 'LiquidAI/LFM2.5-VL-3B-GGUF',
  host: 'hf-mirror.com',
  hosts: 'hf-mirror.com — the request did not leave this machine and huggingface.co — 404',
  // And the reason a whole sentence is placed inside one: the frame around it says what to do
  // next, and what it wraps is either ours or a host's own words.
  why: 'the weights were not fetched',
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
    // The class carries `0-9` because a key may: `ui.chat.stage1-placeholder` is a lookup this
    // scan used to walk past in silence, so ten keys were shipped, drawn and compared by nothing.
    for (const [, key] of source.matchAll(/\bt\(\s*'(ui\.[a-zA-Z0-9.-]+)'/g)) keys.add(key)
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

test('a list is the language’s to join, and the two layers agree on every one', () => {
  // `docs/design/i18n.md` §4: the conjunction differs, so `"A, B and C"` is a formatting
  // decision rather than a string one. The kernel has had it since `joinList`; the window had
  // no equivalent, which is why the weights sentence joined its hosts with `; ` — a separator
  // that is nobody's language. Two implementations, one answer, per shipped language.
  const items = ['hf-mirror.com', 'huggingface.co', 'a third host']

  for (const tag of locales()) {
    bindCatalogue(catalogueFor(tag))
    assert.equal(
      rendererJoinList(items),
      kernelJoinList(tag, items),
      `${tag}: the renderer and the kernel join lists differently`,
    )
  }

  // Anti-vacuity, and it is the reading that matters: the claim above would also hold for two
  // copies of `items.join('; ')`. So the form itself is asserted — a conjunction, and not the
  // separator the sentence used to carry.
  bindCatalogue(catalogueFor('en'))
  assert.match(rendererJoinList(items), / and /, 'English joins its last two with a conjunction')
  assert.doesNotMatch(rendererJoinList(items), /;/, 'a semicolon is not a list formatter')

  bindCatalogue(catalogueFor('zh-CN'))
  const chinese = rendererJoinList(items)
  assert.notEqual(chinese, kernelJoinList('en', items), 'the list is not the English one in Chinese')
  assert.match(chinese, /、/, 'Chinese separates its items with an enumeration comma')
})

test('why the weights did not arrive is the window’s to write, in the language it runs in', () => {
  // The reading this closes: a first run with no host, or with two hosts that refused, drew a
  // sentence composed in `ui/electron/weights-fetch.js` — English in every language. The facts
  // travel now, and this is the whole sentence a person reads, frame and joining included.
  const twoHosts = {
    kind: 'hosts',
    hosts: [
      { host: 'hf-mirror.com', words: 'the request did not leave this machine (getaddrinfo ENOTFOUND)' },
      { host: 'huggingface.co', words: 'the server answered 404 for model.gguf' },
    ],
  }

  bindCatalogue(catalogueFor('en'))
  assert.equal(
    weightsReason(twoHosts),
    'from no host: hf-mirror.com — the request did not leave this machine (getaddrinfo ENOTFOUND) ' +
      'and huggingface.co — the server answered 404 for model.gguf',
    'the English sentence names both hosts, joined the way English joins a list',
  )

  const noHost = { kind: 'no-host', repo: 'LiquidAI/LFM2.5-VL-3B-GGUF' }
  assert.match(weightsReason(noHost), /SEEK_WEIGHTS_BASE/, 'and it names the setting that fixes it')
  assert.match(weightsReason(noHost), /LiquidAI\/LFM2\.5-VL-3B-GGUF/, 'and the download it is about')

  // One host is its own answer, and it is not ours: §2 forbids rewriting what a sender said, so
  // the sentence is drawn exactly as it arrived — in whatever language it arrived in.
  const oneHost = { kind: 'refused', words: 'the server answered 404 for model.gguf' }
  assert.equal(weightsReason(oneHost), 'the server answered 404 for model.gguf', 'a host is quoted, not framed')

  bindCatalogue(catalogueFor('zh-CN'))
  const chinese = weightsReason(twoHosts)
  assert.doesNotMatch(chinese, /^from no host/, 'the frame is not English')
  // Measured, not assumed: `Intl.ListFormat` joins two Chinese items with 和 and three with 、,
  // and English with ` and `. A slash separates neither, so the assertion is the conjunction.
  assert.ok(chinese.includes('和'), 'and the hosts are separated the way Chinese separates a list')
  assert.ok(!chinese.includes(' and '), 'and not by the English conjunction, which Chinese does not use')
  assert.ok(
    chinese.includes('the server answered 404 for model.gguf'),
    'the host’s own words come through unchanged — this change frames refusals, it does not translate them',
  )
  assert.ok(chinese.includes('hf-mirror.com'), 'and the host keeps its identifier')
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
  // The way in: the rail is data now (`ui/src/rail.mjs`), so the row is one entry in `RAIL`
  // and the column draws whatever that list declares. The pair is the assertion — the view is
  // named in the rail's own list, and `App.jsx` draws `item.view` rather than a row written
  // into the markup by hand, which is what this used to be.
  const rail = readFileSync(join(RENDERER, 'rail.mjs'), 'utf8')
  assert.match(rail, /\{ view: 'groups'/, 'the rail offers the way in')
  assert.match(app, /data-view=\{item\.view\}/, 'and the column draws the view the rail names')
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
  // And the way in, held the same way the groups view holds it: the row is one entry in the
  // rail's own list, and the column draws `item.view` rather than a literal in the markup.
  const rail = readFileSync(join(RENDERER, 'rail.mjs'), 'utf8')
  assert.match(rail, /\{ view: 'topics'/, 'the rail offers the way in')
  assert.match(app, /data-view=\{item\.view\}/, 'and the column draws the view the rail names')
  assert.match(app, /function openTopic/, 'the way into a thread is the chat screen\'s')
})

test('the chat page says nothing a catalogue did not say', () => {
  const source = readFileSync(join(RENDERER, 'App.jsx'), 'utf8')

  // The last renderer file that wrote its own words, and the largest: the rail, the room list,
  // the form that makes one, the composer, the thread panel, the four standing strips and the
  // hover toolbar. `docs/design/i18n.md` §1 is the rule, and a text node between `>` and `<` is
  // drawn as it stands.
  //
  // **The scan is naive, and this page is where that shows.** Eight of its hits are code rather
  // than prose: an arrow function's `),` and a ternary's `) : view === 'contacts' ? (` put a `>`
  // and a `<` around something that is not a word. They are separated out by the characters only
  // code uses — prose here carries no parenthesis, no `?`, no `=` and no `&&` — and counted
  // below, so the filter cannot quietly swallow the whole scan and leave it looking clean.
  const CODE = /[()?=]|&&|\[\]/
  const texts = [...source.matchAll(/>([^<>{}]*)</g)]
    .map((match) => match[1].trim())
    .filter((text) => /[A-Za-z]{2}/.test(text))
  assert.deepEqual(
    texts.filter((text) => !CODE.test(text)),
    [],
    'a text node carries words of its own instead of a key',
  )
  const misread = texts.filter((text) => CODE.test(text))
  assert.ok(
    misread.length >= 5,
    `the scan read ${misread.length} code shapes, not the eight it used to — the pattern has ` +
      'changed, so the empty list above is no longer a reading about this page',
  )

  // The attributes a person reads: a button's title and a field's hint are chrome too.
  const attributes = [...source.matchAll(/\b(?:placeholder|title|aria-label)="([^"]*)"/g)]
    .map((match) => match[1])
    .filter((text) => /[A-Za-z]{2}/.test(text))
  assert.deepEqual(attributes, [], 'an attribute carries words of its own instead of a key')

  // **A node that writes its own words around a value is invisible to both scans above**, and
  // this page had three of them — `replying to {name}`, `forwarded from {…}` and
  // `<strong>stage 1 asks {stage1.server}</strong>`. `[^<>{}]*` cannot match across the `{`, so a
  // page made entirely of those would pass the two assertions with English still on screen. This
  // is the third shape, and it is here because it was measured on the page that had it rather
  // than imagined (issue #123).
  //
  // The third of those three is gone as of 2026-10-27 — the host asked why a user is shown
  // `stage 1 asks <origin>` at all, and a working stage now draws nothing. The shape stays even
  // though all three are now lookups, because it was measured here and the next one would land
  // the same way.
  const WORDS = /^[A-Za-z0-9][A-Za-z0-9\s'’,.:;&-]*$/
  const interpolated = [...source.matchAll(/>([^<>{}]*)\{/g)]
    .map((match) => match[1])
    .filter((text) => WORDS.test(text))
  assert.deepEqual(interpolated, [], 'a text node writes its own words around a value')

  // Anti-vacuity: three empty lists are exactly what a broken scan also produces.
  const keys = [...source.matchAll(/\bt\(\s*'(ui\.chat\.[a-zA-Z0-9.-]+)'/g)].map(
    (match) => match[1],
  )
  assert.ok(keys.length >= 60, `the scan found ${keys.length} lookups — the pattern is broken`)
  assert.ok(new Set(keys).size >= 55, 'the page looks its words up rather than repeating a few')

  // And every key it names is one of those lookups. A key written where the scan cannot read it
  // — `t(one ? 'ui.chat.a' : 'ui.chat.b')` — is a key the two language-wide tests never check;
  // the equality is what closes that hole.
  const named = [...source.matchAll(/'(ui\.chat\.[a-zA-Z0-9.-]+)'/g)].map((match) => match[1])
  assert.deepEqual(
    [...new Set(named)].sort(),
    [...new Set(keys)].sort(),
    'a key is written where the scan cannot read it, so nothing checks that it is shipped',
  )

  // And the shapes that were here, one line each. Every one of these is a string this page used
  // to write itself, and a sentence a catalogue has to be able to change is not this file's.
  for (const [shape, what] of [
    [/>Chats</, 'the room list heading written into the markup'],
    [/>Thread</, 'the thread panel heading written into the markup'],
    [/'no messages yet'/, 'an empty room second line written into the code'],
    [/>nothing said here yet</, 'an empty room written into the markup'],
    [/>this thread has nothing in it</, 'an empty thread written into the markup'],
    [/>no room in this store</, 'the empty chat column written into the markup'],
    [/>the store was not opened</, 'the store strip written into the markup'],
    [/>no model server</, 'stage 1 placeholder title written into the markup'],
    [/>no work server</, 'stage 2 placeholder title written into the markup'],
    [/'copied to the clipboard'/, 'the note after a copy written into the handler'],
    [/`forwarded into /, 'the note after a forward written into the handler'],
    [/`stop addressing /, 'the mention chip title written into the markup'],
    [/`Forward into /, 'a forward destination title written into the markup'],
    [/`Message \$\{/, 'the composer hint built by concatenation'],
    [/'no turn has run in this room yet'/, 'the spend title written into the markup'],
    [/'that room'/, 'the fallback room name written into the handler'],
    [/'a picture'/, 'a picture named by the window rather than the catalogue'],
    [/'no words'/, 'a message with no words named by the window'],
    [/\} tokens/, 'a count joined to the word `tokens`, which English alone gets right'],
  ]) {
    assert.doesNotMatch(source, shape, `${what}: it is the catalogue's to say`)
  }

  // A count on this page too, and this one is pinned by the strings rather than by a comparison
  // between two of them: `notEqual(t(1), t(2))` passes on a catalogue with no `one` category at
  // all, because the numeral in the sentence already differs. What a flattened plural cannot
  // survive is the singular spelled out, and what a missing number format cannot survive is the
  // thousands separator.
  bindCatalogue(catalogueFor('en'))
  assert.equal(t('ui.chat.spend', { count: 1 }), '1 token', 'one token, and `one` is English\'s')
  assert.equal(t('ui.chat.spend', { count: 1204 }), '1,204 tokens', 'a count is the number format\'s too')
  bindCatalogue(catalogueFor('zh-CN'))
  assert.equal(
    t('ui.chat.spend', { count: 1 }).replace('1', 'N'),
    t('ui.chat.spend', { count: 7 }).replace('7', 'N'),
    'one Chinese sentence, whatever the count',
  )
  bindCatalogue(catalogueFor('en'))
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

test('the download line is the window’s to write, in the language it is running in', () => {
  // The reading a real first run produced: the download had reached part of the model, and the
  // window drew `0.2 GB of 2.2 GB — LFM2.5-VL-3B-Q4_0.gguf` under a heading that said the
  // weights were arriving. The heading came from the catalogue; the line under it came from
  // `ui/electron/weights-fetch.js`, so a window in any language drew that line in English. It is
  // composed here now, out of the facts the main process hands over — which makes the whole
  // line, its frame and its numbers and its unit, this test's subject.
  const facts = { received: 200_000_000, total: 2_177_004_928, file: 'LFM2.5-VL-3B-Q4_0.gguf' }
  const line = () =>
    t('ui.weights.arriving-amount', {
      got: size(facts.received),
      all: size(facts.total),
      file: facts.file,
    })

  bindCatalogue(catalogueFor('en'))
  assert.equal(line(), '0.2 GB of 2.2 GB — LFM2.5-VL-3B-Q4_0.gguf', 'the English line is unchanged')

  bindCatalogue(catalogueFor('zh-CN'))
  const chinese = line()
  assert.notEqual(chinese, '0.2 GB of 2.2 GB — LFM2.5-VL-3B-Q4_0.gguf', 'the frame is not English')
  assert.ok(chinese.includes('2.2 GB'), 'the size keeps its digits and the unit this locale writes')
  assert.ok(chinese.includes(facts.file), 'a file key is an identifier and stays as it is (§7)')

  // Nothing named is not a missing line: the same reading without a file still has words, and
  // the zero reading keeps its decimal rather than dropping to `0 GB` beside `2.2 GB`.
  bindCatalogue(catalogueFor('en'))
  assert.equal(t('ui.weights.arriving-amount-no-file', { got: size(0), all: size(0) }), '0.0 GB of 0.0 GB')

  // The separators are the locale's, and this is the reading that says so where English and
  // Chinese agree: past a thousand the grouped form is `1,234.5 GB`, which no `toFixed` and no
  // concatenated `' GB'` produces. Without it a formatter that had quietly stopped asking `Intl`
  // would still draw this line correctly in the two languages that ship.
  assert.equal(size(1_234_500_000_000), '1,234.5 GB', 'the number goes through the locale too')
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

test('the window has its words before it draws its first frame', () => {
  // The window was measured drawing nothing at all: `App`'s first frame is a sentence of its
  // own (`ui.chat.opening-store`), the catalogue arrived from an IPC call in an effect, and
  // `t()` refuses before `bindCatalogue()` — so the boot screen threw, React unmounted the
  // tree, and the window stayed empty for as long as the store took. Not a wording problem:
  // the screen that says what is happening could not be drawn.
  //
  // There is no DOM in this suite, so this holds the *order* rather than the frame. It is the
  // same kind of claim `electron/documentation.test.mjs` makes about the bridge: a shape in a
  // file that nothing else reads.
  const main = readFileSync(join(RENDERER, 'main.jsx'), 'utf8')
  const asked = main.indexOf('seekHost.catalogue()')
  const bound = main.indexOf('bindCatalogue(catalogue)')
  const drawn = main.indexOf('.render(')

  for (const [what, at] of [['asks for the catalogue', asked], ['binds it', bound], ['draws', drawn]]) {
    assert.ok(at !== -1, `main.jsx no longer ${what} — the pattern moved and this test is stale`)
  }
  assert.ok(
    asked < bound && bound < drawn,
    'the words are fetched and bound before the first render; a frame drawn before them is a ' +
      'frame that throws (docs/design/i18n.md §1)',
  )

  // And the page never reads the catalogue again: a second reader could arrive at a different
  // moment than the first, which is the disagreement this test exists to prevent.
  const app = readFileSync(join(RENDERER, 'App.jsx'), 'utf8')
  assert.equal(app.includes('seekHost.catalogue()'), false, 'App.jsx does not fetch its own words')
  assert.equal(app.includes('bindCatalogue'), false, 'App.jsx does not bind a second catalogue')
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

test('a working stage is not news: nothing on the page names the server it asks', () => {
  const source = readFileSync(join(RENDERER, 'App.jsx'), 'utf8')

  // The two strips the host asked to be rid of (2026-10-27): `stage 1 asks <origin>` and
  // `stage 2 asks <origin>`. A lookup left behind is the sentence coming back, and a catalogue
  // entry left behind is the lookup one `t()` away from coming back.
  assert.doesNotMatch(source, /ui\.chat\.stage[12]-asks/)
  for (const tag of locales()) {
    const asks = Object.keys(catalogueFor(tag).messages).filter((key) => /stage[12]-asks/.test(key))
    assert.deepEqual(asks, [], `${tag} still ships ${asks.join(', ')} — a working stage draws nothing`)
  }

  // And the state those strips drew — a server answering — now draws nothing at all. Without
  // the two lines below, the check above passes and a stage that is being answered falls through
  // to the *placeholder* strip, telling a person there is no model server while one is answering:
  // the deletion alone trades a sentence nobody can use for a sentence that is false.
  assert.match(source, /if \(stage1\.server\) return null/)
  assert.match(source, /if \(stage2\.server\) return null/)

  // Anti-vacuity: the two readings that do still speak are still on the page and still shipped,
  // so the assertions above are about a deletion rather than about a component that draws nothing.
  for (const stage of ['stage1', 'stage2']) {
    assert.match(source, new RegExp(`ui\\.chat\\.${stage}-refused`))
    assert.match(source, new RegExp(`ui\\.chat\\.${stage}-placeholder`))
    for (const tag of locales()) {
      for (const tail of ['refused', 'placeholder']) {
        assert.ok(
          catalogueFor(tag).messages[`ui.chat.${stage}-${tail}`] !== undefined,
          `${tag} lost ui.chat.${stage}-${tail}, which the page still draws`,
        )
      }
    }
  }
})
