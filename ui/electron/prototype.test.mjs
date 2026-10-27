/**
 * The demo's host, against the window it stands in for.
 *
 * `prototype/src/fake-host.js` has promised this file in its own header since the demo was
 * rebuilt over the window's components: *every method here is checked against the window's own
 * call sites, and `ui/electron/prototype.test.mjs` reads `window.seekHost.<name>` out of
 * `ui/src/**` and asserts this file answers each one*. It did not exist, and the promise is why
 * the two things below are worth a test at all — a demo that answers a method the window never
 * calls is harmless, and a window that calls one the demo does not answer dies on a click.
 *
 * **What was actually missing, and found by hand on 2026-10-27.** Making an organization in the
 * demo blanked the window: `TypeError: Cannot read properties of undefined (reading 'rooms')`.
 * Nothing about organizations was wrong: the fake host's `emit()` called `listener(undefined)`
 * while the window takes that argument as its new state. Every write in the demo unmounted it,
 * and no test noticed because this file was not there to notice.
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const UI = join(HERE, '..')
const FAKE = readFileSync(join(UI, '..', 'prototype', 'src', 'fake-host.js'), 'utf8')
const PRELOAD = readFileSync(join(HERE, 'preload.js'), 'utf8')
const APP = readFileSync(join(UI, 'src', 'App.jsx'), 'utf8')

/** Every file of the window's own source, the demo's renderer included. */
function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.(jsx|js|mjs)$/.test(entry.name) ? [path] : []
  })
}

/** What the window asks its host for, read off the calls rather than from a list. */
function asked() {
  const names = new Set()
  for (const path of sources(join(UI, 'src'))) {
    const text = readFileSync(path, 'utf8')
    for (const [, name] of text.matchAll(/window\.seekHost\??\.([A-Za-z]+)/g)) names.add(name)
  }
  return [...names].sort()
}

test('the fake host answers every call the window makes', () => {
  const names = asked()
  // A call site that stopped being read would make every name below pass on nothing. The floor
  // came down by one on 2026-10-27 with `models` — the settings page's `List models` button went,
  // and the bridge call that answered it went with it.
  assert.ok(names.length >= 18, `only ${names.length} bridge calls found in ui/src`)
  const answered = names.filter((name) => new RegExp(`^  ${name}:`, 'm').test(FAKE))
  assert.deepEqual(names.filter((name) => !answered.includes(name)), [], 'the demo cannot answer these')
})

test('a change hands a snapshot to the listener, on all three sides of the wire', () => {
  // The premise: the window reads the argument as the new state, and reads a field of it
  // straight away — which is why "something changed" is not enough and `undefined` is fatal.
  assert.match(APP, /onChanged\(adopt\)/, 'the window no longer subscribes with its handler')
  assert.match(APP, /const adopt = \(next\) => \{/, 'the handler is not the one this test knows')
  assert.match(APP, /next\.rooms/, 'the handler no longer reads the snapshot it is handed')

  // The real bridge: it passes what the main process sent.
  assert.match(PRELOAD, /handler = \(_event, snapshot\) => listener\(snapshot\)/, 'the bridge stopped handing the snapshot over')

  // The demo's bridge: the same, and this is the line that was wrong.
  const emit = FAKE.slice(FAKE.indexOf('function emit()'), FAKE.indexOf('/** A fresh copy each time'))
  assert.match(emit, /const next = snapshot\(\)/, 'the demo emits without taking a snapshot')
  assert.match(emit, /listener\(next\)/, 'the demo tells its listeners that something happened, not what')
  assert.doesNotMatch(emit, /listener\(undefined\)/, 'the demo is back to handing listeners nothing')
})

test('the demo’s fixture is the only data, and it is not a file', () => {
  // The demo has no store to lose, and says so where the window asks — a demo that claimed a
  // store file would be a screen the app never draws.
  assert.match(FAKE, /storeFile:/, 'the demo no longer answers where its data lives')
  assert.equal(statSync(join(UI, '..', 'prototype', 'src', 'fixture.js')).isFile(), true)
})
