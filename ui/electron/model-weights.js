'use strict'
/**
 * The two weight files a first run fetches, and what makes an arrived file a whole one.
 *
 * A download is the one place in this app where "it worked" is easy to claim and hard to
 * see: a connection that drops after 1.1 GB leaves a file with a plausible size, a stream
 * that ends is not a stream that ended *where the file ends*, and a host that answers `200`
 * to a `Range` request makes a resume look like it happened while the bytes land in the
 * wrong place. So this file decides two things, and nothing else.
 *
 * **A file is whole when its byte count equals the count it was declared with** — counted on
 * disk after the write, not trusted from the stream. That is the only reading that survives a
 * truncated response, because a truncated response ends normally.
 *
 * **A download that stops leaves its bytes in `<name>.part`**, and the next attempt continues
 * from them with a `Range` request. 2.1 GB is paid for once rather than once per attempt,
 * which matters because the reason an attempt stops — a laptop lid, a train tunnel — is
 * usually still there a minute later. The `.part` name is what keeps a half file from being
 * mistaken for a whole one by the caller that only looks at `<name>`.
 *
 * **Where the bytes come from is not decided here.** The caller passes `urlFor`, because the
 * canonical host and any mirror beside it is a choice about distribution rather than about
 * this mechanism, and a default invented here would be that decision recorded in the wrong
 * file. The refusal a failure produces is a sentence something can draw, in the same shape
 * `openHostOrRefuse` refuses a store with.
 */

const { createWriteStream } = require('node:fs')
const { mkdir, rename, rm, stat } = require('node:fs/promises')
const { join } = require('node:path')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')

/**
 * The file a first run wants, with the size measured for the release it was read from.
 *
 * **One file, and no projector.** `d1-2B` is the decision model the judgement is asked of
 * (`src/llama.ts`, `/v1/systemone`), and it answers in text: `/props` reports
 * `modalities.vision: false` on the real binary, so there is nothing for a projector to
 * contribute and one was not fetched. The cut `0.600` is calibrated against this model
 * (`calibration/set4-d1.json`), so the weights cannot be swapped without recalibrating it.
 */
const WEIGHT_FILES = [
  { name: 'd1-2B-Q8_0.gguf', bytes: 1846240576 },
]

/** The suffix a stopped download is kept under, so half a file cannot pass for a whole one. */
const PART_SUFFIX = '.part'

/** A path's size, or `null` when nothing is there. */
async function sizeOf(path) {
  try {
    return (await stat(path)).size
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
}

/**
 * One file, resumed if there is something to resume, and renamed into place only when the
 * count on disk is the count it was declared with.
 */
async function fetchOne(file, request) {
  const { dir, urlFor, fetchImpl, onProgress, signal } = request
  const target = join(dir, file.name)
  const partial = target + PART_SUFFIX
  const have = (await sizeOf(partial)) ?? 0

  let response
  try {
    response = await fetchImpl(urlFor(file), {
      headers: have > 0 ? { range: `bytes=${have}-` } : {},
      signal,
    })
  } catch (error) {
    // The offline case, and the one a person is most likely to meet: the sentence has to say
    // which file it was about, because "fetch failed" is not something a window can draw.
    const why = error instanceof Error ? error.message : String(error)
    throw new Error(`the server could not be reached for ${file.name}: ${why}`)
  }
  if (!response.ok) {
    throw new Error(`the server answered ${response.status} for ${file.name}`)
  }

  // `206` means the range was honoured and the bytes start where the last attempt stopped.
  // `200` means it was ignored — the body starts at zero, so the file has to as well, or the
  // same prefix would be written twice and only the count would look right at the end.
  const resumed = response.status === 206 && have > 0
  if (have > 0 && !resumed) await rm(partial, { force: true })

  let received = resumed ? have : 0
  const body = Readable.fromWeb(response.body)
  body.on('data', (chunk) => {
    received += chunk.length
    if (onProgress) onProgress({ name: file.name, received, total: file.bytes })
  })
  try {
    await pipeline(body, createWriteStream(partial, { flags: resumed ? 'a' : 'w' }))
  } catch (error) {
    // A connection that dies mid-body: `pipeline` rejects, and what was written stays on disk
    // under the `.part` name — which is the whole reason the next attempt can continue.
    const why = error instanceof Error ? error.message : String(error)
    throw new Error(
      `${file.name} stopped after ${received} of ${file.bytes} bytes (${why}); ` +
        `what arrived is kept in ${file.name}${PART_SUFFIX} for the next attempt`,
    )
  }

  const written = (await sizeOf(partial)) ?? 0
  if (written !== file.bytes) {
    throw new Error(
      `${file.name} arrived with ${written} of ${file.bytes} bytes; ` +
        `what did arrive is kept in ${file.name}${PART_SUFFIX} for the next attempt`,
    )
  }
  await rename(partial, target)
  return { name: file.name, bytes: file.bytes, status: 'fetched', path: target }
}

/**
 * The weights a first run needs, in the directory it needs them in.
 *
 * Files already the declared size are left alone — a second launch must not pay 2.1 GB again,
 * and a file of the *wrong* size is not a download to resume but a wrong file, so it is
 * removed and fetched again. Every failure comes back as a refusal rather than an exception:
 * a first run that cannot reach the weights still has a window to open, and the sentence in
 * `refusal` is what that window draws.
 */
async function fetchWeights(options = {}) {
  const { dir, files = WEIGHT_FILES, urlFor, fetchImpl = globalThis.fetch, onProgress, signal } = options
  if (!dir) throw new TypeError('fetchWeights needs a directory to fetch into')
  if (typeof urlFor !== 'function') throw new TypeError('fetchWeights needs urlFor(file) — where a file comes from is the caller’s decision')

  const results = []
  let bytes = 0
  try {
    await mkdir(dir, { recursive: true })
    for (const file of files) {
      const target = join(dir, file.name)
      const present = await sizeOf(target)
      if (present === file.bytes) {
        results.push({ name: file.name, bytes: file.bytes, status: 'present', path: target })
        bytes += file.bytes
        if (onProgress) onProgress({ name: file.name, received: file.bytes, total: file.bytes })
        continue
      }
      // A file of the wrong size is not a partial download — a partial download lives in
      // `.part`. Whatever this is, it is not the file the caller asked for.
      if (present !== null) await rm(target, { force: true })
      const done = await fetchOne(file, { dir, urlFor, fetchImpl, onProgress, signal })
      results.push(done)
      bytes += file.bytes
    }
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    return { ok: false, refusal: `the weights were not fetched: ${why}`, files: results, bytes }
  }
  return { ok: true, files: results, bytes }
}

module.exports = { fetchWeights, WEIGHT_FILES, PART_SUFFIX }
