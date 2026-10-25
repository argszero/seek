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

const { addMember, closeHost, createRoom, openHost, postMessage } = require('./host.js')
const { BY_MIME, mimeForPath, readMedia, saveMedia } = require('./media.js')
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

/** The kernel, opened once, and the one window that may be told when it changes. */
let host = null
let win = null

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
ipcMain.handle('seek:snapshot', () =>
  snapshotOf(host?.store ?? null, STORE_FILE, host?.stage1 ?? null, host?.stage2 ?? null),
)
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

app.whenReady().then(async () => {
  host = await openHost(STORE_FILE, {
    server: MODEL_SERVER,
    window: MODEL_WINDOW,
    workServer: MODEL_WORK_SERVER,
  })
  // A server the person named and this build did not use is said twice — here, where the
  // app was started, and in the window, where they are looking. The window is the one that
  // matters; this line is what makes a refusal visible in a terminal that has no window
  // attached to it yet. Each half is said on its own, because either can refuse alone.
  if (host.stage1?.refusal) {
    console.error(`seek: the watch server was not used — ${host.stage1.refusal}`)
  }
  if (host.stage2?.refusal) {
    console.error(`seek: the work server was not used — ${host.stage2.refusal}`)
  }
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

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
})
