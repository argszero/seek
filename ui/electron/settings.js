/**
 * This app's own settings file, and the one place a person's own words half is kept.
 *
 * **Why a file of ours, and not the config of another program.** Until now the words half
 * could only be pointed anywhere by `~/.emrg/config.toml` — the config of the host's agent
 * runtime, which happens to live on the same machine. Reading it was the right way to make a
 * downloaded app reach an endpoint without a terminal, and it stays as the fallback for
 * exactly that person. But it is another program's file: Seek has no business writing it, and
 * a person who never ran that program has no file to edit. A settings window needs somewhere
 * to write that is ours, and this is it.
 *
 * **Where.** `settings.json` in the app's own data directory (`app.getPath('userData')`,
 * which is `~/Library/Application Support/Seek`). Beside it, and not inside, is
 * `seek-data/seek.json` — the store, one per account. The two are different kinds of thing:
 * a store is a world (rooms, people, messages) and belongs to an account, while this file is
 * the machine's own preferences and belongs to none.
 *
 * **The key is in here, in the clear, with the file at 0600.** That is the same choice the
 * config next door makes, and it is stated rather than hidden: a local app that has to send a
 * bearer token cannot both keep the token out of the file and send it after a restart without
 * a keychain, and the keychain is a second thing to get wrong before the first thing works.
 * What the file must never do is reach a log, a refusal or a snapshot — so everything below
 * returns values, and nothing here prints.
 *
 * **A broken file is a sentence, not a crash.** This is read during start-up, before a window
 * exists: a throw here would leave a person staring at nothing, which is the failure
 * `openHostOrRefuse` was written to stop one layer down. Unreadable or unparseable means "no
 * settings and a reason", and the app carries on with the fallbacks it had before this file
 * existed.
 */

const { chmod, mkdir, readFile, rename, writeFile } = require('node:fs/promises')
const { dirname, join } = require('node:path')

/** The settings file, for a given `userData` directory. */
function defaultSettingsPath(userData) {
  return join(userData, 'settings.json')
}

/**
 * What the file says, or why it could not be used.
 *
 * Three answers, and they are distinguishable on purpose: parsed settings, no settings at all
 * (no file — the ordinary case for every person who never opened the page), and a `refusal`
 * when the file is there and unusable. Nothing is defaulted and nothing is invented: an
 * unknown key is kept, because this file will hold more than the endpoint one day, but it is
 * never read.
 */
async function readSettings(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return { settings: {}, refusal: null }
    return {
      settings: {},
      refusal: `${path} could not be read (${error.message}), so the settings in it are not in use`,
    }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return {
      settings: {},
      refusal: `${path} is not readable JSON (${error.message}), so the settings in it are not in use`,
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { settings: {}, refusal: `${path} holds ${typeof parsed} rather than an object` }
  }
  return { settings: parsed, refusal: null }
}

/**
 * The endpoint named in this file, or why it cannot be used, or `undefined` when it says nothing.
 *
 * **Two keys are required and the third is not.** `base_url` and `model` name a request; a key
 * is a credential, and an endpoint on this machine — the server this app starts, a llama.cpp
 * next door — takes none. Requiring all three here would make the app unable to point its words
 * half at a local model, which is a thing it can already do.
 *
 * A half-written pair is a refusal rather than a fallback: someone typed a base and stopped,
 * and quietly reaching for another program's endpoint instead would answer a question nobody
 * asked. Silence — no `llm` object at all — is the fallback's business, not this function's.
 */
function llmOf(settings) {
  const table = settings?.llm
  if (table === undefined || table === null) return undefined
  if (typeof table !== 'object' || Array.isArray(table)) {
    return { refusal: 'the llm entry in settings.json is not an object' }
  }
  const baseUrl = text(table.baseUrl)
  const model = text(table.model)
  const apiKey = text(table.apiKey)
  if (baseUrl === undefined && model === undefined && apiKey === undefined) return undefined
  if (baseUrl === undefined || model === undefined) {
    const which =
      baseUrl === undefined && model === undefined
        ? 'neither an address nor a model'
        : baseUrl === undefined
          ? 'a model and no address'
          : 'an address and no model'
    return {
      refusal:
        `settings.json names ${which}: a turn has to know both, so this endpoint is not one ` +
        'this app may use',
    }
  }
  return { baseUrl, model, apiKey }
}

/**
 * Write one patch into the file, keeping everything else in it.
 *
 * A shallow merge per top-level key and a merge one level inside `llm`, because the endpoint
 * arrives one field at a time from a form: saving an address must not erase the key in the
 * same table, and saving the endpoint must not erase whatever else this file grows later.
 *
 * Written beside and renamed, so a launch that reads while a save is in flight sees either the
 * old file or the new one and never half of either. Mode 0600 on the way in rather than after,
 * because the bytes are already on disk by the time a `chmod` would run.
 */
async function writeSettings(path, patch) {
  const current = (await readSettings(path)).settings
  const next = { ...current }
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === undefined) continue
    next[key] =
      key === 'llm' && isPlainObject(value) && isPlainObject(current.llm)
        ? { ...current.llm, ...value }
        : value
  }
  // The data directory exists because the app made it for the store, but a save is not the
  // place to find out otherwise: a first run on a machine where nothing has been written yet
  // would fail here with `ENOENT` instead of saving the endpoint.
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await chmod(temporary, 0o600).catch(() => {})
  await rename(temporary, path)
  return next
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A value that was set to something, or `undefined` — blank is not a setting. */
function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

module.exports = { defaultSettingsPath, llmOf, readSettings, writeSettings }
