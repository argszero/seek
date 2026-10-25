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
 * The prose has gone wrong here twice, both times in the same direction and both times
 * silently: the status paragraph said the interface was not wired to a model *after* it was
 * (`#63`), and said it again *after* the second half was wired (`#66`). Nothing failed
 * either time — `src/docs.test.ts` compares the twin documents' sections and points,
 * `src/counts.test.ts` counts files, lines and tests, and a sentence is neither of those.
 * Only a person rereading the paragraph could catch it, which is exactly the kind of check
 * that stops happening.
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
 * hand edit — `#76` of this README names `v0.1.0` in so many words, which is what makes the
 * paragraph checkable by a reader at all.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

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
