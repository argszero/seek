/**
 * The fetch a launch goes through before it can start its server: which host, which files,
 * and how far the whole download has got.
 *
 * The surprising thing about a two-file download is that the arithmetic is not local. Each
 * file reports its own byte count from zero, so a progress line built from the file's own
 * reading **starts again at the second file** — a bar that jumps backwards halfway through a
 * 1.6 GB wait, which is the one thing a resumable download must never look like. So what is
 * pinned here is the whole download's reading: it only ever grows, and it ends at the sum.
 *
 * The host is real (`node:http` on an ephemeral port) for the same reason the weight tests
 * use one — a stubbed `fetch` cannot produce a request whose `Range` header is the reading,
 * and "was this resumed or re-fetched" is exactly that header.
 *
 * Nothing here talks to the internet: `base` is the local origin. What the *recorded* host
 * answers was measured separately, once, and is written down in `weights-fetch.js`.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { ensureWeights, urlForAt, WEIGHTS_BASE, WEIGHTS_BASES, WEIGHTS_REPO } from './weights-fetch.js'

/** Two files with the shape the real pair has, in kilobytes. */
const FILES = [
  { name: 'model.gguf', bytes: 4096 },
  { name: 'mmproj.gguf', bytes: 2048 },
]

/** A directory to work in, and its clean-up. */
async function area() {
  const dir = await mkdtemp(join(tmpdir(), 'seek-first-run-'))
  return { dir, done: () => rm(dir, { recursive: true, force: true }) }
}

/** A host that serves the two files and honours `Range`, recording what it was asked. */
async function weightHost(bodies) {
  const requests = []
  const server = createServer((request, response) => {
    const name = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname.split('/').pop())
    const range = request.headers.range ?? null
    requests.push({ name, range, url: request.url })
    const body = bodies[name]
    if (!body) {
      response.writeHead(404)
      response.end('no')
      return
    }
    const asked = /^bytes=(\d+)-$/.exec(range ?? '')
    const from = asked ? Number(asked[1]) : 0
    const piece = body.subarray(from)
    const headers = { 'content-length': String(piece.length) }
    if (asked) headers['content-range'] = `bytes ${from}-${body.length - 1}/${body.length}`
    response.writeHead(asked ? 206 : 200, headers)
    // In two writes, so the client sees more than one chunk and the progress callback is
    // exercised more than once per file.
    const half = Math.floor(piece.length / 2)
    response.write(piece.subarray(0, half))
    response.end(piece.subarray(half))
  })
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
  const { port } = server.address()
  return {
    requests,
    base: `http://127.0.0.1:${port}`,
    done: () => new Promise((done) => server.close(done)),
  }
}

function bodies() {
  return { 'model.gguf': Buffer.alloc(FILES[0].bytes, 1), 'mmproj.gguf': Buffer.alloc(FILES[1].bytes, 2) }
}

test('the address is the recorded checkpoint, and a base with a trailing slash is the same address', () => {
  const one = urlForAt('https://example.test')
  assert.equal(one(FILES[0]), `https://example.test/${WEIGHTS_REPO}/resolve/main/model.gguf`)
  // `//resolve/main` is a different path, and some hosts answer it with a redirect to a login
  // page rather than with a file — so a trailing slash must not survive into the URL.
  assert.equal(urlForAt('https://example.test/') (FILES[0]), one(FILES[0]))
  assert.equal(urlForAt('https://example.test///')(FILES[1]), one(FILES[1]))
  assert.equal(WEIGHTS_BASE, 'https://hf-mirror.com', 'the mirror is the host asked first')
  assert.deepEqual(
    WEIGHTS_BASES,
    ['https://hf-mirror.com', 'https://huggingface.co'],
    'and the canonical host is the one tried after it — the host ruled this order',
  )
  assert.equal(WEIGHTS_REPO, 'LiquidAI/LFM2.5-VL-3B-GGUF', 'the checkpoint the 0.600 cut was calibrated against')
})

test('a run with no host says so, instead of blaming the network', async () => {
  const room = await area()
  try {
    // An empty or blank setting is somebody configuring nothing — a shell expanding an unset
    // variable, a config line left blank. `undefined` is not that: nobody said, and the
    // canonical host is what "nobody said" means (asserted in the test below).
    for (const base of ['', '   ', null]) {
      const result = await ensureWeights({
        dir: room.dir,
        base,
        files: FILES,
        // A fetch that would fail loudly if it were ever reached: the point is that it is not.
        fetchImpl: () => assert.fail('nothing should be fetched without a host'),
      })
      assert.equal(result.ok, false)
      assert.match(result.refusal, /no address is configured for the weights/)
      assert.match(result.refusal, /SEEK_WEIGHTS_BASE/, 'and names the setting that fixes it')
      assert.doesNotMatch(result.refusal, /could not be reached/, 'a configuration mistake is not an outage')
    }
  } finally {
    await room.done()
  }
})

test('a run that was told nothing asks the mirror first, then the canonical host', async () => {
  const room = await area()
  const asked = []
  try {
    const result = await ensureWeights({
      dir: room.dir,
      files: FILES,
      // Recorded and refused rather than served: this test is about which address is asked,
      // not about the bytes. The rejection is the offline sentence, which is the cheapest way
      // to make `ensureWeights` stop after the first attempt.
      fetchImpl: (url) => {
        asked.push(url)
        return Promise.reject(new TypeError('fetch failed'))
      },
    })

    assert.equal(result.ok, false, 'both fake hosts refuse')
    // Both are tried, in the ruled order, and one file is asked of each: the first host fails,
    // so the second is given the same first file. A run that stopped at one would be a build
    // that cannot reach the mirror and therefore cannot download at all.
    assert.deepEqual(
      asked,
      WEIGHTS_BASES.map((root) => `${root}/${WEIGHTS_REPO}/resolve/main/${FILES[0].name}`),
      'the mirror first, the canonical host second',
    )
    assert.match(result.refusal, /hf-mirror\.com/, 'and the refusal names the host that failed first')
    assert.match(result.refusal, /huggingface\.co/, 'and the one tried after it')
  } finally {
    await room.done()
  }
})

test('a host that fails hands the download to the next one, which finishes it', async () => {
  const room = await area()
  const dead = await weightHost({}) // knows no file, answers 404 to everything
  const live = await weightHost(bodies())
  try {
    const result = await ensureWeights({
      dir: room.dir,
      base: [dead.base, live.base],
      files: FILES,
    })

    assert.equal(result.ok, true, 'the second host served both files')
    assert.equal(result.host, live.base, 'and it is the host the result names')
    assert.equal(result.bytes, FILES[0].bytes + FILES[1].bytes)
    // The first host was asked, was refused, and did not stop the download.
    assert.ok(dead.requests.length > 0, 'the first host was tried')
    assert.deepEqual(
      live.requests.map((one) => one.name).sort(),
      ['mmproj.gguf', 'model.gguf'],
      'and the second fetched both files',
    )
  } finally {
    await dead.done()
    await live.done()
    await room.done()
  }
})

test('bytes left behind by one host are continued by the next, not fetched again', async () => {
  const room = await area()
  const dead = await weightHost({}) // answers 404: it has nothing, so the download moves on
  const live = await weightHost(bodies())
  try {
    // Half of the first file, kept under the name a stopped attempt leaves. Fixed by
    // construction rather than hit by luck: a socket destroyed mid-body drops what was still
    // in its write buffer, so "how much arrived before the host died" is a race and cannot be
    // the anchor of a test (`model-weights.test.mjs` says the same about the same three cases).
    const kept = 1000
    await writeFile(join(room.dir, 'model.gguf.part'), Buffer.alloc(kept, 1))

    const result = await ensureWeights({ dir: room.dir, base: [dead.base, live.base], files: FILES })

    assert.equal(result.ok, true)
    assert.equal(result.host, live.base, 'the host that finished it is the one named')
    // The reading that proves the resume is the second host's own range header: it was asked
    // for the bytes that were missing, which is the contract `model-weights.js` states.
    const resumed = live.requests.find((one) => one.name === 'model.gguf')
    assert.equal(resumed?.range, `bytes=${kept}-`, 'the second host continued the first host\'s bytes')
  } finally {
    await dead.done()
    await live.done()
    await room.done()
  }
})

test('a first run fetches both files, and the progress it reports is the whole download', async () => {
  const room = await area()
  const host = await weightHost(bodies())
  const seen = []
  try {
    const result = await ensureWeights({
      dir: room.dir,
      base: host.base,
      files: FILES,
      onProgress: (reading) => seen.push(reading),
    })

    assert.equal(result.ok, true, `it fetched: ${result.refusal ?? ''}`)
    assert.equal(result.fetched, true, 'it says it fetched rather than found')
    assert.equal(result.bytes, FILES[0].bytes + FILES[1].bytes)
    assert.deepEqual(await readdir(room.dir).then((names) => names.sort()), ['mmproj.gguf', 'model.gguf'])

    // The arithmetic this file exists for: the second file's reading continues from the
    // first file's size instead of starting again at zero.
    const received = seen.map((reading) => reading.received)
    assert.deepEqual(received, [...received].sort((a, b) => a - b), 'the count never goes backwards')
    assert.equal(seen.at(-1).received, FILES[0].bytes + FILES[1].bytes, 'and ends at the sum')
    assert.equal(seen.at(-1).total, FILES[0].bytes + FILES[1].bytes, 'against the whole download')
    assert.ok(
      seen.some((reading) => reading.name === 'mmproj.gguf' && reading.received > FILES[0].bytes),
      'the second file is reported as further along than the first one ended',
    )
  } finally {
    await host.done()
    await room.done()
  }
})

test('a second launch pays nothing, and says it fetched nothing', async () => {
  const room = await area()
  const host = await weightHost(bodies())
  try {
    await ensureWeights({ dir: room.dir, base: host.base, files: FILES })
    const askedBefore = host.requests.length
    const again = await ensureWeights({ dir: room.dir, base: host.base, files: FILES })

    assert.equal(again.ok, true)
    assert.equal(again.fetched, false, 'nothing was fetched this time')
    assert.equal(host.requests.length, askedBefore, 'and the host was not asked again')
  } finally {
    await host.done()
    await room.done()
  }
})

test('a stopped download resumes where it stopped, through this layer', async () => {
  const room = await area()
  const host = await weightHost(bodies())
  try {
    // Half of the first file, kept under the name a stopped attempt leaves. This is the state
    // a laptop lid or a tunnel leaves behind, fixed by construction rather than hit by luck.
    const kept = 1024
    await writeFile(join(room.dir, 'model.gguf.part'), Buffer.alloc(kept, 1))

    const result = await ensureWeights({ dir: room.dir, base: host.base, files: FILES })

    assert.equal(result.ok, true)
    const first = host.requests.find((request) => request.name === 'model.gguf')
    assert.equal(first.range, `bytes=${kept}-`, 'it asked for the rest rather than the whole file')
  } finally {
    await host.done()
    await room.done()
  }
})

test('offline is a sentence, not an exception, and it names the file', async () => {
  const room = await area()
  try {
    const result = await ensureWeights({
      dir: room.dir,
      base: 'http://127.0.0.1:9',
      files: FILES,
      fetchImpl: () => Promise.reject(new TypeError('fetch failed')),
    })

    assert.equal(result.ok, false)
    assert.match(result.refusal, /the weights were not fetched/)
    assert.match(result.refusal, /model\.gguf/, 'the sentence says which file it was about')
    assert.equal(result.bytes, 0)
  } finally {
    await room.done()
  }
})

test('a progress reading is facts, and no sentence is composed from them here', async () => {
  // The line a window drew on a first run — `0.2 GB of 2.2 GB — LFM2.5-VL-3B-Q4_0.gguf` — was
  // built in this module, which fixed its language and its decimal separator before any
  // catalogue was consulted (`docs/design/i18n.md` §1, §4). The three facts travel (`onProgress`,
  // asserted above) and the window writes the words, so a composer reappearing here is the
  // defect coming back rather than a refactor.
  const mod = await import('./weights-fetch.js')
  assert.equal(mod.progressSentence, undefined, 'this module composes no sentence')
  assert.equal(mod.gigabytes, undefined, 'and formats no size of its own')
})
