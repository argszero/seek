'use strict'

/**
 * The client's half of a picture message.
 *
 * The design settles what the *kernel* carries: a message whose `kind` is
 * `image` names one `{key, mime}` reference in `media`, and **the bytes are not in the
 * store** — the store rewrites its shards whole on every save, so an inlined picture would
 * be re-serialised on every unrelated turn. The row says the rest in one clause: *"naming
 * a blob is a client's scheme"*. This file is that scheme, and nothing else in the app
 * invents a second one.
 *
 * **Two files, because a key and a path are not the same thing.** `key` is what the kernel
 * stores and what a reader is handed: a bare file name inside the media directory. Turning
 * a key back into a path is the one step where a stored string becomes a filesystem read,
 * so it is a single function that refuses anything which is not a plain name — a key of
 * `../../.ssh/id_rsa` would otherwise be a store that can read the disk, and the store is a
 * file a person edits by hand.
 *
 * **Why beside the store rather than somewhere the app owns.** The store is the thing this
 * product keeps and a person can point at (`SEEK_DATA_DIR`, or the default under the app's
 * own data path). A picture whose bytes lived in a cache directory the app may clear would
 * be a message that says "there is a picture" and then shows nothing — the silent half-loss
 * this file's refusals exist to prevent. Beside the store, a copied `seek.json` plus its
 * `media/` directory is the whole conversation, which is what "the data stays on your
 * machine" has to mean to be worth saying.
 */

const { mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { dirname, join } = require('node:path')

/** Where the bytes go: one directory beside the store, whatever the store is called. */
const MEDIA_DIR_NAME = 'media'

/**
 * The one refusal on this edge a person can meet, as a word rather than a sentence.
 *
 * A message may name a picture whose bytes are no longer beside the store. What the window does
 * with that is say so in the language it is running in, so what crosses to the renderer is
 * *which* refusal this is and never the wording — `docs/host-rulings.md`, "The window does not
 * speak to a developer", keeps the diagnosis in the log. The sentence this module throws with is
 * therefore written for whoever reads stderr: a store moved without its `media/` directory.
 */
const PICTURE_GONE = 'gone'

/**
 * The extension each mime writes, and the mime each extension reads back.
 *
 * A closed list rather than a derived one: the kernel refuses a `media.mime` that does not
 * start with `image/` (`mediaFor` in `src/delivery.ts`), so the set of pictures this app
 * can send is exactly the set it can draw. An extension guessed from the mime string would
 * write `image/svg+xml` as `.svg+xml`, which is a file macOS cannot open by double-click.
 */
const BY_MIME = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
])

/**
 * Every extension that names one of those, read back to its mime.
 *
 * Built from `BY_MIME` and then widened by the aliases, because a mime has one extension
 * this app *writes* and several a person's file may *have*: macOS writes `.jpeg` as readily
 * as `.jpg`, and a reader that knew only the first would refuse half the JPEG files on the
 * machine. The written extension stays first, so `saveMedia` and this table cannot drift:
 * one is derived from the other, not copied beside it.
 */
const BY_EXT = new Map([...BY_MIME].map(([mime, ext]) => [ext, mime]))
for (const [ext, mime] of [
  ['jpeg', 'image/jpeg'],
  ['jpe', 'image/jpeg'],
]) {
  BY_EXT.set(ext, mime)
}

/** The media directory belonging to a store file. */
function mediaDirFor(storeFile) {
  return join(dirname(storeFile), MEDIA_DIR_NAME)
}

/**
 * A key turned into a path, or a refusal.
 *
 * The test is deliberately about *shape* rather than about a list of forbidden substrings:
 * a key is the name this file itself wrote, so anything containing a separator, a parent
 * hop, or nothing at all is not one of ours. Refusing by shape covers the encodings a
 * substring list forgets.
 */
function pathForKey(storeFile, key) {
  if (typeof key !== 'string' || key === '') {
    throw new Error('a picture with no key names no blob, so nothing can be read')
  }
  if (key.includes('/') || key.includes('\\') || key === '.' || key === '..') {
    throw new Error(
      `the key ${JSON.stringify(key)} is a path, not a name: a picture's key is a file ` +
        'name inside the media directory beside the store, and a store is a file a person edits',
    )
  }
  return join(mediaDirFor(storeFile), key)
}

/** A name nothing else in the directory can collide with, in a shape a shell can read. */
function keyFor(mime) {
  const ext = BY_MIME.get(mime)
  if (!ext) {
    throw new Error(
      `a picture of type ${JSON.stringify(mime)} is not one this app can send: ` +
        `it draws ${[...BY_MIME.keys()].join(', ')}, and a kind saying 'image' over ` +
        'bytes it cannot show is a message that lies about itself',
    )
  }
  const stamp = Date.now().toString(36)
  const salt = Math.random().toString(36).slice(2, 10)
  return `om-${stamp}-${salt}.${ext}`
}

/**
 * Write a picture's bytes beside the store and hand back the reference the kernel stores.
 *
 * `name` is kept for the interface to show and is deliberately **not** part of the key: a
 * person's file name is theirs, it may repeat (`image.png` twice is two pictures), and it
 * may contain anything at all. A key built from it would be a key that is sometimes a path.
 */
function saveMedia(storeFile, { bytes, mime, name }) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    throw new Error('an empty file is not a picture, so nothing was attached')
  }
  const key = keyFor(mime)
  const dir = mediaDirFor(storeFile)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, key), bytes)
  return { key, mime, name: typeof name === 'string' && name !== '' ? name : key }
}

/**
 * A picture's bytes, as the one string a renderer can draw without touching the disk.
 *
 * A `data:` URL rather than a file path because the renderer has `contextIsolation` and no
 * filesystem: handing it a path would be handing it a path it cannot read, which draws as
 * a broken image and reads as a missing file. The mime comes from the message, not from the
 * file's extension — the kernel's own reference is the claim about what the bytes are, and
 * a second guess here could disagree with it.
 */
function readMedia(storeFile, { key, mime }) {
  const bytes = readBytes(storeFile, key)
  const type = typeof mime === 'string' && mime !== '' ? mime : 'application/octet-stream'
  return { dataUrl: `data:${type};base64,${bytes.toString('base64')}` }
}

/**
 * A picture's bytes, for the half that answers — not for drawing.
 *
 * The same read and the same refusal as `readMedia`, minus the encoding: the kernel asks for
 * bytes (`LlamaServer.loadMedia`), and encoding them into a `data:` URL here only for it to
 * be decoded again would be two formats for one fact. The refusal stays one function so a key
 * that is not beside the store is the same state on both paths.
 */
function readBytes(storeFile, key) {
  const path = pathForKey(storeFile, key)
  try {
    return readFileSync(path)
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      // A refusal that carries which refusal it is. The sentence stays a diagnostic — it names
      // the store's directory, which is a fact about a filesystem rather than something a person
      // reading a room can do anything with — and `main.js` answers the renderer the `reason`
      // instead of it. Nothing but a log ever reads the message.
      const gone = new Error(
        `the picture ${JSON.stringify(key)} is not beside this store any more: the message ` +
          `is the store's and the bytes are the client's, so a store moved without its ` +
          `${MEDIA_DIR_NAME}/ directory keeps the sentence and loses the picture`,
      )
      gone.reason = PICTURE_GONE
      throw gone
    }
    throw error
  }
}

/**
 * The mime of a file the person chose, read off its extension.
 *
 * The file dialog hands back a path and no type — Electron has no mime to give — so the
 * extension is the only fact available before the bytes are read, and this is the one
 * place that translates it. An extension outside the list is `null` rather than a guess:
 * the caller turns that into a refusal naming what the app can send, because writing
 * bytes under a mime the kernel will refuse leaves a file in `media/` no message points at.
 */
function mimeForPath(filePath) {
  const match = /\.([A-Za-z0-9]+)$/.exec(String(filePath))
  if (!match) return null
  return BY_EXT.get(match[1].toLowerCase()) ?? null
}

/**
 * The mime of a file the person attached, which may be anything at all.
 *
 * **Not the same question as `mimeForPath`.** A picture has to be one of four types, because
 * the window draws it and the kernel refuses a `media.mime` that is not `image/*`. An
 * attachment is opened by whichever application the person's machine has for it, so the set
 * is not ours to close: this answers a good name for the common cases and
 * `application/octet-stream` for everything else, which is the answer every system already
 * understands as "ask the person".
 */
const ATTACHMENT_TYPES = new Map([
  ['pdf', 'application/pdf'],
  ['txt', 'text/plain'],
  ['md', 'text/markdown'],
  ['csv', 'text/csv'],
  ['json', 'application/json'],
  ['zip', 'application/zip'],
  ['gz', 'application/gzip'],
  ['tar', 'application/x-tar'],
  ['doc', 'application/msword'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['xls', 'application/vnd.ms-excel'],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['ppt', 'application/vnd.ms-powerpoint'],
  ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
])

/** The extension of a path or a name, lowercased, or `''`. */
function extensionOf(name) {
  const match = /\.([A-Za-z0-9]+)$/.exec(String(name))
  return match ? match[1].toLowerCase() : ''
}

/**
 * What an attachment's bytes are, off its name.
 *
 * A picture keeps its own mime when it has one, so attaching a PNG through the paperclip
 * says `image/png` rather than `application/octet-stream`: the bytes are the same bytes, and
 * a reader that has to choose an application does better with the truth.
 */
function attachmentMimeFor(name) {
  const ext = extensionOf(name)
  if (BY_EXT.has(ext)) return BY_EXT.get(ext)
  return ATTACHMENT_TYPES.get(ext) ?? 'application/octet-stream'
}

/**
 * A key for an attachment: a stamp, a salt, and the extension the person's file had.
 *
 * The extension is kept because it is the only thing that survives a round trip to the
 * person's own machine: opening an attachment copies the blob back out under the name they
 * gave it (`openAttachment`), and a name this app invented with no extension is a file
 * their system cannot open. The rest of the name is **not** used, for the reason
 * `saveMedia` gives: a key built from a name is sometimes a path.
 */
function attachmentKeyFor(name) {
  const ext = extensionOf(name)
  const stamp = Date.now().toString(36)
  const salt = Math.random().toString(36).slice(2, 10)
  return ext === '' ? `om-${stamp}-${salt}` : `om-${stamp}-${salt}.${ext}`
}

/**
 * Write an attachment's bytes beside the store and hand back the four facts the kernel keeps.
 *
 * The size is measured here rather than believed from a caller: it is what the row says
 * about the file, and a wrong number in a row is worse than no row.
 */
function saveAttachment(storeFile, { bytes, name }) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    throw new Error('an empty file is not an attachment, so nothing was attached')
  }
  const wanted = typeof name === 'string' && name.trim() !== '' ? name : 'attachment'
  const key = attachmentKeyFor(wanted)
  const dir = mediaDirFor(storeFile)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, key), bytes)
  return { key, name: wanted, size: bytes.length, mime: attachmentMimeFor(wanted) }
}

/** Whether a mime is one this app can both send and draw. */
function isSupportedImage(mime) {
  return BY_MIME.has(mime)
}

/**
 * Take a blob out of the media directory, because the message that named it is gone.
 *
 * `force` rather than a check: a file that is not there is the state this call wants, so a
 * picture somebody already removed by hand is not an error. The key goes through `pathForKey`
 * first, which is what keeps a key that names a path from reaching anything outside `media/`.
 */
function dropMedia(storeFile, key) {
  if (typeof key !== 'string' || key === '') return false
  rmSync(pathForKey(storeFile, key), { force: true })
  return true
}

module.exports = {
  dropMedia,
  PICTURE_GONE,
  ATTACHMENT_TYPES,
  BY_EXT,
  BY_MIME,
  attachmentMimeFor,
  saveAttachment,
  MEDIA_DIR_NAME,
  isSupportedImage,
  mediaDirFor,
  mimeForPath,
  pathForKey,
  readBytes,
  readMedia,
  saveMedia,
}
