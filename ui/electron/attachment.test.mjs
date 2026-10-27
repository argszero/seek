/**
 * A file in a message: the third kind, and every end of the two calls that carry it.
 *
 * `docs/design/agent-lifecycle.md` §2 requirement 2 says messages carry screenshots, files and
 * tool cards; until this slice the window could carry one of the three. A picture is `media` —
 * a `{key, mime}` pair the column draws and the judgement reads — and a file is a different
 * fact: bytes no reader here opens, a name the person chose, a size, and a type that decides
 * which application on their machine opens it. Two carriers because they are two kinds, which
 * is the whole of what `MessageFile` is.
 *
 * **What this file is for.** A capability in this window is a chain of five surfaces and it is
 * only real when all five exist: the page that presses something, the bridge that names a
 * channel, the main process that handles it, the demo host that answers it, and the words the
 * person reads. Three of the five have been missing at once before, and each time every other
 * test stayed green — so the tests below read the surfaces rather than trusting one of them.
 *
 * The claims that are **not** here belong to other files and are not repeated: the kernel's two
 * refusals are `src/delivery.test.ts`'s (`fileFor`), the vocabulary comparison between the
 * bridge and the main process is `documentation.test.mjs`'s, and the two README sentences are
 * claimed there too.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { catalogueFor } from '../../src/i18n.ts'
import { bindCatalogue, fileSize } from '../src/catalogue.mjs'

const HERE = import.meta.dirname
const ROOT = join(HERE, '..', '..')
const read = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8')

const APP = read('ui', 'src', 'App.jsx')
const TOPICS = read('ui', 'src', 'Topics.jsx')
const SHELL = read('ui', 'src', 'styles', 'shell.css')
const ICONS = read('ui', 'src', 'icons.jsx')
const PRELOAD = read('ui', 'electron', 'preload.js')
const MAIN = read('ui', 'electron', 'main.js')
const SNAPSHOT = read('ui', 'electron', 'snapshot.js')
const HOST = read('ui', 'electron', 'host.js')
const MEDIA = read('ui', 'electron', 'media.js')
const DEMO = read('prototype', 'src', 'fake-host.js')
const TYPES = read('src', 'types.ts')
const DELIVERY = read('src', 'delivery.ts')

/** How many times `needle` appears in `haystack`. */
const count = (haystack, needle) => haystack.split(needle).length - 1

/** The slice of a file between an opener and the first closer after it. */
function slice(text, opener, closer) {
  const from = text.indexOf(opener)
  assert.notEqual(from, -1, `${opener} is gone, so this check reads nothing`)
  const to = text.indexOf(closer, from)
  assert.notEqual(to, -1, `${opener} has no ${closer} after it`)
  return text.slice(from, to)
}

/** One rule's declarations, comments removed. */
function rule(css, selector) {
  const opener = `${selector} {`
  const from = css.indexOf(opener)
  assert.notEqual(from, -1, `the sheet has no rule for ${selector}`)
  const to = css.indexOf('}', from)
  const body = css.slice(from + opener.length, to).replace(/\/\*[\s\S]*?\*\//g, '')
  const declarations = {}
  for (const line of body.split('\n')) {
    const text = line.trim().replace(/;$/, '')
    if (text === '' || !text.includes(':')) continue
    const at = text.indexOf(':')
    declarations[text.slice(0, at).trim()] = text.slice(at + 1).trim()
  }
  return declarations
}

test('a file is the kernel’s third kind, and it carries the four facts a reader needs', () => {
  // The kind exists among the closed set, not beside it: `deriveKind()` (`src/delivery.ts`)
  // answers with one of these, and a kind added outside the union is a message no reader has
  // a branch for.
  assert.match(TYPES, /export type MessageKind = [^;]*'file'/)

  const shape = slice(TYPES, 'export interface MessageFile {', '\n}')
  for (const field of ['key: string', 'name: string', 'size: number', 'mime: string']) {
    assert.ok(shape.includes(field), `MessageFile is missing ${field}, so a row cannot draw it`)
  }
  // The carrier is on the message, and it is optional because two kinds of message do not
  // have one. `fileFor()` makes the two halves an invariant; this only says the field is there.
  assert.match(TYPES, /\n  file\?: MessageFile;/)
})

test('both halves of the carrier are refused by the kernel rather than by a caller', () => {
  // A `file` with no attachment draws a row over nothing, and an attachment on a `text`
  // message is bytes every reader drops in silence. Both sentences are the kernel's, so both
  // exits of `fileFor()` are checked here rather than trusted to whoever posts.
  assert.match(DELIVERY, /function fileFor\(/)
  assert.match(DELIVERY, /a file message with no file/)
  assert.match(DELIVERY, /an attachment on a \$\{JSON\.stringify\(kind\)\} message/)
  // And the copy is a copy: a caller still holding the object must not be able to rename a
  // file under a message already delivered.
  assert.match(DELIVERY, /function copyOfFile\(/)
})

test('the five surfaces of “attach a file” all exist', () => {
  // 1. The page presses something and calls the bridge.
  assert.match(APP, /window\.seekHost\.attachFile\(\)/)
  // 2. The bridge names a channel.
  assert.match(PRELOAD, /attachFile: \(\) => ipcRenderer\.invoke\('seek:attach-file'\)/)
  // 3. The main process handles it, and it is the one that writes the bytes.
  assert.match(MAIN, /ipcMain\.handle\('seek:attach-file'/)
  assert.match(MAIN, /saveAttachment\(STORE_FILE/)
  // 4. The demo answers it, or the prototype shows a button nothing answers.
  assert.match(DEMO, /attachFile: async \(\) =>/)
  // 5. The mark a person presses is drawn, in both composers, and it is the file glyph.
  assert.equal(count(APP, 'data-file="open"'), 1, 'the room composer has a file mark')
  assert.equal(count(APP, 'data-file="open-thread"'), 1, 'and so does the thread composer')
  assert.equal(count(APP, '<Icon name="file" size={COMPOSER_ICON} />'), 2)
  assert.match(ICONS, /\n  file: \[\n/)
})

test('the bytes are kept beside the store, under a key that is not the person’s name', () => {
  // A key built from a name is sometimes a path — the same rule `saveMedia` states — so the
  // key is a stamp and a salt with the extension kept, and the name travels as a fact in the
  // message rather than as a filename on disk.
  const key = slice(MEDIA, 'function attachmentKeyFor(name) {', '\n}')
  assert.match(key, /Date\.now\(\)\.toString\(36\)/)
  assert.doesNotMatch(key, /return [^;\n]*wanted/, 'the key is the person’s name again')
  // A file is not refused for its type: an attachment is opened by the machine, not drawn
  // here, so the answer for an unknown extension is the type that means “ask the person”.
  assert.match(MEDIA, /application\/octet-stream/)
  // The size is measured, never believed: it is what the row says about the file.
  const save = slice(MEDIA, 'function saveAttachment(', '\n}')
  assert.match(save, /size: bytes\.length/)
  // And there is a stated ceiling rather than a discovered one.
  assert.match(MAIN, /const ATTACHMENT_LIMIT = 25 \* 1024 \* 1024/)
})

test('the snapshot hands the four facts over, and null rather than undefined', () => {
  const from = SNAPSHOT.indexOf('file: message.file')
  assert.notEqual(from, -1, 'the snapshot does not hand the attachment over at all')
  const body = SNAPSHOT.slice(from, from + 400)
  for (const field of ['key:', 'name:', 'size:', 'mime:']) {
    assert.ok(body.includes(field), `the snapshot drops ${field}, so the row cannot draw it`)
  }
  // Two kinds of nothing is what a renderer draws wrongly: `media` is already `null` when it
  // has nothing, and this follows it for the same reason.
  assert.match(SNAPSHOT, /: null,\n/)
})

test('the message column draws the name and the size, and the name is the way in', () => {
  // Drawn because the kernel's kind says so — never because the words look like a filename.
  assert.match(APP, /message\.kind === 'file' && message\.file/)
  assert.match(APP, /\{attachment && <FileRow file=\{attachment\} \/>\}/)
  const row = slice(APP, 'function FileRow(', '\n/**')
  assert.match(row, /\{file\.name\}/, 'the row does not say which file it is')
  assert.match(row, /\{fileSize\(file\.size\)\}/, 'the row does not say how big it is')
  // The mime is not drawn: a person reading a row that says
  // `application/vnd.openxmlformats-…` has been told something they did not ask.
  assert.doesNotMatch(row, /\{file\.mime\}/)
  // Pressing it is the call, and the refusal is drawn in the main process's own words.
  assert.match(row, /window\.seekHost\.openFile\(file\)/)
  assert.match(row, /data-file-refused/)
})

test('the five surfaces of “open that file” all exist', () => {
  assert.match(PRELOAD, /openFile: \(reference\) => ipcRenderer\.invoke\('seek:open-file', reference\)/)
  assert.match(MAIN, /ipcMain\.handle\('seek:open-file'/)
  // The copy is written under the name the person gave it, because the key is opaque: handing
  // the system `om-lq3k2-8f1a.pdf` would open a file called that.
  const handler = slice(MAIN, "ipcMain.handle('seek:open-file'", '\n})')
  assert.match(handler, /basename\(name\)/)
  assert.match(handler, /shell\.openPath\(target\)/)
  assert.match(DEMO, /openFile: async \(reference\) =>/)
})

test('the words an attachment is drawn with are in both catalogues, and asked for', () => {
  const keys = [
    'ui.chat.emoji-hint',
    'ui.chat.attach-file',
    'ui.chat.file-open',
    'ui.chat.file-opening',
    'ui.chat.said.file',
    'ui.topics.said.file',
  ]
  const en = JSON.parse(read('src', 'i18n', 'en.json')).messages
  const zh = JSON.parse(read('src', 'i18n', 'zh-CN.json')).messages
  for (const key of keys) {
    assert.equal(typeof en[key], 'string', `en.json has no ${key}`)
    assert.equal(typeof zh[key], 'string', `zh-CN.json has no ${key}`)
    // Asked for by one of the two surfaces, and a key nobody asks for is a claim nobody checks.
    assert.ok(
      APP.includes(`'${key}'`) || TOPICS.includes(`'${key}'`),
      `${key} is shipped and never used`,
    )
  }
})

test('every class the row and the picker are drawn with has a rule of its own', () => {
  // The seventh shape of drift this repository has paid for: a new mark reuses a class name
  // that has never had a rule, and the browser's own default is drawn — a `<button>` at 153×21
  // in the platform's font — while both suites stay green.
  for (const selector of [
    '.emoji-pop',
    '.emoji-pick',
    '.msg-file',
    '.msg-file-open',
    '.msg-file-mark',
    '.msg-file-name',
    '.msg-file-size',
    '.msg-file-state',
  ]) {
    const declarations = rule(SHELL, selector)
    assert.ok(Object.keys(declarations).length > 0, `${selector} has an empty rule`)
  }
  // The picker is anchored, and the anchor is the marks' row: it opens above the mark that
  // opened it rather than over the field it writes into.
  assert.match(rule(SHELL, '.emoji-pop').position, /absolute/)
  // The picker is anchored to the field, and its bottom edge is measured from the field's own
  // top: anchored to the marks' row it landed 32px inside the field and covered the words.
  assert.match(rule(SHELL, '.composer-box').position, /relative/)
  assert.match(rule(SHELL, '.emoji-pop').bottom, /calc\(100% \+ 8px\)/)
})

test('the picker writes into the words and never into the store', () => {
  // An emoji in a sentence is a character; a reaction is an `emoji_type` this store counts
  // operators under. Confusing the two would make a smiley typed into a message a row of
  // reactions under it.
  const insert = slice(APP, 'function insertEmoji(where, glyph) {', '\n  }\n')
  assert.doesNotMatch(insert, /seekHost/, 'the picker reaches the store, so it is a reaction')
  assert.match(insert, /selectionStart/)
  assert.match(insert, /pendingCaret\.current = /)
  // The caret comes back after the re-render, or an emoji picked mid-sentence sends the caret
  // to the end of the line.
  assert.match(APP, /pending\.field\.setSelectionRange\(pending\.at, pending\.at\)/)
  // The set is the prototype's forty glyphs, five rows of eight.
  const table = slice(APP, 'const DRAFT_EMOJI = [', '\n]')
  assert.equal(count(table, "'"), 40 * 2, 'the emoji set is not the prototype’s forty')
})

test('a size is written in the unit its magnitude asks for, in the language’s own form', () => {
  // The unit is arithmetic; how it is written is the locale's, so no catalogue key holds it —
  // and the two languages really do write the same byte count differently.
  bindCatalogue(catalogueFor('en'))
  assert.equal(fileSize(512), '512B')
  assert.equal(fileSize(18_432), '18.4kB')
  assert.equal(fileSize(3_400_000), '3.4MB')
  assert.equal(fileSize(2_200_000_000), '2.2GB')

  bindCatalogue(catalogueFor('zh-CN'))
  assert.equal(fileSize(512), '512 B')
  assert.equal(fileSize(18_432), '18.4 kB')
  assert.equal(fileSize(3_400_000), '3.4 MB')

  // A store that names something absurd draws a number rather than `NaN`, which is the one
  // reading a person would think was their file's fault.
  assert.equal(fileSize(-1), fileSize(0))
  assert.equal(fileSize('not a size'), fileSize(0))
})

test('the conversation list says which file rather than “nothing”', () => {
  // A room whose last message was a spreadsheet otherwise reads as a room somebody spoke in
  // and said nothing, with the thing they sent one click away — the same failure
  // `ui.chat.said.picture` exists for.
  // The branch is pinned whole — its condition and its body, one after the other — rather
  // than by looking for the two tokens somewhere in the function. A guard that only checks
  // that the words are present passes a branch rewritten to `if (false && …)`, which is the
  // mutation this assertion was widened for.
  const second = slice(APP, 'function lastLineOf(message) {', '\n}')
  assert.match(
    second,
    /\n  if \(message\?\.kind === 'file' && message\.file\) \{\n    return t\('ui\.chat\.said\.file', \{ name: message\.file\.name \}\)\n  \}/,
  )
  const topics = slice(TOPICS, 'function said(message) {', '\n}')
  assert.match(
    topics,
    /\n  if \(message\.kind === 'file' && message\.file\) \{\n    return t\('ui\.topics\.said\.file', \{ name: message\.file\.name \}\)\n  \}/,
  )
})

test('the kernel keeps the attachment out of what a bot is handed', () => {
  // A file is not a picture: nothing in this build reads its bytes to decide anything, so the
  // judgement is handed no part of it. The turn's own inputs (`src/box.ts`) take `media` and
  // have no field for an attachment — which is why this is a check and not a field.
  assert.doesNotMatch(read('src', 'box.ts'), /MessageFile|\bfile\?:/)
  assert.match(HOST, /function fileOf\(file\)/)
  assert.match(HOST, /file: forwarding \? undefined : fileOf\(input\?\.file\)/)
})
