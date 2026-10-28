/**
 * The server the app starts for itself: when it starts one, when it refuses, and how it stops.
 *
 * The stand-ins here are **real child processes** — `node` running a script this file writes —
 * because the thing under test is a lifecycle, and a stubbed `spawn` cannot fail to die, cannot
 * answer late and cannot leave an orphan. What each test drives is the same sequence a launch
 * does: decide, check, spawn, wait for `/props`, hand back an origin, stop.
 *
 * No test here needs a real model or a real 1.5 GB file: the weights are checked by size, so a
 * handful of bytes stands in for them, and the binary is only ever a path that has to exist.
 * The real binary is measured on the packaged app, not here (`seek-verify-by-doing`).
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  bundledServerPath,
  serverChoiceFrom,
  startBundledServer,
  weightsDirectory,
  weightsTrouble,
} from './server.js'

/** Two small files with the shape the real pair has: a model and its projector. */
/** The one weight file a first run wants, as a body and as its declaration. */
function weights(modelBytes = 64) {
  return {
    files: [{ name: 'model.gguf', bytes: modelBytes }],
    bodies: { 'model.gguf': Buffer.alloc(modelBytes, 7) },
  }
}

/** A directory to work in, with a binary in it, and its clean-up. */
async function area() {
  const dir = await mkdtemp(join(tmpdir(), 'seek-server-'))
  const binaryPath = join(dir, 'llama-server')
  const weightsDir = join(dir, 'weights')
  await writeFile(binaryPath, 'not really a binary, but it is a path that exists')
  await writeFile(binaryPath, 'stand-in')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(weightsDir, { recursive: true })
  return { dir, binaryPath, weightsDir, done: () => rm(dir, { recursive: true, force: true }) }
}

/** Write the two weight files, whole. */
async function putWeights(weightsDir, bodies) {
  for (const [name, body] of Object.entries(bodies)) await writeFile(join(weightsDir, name), body)
}

/**
 * A stand-in for `llama-server`: a real process that answers `/props` on the port it is given.
 *
 * `mode` is what the process does instead of loading a model — `answer` is the honest case,
 * `never` listens forever without answering (a model that will not load), `die` exits at once
 * with a reason on stderr (a binary that cannot start at all).
 */
async function standIn(dir, mode) {
  const path = join(dir, `stand-in-${mode}.cjs`)
  // Every mode writes its own pid before it does anything else. A refused start is *about*
  // whether the process it began is still there, and the refusal carries no `child` to ask,
  // so the process has to be findable from outside it — otherwise the claim is unfalsifiable
  // and the assertion that makes it can never go red.
  const body =
    `require('node:fs').writeFileSync(require('node:path').join(__dirname, 'pid-${mode}'), String(process.pid))\n` +
    (mode === 'die'
      ? `process.stderr.write('error: failed to load model\\n'); process.exit(3)\n`
      : `const { createServer } = require('node:http')\n` +
        `const port = Number(process.argv[process.argv.indexOf('--port') + 1])\n` +
        `const answer = ${mode === 'answer'}\n` +
        `createServer((request, response) => {\n` +
        `  if (!answer) return\n` +
        `  if (request.url === '/props') { response.writeHead(200, {'content-type':'application/json'}); response.end(JSON.stringify({ model_alias: 'stand-in', model_path: '/stand-in.gguf' })); return }\n` +
        `  response.writeHead(404); response.end('no')\n` +
        `}).listen(port, '127.0.0.1')\n` +
        `process.on('SIGTERM', () => process.exit(0))\n`)
  await writeFile(path, body)
  return path
}

/** The pid a stand-in wrote for itself, and whether that process is still running. */
async function pidOf(dir, mode) {
  return Number(String(await readFile(join(dir, `pid-${mode}`), 'utf8')).trim())
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Run the stand-in as if it were the packaged binary. */
function spawnStandIn(script) {
  const calls = []
  const spawnImpl = (binaryPath, args, options) => {
    calls.push({ binaryPath, args, options })
    return spawn(process.execPath, [script, ...args], options)
  }
  return { calls, spawnImpl }
}

test('a person who named a server is not overruled', () => {
  assert.deepEqual(serverChoiceFrom({ SEEK_SERVER: 'http://127.0.0.1:8080' }), {
    mode: 'named',
    names: ['SEEK_SERVER'],
  })
  assert.deepEqual(serverChoiceFrom({ SEEK_WORK_SERVER: 'http://127.0.0.1:8080' }), {
    mode: 'named',
    names: ['SEEK_WORK_SERVER'],
  })
  // An empty string is not a name: it is what an unset variable looks like after a shell has
  // expanded it, and treating it as a choice would leave the app with no server at all.
  assert.deepEqual(serverChoiceFrom({ SEEK_SERVER: '' }), { mode: 'start' })
  assert.deepEqual(serverChoiceFrom({}), { mode: 'start' })
  assert.deepEqual(serverChoiceFrom(undefined), { mode: 'start' })
})

test('a build with no server in it says so, and starts nothing', async () => {
  const room = await area()
  const { calls, spawnImpl } = spawnStandIn(await standIn(room.dir, 'answer'))
  try {
    await putWeights(room.weightsDir, weights().bodies)
    const result = await startBundledServer({
      binaryPath: join(room.dir, 'absent', 'llama-server'),
      weightsDir: room.weightsDir,
      files: weights().files,
      spawnImpl,
    })

    assert.equal(result.origin, undefined)
    assert.match(result.refusal, /carries no model server/, 'it says which kind of failure this is')
    assert.match(result.refusal, /absent\/llama-server/, 'and names the path it looked at')
    assert.equal(calls.length, 0, 'nothing was spawned')
  } finally {
    await room.done()
  }
})

test('weights that are not there, or not the declared size, are a sentence not a crash', async () => {
  const room = await area()
  const { files, bodies } = weights()
  try {
    const missing = await weightsTrouble(room.weightsDir, files)
    assert.match(missing, /model\.gguf is not in/, 'it names the file that is gone')
    assert.match(missing, /64 bytes when it has/, 'and the size it should be')

    await writeFile(join(room.weightsDir, 'model.gguf'), bodies['model.gguf'].subarray(0, 10))
    const wrong = await weightsTrouble(room.weightsDir, files)
    assert.match(wrong, /model\.gguf is 10 bytes where it should be 64/, 'both counts')
    assert.match(wrong, /a different file/, 'and why it is refused rather than resumed')

    await putWeights(room.weightsDir, bodies)
    assert.equal(await weightsTrouble(room.weightsDir, files), null, 'a whole pair is no trouble')
  } finally {
    await room.done()
  }
})

test('the origin comes back only once the server answers, and stopping it ends the process', async () => {
  const room = await area()
  const script = await standIn(room.dir, 'answer')
  const { calls, spawnImpl } = spawnStandIn(script)
  // Stopped in the `finally`, not only on the happy path: a failed assertion above this line
  // would otherwise leave the stand-in running, and a live child keeps this file's process in
  // its event loop — so the suite would **hang instead of going red**, which is the one
  // outcome a test must never have.
  let result = null
  try {
    await putWeights(room.weightsDir, weights().bodies)
    result = await startBundledServer({
      binaryPath: room.binaryPath,
      weightsDir: room.weightsDir,
      files: weights().files,
      spawnImpl,
      deadlineMs: 20_000,
    })

    assert.equal(result.refusal, undefined, 'it started')
    assert.match(result.origin, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.equal(result.props.model_alias, 'stand-in', 'answered /props before the origin was handed back')

    const args = calls[0].args
    assert.ok(args.includes('--model'), 'started with the weight file it was given')
    // The model this app carries is a decision model and reports no vision modality, so a
    // projector would name a file nothing fetches; `d1-2B` needs none.
    assert.ok(!args.includes('--mmproj'), 'and with no projector it was never given')
    assert.equal(args[args.indexOf('--host') + 1], '127.0.0.1', 'on the loopback, not on every interface')
    assert.equal(args[args.indexOf('--port') + 1], String(result.port), 'on the port it was given')

    const died = await result.stop()
    assert.notEqual(died, null, 'the child really ended')
    assert.equal(result.child.exitCode !== null || result.child.signalCode !== null, true)
    // Stopping twice is what a quit handler and a crash handler both do, and it must not throw.
    assert.deepEqual(await result.stop(), died, 'stopping again is the same answer')
  } finally {
    if (result && typeof result.stop === 'function') await result.stop()
    await room.done()
  }
})

test('a server that never answers is refused within the deadline and leaves no orphan', async () => {
  const room = await area()
  const script = await standIn(room.dir, 'never')
  const { spawnImpl } = spawnStandIn(script)
  let pid = null
  try {
    await putWeights(room.weightsDir, weights().bodies)
    const started = Date.now()
    const result = await startBundledServer({
      binaryPath: room.binaryPath,
      weightsDir: room.weightsDir,
      files: weights().files,
      spawnImpl,
      deadlineMs: 1500,
    })
    // Read the pid before asserting anything: the clean-up below has to be able to reach the
    // process even when an assertion above it threw.
    pid = await pidOf(room.dir, 'never').catch(() => null)

    assert.equal(result.origin, undefined)
    assert.match(result.refusal, /did not answer on http:\/\/127\.0\.0\.1:\d+ within \d+ s/)
    assert.ok(Date.now() - started < 20_000, 'it gave up rather than waiting forever')
    // A refusal carries no `child` — that is the shape of every refusal — so "it left nothing
    // behind" has to be asked of the process itself, by the pid it wrote on the way in. The
    // version of this assertion that read `result.child === undefined` was true of the empty
    // return value and could never have gone red.
    assert.equal(alive(pid), false, 'the process it started is gone')
  } finally {
    // An orphan these tests are *about* must fail this file, not hang it: the stand-in is this
    // process's own child, so leaving it alive keeps the event loop open and the runner waits
    // for ever — measured, on the very breakage that removes `stop()` from the deadline. The
    // test therefore clears up after the module when the module did not.
    if (pid !== null && alive(pid)) process.kill(pid, 'SIGKILL')
    await room.done()
  }
})

test('a server that dies on start-up is refused with its own last words', async () => {
  const room = await area()
  const script = await standIn(room.dir, 'die')
  const { spawnImpl } = spawnStandIn(script)
  try {
    await putWeights(room.weightsDir, weights().bodies)
    const result = await startBundledServer({
      binaryPath: room.binaryPath,
      weightsDir: room.weightsDir,
      files: weights().files,
      spawnImpl,
      deadlineMs: 20_000,
    })

    assert.equal(result.origin, undefined)
    assert.match(result.refusal, /stopped while it was starting/)
    assert.match(result.refusal, /exit 3/, 'the code it exited with')
    assert.match(result.refusal, /failed to load model/, 'and what it said, which is nowhere else')
  } finally {
    await room.done()
  }
})

test('the packaged paths are the ones the manifest ships', () => {
  assert.equal(
    bundledServerPath('/Applications/Seek.app/Contents/Resources'),
    join('/Applications/Seek.app/Contents/Resources', 'server', 'llama-server'),
    'the binary sits under the resources directory the package is built with',
  )
  assert.equal(
    weightsDirectory('/Users/someone/Library/Application Support/Seek'),
    join('/Users/someone/Library/Application Support/Seek', 'weights'),
  )
})
