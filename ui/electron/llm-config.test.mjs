/**
 * The endpoint a person already configured, read without a settings window.
 *
 * Two things are measured here, and they are the two that could be wrong without anyone
 * noticing. **The reader**: which keys of `~/.emrg/config.toml` this app takes, and what it
 * refuses to take. The file has an array of model tables four lines below the three keys this
 * app wants, and a reader that ignored the difference would pick up a `name` and a
 * `context_window` and call them an endpoint — so that case is a test rather than a comment.
 *
 * **The precedence**: the environment wins whole, and the two sources never merge. A merge
 * would be a server from one place and a model from the other, which nobody typed.
 *
 * Every fixture here is a file this test writes, so nothing depends on the machine it runs on
 * — the real config belongs to whoever is sitting at it, and a test that read it would pass or
 * fail by whose laptop it was.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  defaultConfigPath,
  readConfiguredEndpoint,
  tableOf,
  wordsHalfFrom,
} from './llm-config.js'

/** A file holding `text`, and the directory it lives in, to be removed by the caller. */
async function configFile(text) {
  const dir = await mkdtemp(join(tmpdir(), 'seek-llm-config-'))
  const path = join(dir, 'config.toml')
  await writeFile(path, text, 'utf8')
  return { dir, path }
}

const TRIO = `[llm]
base_url = "https://endpoint.test/v1"
api_key = "sk-a-key-of-33-characters-written-out!!"
model = "a-model"
`

test('the three keys are read, and nothing else is required', async () => {
  const { dir, path } = await configFile(TRIO)
  try {
    const read = readConfiguredEndpoint(path)
    assert.equal(read.refusal, null)
    assert.equal(read.baseUrl, 'https://endpoint.test/v1')
    assert.equal(read.apiKey, 'sk-a-key-of-33-characters-written-out!!')
    assert.equal(read.model, 'a-model')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a machine that never configured one is the ordinary case, not a refusal', async () => {
  // A person who installed Seek and never used the program this config belongs to has no
  // file, and must not be told something is broken because of it.
  const read = readConfiguredEndpoint(join(tmpdir(), 'seek-no-such-dir', 'config.toml'))
  assert.deepEqual(read, { refusal: null })
  assert.equal(wordsHalfFrom({ env: {}, config: read }), null)
})

test('two of the three keys is a sentence rather than a guess', async () => {
  // `model` is the one that cannot be defaulted: the chat call has to name the model it is
  // asked of, and an endpoint that lists many names is not an answer to which one was meant.
  const { dir, path } = await configFile(`[llm]
base_url = "https://endpoint.test/v1"
api_key = "a-key"
`)
  try {
    const read = readConfiguredEndpoint(path)
    assert.match(read.refusal, /'base_url', 'api_key'/, 'it names what is there')
    assert.match(read.refusal, /'model'/, 'and what is missing')
    assert.equal(read.baseUrl, undefined, 'and it does not half-answer')
    assert.equal(wordsHalfFrom({ env: {}, config: read }).refusal, read.refusal, 'the sentence reaches the caller')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the key never appears in the sentence, whatever is wrong with the file', async () => {
  // The refusal is drawn in the window and printed at start-up, so a sentence carrying the
  // credential would put it where nobody meant to put it.
  const secret = 'sk-do-not-print-this-anywhere-please'
  const { dir, path } = await configFile(`[llm]
base_url = "https://endpoint.test/v1"
api_key = "${secret}"
`)
  try {
    const read = readConfiguredEndpoint(path)
    assert.ok(read.refusal.length > 0)
    assert.equal(read.refusal.includes(secret), false, 'the value is not in the sentence')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an array of model tables is not the endpoint beside it', async () => {
  // The real file keeps `[[llm.models]]` rows four lines under the three keys, each with a
  // `name` and a `context_window`. Read as one table, the last model's name would become the
  // endpoint's model — a different model than the one configured, silently.
  const { dir, path } = await configFile(`[llm]
base_url = "https://endpoint.test/v1"
api_key = "a-key"
model = "the-configured-one"

[[llm.models]]
name = "some-other-model"
context_window = 1024000

[[llm.models]]
name = "a-third-model"
context_window = 256000
`)
  try {
    const read = readConfiguredEndpoint(path)
    assert.equal(read.model, 'the-configured-one')
    assert.equal(read.baseUrl, 'https://endpoint.test/v1')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('keys in another table are not read at all', async () => {
  const { dir, path } = await configFile(`[gui]
base_url = "https://not-this-one.test/v1"
model = "not-this-one"

[update]
model = "neither-is-this"
`)
  try {
    const read = readConfiguredEndpoint(path)
    assert.deepEqual(read, { refusal: null })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('comments, blank lines and both kinds of quote are read as the file states them', async () => {
  const { dir, path } = await configFile(`# the default endpoint
[llm]
# the origin this app may talk to
base_url = 'https://single.test/v1'   # a trailing comment
api_key = "escaped\\ttab"
model = a-bare-value

[other]
model = "ignored"
`)
  try {
    const read = readConfiguredEndpoint(path)
    assert.equal(read.baseUrl, 'https://single.test/v1')
    assert.equal(read.apiKey, 'escaped\ttab', 'a basic string is unescaped')
    assert.equal(read.model, 'a-bare-value', 'a bare value is taken as it stands')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the environment wins whole, over a config that says something else entirely', async () => {
  const config = {
    baseUrl: 'https://from-the-config.test/v1',
    apiKey: 'the-config-key',
    model: 'the-config-model',
    refusal: null,
  }
  const half = wordsHalfFrom({
    env: {
      SEEK_WORK_SERVER: 'https://from-the-environment.test/v1',
      SEEK_WORK_MODEL: 'the-environment-model',
      SEEK_API_KEY: 'the-environment-key',
    },
    config,
  })
  assert.equal(half.from, 'environment')
  assert.equal(half.workServer, 'https://from-the-environment.test/v1')
  assert.equal(half.workModel, 'the-environment-model')
  assert.equal(half.workApiKey, 'the-environment-key', 'one environment, one key')
})

test('a name in the environment is not half a name plus half a config', async () => {
  // Nobody typed a pairing of the environment's server and the config's model, so the config
  // is not consulted at all — and `stageTwoFor` refuses the unpaired name in its own words.
  const half = wordsHalfFrom({
    env: { SEEK_WORK_MODEL: 'only-a-name' },
    config: { baseUrl: 'https://from-the-config.test/v1', apiKey: 'k', model: 'm', refusal: null },
  })
  assert.equal(half.from, 'environment')
  assert.equal(half.workServer, undefined, 'no server came from anywhere else')
  assert.equal(half.workModel, 'only-a-name')
})

test('with the environment silent, the configured endpoint is the words half', async () => {
  const half = wordsHalfFrom({
    env: {},
    config: {
      baseUrl: 'https://from-the-config.test/v1',
      apiKey: 'the-config-key',
      model: 'the-config-model',
      refusal: null,
    },
  })
  assert.equal(half.from, 'config')
  assert.equal(half.workServer, 'https://from-the-config.test/v1')
  assert.equal(half.workModel, 'the-config-model')
  assert.equal(half.workApiKey, 'the-config-key', "the config's key belongs to that origin")
  assert.equal(half.refusal, null)
})

test('a blank variable is not a variable, on either side of the rule', async () => {
  const half = wordsHalfFrom({
    env: { SEEK_WORK_SERVER: '   ', SEEK_WORK_MODEL: '' },
    config: { baseUrl: 'https://from-the-config.test/v1', apiKey: 'k', model: 'm', refusal: null },
  })
  assert.equal(half.from, 'config', 'blank counts as silence, as it does for every other variable')
})

test('the path is the one the config lives at, under the home it is given', () => {
  assert.equal(defaultConfigPath('/Users/someone'), '/Users/someone/.emrg/config.toml')
})

test('the table reader keeps the last value of a repeated key, as a TOML file means it', () => {
  // Not a case the real file exercises; it is here because "last one wins" is the answer that
  // needs no second rule, and a reader that kept the first would be a different file.
  const table = tableOf('[llm]\nmodel = "first"\nmodel = "second"\n', 'llm')
  assert.equal(table.get('model'), 'second')
})

// ---- the middle source: this app's own settings -----------------------------------------

/**
 * Seek's own `settings.json` sits between the environment and the config of another program.
 *
 * The order is the one a person would expect and the one the settings page promises: what they
 * started the app with, then what they chose inside it, then what was already configured on the
 * machine before Seek existed. Each source is used whole — the no-merge rule holds for three
 * sources as it did for two — so a settings file that names an address and stops is a refusal
 * rather than a config endpoint pulled in to fill the gap.
 */
test('a settings endpoint is used when the environment says nothing', () => {
  const half = wordsHalfFrom({
    settings: { baseUrl: 'https://own.test/v1', model: 'own-model', apiKey: 'sk-own' },
  })
  assert.equal(half.from, 'settings')
  assert.equal(half.workServer, 'https://own.test/v1')
  assert.equal(half.workModel, 'own-model')
  assert.equal(half.workApiKey, 'sk-own')
  assert.equal(half.refusal, null)
})

test('the environment still wins over settings, whole', () => {
  const half = wordsHalfFrom({
    env: { SEEK_WORK_SERVER: 'https://env.test/v1', SEEK_WORK_MODEL: 'env-model' },
    settings: { baseUrl: 'https://own.test/v1', model: 'own-model' },
  })
  assert.equal(half.from, 'environment')
  assert.equal(half.workServer, 'https://env.test/v1')
  assert.equal(half.workModel, 'env-model')
})

test('settings win over the config of another program', () => {
  const half = wordsHalfFrom({
    settings: { baseUrl: 'https://own.test/v1', model: 'own-model' },
    config: { baseUrl: 'https://other.test/v1', model: 'other-model', apiKey: 'sk-other' },
  })
  assert.equal(half.from, 'settings')
  assert.equal(half.workServer, 'https://own.test/v1')
  // and the two never merge: the key is the settings file's, which has none.
  assert.equal(half.workApiKey, undefined)
})

test('an endpoint with no key is used as it stands', () => {
  const half = wordsHalfFrom({ settings: { baseUrl: 'http://127.0.0.1:8080', model: 'local' } })
  assert.equal(half.from, 'settings')
  assert.equal(half.workApiKey, undefined)
  assert.equal(half.refusal, null)
})

test('a half-written settings file is refused rather than filled in from the config', () => {
  const half = wordsHalfFrom({
    settings: { refusal: 'settings.json names a model and no address' },
    config: { baseUrl: 'https://other.test/v1', model: 'other-model', apiKey: 'sk-other' },
  })
  assert.equal(half.from, 'settings')
  assert.equal(half.workServer, undefined)
  assert.match(half.refusal, /a model and no address/)
})

test('a machine that never opened the settings page still reads the config', () => {
  const half = wordsHalfFrom({
    settings: undefined,
    config: { baseUrl: 'https://other.test/v1', model: 'other-model', apiKey: 'sk-other' },
  })
  assert.equal(half.from, 'config')
  assert.equal(half.workServer, 'https://other.test/v1')
})
