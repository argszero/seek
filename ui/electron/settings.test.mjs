/**
 * Seek's own settings file: what it reads, what it refuses, and what it writes.
 *
 * Three things are measured here, each because it could be wrong without anyone noticing.
 *
 * **The key is optional and the other two are not.** An endpoint on this machine — the server
 * this app starts, a llama.cpp next door — takes no credential, so requiring all three would
 * make this app unable to point its words half at a local model, which is a thing it can
 * already do. A *half-written* pair, on the other hand, is refused rather than passed on: a
 * person typed an address and stopped, and falling through to another program's config would
 * answer a question nobody asked.
 *
 * **A broken file is a sentence, not a throw.** This is read during start-up, before a window
 * exists, and a throw here is an app that looks dead — the failure `openHostOrRefuse` was
 * written to stop one layer down. So unreadable, unparseable and not-an-object are all values.
 *
 * **A save keeps what it did not touch, and lands at 0600.** The form sends the endpoint one
 * field at a time, and the key is already on disk: a merge that replaced the `llm` table whole
 * would erase the key every time someone fixed a typo in the address. The mode is on the way in
 * rather than after, and the write goes through a temporary file, because a launch that reads
 * mid-save must see one whole version of the file and never half of either.
 *
 * Every fixture is a directory this test makes, so nothing here reads the machine it runs on —
 * the real file belongs to whoever is sitting at it.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { defaultSettingsPath, llmOf, readSettings, writeSettings } from './settings.js'

/** A directory to hold this test's file, removed by the caller. */
async function scratch() {
  return mkdtemp(join(tmpdir(), 'seek-settings-'))
}

test('the settings file sits in the app data directory', () => {
  assert.equal(
    defaultSettingsPath('/Users/someone/Library/Application Support/Seek'),
    '/Users/someone/Library/Application Support/Seek/settings.json',
  )
})

test('a file that is not there is no settings and no refusal', async () => {
  const dir = await scratch()
  try {
    const read = await readSettings(join(dir, 'settings.json'))
    assert.deepEqual(read, { settings: {}, refusal: null })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a file that is not JSON is refused in a sentence that names the file', async () => {
  const dir = await scratch()
  const path = join(dir, 'settings.json')
  try {
    await writeFile(path, '{ this is not json', 'utf8')
    const read = await readSettings(path)
    assert.deepEqual(read.settings, {})
    assert.match(read.refusal, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(read.refusal, /not readable JSON/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an array is not an object, and is refused rather than read as one', async () => {
  const dir = await scratch()
  const path = join(dir, 'settings.json')
  try {
    await writeFile(path, '[1, 2, 3]', 'utf8')
    const read = await readSettings(path)
    assert.deepEqual(read.settings, {})
    assert.match(read.refusal, /rather than an object/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an endpoint with no key is a whole endpoint', () => {
  assert.deepEqual(llmOf({ llm: { baseUrl: 'http://127.0.0.1:8080/v1', model: 'local' } }), {
    baseUrl: 'http://127.0.0.1:8080/v1',
    model: 'local',
    apiKey: undefined,
  })
})

test('the three keys are read as they are written', () => {
  assert.deepEqual(
    llmOf({ llm: { baseUrl: 'https://endpoint.test/v1', model: 'a-model', apiKey: 'sk-x' } }),
    { baseUrl: 'https://endpoint.test/v1', model: 'a-model', apiKey: 'sk-x' },
  )
})

test('nothing said is not a refusal — it is the fallback\u2019s business', () => {
  assert.equal(llmOf({}), undefined)
  assert.equal(llmOf({ llm: {} }), undefined)
})

test('a key on its own names no endpoint, and is said rather than swallowed', () => {
  // This app cannot produce this state — a save needs an address and a model. It can only be
  // hand-edited, and a hand-written key that points nowhere is a person's mistake worth
  // naming: falling through to another program's config would quietly use a different
  // endpoint than the one they were trying to set up.
  const read = llmOf({ llm: { apiKey: 'sk-only-a-key' } })
  assert.match(read.refusal, /neither an address nor a model/)
  assert.equal(read.baseUrl, undefined)
})

test('half a pair is refused, and says which half is missing', () => {
  const noAddress = llmOf({ llm: { model: 'a-model' } })
  assert.match(noAddress.refusal, /a model and no address/)

  const noModel = llmOf({ llm: { baseUrl: 'https://endpoint.test/v1' } })
  assert.match(noModel.refusal, /an address and no model/)

  const neither = llmOf({ llm: { apiKey: 'sk-x' } })
  assert.match(neither.refusal, /neither an address nor a model/)
})

test('a save writes the endpoint, at 0600, and leaves no temporary behind', async () => {
  const dir = await scratch()
  const path = join(dir, 'settings.json')
  try {
    await writeSettings(path, { llm: { baseUrl: 'https://endpoint.test/v1', model: 'a-model' } })
    const mode = (await stat(path)).mode & 0o777
    assert.equal(mode.toString(8), '600')
    const written = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(written.llm.baseUrl, 'https://endpoint.test/v1')
    assert.equal(written.llm.model, 'a-model')
    // The write goes through `<path>.<pid>.tmp`: a leftover is a save that did not finish.
    const leftovers = (await readFile(path, 'utf8')).includes('.tmp')
    assert.equal(leftovers, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a save that fixes the address does not erase the key already saved', async () => {
  const dir = await scratch()
  const path = join(dir, 'settings.json')
  try {
    await writeSettings(path, {
      llm: { baseUrl: 'https://endpoint.test/v1', model: 'a-model', apiKey: 'sk-saved-earlier' },
    })
    await writeSettings(path, { llm: { baseUrl: 'https://elsewhere.test/v1', model: 'a-model' } })
    const written = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(written.llm.baseUrl, 'https://elsewhere.test/v1')
    assert.equal(written.llm.apiKey, 'sk-saved-earlier')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a save leaves everything it was not asked about alone', async () => {
  const dir = await scratch()
  const path = join(dir, 'settings.json')
  try {
    await writeFile(path, JSON.stringify({ theme: 'dark', llm: { baseUrl: 'https://a/v1' } }), 'utf8')
    await writeSettings(path, { llm: { model: 'a-model' } })
    const written = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(written.theme, 'dark')
    assert.equal(written.llm.baseUrl, 'https://a/v1')
    assert.equal(written.llm.model, 'a-model')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a first save makes the directory it needs', async () => {
  const dir = await scratch()
  const path = join(dir, 'not', 'there', 'settings.json')
  try {
    await writeSettings(path, { llm: { baseUrl: 'https://a/v1', model: 'm' } })
    const written = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(written.llm.model, 'm')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
