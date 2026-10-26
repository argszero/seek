'use strict'

/**
 * The Electron main process: it *is* the kernel's host.
 *
 * Electron 45 carries Node 24, which strips TypeScript itself, so `src/` runs here as
 * it stands — no build step for the kernel, and no second process to supervise. That
 * was measured before this file was written rather than assumed: importing
 * `../../src/store.ts` in a ready main process builds a `SeekStore`.
 *
 * This file adds windows and IPC and nothing else. What the interface may do to the
 * kernel — read a snapshot, post a message — is `host.js`, which runs under plain
 * `node --test`. The renderer never touches the filesystem and never holds a store
 * handle: it asks, and the kernel answers.
 */

const { app, BrowserWindow, dialog, ipcMain, nativeTheme } = require('electron')
const { readFile } = require('node:fs/promises')
const { basename, join } = require('node:path')

const { addMember, closeHost, createRoom, openHostOrRefuse, postMessage } = require('./host.js')
const { BY_MIME, mimeForPath, readMedia, saveMedia } = require('./media.js')
const { ensureWeights, progressSentence } = require('./weights-fetch.js')
const {
  WATCH_WINDOW,
  bundledServerPath,
  serverChoiceFrom,
  startBundledServer,
  weightsDirectory,
} = require('./server.js')
const { snapshotOf } = require('./snapshot.js')

const DEV_URL = process.env.SEEK_UI_DEV_URL
const DATA_DIR = process.env.SEEK_DATA_DIR || join(app.getPath('userData'), 'seek-data')
const STORE_FILE = join(DATA_DIR, 'seek.json')

/**
 * The model servers, as the person started the app with them.
 *
 * **Three variables, and each half of the bot takes its own.** Stage 1 needs two facts and
 * neither has a default this app may invent: `SEEK_SERVER` is which `llama-server` decides
 * *whether* the bot acts, and `SEEK_WINDOW` is how much one judgement may read
 * (`docs/decisions.md` row 20). Stage 2 needs one: `SEEK_WORK_SERVER` is which server
 * writes the *words*, and it is a separate origin because a server serves one model while
 * the roster's watch and work rows may name two (`docs/decisions.md` row 24 — the work
 * row's model "belongs to the other server"). A turn's prompt is checked against that
 * server's own window per turn, so this half takes no budget.
 *
 * They are read here rather than in `host.js` so that the one place the environment is
 * consulted is the process that owns it — `host.js` takes them as arguments and stays
 * runnable under `node --test`.
 *
 * **Left unset, nothing changes**: that half is the kernel's placeholder and the window
 * says so. `SEEK_SERVER` without `SEEK_WINDOW` is a refusal rather than a guess, and the
 * window shows it.
 */
const MODEL_SERVER = process.env.SEEK_SERVER
const MODEL_WINDOW = process.env.SEEK_WINDOW
const MODEL_WORK_SERVER = process.env.SEEK_WORK_SERVER

/**
 * The server the app starts for itself, when nobody named one.
 *
 * A person who double-clicks the app cannot set an environment variable, so the three above
 * could only ever be supplied from a terminal — which left every downloaded app on the
 * kernel's placeholder. The package now carries `llama-server` (`extraResources`), and this
 * is where it is started, fed to both halves and stopped. The decision lives in `server.js`,
 * including the rule that a person who *did* name a server is not overruled.
 */
let modelServer = null

/**
 * Why the server this app started is no longer in use, or `null` while it is.
 *
 * The same fact a server the person *named* reports, in the same place: `snapshot.js` draws
 * `refusal` as "a server that was in use and is not", and a bundled server that died
 * mid-run is exactly that. It is held here rather than thrown because the window must stay
 * open — the store is local and every message in it is still readable.
 */
let modelServerRefusal = null

/**
 * The weights: how far the download has got, and why it stopped.
 *
 * A first run fetches 2.1 GB before any model exists, so this is the state the window spends
 * the longest in, and it is two readings rather than one — "still arriving, this far" and
 * "stopped, and why" — because they are drawn in different colours and only the second is a
 * failure. `null` in both means nothing is being fetched and nothing went wrong, which is
 * every launch after the first.
 */
let weightsPending = null
let weightsRefusal = null

/** The kernel, opened once, and the one window that may be told when it changes. */
let host = null
let win = null

/**
 * Why the kernel would not open the store, or `null` when it did.
 *
 * Held beside `host` rather than thrown, because a store this version refuses is exactly the
 * state the window must be able to describe. See the ready handler below for what went wrong
 * when it was an exception instead.
 */
let storeRefusal = null

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1f2329' : '#f5f6f7',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  if (DEV_URL) win.loadURL(DEV_URL)
  else win.loadFile(join(__dirname, '..', 'dist', 'index.html'))
  win.on('closed', () => {
    win = null
  })
  return win
}

/** What the interface is allowed to see: a plain, serialisable read of the store. */
function snapshotNow() {
  // The model-server facts replace each half's own reading and nothing else: the origin each
  // half was bound to is still true, and `server` is what the window prints beside it. They
  // are stated in the order they win — a download under way is the newest fact, the reason it
  // stopped is the next, and a server that died while the window was open is the last.
  const half = (stage) => {
    if (weightsPending !== null) return { ...stage, pending: weightsPending, refusal: null }
    if (weightsRefusal !== null) return { ...stage, pending: null, refusal: weightsRefusal }
    if (modelServerRefusal !== null) return { ...stage, pending: null, refusal: modelServerRefusal }
    return stage
  }
  return snapshotOf(
    host?.store ?? null,
    STORE_FILE,
    half(host?.stage1 ?? null),
    half(host?.stage2 ?? null),
    storeRefusal,
  )
}

/** Tell the window the facts changed, if there is a window listening. */
function pushChanged() {
  if (win && !win.isDestroyed()) win.webContents.send('seek:changed', snapshotNow())
}

ipcMain.handle('seek:snapshot', () => snapshotNow())
ipcMain.handle('seek:data-path', () => STORE_FILE)

/**
 * The composer's one call.
 *
 * A refusal comes back as `{ ok: false, error }` rather than as a rejected renderer
 * call, because the interface has to *show* it: a message that was silently not sent,
 * or sent into a room that does not exist, is the one failure a chat window cannot
 * have. The kernel's own errors (`unknown room`, `sender is not a member`, an empty
 * text) are already sentences, so they are passed through rather than re-worded here.
 */
ipcMain.handle('seek:post', async (_event, input) => {
  try {
    const snapshot = await postMessage(host, input ?? {})
    if (win && !win.isDestroyed()) win.webContents.send('seek:changed', snapshot)
    return { ok: true, snapshot }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
})

/**
 * Make a room, and tell every window the new snapshot.
 *
 * The same envelope as `seek:post`, for the same reason: a room that was refused has to be
 * *shown*, and a rejected renderer call would put the kernel's sentence in a console nobody
 * is reading. `roomId` is what the window needs and a snapshot cannot say — "the room that
 * was just made" is not derivable from a room list that may already have held one with that
 * name.
 */
ipcMain.handle('seek:create-room', async (_event, input) => {
  try {
    const made = await createRoom(host, input ?? {})
    if (win && !win.isDestroyed()) win.webContents.send('seek:changed', made.snapshot)
    return { ok: true, snapshot: made.snapshot, roomId: made.roomId }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
})

/**
 * Put one more person into a room, and tell every window the new snapshot.
 *
 * The same envelope as `seek:post`, with one thing `seek:create-room` needs and this does
 * not: no second return field. A room that just gained a member is the room it already was,
 * so there is no id here that a snapshot cannot say — `seek:create-room` hands back `roomId`
 * only because "the room that was just made" is not derivable from a room list.
 */
ipcMain.handle('seek:add-member', async (_event, input) => {
  try {
    const snapshot = await addMember(host, input ?? {})
    if (win && !win.isDestroyed()) win.webContents.send('seek:changed', snapshot)
    return { ok: true, snapshot }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
})

/**
 * Choose a picture, and put its bytes where this machine keeps them.
 *
 * The dialog is here rather than in the renderer because a renderer with
 * `contextIsolation` has no filesystem — and because the bytes must be written *before*
 * the message that names them is posted: `deliver()` refuses an `image` whose reference
 * points at nothing (`src/delivery.ts`), so the order is the kernel's requirement, not a
 * preference of this file.
 *
 * Three answers, and the interface draws all three apart:
 *
 * - `{ ok: true, media }` — a picture is on disk and the composer may post it.
 * - `{ ok: false, cancelled: true }` — the person closed the dialog. Not a failure, and
 *   nothing to draw.
 * - `{ ok: false, error }` — the file is there and unusable, named in a sentence. The one
 *   refusal this file adds is the extension: `@electron/get`-style guessing is not
 *   available, the dialog hands back a path and no mime, and writing bytes under a type
 *   `mediaFor` will refuse leaves a file in `media/` that no message ever points at.
 */
ipcMain.handle('seek:attach', async () => {
  try {
    if (!win || win.isDestroyed()) throw new Error('there is no window to ask in')
    const picked = await dialog.showOpenDialog(win, {
      title: 'Attach a picture',
      properties: ['openFile'],
      filters: [{ name: 'Pictures', extensions: [...new Set([...BY_MIME.values()])] }],
    })
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, cancelled: true }

    const filePath = picked.filePaths[0]
    const mime = mimeForPath(filePath)
    if (!mime) {
      return {
        ok: false,
        error:
          `this app sends ${[...BY_MIME.keys()].join(', ')} and cannot tell what ` +
          `${basename(filePath)} is: the file dialog hands back a name with no type on it, ` +
          'so the extension is the only thing there is to read',
      }
    }
    const bytes = await readFile(filePath)
    const media = saveMedia(STORE_FILE, { bytes, mime, name: basename(filePath) })
    return { ok: true, media }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
})

/**
 * One picture's bytes, as a string the renderer can draw.
 *
 * The snapshot carries the reference and never the bytes: the store is rewritten whole on
 * every save and a snapshot is taken after every delivery, so inlining a picture there
 * would re-serialise it on every unrelated message. A `data:` URL per picture, asked for
 * once per message as it is drawn, keeps the snapshot a description of the store.
 */
ipcMain.handle('seek:media', (_event, reference) => {
  try {
    return { ok: true, ...readMedia(STORE_FILE, reference ?? {}) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
})

/**
 * Start the app: open the kernel, then make the window — in that order, and the window is
 * made **whatever the kernel answered**.
 *
 * **A refusal must not be able to stop the window from being made.** This used to be
 * `app.whenReady().then(async () => { host = await openHost(...); createWindow() })`, and a
 * store this version would not read made `openHost` throw: `createWindow()` never ran, the
 * `activate` handler below was never registered, and the failure surfaced as an
 * `UnhandledPromiseRejectionWarning` on a stderr the Finder-launched app writes to
 * `/dev/null`. The person saw an app that did nothing at all — no window, no dialog, no
 * sentence — while the kernel had written a paragraph explaining exactly what to do. Found
 * on a real install, where a store from an older build sat in `~/Library/Application
 * Support/Seek`; no driver in this repository had ever started the app over one, because
 * every driver passed `SEEK_DATA_DIR` pointing at an empty directory.
 *
 * So the store's answer is a fact held in `storeRefusal` and drawn by the window, in the
 * same shape stage 1 and stage 2 refuse in. A store that opened leaves it `null` and nothing
 * changes.
 */
async function start() {
  // **The window is made first, before anything that can take minutes.** A first run fetches
  // 2.1 GB before a model exists, and a launch that opened the window afterwards would spend
  // that whole download showing nothing at all — indistinguishable from an app that did not
  // start, which is the failure `openHostOrRefuse` was written for one layer down. The
  // snapshot reports "the store is not open yet" in the meantime, which is a state it already
  // had for exactly this moment.
  createWindow()
  registerActivate()

  // **Nobody named a server, so the app starts the one it carries.**
  // `serverChoiceFrom` reads the environment and nothing else, and it answers `named` for a
  // person who did — a terminal run is not overruled by a package that holds a binary.
  const choice = serverChoiceFrom(process.env)
  let server = MODEL_SERVER
  let serverWindow = MODEL_WINDOW
  let workServer = MODEL_WORK_SERVER
  let startRefusal = null

  if (choice.mode === 'start') {
    // `process.resourcesPath` is a packaged app's `Contents/Resources`, which is where
    // `extraResources` puts `server/`. An unpackaged run points at Electron's own resources
    // instead, so it is given the directory the packaging copies *from* — otherwise the only
    // way to see this code run would be to build a `.app` first.
    const resources = app.isPackaged ? process.resourcesPath : join(__dirname, '..', 'resources')
    const weightsDir = weightsDirectory(app.getPath('userData'))

    // The weights come first, because a server started over files that are not there refuses
    // by design and the reason would be the wrong one. `SEEK_WEIGHTS_BASE` is how a run is
    // pointed at a mirror; unset means the canonical host (`weights-fetch.js`).
    const arrived = await ensureWeights({
      dir: weightsDir,
      base: process.env.SEEK_WEIGHTS_BASE,
      onProgress: (reading) => weightProgress(reading),
    })
    weightsPending = null
    if (!arrived.ok) {
      // Offline, a host that refused, a file that stopped short: one sentence, drawn where the
      // model strips already draw "which server, and why not". The download resumes where it
      // stopped on the next launch, which is what the sentence tells the person to do.
      weightsRefusal = `${arrived.refusal}; launching Seek again continues where it stopped`
      startRefusal = weightsRefusal
      server = undefined
      workServer = undefined
      console.error(`seek: the weights did not arrive — ${weightsRefusal}`)
      pushChanged()
    } else {
      if (arrived.fetched) console.error(`seek: the weights arrived (${arrived.bytes} bytes)`)
      const started = await startBundledServer({
        binaryPath: bundledServerPath(resources),
        weightsDir,
        log: (line) => console.error(`seek: model server — ${line}`),
        // Only a server the app has *already opened on* is this handler's business. Before
        // that, a child that exits is `startBundledServer`'s answer — it returns the refusal
        // itself — and reporting it here as well would say it twice, in the wrong order.
        onStop: (how) => {
          if (modelServer !== null) serverStopped(how)
        },
      })
      if (started.refusal) {
        // No binary, a model that would not load: every one of them is a state a first run can
        // be in, and each is said rather than crashed. Both halves are refused together
        // because one server answers for both — the roster's two rows name no model of their
        // own (`FIRST_RUN_ROSTER`), so there is one origin and not two.
        startRefusal = started.refusal
        server = undefined
        workServer = undefined
      } else {
        modelServer = started
        server = started.origin
        // How much one judgement may read: `src/main.ts` asks the measured watch model with
        // `--window 24`, and `docs/decisions.md` row 20 leaves the number out of the kernel
        // because the runtime cannot know one. This file *is* the caller, so it lives here.
        serverWindow = WATCH_WINDOW
        workServer = started.origin
        console.error(`seek: the model server is ${started.origin}`)
      }
    }
  }

  const opened = await openHostOrRefuse(STORE_FILE, {
    server,
    window: serverWindow,
    workServer,
    serverRefusal: startRefusal ?? undefined,
    workServerRefusal: startRefusal ?? undefined,
  })
  host = opened.host
  storeRefusal = opened.refusal
  // Said here, where the app was started, as well as in the window where the person is
  // looking — the same two places a refused model server is said, and for the same reason.
  if (storeRefusal) console.error(`seek: the store was not opened — ${storeRefusal}`)
  // A server the person named and this build did not use is said twice — here, where the
  // app was started, and in the window, where they are looking. The window is the one that
  // matters; this line is what makes a refusal visible in a terminal that has no window
  // attached to it yet. Each half is said on its own, because either can refuse alone.
  if (host?.stage1?.refusal) {
    console.error(`seek: the watch server was not used — ${host.stage1.refusal}`)
  }
  if (host?.stage2?.refusal) {
    console.error(`seek: the work server was not used — ${host.stage2.refusal}`)
  }
  // The window was made before any of this, so what is left is telling it what it now knows:
  // the store is open, the halves are bound or refused, or the store itself was refused.
  pushChanged()
}

/** One `activate` handler, however many times `start` runs. */
function registerActivate() {
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}

/**
 * The bundled server stopped after the app had opened on it.
 *
 * Nothing restarts it. A server that dies is a fact about this run, and a restart loop would
 * hide the reason behind a spinner while the child's own last words — the only place a
 * llama.cpp start-up failure explains itself — scroll away unread. Both halves take the
 * sentence because both were bound to the one process.
 *
 * The kernel keeps the judge it was built with, which is now pointed at a dead origin; a
 * message that asks it gets a transport failure, and the strip above the room says why.
 */
function serverStopped({ reason, code, signal, tail }) {
  const how =
    reason === 'exited'
      ? `stopped (exit ${code}${signal ? `, ${signal}` : ''})`
      : String(reason ?? 'stopped')
  const said = String(tail ?? '').trim() || 'it said nothing'
  modelServerRefusal = `the model server this app started ${how}: ${said}`
  modelServer = null
  console.error(`seek: the model server stopped — ${modelServerRefusal}`)
  pushChanged()
}

/**
 * The download's reading, drawn on the strips.
 *
 * Two things are decided here rather than in `weights-fetch.js`. The sentence is formatted for a
 * strip that truncates with an ellipsis, so it leads with the numbers. And the pushes are
 * throttled: a 2.1 GB body arrives in thousands of chunks, and re-rendering the window once
 * per chunk would spend the download's own bandwidth on IPC. Half a second is finer than a
 * person reads and coarse enough that the message never grows to a queue.
 */
const PROGRESS_INTERVAL_MS = 500
let lastPushed = 0

function weightProgress(reading) {
  weightsPending = progressSentence(reading)
  const now = Date.now()
  if (now - lastPushed < PROGRESS_INTERVAL_MS) return
  lastPushed = now
  pushChanged()
}

app.whenReady().then(start)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (host) closeHost(host)
    app.quit()
  }
})

// The comparator is disarmed on the way out. Nothing is lost by it: a row that came
// due while nothing was sweeping is caught by the next start, once (`§12 (c)`).
app.on('before-quit', () => {
  if (host) closeHost(host)
  // **The child does not die with the app.** A process started without `detached` is
  // reparented when its parent goes, not killed, so a quit that only closed the store would
  // leave a `llama-server` holding a model in memory behind every launch. `stop()` sends
  // SIGTERM synchronously, before its first `await`, so calling it here is enough.
  if (modelServer) modelServer.stop()
})
