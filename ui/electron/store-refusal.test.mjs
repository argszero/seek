/**
 * What the window does when the kernel will not open the store.
 *
 * **This is the one failure a person cannot diagnose for themselves.** Every other refusal
 * in this app is drawn on a window that exists: a model server that was named and not used,
 * a picture that cannot be read, a message the kernel rejected. A store this version refuses
 * happens *before* there is a window, so the code path that draws refusals is not reached at
 * all — and an app launched from Finder writes its stderr to `/dev/null`, so the kernel's own
 * paragraph explaining what to do goes nowhere a person can look.
 *
 * That is not hypothetical. It was found on a real install: `v0.1.3` installed over a machine
 * that still held a store written by an older build, in
 * `~/Library/Application Support/Seek`. Double-clicking the app produced no window, no dialog
 * and no message — only a process, alive, with no window and no `activate` handler, because
 * the startup chain was `whenReady().then(async () => { await openHost(...); createWindow() })`
 * with no catch. The kernel had refused correctly and said so at length; nothing was left to
 * carry that sentence to the screen.
 *
 * No driver in this repository could have caught it: every one of them passed `SEEK_DATA_DIR`
 * pointing at an empty directory, which is the one state where this cannot happen. So the two
 * halves are pinned here where they can run under plain `node --test` — the opener answers
 * with the refusal as a value instead of throwing, and the startup file has no await between
 * `whenReady` and the window.
 *
 * The last test reads `main.js` as text, because Electron cannot be imported here. That is the
 * same trade `packaging.test.mjs` makes, and for the same reason: the defect is a fact about
 * how the file is composed, and a comment cannot hold it.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { closeHost, openHost, openHostOrRefuse } from './host.js'
import { snapshotOf } from './snapshot.js'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * A store as the build before this one wrote it: two accounts and a `store` shard, with none
 * of the eleven shards the kernel now requires. Copied from the file actually found on the
 * install that reported the blank window, trimmed of its content — the shape is the whole
 * point, and every field here is one the old store really carried.
 */
const OLD_SHAPED_STORE = JSON.stringify(
  {
    version: 1,
    theme: 'light',
    currentOrganizationId: 'acc_5678a0b140',
    accounts: [{ id: 'acc_5678a0b140', name: 'an account' }],
    store: { acc_5678a0b140: { rooms: [], messages: {} } },
  },
  null,
  2,
)

async function dirWithStore(contents) {
  const dir = await mkdtemp(join(tmpdir(), 'seek-ui-store-refusal-'))
  const storeFile = join(dir, 'seek.json')
  if (contents !== undefined) await writeFile(storeFile, contents, 'utf8')
  return { dir, storeFile, async done() { await rm(dir, { recursive: true, force: true }) } }
}

/**
 * The load-bearing half: a refused store is an answer, not an exception, so the caller that
 * makes the window can go on to make it.
 */
test('a store this version refuses is an answer rather than a throw', async () => {
  const where = await dirWithStore(OLD_SHAPED_STORE)
  try {
    // The throwing opener still throws — this is why the refusal needed a second caller,
    // not a softer rule: a caller that wants the exception keeps it.
    await assert.rejects(
      () => openHost(where.storeFile),
      /is not a store this version can read/,
      'openHost still refuses, because a store it cannot read is still not readable',
    )

    const opened = await openHostOrRefuse(where.storeFile)
    assert.equal(opened.host, null, 'nothing is opened over a store that was refused')
    assert.match(
      opened.refusal,
      /is not a store this version can read/,
      'the kernel\'s own sentence is what the caller gets, not a rewrite of it',
    )
    // The sentence has to be actionable, not merely true: it names the shards it found
    // absent and says the file was left alone, which is what the person acts on.
    assert.match(opened.refusal, /"bots", "agents", "principals"/, 'the refusal names what is missing')
    assert.match(opened.refusal, /Nothing was changed or removed/, 'and promises the file is untouched')
  } finally {
    await where.done()
  }
})

/** A refusal that had a side effect would be worse than the blank window it replaced. */
test('a refused store is left exactly as it was found', async () => {
  const where = await dirWithStore(OLD_SHAPED_STORE)
  try {
    const before = await readFile(where.storeFile, 'utf8')
    await openHostOrRefuse(where.storeFile)
    assert.equal(await readFile(where.storeFile, 'utf8'), before, 'the file is byte for byte what it was')
  } finally {
    await where.done()
  }
})

/** The other direction: a store the kernel can read must not acquire a refusal on the way. */
test('a store this version can read opens, and carries no refusal', async () => {
  const where = await dirWithStore(undefined)
  try {
    const opened = await openHostOrRefuse(where.storeFile)
    assert.equal(opened.refusal, null, 'a first run is not a refusal')
    assert.ok(opened.host, 'and it opens')
    closeHost(opened.host)
  } finally {
    await where.done()
  }
})

/**
 * The refusal reaches the window, as its own reading.
 *
 * `error` is "the store is not open yet" — true for a moment on every start, and not a
 * failure. A window that drew a refusal as that would show a broken install as a slow one.
 */
test('the window can be told why the store was refused, in a field of its own', () => {
  const refused = snapshotOf(null, '/tmp/seek.json', null, null, 'this store is older than the kernel')
  assert.equal(refused.storeRefusal, 'this store is older than the kernel')
  assert.match(refused.error, /not open yet/, 'the transient reading is still its own thing')
  assert.deepEqual(refused.rooms, [], 'and there is no room to draw, which is what it is explaining')

  // Present and null on an open store, so a window reading it never has to decide whether an
  // absent key means "fine" or "not asked".
  assert.equal(snapshotOf(null, '/tmp/seek.json').storeRefusal, null, 'nothing refused, nothing said')
})

/**
 * The startup file: nothing may sit between `whenReady` and the window.
 *
 * Read as text because `main.js` requires Electron. Both halves are asserted, because either
 * alone would have left the defect reachable: the opener that answers instead of throwing, and
 * a startup chain where the window is made after it rather than *inside* a `then` that a
 * rejection skips.
 */
test('the window is made whether or not the store opened', async () => {
  const main = await readFile(join(HERE, 'main.js'), 'utf8')
  // The claim is about code, and this file's own doc comment quotes the shape it replaced —
  // so the comments come out first. A test that read them too would fail on the explanation
  // of the defect rather than on the defect, and the next person's first instinct would be
  // to delete the explanation.
  const code = main.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  assert.match(code, /openHostOrRefuse/, 'the startup uses the opener that answers a refusal')
  assert.doesNotMatch(
    code,
    /await openHost\(/,
    'and never awaits the throwing one before making a window',
  )
  // The function that makes the window is the one handed to `whenReady`, and `createWindow()`
  // is called in it unconditionally — not after an await that can reject.
  assert.match(code, /app\.whenReady\(\)\.then\(start\)/, 'whenReady runs the startup as a whole')
  assert.match(code, /async function start\(\)/, 'and that startup is a named function')
  // The window is made on the first two statements of the startup, before anything that waits:
  // `registerActivate()` sits beside it because the handler and the window have to arrive
  // together — a startup that threw between them left an app with no window *and* no handler,
  // which is the defect this test was written for. What changed is that a first run now fetches
  // 2.1 GB before it can start a server, so "before the first await" is the claim that has to
  // hold rather than "immediately after the store opened".
  const beforeFirstAwait = code.slice(code.indexOf('async function start()')).split(/\bawait\b/)[0]
  assert.match(beforeFirstAwait, /createWindow\(\)/, 'the window is made before anything is awaited')
  assert.match(beforeFirstAwait, /registerActivate\(\)/, 'and its handler is registered beside it')
  assert.match(code, /app\.on\('activate'/, 'the handler is still registered on the app')
  assert.match(code, /storeRefusal/, 'the refusal is state the window can be told about')
})
