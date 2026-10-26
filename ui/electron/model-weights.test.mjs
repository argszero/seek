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
 *
 * **How many bytes a dying body delivered is not something a test may assume.** When the host
 * destroys the connection, the bytes that reached the client are whatever the socket managed:
 * on a loopback that is usually all of them and occasionally none, and a real 2.1 GB download
 * behind a tunnel is the same coin landing the other way. So both cases are fixed by
 * construction rather than hit by luck — a `.part` this file writes itself pins the count a
 * resume starts from, and a host that stops before the first byte pins the other end.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
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
      // The headers go out on their own first: what is being simulated is a body that stops
      // part-way, and a client that never saw a response at all is a different failure — the
      // one `fetch` itself throws, before `fetchOne` has written anything to disk. Flushed
      // here, the client is guaranteed to read a declared length and then a dead connection.
      response.flushHeaders()
      if (options.cutAfter > 0) response.write(piece.subarray(0, options.cutAfter))
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

/** What a path holds on disk, or `0` when nothing is there — a `.part` never written at all. */
async function sizeOnDisk(path) {
  try {
    return (await stat(path)).size
  } catch (error) {
    if (error && error.code === 'ENOENT') return 0
    throw error
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

// A connection that dies part-way leaves a `.part` holding however many bytes got through, and
// on a real 2.1 GB download that number is whatever the socket managed — not something the
// caller chooses. Both ends of the range are therefore exercised by construction: at
// `cutAfter: 0` the client reads the headers and not one byte of the body, at `cutAfter: 1000`
// it reads a thousand. What is asserted holds at both, because it is the module's contract
// rather than the timing: the bytes that arrived are kept, the real name stays empty, and the
// next attempt asks for exactly what the `.part` holds — an empty one not being a resume.
for (const { cutAfter, seeded } of [
  { cutAfter: 0, seeded: 0 },
  { cutAfter: 1000, seeded: 0 },
  { cutAfter: 1000, seeded: 700 },
]) {
  const scenario = seeded > 0
    ? `a body that dies after ${cutAfter} more bytes keeps them beside the ${seeded} already on disk`
    : `a body that dies after ${cutAfter} bytes is kept, and the file is not called whole`
  test(scenario, async () => {
    const { files, bodies } = pair()
    const dir = await downloadDirectory()
    const cut = await weightHost({ files: bodies, cutAfter })
    let keptSize
    try {
      // Bytes from an earlier attempt are put there by the test, so the floor asserted below
      // does not depend on how much of a dying body this run's socket managed to deliver.
      if (seeded > 0) {
        await writeFile(join(dir.dir, `big.gguf${PART_SUFFIX}`), bodies['big.gguf'].subarray(0, seeded))
      }
      const first = await fetchWeights({ dir: dir.dir, files, urlFor: cut.urlFor })

      assert.equal(first.ok, false, 'a body that dies mid-file is not a completed download')
      assert.match(first.refusal, /big\.gguf/, 'the refusal names the file that did not arrive')
      await assert.rejects(readFile(join(dir.dir, 'big.gguf')), 'and nothing pretends it is whole')
      keptSize = await sizeOnDisk(join(dir.dir, `big.gguf${PART_SUFFIX}`))
      assert.ok(keptSize >= seeded, `the ${seeded} bytes already on disk were not thrown away`)
      assert.ok(keptSize <= seeded + cutAfter, `and never more than those plus the ${cutAfter} sent`)
    } finally {
      await cut.close()
    }

    const whole = await weightHost({ files: bodies })
    try {
      const second = await fetchWeights({ dir: dir.dir, files, urlFor: whole.urlFor })

      assert.equal(second.ok, true)
      const bigRequest = whole.requests.find((one) => one.name === 'big.gguf')
      assert.equal(
        bigRequest.range,
        keptSize > 0 ? `bytes=${keptSize}-` : null,
        'the next attempt asks from exactly what was kept — an empty .part is a start, not a resume',
      )
      assert.deepEqual(
        await readFile(join(dir.dir, 'big.gguf')),
        bodies['big.gguf'],
        'and the file ends up the bytes the host served, once',
      )
    } finally {
      await whole.close()
      await dir.done()
    }
  })
}

test('a .part with bytes in it is resumed from exactly those bytes', async () => {
  // The resume arithmetic as a fact rather than as an outcome: the `.part` is written here, so
  // how many bytes to continue from is known before the request goes out. A killed connection
  // cannot fix that number — it lands anywhere from zero up — which is why the test above
  // asserts what is true at both ends of that range and this one asserts the exact count.
  const { files, bodies } = pair()
  const host = await weightHost({ files: bodies })
  const dir = await downloadDirectory()
  try {
    await writeFile(join(dir.dir, `big.gguf${PART_SUFFIX}`), bodies['big.gguf'].subarray(0, 700))
    const result = await fetchWeights({ dir: dir.dir, files, urlFor: host.urlFor })

    assert.equal(result.ok, true)
    assert.equal(
      host.requests.find((one) => one.name === 'big.gguf').range,
      'bytes=700-',
      'it asks for the bytes it does not have, starting at the first one it does',
    )
    const onDisk = await readFile(join(dir.dir, 'big.gguf'))
    assert.equal(onDisk.length, 4096, 'appended to what was on disk rather than written over it')
    assert.deepEqual(onDisk, bodies['big.gguf'], 'and the file is the bytes the host served')
    assert.deepEqual(
      (await readdir(dir.dir)).sort(),
      ['big.gguf', 'small.gguf'],
      'the .part name is gone once the count is right',
    )
  } finally {
    await host.close()
    await dir.done()
  }
})

test('a host that ignores the range is not believed, and the file does not grow a second head', async () => {
  // The failure this rules out: `Range` was sent, the host answered `200` with the whole body
  // from zero, and the writer appended it to the bytes already there. The size would be wrong
  // — but a download that trusted the stream's own end could call it right.
  const { files, bodies } = pair()
  const dir = await downloadDirectory()
  const deaf = await weightHost({ files: bodies, ignoresRange: true })
  try {
    // The `.part` is written here rather than left behind by a killed connection: what this
    // test needs is a known number of bytes already on disk, and a race would sometimes hand
    // it zero — the one case where no range goes out at all, so the rule under test never runs.
    await writeFile(join(dir.dir, `big.gguf${PART_SUFFIX}`), bodies['big.gguf'].subarray(0, 1000))
    const result = await fetchWeights({ dir: dir.dir, files, urlFor: deaf.urlFor })
    assert.equal(result.ok, true)
    assert.equal(deaf.requests.find((one) => one.name === 'big.gguf').range, 'bytes=1000-', 'a range was asked for')
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
