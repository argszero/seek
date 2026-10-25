/**
 * What the window reads out of the environment, and whether a reader can find out.
 *
 * The main process reads five variables and each one changes what happens when the app
 * opens: `SEEK_DATA_DIR` says where the store lives, `SEEK_SERVER` with `SEEK_WINDOW` names
 * the server that decides *whether* the bot acts, `SEEK_WORK_SERVER` names the one that
 * writes its *words*, and `SEEK_UI_DEV_URL` points the window at a dev server instead of the
 * built page. There is no `--help`, no argument parser and no config file — so the README is
 * the only place a person can learn a variable exists at all. That makes "is it documented"
 * a property of the repository rather than a matter of care, and a property is something a
 * test can hold.
 *
 * The prose has gone wrong here three times, each time in the same direction and each time
 * silently: the status paragraph said the interface was not wired to a model *after* it was
 * (`#63`), said it again *after* the second half was wired (`#66`), and went on saying the
 * window only read a room, drew it and took what you type *after* it had gained a room
 * composer (`#78`), an add-member panel (`#79`) and an `@` that addresses a message
 * (`#80`) — so the chapter that tells a reader how to run the interface opened with "pick a
 * room, type, press Enter" while the window had three more things a person could do in it.
 * Nothing failed any of the three times — `src/docs.test.ts` compares the twin documents'
 * sections and points, `src/counts.test.ts` counts files, lines and tests, and a sentence is
 * neither of those. Only a person rereading the paragraph could catch it, which is exactly
 * the kind of check that stops happening.
 *
 * So this file pins the measurable half of that prose:
 *
 * - the set of variables the main process consults, against the set each README names;
 * - the two READMEs against each other, because a variable documented in one language only
 *   is the same gap told more quietly;
 * - the one number in the dev sentence, because the README says which port a dev window
 *   reaches and `ui/vite.config.mjs` configures no port at all.
 *
 * What it cannot pin is whether a sentence about the *download* is true of the download:
 * that depends on which tag the release page serves, not on this tree. That half stays a
 * hand edit, and the edit that survives is the one that cannot go stale: `#86` states what
 * the releases **up to** `v0.1.0` contain, a historical claim that stays true however many
 * releases follow, while `#76` names the file shapes and lets the release page carry the
 * number rather than repeating it here once per release.
 *
 * One part of that half is checkable after all, and it is the part that was wrong. Which
 * shapes a release publishes is `release.yml`'s to say; what macOS does to each of them is
 * this project's to say back, and the two are one fact seen from two sides — so the pair is
 * a property rather than a matter of care. They had drifted apart: the remedy named only
 * `/Applications/Seek.app`, which is where the `.zip` ends and not where a `.pkg` starts, so
 * a reader who chose the installer was told to clear a flag on a file the refusal had
 * prevented from existing. Measured on the published `v0.1.1` `.pkg`:
 * `pkgutil --check-signature` answers `no signature` and `spctl -a -t install` answers
 * `rejected` — so the refusal really does come before the app is on disk. The test that
 * holds the remedies against the shapes.
 *
 * **A capability is checkable the same way a variable is**, and the third drift above is
 * what made that worth doing. What the window can *do* is not a matter of prose at all on
 * the source side: `preload.js` is the renderer's whole vocabulary, `main.js` answers every
 * call in it, and a call that changes the store says so — it broadcasts `seek:changed` to
 * the window. So the set of capabilities is derivable from two files, and what the READMEs
 * owe is one claim per capability, in each language. A fourth write tomorrow is a fourth
 * claim nothing has written yet, and the tests below say so without being edited.
 *
 * The `@` is the one capability that is not a call: a mention rides inside `post` and shows
 * up in the snapshot's own `mentions`, which is what makes it visible at all. It is pinned
 * from that end instead, against the sentence that says a message names who it addresses.
 *
 * **The set is closed, and that is what makes it hold.** The first version of these tests
 * read only the calls that broadcast — which left the picture pair out, because `attach`
 * writes bytes beside the store and tells no window about it. So the drift came back a
 * fourth time in the other shape: `Picture`, `seek:attach` and `seek:media` all shipped,
 * and the window chapter described a window with no pictures in it. A rule that reads only
 * one kind of call cannot notice the other kind, so every channel the bridge exposes now
 * has to be *classified* — a capability the READMEs claim, or plumbing this file names —
 * and an eighth call tomorrow fails until it is one of the two.
 *
 * **A file written twice is one fact, and a fact is something a test can hold.** The roster
 * a fresh install gets is written from a constant in `host.js` rather than copied out of
 * `seek-data/agents.yml`, because the packaged app packs `src/` and a built page and not this
 * repository's data directory — so the two copies exist on purpose, and `host.js`'s own
 * comment says they hold the same rows while nothing checked it. A role added to one copy is
 * an install that differs from the next, and every test stayed green. They are compared here
 * through the kernel's own `parseRoster`, so what agrees is the shape the kernel accepts and
 * not this file's idea of one.
 *
 * What the roster's *absence* means stays prose, and that was the sentence that was wrong:
 * the run chapter said one state — "a store with no roster beside it opens over a bot with no
 * agents and refuses to run" — where the kernel keeps two apart. A missing file says nothing
 * and a store goes on using the agents it already has; a file that is there and has no rows is
 * the one that says the bot has no agents; and what refuses is the run, because the bot has no
 * agent rather than because a file is gone. The half a machine can hold is that each language
 * says both states, which is what the last test below asserts.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { parseRoster } from '../../src/roster.ts'

const UI = fileURLToPath(new URL('../', import.meta.url))
const REPO = resolve(UI, '..')
const read = (path) => readFileSync(join(REPO, path), 'utf8')

/**
 * Every `SEEK_*` the main process reads, taken from the sources rather than listed here: a
 * variable added to `main.js` tomorrow is undocumented tomorrow, and this file has to say so
 * without being edited. The scan is the whole of `electron/` minus the tests, so a read that
 * moves into `host.js` stays covered.
 */
function readVariables() {
  const found = new Set()
  const files = readdirSync(join(UI, 'electron')).filter((name) => name.endsWith('.js'))
  for (const name of files) {
    const source = readFileSync(join(UI, 'electron', name), 'utf8')
    for (const [, variable] of source.matchAll(/process\.env\.(SEEK_[A-Z0-9_]+)/g)) found.add(variable)
  }
  return [...found].sort()
}

/** Every `SEEK_*` a document mentions, whatever it says about it. */
const names = (document) => [...new Set(read(document).match(/SEEK_[A-Z0-9_]+/g) ?? [])].sort()

const VARS = readVariables()

test('every variable the window reads is a variable the README names', () => {
  // A scan that found nothing would pass every assertion below it, which is the failure
  // mode of every test built out of a pattern match.
  assert.ok(VARS.length >= 5, `expected the window's environment to be read somewhere, found ${VARS.length}`)

  for (const document of ['README.md', 'README.zh-CN.md']) {
    const named = new Set(names(document))
    const missing = VARS.filter((variable) => !named.has(variable))
    assert.deepEqual(missing, [], `${document} never names ${missing.join(', ')}`)
  }
})

test('the two READMEs name the same variables', () => {
  // The twins are required to move together; this is the part of that promise a machine can
  // check without parsing prose. A variable added to the English paragraph alone fails here
  // rather than waiting for a translator to notice.
  assert.deepEqual(names('README.zh-CN.md'), names('README.md'))
  assert.ok(VARS.length > 0, 'and the comparison is not between two empty lists')
})

test('the dev window is pointed at the port the dev server actually listens on', () => {
  // Vite's own fallback is 5173 (`DEFAULT_DEV_PORT`, `vite/dist/node/chunks/node.js`), so a
  // config that named no port leaves that number in force. If someone later configures one,
  // this fails and sends them to the sentence the README states it in — which is the whole
  // point: the README's number has to be the number a dev window reaches.
  assert.doesNotMatch(read('ui/vite.config.mjs'), /\bserver\s*:/, 'no port is configured, so the framework default applies')

  for (const document of ['README.md', 'README.zh-CN.md']) {
    const text = read(document)
    const at = text.indexOf('SEEK_UI_DEV_URL')
    assert.notEqual(at, -1, `${document} names SEEK_UI_DEV_URL`)
    // Read near the mention rather than anywhere in the file: `5173` belongs to this
    // variable, and a README that happens to name the port somewhere else says nothing.
    const nearby = text.slice(Math.max(0, at - 400), at + 400)
    assert.match(nearby, /5173/, `${document} states the port next to the variable that points at it`)
  }
})

/**
 * What macOS does is decided per shape, so the answer has to be per shape.
 *
 * A `.pkg` is assessed when it is opened, before there is any `Seek.app` on disk; a `.zip`
 * yields an app that is assessed on first launch. One command cannot serve both, and the one
 * that stood here served only the second — `xattr -dr com.apple.quarantine
 * /Applications/Seek.app` names a path that a refused install never creates. So every shape
 * the workflow publishes has to come with a command naming the thing that shape refused: the
 * downloaded `.pkg` for one, the dragged `Seek.app` for the other. Both READMEs, because a
 * reader who chose the installer reads one of them and not the other.
 */
test('a reader is told what to clear for the shape they downloaded', () => {
  const workflow = readFileSync(join(REPO, '.github', 'workflows', 'release.yml'), 'utf8')
  for (const extension of ['pkg', 'zip']) {
    assert.ok(workflow.includes(`ui/release/*.${extension}`), `the release publishes a .${extension}`)
  }

  // The target is the last word of the command, which is the path xattr is asked about.
  const targets = (document) =>
    [...read(document).matchAll(/^xattr\s+[^\n]*?\s(\S+)$/gm)].map(([, target]) => target)

  for (const document of ['README.md', 'README.zh-CN.md']) {
    const found = targets(document)
    assert.ok(
      found.some((target) => target.endsWith('.pkg')),
      `${document} says what to clear for the .pkg, which is refused before the app exists`,
    )
    assert.ok(
      found.some((target) => target.endsWith('Seek.app')),
      `${document} says what to clear for the .zip's app, which is refused on first launch`,
    )
  }
})

/**
 * Every channel the renderer can call, taken from the bridge rather than listed here.
 *
 * The `invoke(` prefix without its closing parenthesis on purpose: four of the seven calls
 * pass an argument, and a pattern that required `)` would silently see only the three that
 * do not — a scan that under-reported would make every comparison below agree with less
 * than the truth.
 */
function invokedChannels() {
  const source = readFileSync(join(UI, 'electron', 'preload.js'), 'utf8')
  const found = [...source.matchAll(/ipcRenderer\.invoke\('(seek:[a-z-]+)'/g)].map(([, channel]) => channel)
  return [...new Set(found)].sort()
}

/** Every channel the main process registers a handler for. */
function handledChannels() {
  const source = readFileSync(join(UI, 'electron', 'main.js'), 'utf8')
  const found = [...source.matchAll(/ipcMain\.handle\('(seek:[a-z-]+)'/g)].map(([, channel]) => channel)
  return [...new Set(found)].sort()
}

/**
 * The calls that change the store, derived from the way `main.js` writes one.
 *
 * A write here is not a naming convention: it is a handler that broadcasts `seek:changed`
 * after it returns, because a window that changed something and told nobody would go on
 * drawing the room it used to have. Each broadcast is attributed to the nearest handler
 * declared above it, which is the block it sits in — no block boundaries to cut, so a
 * handler written in a style this file did not anticipate is still read correctly.
 */
function storeWritingChannels() {
  const source = readFileSync(join(UI, 'electron', 'main.js'), 'utf8')
  const channels = []
  for (const broadcast of source.matchAll(/win\.webContents\.send\('seek:changed'/g)) {
    const declared = [...source.slice(0, broadcast.index).matchAll(/ipcMain\.handle\('(seek:[a-z-]+)'/g)].at(-1)
    if (declared) channels.push(declared[1])
  }
  return [...new Set(channels)].sort()
}

/**
 * What each store-changing call owes the two READMEs, in each language.
 *
 * The claim is a capability and not an API name: a reader is told the window can do the
 * thing. The keys are checked against the derivation above in both directions, so a write
 * added tomorrow fails here with the row it needs rather than passing as an absence — and
 * a row left behind after a call was removed fails the same way.
 */
const CLAIMS = {
  'seek:post': { en: /takes what you type/, zh: /你输入的消息/ },
  'seek:create-room': { en: /makes a room/, zh: /造一个房间/ },
  'seek:add-member': { en: /one more person/, zh: /把一个人加进去/ },
  // The picture pair, and neither of them broadcasts: `attach` writes bytes beside the
  // store and `media` reads them back, so the derivation from `seek:changed` cannot see
  // either. They are claimed because a person clicks `Picture` and a picture appears, and
  // that is the half a reader has to be told.
  'seek:attach': { en: /`?Picture`? button/, zh: /`?Picture`? ?按钮/ },
  'seek:media': { en: /draws it back from that\s+reference alone/, zh: /只凭那个引用把图画回来/ },
}

/**
 * The rest of the bridge, and why a reader is not told about it as an affordance.
 *
 * Not a discard list: each entry is a claim about what the call is. A channel added to
 * either kind has to be named here or in `CLAIMS`, which is the point — the pair of tables
 * is the whole vocabulary, so nothing can arrive unclassified.
 */
const PLUMBING = {
  'seek:snapshot': 'the read every render starts from — the window draws the room it returns',
  'seek:data-path': 'where the store lives: the README states it as a fact, not as a button',
}

test('every call that changes the store is a call the window can reach and main answers', () => {
  const invoked = invokedChannels()
  const handled = handledChannels()

  // Anti-vacuity: two empty lists would agree with the comparison below without reading a
  // single line of either file.
  assert.ok(invoked.length >= 5, `the bridge exposes ${invoked.length} calls — the scan is broken`)
  assert.deepEqual(handled, invoked, 'the bridge and the main process disagree about the vocabulary')
})

test('every call that changes the store is a capability both READMEs claim', () => {
  const writes = storeWritingChannels()

  // Three: a message, a room, and one more member — the number `preload.js` states in its
  // own comment. A fourth is not an error in itself, it is one more claim the READMEs owe,
  // so the assertion that matters is the set comparison below; this one only keeps the
  // derivation honest if a broadcast stops being recognisable.
  assert.ok(writes.length >= 3, `only ${writes.length} store-changing calls were found: ${writes.join(', ')}`)

  const missing = writes.filter((channel) => CLAIMS[channel] === undefined)
  assert.deepEqual(
    missing,
    [],
    'a call that changes the store and a claim in the READMEs are the same fact seen twice — ' +
      'add the row here and the sentence it owes in both READMEs',
  )

  // Every claimed capability is checked, not only the ones that broadcast: the loop used
  // to run over `writes`, which left the picture pair in the table and unread — the two
  // rows could have said anything. A claim nothing asserts is worse than no claim.
  for (const channel of Object.keys(CLAIMS)) {
    assert.match(read('README.md'), CLAIMS[channel].en, `README.md never claims ${channel}`)
    assert.match(
      read('README.zh-CN.md'),
      CLAIMS[channel].zh,
      `README.zh-CN.md never claims ${channel}, so the pair says different things`,
    )
  }
})

test('a message that names who it addresses is a message both READMEs say names them', () => {
  // The renderer cannot see a mention except through the snapshot, so this is the end that
  // makes it visible on screen at all — and the end that goes stale if the field is renamed.
  assert.match(read('ui/electron/snapshot.js'), /mentions:/)

  assert.match(read('README.md'), /names the people it addresses/)
  assert.match(read('README.zh-CN.md'), /点名它说的是谁/)
})

test('every call the bridge exposes is either a capability the READMEs claim or plumbing', () => {
  const invoked = invokedChannels()

  // The vocabulary and the two tables are the same set, read three ways. A call that is
  // neither claimed nor named as plumbing is a capability nobody has decided about — which
  // is exactly how the picture pair stayed undocumented through four slices — and this
  // assertion is what refuses to let the next one do the same.
  const classified = [...Object.keys(CLAIMS), ...Object.keys(PLUMBING)].sort()
  assert.deepEqual(
    classified,
    invoked,
    'the bridge exposes a call that is neither a claimed capability nor declared plumbing: ' +
      `claim it in both READMEs and add it to CLAIMS, or say here why a reader is not told: ${invoked
        .filter((channel) => !classified.includes(channel))
        .join(', ')}`,
  )

  // Anti-vacuity again: two tables compared against a scan that read nothing would agree.
  assert.ok(invoked.length >= 7, `only ${invoked.length} calls were read out of the bridge`)
})

/**
 * The roster a first run writes, read out of `host.js` instead of being listed here.
 *
 * It is a template literal, and its only escape is the backtick pair around a name in a
 * comment. A second kind would be read wrong by the unescape below, so the read stops on one
 * rather than comparing a mangled copy of the file and calling the two copies equal.
 */
function firstRunRoster() {
  const [, body] = read('ui/electron/host.js').match(/const FIRST_RUN_ROSTER = `([\s\S]*?)`\n/) ?? []
  assert.ok(body, 'host.js still carries the roster a first run writes, as a template literal')
  const text = body.replaceAll('\\`', '`')
  assert.doesNotMatch(text, /\\/, 'the literal holds no escape this read did not undo')
  return text
}

test('the roster a first run writes is the roster this repository ships', () => {
  // Both sides through the kernel's own reader, so the comparison is over what the kernel
  // accepts — bot, role, tools, and the three fields that are absent by design — rather than
  // over two texts that differ in their comments on purpose.
  const shipped = parseRoster(read('seek-data/agents.yml'), 'seek-data/agents.yml')

  // Anti-vacuity: two rosters that failed to parse would agree with the comparison below
  // while holding not one row.
  assert.ok(shipped.length > 0, 'the shipped roster holds rows')

  assert.deepEqual(
    parseRoster(firstRunRoster(), 'host.js FIRST_RUN_ROSTER'),
    shipped,
    'a first run writes the roster this repository ships — a row added to one copy and not ' +
      'the other is a bot that exists in one install and not in the next',
  )
})

test('both READMEs separate a missing roster from a roster with no rows', () => {
  // The kernel's half of this is pinned in `src/roster.test.ts`: a missing file reads
  // `undefined`, a file with no rows reads `[]`, and `Kernel.open` applies only the second —
  // so the store a person already has keeps its agents when the file goes away. The half a
  // test can hold here is whether the chapter says so, in both languages, next to the
  // sentence that sends a reader to the file at all.
  for (const [document, keeps, noRows] of [
    ['README.md', /keeps the agents it already has/, /holds no rows/],
    ['README.zh-CN.md', /保留它已经有的那些 agent/, /一行没有/],
  ]) {
    const text = read(document)
    const at = text.indexOf('agents.yml')
    assert.notEqual(at, -1, `${document} sends a reader to agents.yml`)

    // Read near the mention rather than anywhere in the file: a chapter that happens to say
    // "no rows" about something else says nothing about a roster.
    const nearby = text.slice(Math.max(0, at - 200), at + 900)
    assert.match(nearby, keeps, `${document} says a store that lost its roster keeps its agents`)
    assert.match(nearby, noRows, `${document} names the state that leaves a bot with no agents`)
  }
})
