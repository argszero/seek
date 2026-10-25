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

const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron')
const { join } = require('node:path')

const { closeHost, openHost, postMessage } = require('./host.js')
const { snapshotOf } = require('./snapshot.js')

const DEV_URL = process.env.SEEK_UI_DEV_URL
const DATA_DIR = process.env.SEEK_DATA_DIR || join(app.getPath('userData'), 'seek-data')
const STORE_FILE = join(DATA_DIR, 'seek.json')

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
ipcMain.handle('seek:snapshot', () => snapshotOf(host?.store ?? null, STORE_FILE))
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

app.whenReady().then(async () => {
  host = await openHost(STORE_FILE)
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
