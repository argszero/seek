/**
 * What a first run fetches, and the three ways a download lies about having finished.
 *
 * The download is the one step of issue #89 that nothing can stand in for: 2.1 GB arrives
 * over a connection this program does not own, and every failure below is one a real
 * connection produces — a stream that ends early, a host that ignores the `Range` header and
 * starts the body at zero anyway, a response that ends *normally* with fewer bytes than the
 * file has. All three leave a file that looks like a file. So what is measured here is not
 * that bytes arrived but that **an arrived file is only called whole when its count on disk
 * is the count it was declared with**, and that what did arrive is kept for the next attempt
 * rather than thrown away and paid for again.
 *
 * The server is a real one on `127.0.0.1` — `node:http`, an ephemeral port, real chunked
 * writes — because a stubbed `fetch` could not produce a connection that dies mid-body, and
 * that death is the case worth having. The files are kilobytes; the mechanism is the same
 * one the 1.5 GB file goes through, and the sizes it is asked for are the caller's.
 *
 * Nothing here decides where the bytes come from. `urlFor` is the caller's, so these tests
 * pass their own origin — which is also what keeps them offline.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { fetchWeights, PART_SUFFIX, WEIGHT_FILES } from './model-weights.js'

/**
 * A host that serves named files, honours `Range` unless told not to, and records what it was
 * asked — the request is the reading for "this was resumed rather than re-fetched".
 *
 * `cutAfter` is the honest failure mode of a download: the body stops, the connection is
 * destroyed, and the client is told nothing but that the stream ended.
 */
async function weightHost(options = {}) {
  const requests = []
  const server = createServer((request, response) => {
    const name = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname.slice(1))
    const range = request.headers.range ?? null
    requests.push({ name, range })
    const body = (options.files ?? {})[name]
    if (!body) {
      response.writeHead(404, { 'content-length': '2' })
      response.end('no')
      return
    }
    const asked = /^bytes=(\d+)-$/.exec(range ?? '')
    const honoured = asked && !options.ignoresRange
    const from = honoured ? Number(asked[1]) : 0
    const piece = body.subarray(from)
    const headers = {
      'content-length': String(piece.length),
      'content-type': 'application/octet-stream',
    }
    if (honoured) {
      headers['content-range'] = `bytes ${from}-${body.length - 1}/${body.length}`
      response.writeHead(206, headers)
    } else {
      response.writeHead(200, headers)
    }
    if (options.cutAfter !== undefined) {
      response.write(piece.subarray(0, options.cutAfter))
      setTimeout(() => response.destroy(), 20)
      return
    }
    response.end(piece)
  })
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
  const origin = `http://127.0.0.1:${server.address().port}`
  return {
    origin,
    requests,
    urlFor: (file) => `${origin}/${encodeURIComponent(file.name)}`,
    close: () => new Promise((done) => server.close(done)),
  }
}

/** A directory to fetch into, and its clean-up. */
async function downloadDirectory() {
  const dir = await mkdtemp(join(tmpdir(), 'seek-weights-'))
  return { dir, done: () => rm(dir, { recursive: true, force: true }) }
}

/** Two small files with the shape the real pair has: a big one and a smaller one beside it. */
function pair(bigBytes = 4096, smallBytes = 1024) {
  return {
    files: [
      { name: 'big.gguf', bytes: bigBytes },
      { name: 'small.gguf', bytes: smallBytes },
    ],
    bodies: {
      'big.gguf': Buffer.alloc(bigBytes, 7),
      'small.gguf': Buffer.alloc(smallBytes, 3),
    },
  }
}

test('a first run writes both files, and each one is whole', async () => {
  const { files, bodies } = pair()
  const host = await weightHost({ files: bodies })
  const dir = await downloadDirectory()
  const progress = []
  try {
    const result = await fetchWeights({
      dir: dir.dir,
      files,
      urlFor: host.urlFor,
      onProgress: (step) => progress.push(step),
    })

    assert.equal(result.ok, true, 'both files arrived')
    assert.deepEqual(
      result.files.map((one) => [one.name, one.bytes, one.status]),
      [
        ['big.gguf', 4096, 'fetched'],
        ['small.gguf', 1024, 'fetched'],
      ],
    )
    assert.equal(result.bytes, 5120, 'the count a progress strip would show')

    for (const file of files) {
      const onDisk = await readFile(join(dir.dir, file.name))
      assert.equal(onDisk.length, file.bytes, `${file.name} is exactly the size it declares`)
      assert.deepEqual(onDisk, bodies[file.name], 'and it is the bytes the host served')
    }
    assert.deepEqual(
      (await readdir(dir.dir)).sort(),
      ['big.gguf', 'small.gguf'],
      'nothing is left under a .part name',
    )

    // Progress rises, is counted per file, and ends at the declared size rather than at
    // whatever the stream happened to hand over.
    const big = progress.filter((step) => step.name === 'big.gguf')
    assert.ok(big.length > 0, 'the big file reported progress')
    assert.deepEqual(big.at(-1), { name: 'big.gguf', received: 4096, total: 4096 })
    for (let index = 1; index < big.length; index += 1) {
      assert.ok(big[index].received >= big[index - 1].received, 'never goes backwards')
    }
  } finally {
    await host.close()
    await dir.done()
  }
})

test('a download that stopped is resumed from the bytes it kept, not fetched again', async () => {
  const { files, bodies } = pair()
  const dir = await downloadDirectory()
  const cut = await weightHost({ files: bodies, cutAfter: 1000 })
  try {
    const first = await fetchWeights({ dir: dir.dir, files, urlFor: cut.urlFor })

    assert.equal(first.ok, false, 'a body that dies mid-file is not a completed download')
    assert.match(first.refusal, /big\.gguf/, 'the refusal names the file that did not arrive')
    const kept = await readFile(join(dir.dir, `big.gguf${PART_SUFFIX}`))
    assert.ok(kept.length > 0, 'what did arrive is kept rather than thrown away')
    await assert.rejects(readFile(join(dir.dir, 'big.gguf')), 'and nothing pretends it is whole')
  } finally {
    await cut.close()
  }

  const whole = await weightHost({ files: bodies })
  try {
    const second = await fetchWeights({ dir: dir.dir, files, urlFor: whole.urlFor })

    assert.equal(second.ok, true)
    const bigRequest = whole.requests.find((one) => one.name === 'big.gguf')
    assert.match(bigRequest.range ?? '', /^bytes=\d+-$/, 'the second attempt asked for a range')
    assert.ok(
      Number(/\d+/.exec(bigRequest.range)[0]) > 0,
      'and it asked from where the first attempt stopped, not from zero',
    )
    assert.equal((await readFile(join(dir.dir, 'big.gguf'))).length, 4096, 'the file ends up whole')
  } finally {
    await whole.close()
    await dir.done()
  }
})

test('a host that ignores the range is not believed, and the file does not grow a second head', async () => {
  // The failure this rules out: `Range` was sent, the host answered `200` with the whole body
  // from zero, and the writer appended it to the bytes already there. The size would be wrong
  // — but a download that trusted the stream's own end could call it right.
  const { files, bodies } = pair()
  const dir = await downloadDirectory()
  const cut = await weightHost({ files: bodies, cutAfter: 1000 })
  try {
    await fetchWeights({ dir: dir.dir, files, urlFor: cut.urlFor })
  } finally {
    await cut.close()
  }

  const deaf = await weightHost({ files: bodies, ignoresRange: true })
  try {
    const result = await fetchWeights({ dir: dir.dir, files, urlFor: deaf.urlFor })
    assert.equal(result.ok, true)
    assert.match(deaf.requests.find((one) => one.name === 'big.gguf').range ?? '', /^bytes=\d+-$/, 'a range was asked for')
    const onDisk = await readFile(join(dir.dir, 'big.gguf'))
    assert.equal(onDisk.length, 4096, 'the file is the declared size, not the sum of two attempts')
    assert.deepEqual(onDisk, bodies['big.gguf'], 'and it is the served bytes, once')
  } finally {
    await deaf.close()
    await dir.done()
  }
})

test('a response that ends normally with fewer bytes than the file is refused', async () => {
  // The quiet one: no error, no reset — the body simply ends, and `pipeline` resolves. Only
  // the count on disk tells this apart from success.
  const short = { name: 'short.gguf', bytes: 5000 }
  const host = await weightHost({ files: { 'short.gguf': Buffer.alloc(1200, 9) } })
  const dir = await downloadDirectory()
  try {
    const result = await fetchWeights({ dir: dir.dir, files: [short], urlFor: host.urlFor })

    assert.equal(result.ok, false, 'a clean end is not a whole file')
    assert.match(result.refusal, /1200 of 5000/, 'the refusal says both counts')
    assert.match(result.refusal, new RegExp(`short\\.gguf\\${PART_SUFFIX}`), 'and where the bytes are kept')
    await assert.rejects(readFile(join(dir.dir, 'short.gguf')), 'it is never renamed into place')
    assert.equal((await readFile(join(dir.dir, `short.gguf${PART_SUFFIX}`))).length, 1200)
  } finally {
    await host.close()
    await dir.done()
  }
})

test('a host that answers with an error is a refusal naming the file, not a half-written one', async () => {
  const dir = await downloadDirectory()
  const host = await weightHost({ files: {} })
  try {
    const result = await fetchWeights({
      dir: dir.dir,
      files: [{ name: 'missing.gguf', bytes: 10 }],
      urlFor: host.urlFor,
    })

    assert.equal(result.ok, false)
    assert.match(result.refusal, /404/, 'the refusal carries what the host answered')
    assert.match(result.refusal, /missing\.gguf/, 'and which file it was about')
    assert.deepEqual(await readdir(dir.dir), [], 'nothing was written')
  } finally {
    await host.close()
    await dir.done()
  }
})

test('a file already whole on disk is not fetched a second time', async () => {
  const { files, bodies } = pair()
  const host = await weightHost({ files: bodies })
  const dir = await downloadDirectory()
  try {
    await writeFile(join(dir.dir, 'big.gguf'), bodies['big.gguf'])
    const result = await fetchWeights({ dir: dir.dir, files, urlFor: host.urlFor })

    assert.equal(result.ok, true)
    assert.deepEqual(
      result.files.map((one) => one.status),
      ['present', 'fetched'],
      'the whole one is taken as it is, the other is fetched',
    )
    assert.deepEqual(
      host.requests.map((one) => one.name),
      ['small.gguf'],
      'the host was never asked for the file that was already there',
    )
  } finally {
    await host.close()
    await dir.done()
  }
})

test('a file of the wrong size is replaced rather than resumed', async () => {
  // A partial download lives under `.part`; a file under the real name that is the wrong size
  // is something else — an older build's weights, a truncated copy — and appending to it would
  // build a file that is the right length and the wrong bytes.
  const { files, bodies } = pair()
  const host = await weightHost({ files: bodies })
  const dir = await downloadDirectory()
  try {
    await writeFile(join(dir.dir, 'big.gguf'), Buffer.alloc(100, 1))
    const result = await fetchWeights({ dir: dir.dir, files, urlFor: host.urlFor })

    assert.equal(result.ok, true)
    assert.equal(host.requests.find((one) => one.name === 'big.gguf').range, null, 'no range was asked for')
    assert.deepEqual(await readFile(join(dir.dir, 'big.gguf')), bodies['big.gguf'], 'the file is the served bytes')
  } finally {
    await host.close()
    await dir.done()
  }
})

test('the two files a first run wants are the two the issue measured', () => {
  // The sizes are what make "whole" checkable, so they are a fact rather than a detail: they
  // are the counts issue #89 measured on the release these were read from.
  assert.deepEqual(
    WEIGHT_FILES.map((file) => [file.name, file.bytes]),
    [
      ['LFM2.5-VL-3B-Q4_0.gguf', 1593894944],
      ['mmproj-LFM2.5-VL-3B-Q8_0.gguf', 583109984],
    ],
  )
})
