'use strict'

/**
 * The model server the app starts for itself, so a downloaded app answers on its own.
 *
 * Until this file existed, `SEEK_SERVER` / `SEEK_WINDOW` / `SEEK_WORK_SERVER` could only be
 * set by whoever launched the app from a terminal — which a person who double-clicks a `.pkg`
 * in `/Applications` cannot do. The package therefore carried a model server it never ran and
 * a first run downloaded weights nothing read: `model-weights.js` fetched them (PR #92) and no
 * file imported it. This is the half that turns both into behaviour.
 *
 * **The kernel is not touched by this and must not be.** `docs/decisions.md` row 20 says
 * nothing *in the kernel* starts, supervises or stops the process, and its change-phrase is
 * "let the kernel start and supervise it". Spawning from the Electron main process leaves that
 * row exactly as written: the app is a caller that supplies an origin, which is all `llama.ts`
 * ever wanted. `src/` gains nothing here.
 *
 * **The person's own variables win, and are not a fallback.** A person who names a server has
 * said which model judges their rooms; starting a second one beside it would be this file
 * overruling them, and two servers answering for one bot is the state row 24 exists to
 * prevent. So `SEEK_SERVER` (or `SEEK_WORK_SERVER`) present means this file does nothing at
 * all — it does not start, and it does not refuse.
 *
 * **What is missing is a sentence, not a crash.** A build without the binary, or a first run
 * that has not fetched the weights, has to leave the window open with the reason on the strip
 * that says which server was not used — the same shape a refused server has had since PR #88.
 * Nothing here throws for a state a person can be in.
 */

const { spawn } = require('node:child_process')
const { createServer } = require('node:net')
const { stat } = require('node:fs/promises')
const { join } = require('node:path')

const { WEIGHT_FILES } = require('./model-weights.js')

/** The directory the binary is packaged into (`ui/package.json`, `build.extraResources`). */
const SERVER_DIRECTORY = 'server'

/** The executable's name, which is llama.cpp's own. */
const SERVER_NAME = 'llama-server'

/**
 * How much one judgement may read, once the app is the one supplying the server.
 *
 * This is the number the kernel's own instructions use — `src/main.ts:69` asks "the measured
 * watch model" with `--server … --window 24` — so a bundled run reads its rooms the way the
 * measurements in `calibration/` read them. It is **not** a number this file is entitled to
 * invent: `box.ts` says the window is the caller's because the runtime cannot know one, and
 * row 20 leaves it out of the kernel for that reason. It therefore lives here, in the file
 * that is the caller, rather than beside the artifact.
 */
const WATCH_WINDOW = '24'

/** How long a cold start may take before it is called a refusal. */
const START_DEADLINE_MS = 180_000

/** Where the packaged binary sits, given the app's `resources` directory. */
function bundledServerPath(resourcesPath) {
  return join(resourcesPath, SERVER_DIRECTORY, SERVER_NAME)
}

/**
 * Where the two weight files live.
 *
 * `~/Library/Application Support/Seek/weights/`, which is `app.getPath('userData')` and then
 * one directory in: the weights are this app's data, and Electron already keeps its own caches
 * in the directory above. The two names are `model-weights.js`'s, so what a first run
 * downloads and what this reads cannot drift apart.
 */
function weightsDirectory(userDataPath) {
  return join(userDataPath, 'weights')
}

/**
 * Whether to start a server, decided from the environment and nothing else.
 *
 * `named` — the person said which server to use, so this file keeps out of it entirely.
 * `start` — nobody did, and the honest reading of a downloaded app is that it should.
 */
function serverChoiceFrom(env) {
  const names = ['SEEK_SERVER', 'SEEK_WORK_SERVER']
  const named = names.filter((name) => typeof env?.[name] === 'string' && env[name] !== '')
  return named.length > 0 ? { mode: 'named', names: named } : { mode: 'start' }
}

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
 * The first weight file that is not the size it is declared with, as a sentence — or `null`.
 *
 * The test is the one `model-weights.js` settled on, for the same reason it settled there: a
 * truncated file and a whole one are the same shape on disk, and only the count tells them
 * apart. A file that is the wrong size is not a download to resume but something else, and a
 * server started over it would either refuse in its own words or — worse — load whatever it
 * could and answer with a model nobody calibrated.
 */
async function weightsTrouble(directory, files) {
  for (const file of files) {
    const size = await sizeOf(join(directory, file.name))
    if (size === null) {
      return (
        `${file.name} is not in ${directory}: the weights arrive on a first run, and this ` +
        `one has not arrived yet (${file.bytes} bytes when it has)`
      )
    }
    if (size !== file.bytes) {
      return (
        `${file.name} is ${size} bytes where it should be ${file.bytes}: a file of the wrong ` +
        'size is a different file, and a model server started over it would answer as a model ' +
        'nothing here was calibrated against'
      )
    }
  }
  return null
}

/** A port nothing is listening on, so the child can have one of its own. */
async function freePort() {
  const probe = createServer()
  await new Promise((ready, fail) => {
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', ready)
  })
  const { port } = probe.address()
  await new Promise((done) => probe.close(done))
  return port
}

/**
 * Start the server the package carries, and hand back the origin the kernel wants.
 *
 * Returns `{ origin, port, stop, whenItStops }` when the server answers, and
 * `{ refusal }` — one sentence, in the shape the window draws — when it does not. Nothing
 * throws: a build with no binary, a first run with no weights and a server that died on
 * start-up are all states a person can be in, and each one is *said* rather than crashed.
 *
 * **Ready means answering, not started.** A process that has been spawned has not loaded a
 * model, and handing its origin to stage 1 first would make the first message of every launch
 * a refusal. So the origin comes back only once `/props` answers — the same endpoint row 24
 * has the kernel compare a roster's claimed model against.
 */
async function startBundledServer(options = {}) {
  const {
    binaryPath,
    weightsDir,
    files = WEIGHT_FILES,
    port: wantedPort,
    deadlineMs = START_DEADLINE_MS,
    env = process.env,
    fetchImpl = globalThis.fetch,
    spawnImpl = spawn,
    log = () => {},
    onStop = () => {},
  } = options

  const binarySize = await sizeOf(binaryPath)
  if (binarySize === null) {
    return {
      refusal:
        `this build carries no model server at ${binaryPath}: the package is supposed to hold ` +
        'one (`ui/package.json`), so this is a build that was made without it rather than a ' +
        'machine that is missing something',
    }
  }

  const trouble = await weightsTrouble(weightsDir, files)
  if (trouble !== null) return { refusal: trouble }

  const port = wantedPort ?? (await freePort())
  const args = [
    '--model', join(weightsDir, files[0].name),
    '--mmproj', join(weightsDir, files[1].name),
    '--host', '127.0.0.1',
    '--port', String(port),
    '--no-webui',
    // One slot: this server answers one bot's turns, and a second slot would split the KV
    // cache for a caller that never asks twice at once.
    '--parallel', '1',
    // The window this app feeds stage 1 is counted in tokens by `box.ts`, so the server has
    // to be able to hold at least that many plus the reply. 4096 is the smallest power of two
    // above the 2048 the measurements in `calibration/` ran with.
    '--ctx-size', '4096',
    '--n-gpu-layers', '99',
  ]

  let child
  try {
    child = spawnImpl(binaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env })
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    return { refusal: `the model server could not be started from ${binaryPath}: ${why}` }
  }

  // The child's own words are worth keeping: when a server refuses to load a model, its reason
  // is on stderr and nowhere else, and a person on a downloaded app has no terminal to read.
  let tail = ''
  const keep = (chunk) => {
    tail = `${tail}${chunk}`.split('\n').slice(-8).join('\n')
    log(String(chunk).trimEnd())
  }
  child.stdout?.on('data', keep)
  child.stderr?.on('data', keep)

  let exited = null
  let stopping = false
  const stopped = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      exited = { code, signal }
      resolve(exited)
      if (!stopping) onStop({ reason: 'exited', code, signal, tail })
    })
  })

  /** Stop the child and wait for it, however many times this is called. */
  async function stop() {
    stopping = true
    if (exited !== null) return exited
    child.kill('SIGTERM')
    const died = await Promise.race([stopped, new Promise((r) => setTimeout(() => r(null), 5000))])
    if (died === null && exited === null) {
      child.kill('SIGKILL')
      await stopped
    }
    return exited
  }

  const origin = `http://127.0.0.1:${port}`
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    if (exited !== null) {
      return {
        refusal:
          `the model server stopped while it was starting (exit ${exited.code}` +
          `${exited.signal ? `, ${exited.signal}` : ''}): ${tail.trim() || 'it said nothing'}`,
      }
    }
    try {
      const answer = await fetchImpl(`${origin}/props`, { signal: AbortSignal.timeout(3000) })
      if (answer.ok) {
        const props = await answer.json()
        return { origin, port, props, child, stop, whenItStops: stopped }
      }
    } catch {
      // Not listening yet, or mid-load: the loop is the wait.
    }
    await new Promise((ready) => setTimeout(ready, 500))
  }

  // Giving up is not the same as walking away: the process that was started is stopped before
  // the refusal is returned, because a refused launch that leaves a `llama-server` holding a
  // 1.5 GB model on someone's laptop is worse than a launch that refuses.
  await stop()
  return {
    refusal:
      `the model server did not answer on ${origin} within ${Math.round(deadlineMs / 1000)} s: ` +
      `${tail.trim() || 'it said nothing'}`,
  }
}

module.exports = {
  SERVER_DIRECTORY,
  SERVER_NAME,
  START_DEADLINE_MS,
  WATCH_WINDOW,
  bundledServerPath,
  serverChoiceFrom,
  startBundledServer,
  weightsDirectory,
  weightsTrouble,
}
