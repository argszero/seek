/**
 * The endpoint already configured on this machine, read for the half that writes the words.
 *
 * **Why this file exists.** A downloaded app is opened by double-clicking, and a double-click
 * cannot set an environment variable. The three variables the words half takes —
 * `SEEK_WORK_SERVER`, `SEEK_WORK_MODEL`, `SEEK_API_KEY` — therefore reached only a run started
 * from a terminal, so a person who installed the package could never point that half anywhere.
 * What was left is the model the package carries, and that model does not call the tool a turn
 * speaks through: measured on three of them, prose and zero tool calls, so the room stayed
 * empty. This file is what closes that gap without a settings window.
 *
 * **What it reads, and what it will not invent.** One file — `~/.emrg/config.toml`, the config
 * the host's own agent runtime runs on — and inside it the `[llm]` table's three plain string
 * keys: `base_url`, `api_key`, `model`. Nothing else in that file is read. Nothing is
 * defaulted: a table that carries two of the three is a sentence rather than a guess, because
 * the chat call has to name the model it is asked of, and an endpoint named without one cannot
 * be asked for a turn at all.
 *
 * **The environment still wins, and the sources never merge.** These are the settings of
 * another program on the same machine, so they are used only where the person said nothing:
 * with `SEEK_WORK_SERVER` or `SEEK_WORK_MODEL` set, this file is not consulted. Merging them
 * would produce a server from one source and a model from the other — a pairing nobody typed.
 *
 * **Three sources now, in the order a person would expect.** The environment first (a run
 * started from a terminal overrides files it never edited), then Seek's own `settings.json`
 * — what someone chose inside the app, which is the ordinary case once there is a settings
 * page — and only then this file, for a machine where the other program was configured first.
 * Each source is still used whole or not at all, so the no-merge rule above holds for all
 * three rather than only for the first two.
 *
 * **A configured endpoint is not a server the app was *told* about.** `server.js` answers
 * `named` for an origin in the environment and then starts nothing, and that rule is untouched
 * here: the environment is silent in this path, so the app still fetches its weights and starts
 * the server it carries for the *judgement*, which no hosted endpoint can serve — stage 1 reads
 * token probabilities (`src/llama.ts`), and a hosted endpoint reports text.
 *
 * The key is never written to a log, a refusal or a snapshot: a refusal names the *key's name*
 * and never its value, and the only places the value goes are the `Authorization` headers of
 * the requests it belongs to.
 */

const { readFileSync } = require('node:fs')
const { homedir } = require('node:os')
const { join } = require('node:path')

/** The three keys, in the order a refusal lists what is there and what is not. */
const KEYS = ['base_url', 'api_key', 'model']

/**
 * Where the file lives.
 *
 * A function rather than a constant, so the caller says which home it means: `main.js` passes
 * the one Electron reports for the user it is running as, and a test passes a directory it
 * made. Reading `homedir()` at module load would answer for whoever imported it first.
 */
function defaultConfigPath(home = homedir()) {
  return join(home, '.emrg', 'config.toml')
}

/**
 * One table's plain keys, out of a TOML file.
 *
 * A whole TOML parser is not what this needs: the file is read for three string keys of one
 * table, and a dependency for that would be a second thing to keep correct. What is supported
 * is exactly what that file uses for those keys — `[table]` headers, `key = value`, comments,
 * blank lines. **An array of tables is a different table**, so `[[llm.models]]` and its
 * `name`/`context_window` rows are never read as the default trio sitting above them; that is
 * the one distinction worth spelling out, because the two live four lines apart in the file.
 *
 * Anything this reader does not understand is skipped rather than guessed at: a line it cannot
 * read becomes a key that is absent, and an absent key is one of the refusals below.
 */
function tableOf(text, section) {
  const found = new Map()
  let inside = false
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    if (line.startsWith('[')) {
      // `[[llm.models]]` does not equal `[llm]`, which is the whole reason this comparison is
      // on the whole header rather than on the name inside the brackets.
      inside = line === `[${section}]`
      continue
    }
    if (!inside) continue
    const match = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line)
    if (match === null) continue
    found.set(match[1], unquote(match[2]))
  }
  return found
}

/** A TOML value as a string: either kind of quote, or bare with a trailing comment gone. */
function unquote(value) {
  const trimmed = value.trim()
  const quote = trimmed[0]
  if (quote === '"' || quote === "'") {
    const end = trimmed.lastIndexOf(quote)
    if (end > 0) {
      const body = trimmed.slice(1, end)
      // A literal (single-quoted) value has no escapes at all; a basic one has the three that
      // can appear in a URL or a key. Anything else is left as it stands, which is what a
      // reader that refuses to guess does.
      if (quote === "'") return body
      return body.replace(/\\(["\\nt])/g, (_one, letter) =>
        letter === 'n' ? '\n' : letter === 't' ? '\t' : letter,
      )
    }
  }
  const comment = trimmed.indexOf(' #')
  return (comment === -1 ? trimmed : trimmed.slice(0, comment)).trim()
}

/**
 * What the configured `[llm]` names, or why it cannot be used.
 *
 * Three answers, and they are distinguishable on purpose:
 *
 * - all three keys present → `baseUrl`, `apiKey`, `model`;
 * - the file is there and says something incomplete or unreadable → `refusal`, one sentence;
 * - nothing is configured → neither field, which is **not** a failure: a machine that never
 *   ran the program this config belongs to is the ordinary case.
 *
 * A missing file is that third answer rather than the second, and that is a decision: a person
 * who installed Seek and never used EMRG should not be handed a refusal for a file they never
 * had.
 */
function readConfiguredEndpoint(configPath = defaultConfigPath()) {
  let text
  try {
    text = readFileSync(configPath, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return { refusal: null }
    return {
      refusal:
        `the endpoint configured in ${configPath} could not be read (${error.message}): the ` +
        'words half is left with the server this app carries, which cannot write a turn',
    }
  }

  const table = tableOf(text, 'llm')
  const named = KEYS.filter((key) => (table.get(key) ?? '').trim() !== '')
  if (named.length === 0) return { refusal: null }

  if (named.length < KEYS.length) {
    const missing = KEYS.filter((key) => !named.includes(key))
    return {
      refusal:
        `${configPath} names ${named.map((key) => `'${key}'`).join(', ')} under [llm] and not ` +
        `${missing.map((key) => `'${key}'`).join(', ')}: a turn has to name the model it is ` +
        'asked of, so an endpoint missing one of the three is not one this app may use',
    }
  }

  return {
    baseUrl: table.get('base_url').trim(),
    apiKey: table.get('api_key').trim(),
    model: table.get('model').trim(),
    refusal: null,
  }
}

/**
 * Which server writes the words, which model on it, and which key that server is given.
 *
 * Two sources, and one of them wins whole: an environment that names the words half is used as
 * it stands (including a name given with no server, which `stageTwoFor` refuses in its own
 * words), and the config is read only when the environment is silent. `null` means nobody named
 * one, which leaves that half on the server the app carries — the shipped state until this file
 * existed.
 *
 * `from` is what the app says out loud at start-up and what decides whether a weights failure
 * takes this half down with it: a configured endpoint does not depend on those files, so it is
 * not refused along with the judgement.
 */
function wordsHalfFrom({ env, settings, config } = {}) {
  const server = textOf(env?.SEEK_WORK_SERVER)
  const model = textOf(env?.SEEK_WORK_MODEL)
  if (server !== undefined || model !== undefined) {
    return {
      workServer: server,
      workModel: model,
      workApiKey: textOf(env?.SEEK_API_KEY),
      from: 'environment',
      refusal: null,
    }
  }
  // This app's own settings come second: they are the answer a person gave inside Seek, so
  // they outrank the config of another program on the same machine — but not the environment,
  // which is how a run started from a terminal overrides a file it did not edit.
  if (settings?.refusal) return { from: 'settings', refusal: settings.refusal }
  if (settings?.baseUrl !== undefined) {
    return {
      workServer: settings.baseUrl,
      workModel: settings.model,
      workApiKey: settings.apiKey,
      from: 'settings',
      refusal: null,
    }
  }
  if (config?.refusal) return { from: 'config', refusal: config.refusal }
  if (config?.baseUrl === undefined) return null
  return {
    workServer: config.baseUrl,
    workModel: config.model,
    workApiKey: config.apiKey,
    from: 'config',
    refusal: null,
  }
}

/** A variable that was set to something, or `undefined` — blank is not an answer. */
function textOf(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

module.exports = { defaultConfigPath, readConfiguredEndpoint, tableOf, wordsHalfFrom }
