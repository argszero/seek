'use strict'

/**
 * The Electron main process: it *is* the kernel's host.
 *
 * Electron 45 carries Node 24, which strips TypeScript itself, so `src/` runs here
 * as it stands — no build step for the kernel, and no second process to supervise.
 * That was measured before this file was written rather than assumed: importing
 * `../../src/store.ts` in a ready main process builds a `SeekStore`.
 *
 * The renderer never touches the filesystem. It asks for a snapshot through
 * `preload.js`, so the kernel keeps its one writer and the interface stays a view.
 */

const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron')
const { join } = require('node:path')
const { existsSync } = require('node:fs')
const { snapshotOf } = require('./snapshot.js')

const DEV_URL = process.env.SEEK_UI_DEV_URL
const DATA_DIR = process.env.SEEK_DATA_DIR || join(app.getPath('userData'), 'seek-data')
const STORE_FILE = join(DATA_DIR, 'seek.json')

/** The kernel, loaded once. `src/` stays TypeScript; Node strips it. */
let kernelModule = null
let store = null

async function openStore() {
  const mod = await import('../../src/store.ts')
  kernelModule = mod
  store = existsSync(STORE_FILE) ? await mod.SeekStore.load(STORE_FILE) : new mod.SeekStore(mod.emptyData(), STORE_FILE)
  return store
}

/**
 * What the interface is allowed to see.
 *
 * A plain, serialisable read of the store: rooms, the bots in them, and each room's
 * messages in the order they were written. It is built here rather than in the
 * renderer because the renderer has no access to the kernel.
 */
function createWindow() {
  const win = new BrowserWindow({
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
  return win
}

ipcMain.handle('seek:snapshot', () => snapshotOf(store, STORE_FILE))
ipcMain.handle('seek:data-path', () => STORE_FILE)

app.whenReady().then(async () => {
  await openStore()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
