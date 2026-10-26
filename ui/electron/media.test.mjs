/**
 * The client's half of a picture message.
 *
 * The design gives the kernel a reference and no bytes: a message whose
 * `kind` is `image` names one `{key, mime}` in `media`, and *"naming a blob is a client's
 * scheme"*. This file is the tests for that scheme, and it runs under plain `node --test`
 * because the scheme is ordinary filesystem code — none of it needs a window.
 *
 * **The store is a real temporary directory, not a mocked `fs`.** The three things that can
 * go wrong here are all filesystem facts — a key that walks out of the directory, a type
 * this app cannot draw, bytes that are no longer beside the store — and a mocked `fs` would
 * be this test's idea of a filesystem rather than the one the app runs on.
 *
 * The round trip is always `saveMedia` → `readMedia`: a test that wrote a file by hand and
 * read it back would pass on a scheme whose own writer and reader disagree about the
 * extension, which is exactly the drift this file is here to catch.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  MEDIA_DIR_NAME,
  isSupportedImage,
  mediaDirFor,
  mimeForPath,
  pathForKey,
  readMedia,
  saveMedia,
} from './media.js'

/** A store file in a directory of its own, so each test owns its media directory. */
function withStore(run) {
  const dir = mkdtempSync(join(tmpdir(), 'seek-media-'))
  try {
    return run(join(dir, 'seek.json'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The smallest real PNG: eight bytes of signature, which is enough to be bytes. */
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

test('a picture is written beside the store and read back from its reference alone', () => {
  withStore((storeFile) => {
    const saved = saveMedia(storeFile, { bytes: PNG, mime: 'image/png', name: 'shot.png' })

    assert.equal(saved.mime, 'image/png', 'the mime is the one the caller measured')
    assert.equal(saved.name, 'shot.png', 'the person’s own name is kept for the interface')
    assert.match(saved.key, /^om-[\da-z]+-[\da-z]+\.png$/, 'the key is a plain name with the right extension')
    assert.ok(!saved.key.includes('shot'), 'the key is not built from the file name, which may repeat or be a path')

    const back = readMedia(storeFile, { key: saved.key, mime: saved.mime })
    const payload = back.dataUrl.replace(/^data:image\/png;base64,/, '')
    assert.deepEqual(
      Uint8Array.from(Buffer.from(payload, 'base64')),
      PNG,
      'the bytes that come back are the bytes that went in',
    )
  })
})

test('the media directory is beside the store, whatever the store is called', () => {
  const storeFile = '/tmp/whatever/seek.json'
  assert.equal(mediaDirFor(storeFile), join('/tmp/whatever', MEDIA_DIR_NAME))
  // A different store name in the same directory shares the media directory, which is
  // what makes a copied pair of `seek.json` and `media/` a whole conversation.
  assert.equal(mediaDirFor('/tmp/whatever/other.json'), join('/tmp/whatever', MEDIA_DIR_NAME))
})

test('a key that is a path is refused, because a store is a file a person edits by hand', () => {
  const storeFile = '/tmp/seek-media-guard/seek.json'
  for (const key of ['../seek.json', 'sub/pic.png', 'sub\\pic.png', '..', '.', '']) {
    assert.throws(
      () => pathForKey(storeFile, key),
      /not a name|names no blob/,
      `${JSON.stringify(key)} is not a file name and must not become a read`,
    )
  }
})

test('a type this app cannot draw is refused before any bytes are written', () => {
  withStore((storeFile) => {
    assert.throws(
      () => saveMedia(storeFile, { bytes: PNG, mime: 'image/tiff' }),
      /not one this app can send/,
      'the kernel would refuse `image/tiff` nowhere, so this is the only place that can',
    )
    assert.equal(isSupportedImage('image/tiff'), false)
    assert.equal(isSupportedImage('image/png'), true)
  })
})

test('a picture’s bytes that are gone say so, and do not read as an empty picture', () => {
  withStore((storeFile) => {
    const saved = saveMedia(storeFile, { bytes: PNG, mime: 'image/png' })
    rmSync(join(mediaDirFor(storeFile), saved.key))
    assert.throws(
      () => readMedia(storeFile, { key: saved.key, mime: saved.mime }),
      /is not beside this store any more/,
      'a store moved without its media directory keeps the message and loses the picture',
    )
  })
})

test('an empty file is not a picture, so nothing is attached', () => {
  withStore((storeFile) => {
    assert.throws(
      () => saveMedia(storeFile, { bytes: new Uint8Array(0), mime: 'image/png' }),
      /an empty file is not a picture/,
    )
  })
})

test('the mime comes off the extension, and an unknown one is null rather than a guess', () => {
  assert.equal(mimeForPath('/tmp/a/shot.PNG'), 'image/png')
  assert.equal(mimeForPath('/tmp/a/shot.jpeg'), 'image/jpeg')
  assert.equal(mimeForPath('/tmp/a/shot.webp'), 'image/webp')
  assert.equal(mimeForPath('/tmp/a/shot.tiff'), null, 'a type the app cannot draw is not invented')
  assert.equal(mimeForPath('/tmp/a/no-extension'), null)
  // `.jpg` and `.jpeg` are both JPEG files and both map to the one mime the kernel checks.
  assert.equal(mimeForPath('/tmp/a/shot.jpg'), 'image/jpeg')
})

test('a file written by an older version is still readable by its reference', () => {
  // The scheme's promise to the store: a reference written today is a plain name in the
  // media directory, so a reader that only knows `{key, mime}` can still open it even if
  // the app that wrote it is gone. Written by hand here on purpose — this is the one test
  // that must not go through `saveMedia`.
  withStore((storeFile) => {
    const dir = mediaDirFor(storeFile)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'om-legacy-abc.png'), PNG)
    const back = readMedia(storeFile, { key: 'om-legacy-abc.png', mime: 'image/png' })
    assert.ok(back.dataUrl.startsWith('data:image/png;base64,'), 'a plain name in media/ is the whole contract')
  })
})
