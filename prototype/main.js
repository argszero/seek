'use strict'

const {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  shell,
  nativeTheme,
  protocol,
  net,
  dialog,
  clipboard
} = require('electron')
const path = require('path')
const fs = require('fs')
const { pathToFileURL } = require('url')

// The app mark. It lives at the repo root so there is one source of truth for the icon;
// `node assets/render-icons.js` regenerates every size from assets/icon.svg.
const APP_ICON = path.join(__dirname, '..', 'assets', 'icon.png')

// ---------------------------------------------------------------------------
// Local persistence. Everything lives on this machine — seek has no server.
// ---------------------------------------------------------------------------

const dataDir = () => path.join(app.getPath('userData'), 'seek-data')
const dataFile = () => path.join(dataDir(), 'seek.json')

// Attachments live next to the state file, one flat directory of blobs.
const filesDir = () => path.join(dataDir(), 'files')

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.heic': 'image/heic',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json'
}

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic', 'avif']

// A file key is a flat name; anything that could climb out of filesDir is dropped.
function safeKey(key) {
  return String(key || '').replace(/[^A-Za-z0-9._-]/g, '')
}

// Copy one picked path into the blob directory and describe it for the model.
function ingest(filePath) {
  fs.mkdirSync(filesDir(), { recursive: true })
  const ext = path.extname(filePath).toLowerCase()
  const key =
    Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9) + (ext || '')
  fs.copyFileSync(filePath, path.join(filesDir(), key))
  let size = 0
  try {
    size = fs.statSync(filePath).size
  } catch (err) {}
  return {
    file_key: key,
    file_name: path.basename(filePath),
    file_size: size,
    mime: MIME[ext] || '',
    is_image: IMAGE_EXT.indexOf(ext.replace('.', '')) >= 0
  }
}

// Attachments are served over a private scheme so the renderer can show them
// without handing the page a filesystem path.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'seek-file',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])

function readState() {
  try {
    return JSON.parse(fs.readFileSync(dataFile(), 'utf8'))
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[seek] read failed:', err.message)
    return null
  }
}

function writeState(state) {
  fs.mkdirSync(dataDir(), { recursive: true })
  const tmp = dataFile() + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
  fs.renameSync(tmp, dataFile())
  return { ok: true, path: dataFile() }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

let win = null

function createWindow() {
  // macOS takes the dock icon from the app bundle; an unpackaged run has to set it by hand.
  if (process.platform === 'darwin' && app.dock && fs.existsSync(APP_ICON)) {
    app.dock.setIcon(APP_ICON)
  }

  win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 940,
    minHeight: 600,
    title: 'Seek',
    icon: fs.existsSync(APP_ICON) ? APP_ICON : undefined,
    backgroundColor: '#ffffff',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })

  win.loadFile(path.join(__dirname, 'src', 'index.html'))

  // Links never navigate the shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault()
      if (/^https?:/.test(url)) shell.openExternal(url)
    }
  })

  win.on('closed', () => { win = null })
}

// ---------------------------------------------------------------------------
// Menu — the usual macOS set, so copying / pasting / undoing works.
// ---------------------------------------------------------------------------

function buildMenu() {
  const isMac = process.platform === 'darwin'
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新载入' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    { role: 'windowMenu', label: '窗口' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

ipcMain.handle('seek:load', () => readState())
ipcMain.handle('seek:save', (_event, state) => writeState(state))
ipcMain.handle('seek:data-path', () => dataFile())
ipcMain.handle('seek:open-data-folder', () => {
  fs.mkdirSync(dataDir(), { recursive: true })
  return shell.openPath(dataDir())
})
ipcMain.handle('seek:set-theme', (_event, theme) => {
  nativeTheme.themeSource = theme === 'dark' ? 'dark' : theme === 'light' ? 'light' : 'system'
  return nativeTheme.shouldUseDarkColors
})

// ---------------------------------------------------------------------------
// Attachments: pick → copy into the data directory → hand the model a key.
// ---------------------------------------------------------------------------

ipcMain.handle('seek:pick', async (_event, kind) => {
  const isImage = kind === 'image'
  const result = await dialog.showOpenDialog(win, {
    title: isImage ? '选择图片' : '选择文件',
    buttonLabel: '发送',
    properties: ['openFile', 'multiSelections'],
    filters: isImage
      ? [{ name: '图片', extensions: IMAGE_EXT }]
      : [{ name: '所有文件', extensions: ['*'] }]
  })
  if (result.canceled || !result.filePaths.length) return []
  const out = []
  result.filePaths.forEach((p) => {
    try {
      out.push(ingest(p))
    } catch (err) {
      console.error('[seek] attach failed:', p, err.message)
    }
  })
  return out
})

// Drag & drop hands over real paths, which are ingested the same way.
ipcMain.handle('seek:ingest', (_event, paths) => {
  const out = []
  ;(paths || []).forEach((p) => {
    try {
      if (p && fs.existsSync(p) && fs.statSync(p).isFile()) out.push(ingest(p))
    } catch (err) {
      console.error('[seek] attach failed:', p, err.message)
    }
  })
  return out
})

// Cmd+V with an image on the clipboard — the most common way to send a picture.
ipcMain.handle('seek:paste-image', () => {
  const image = clipboard.readImage()
  if (!image || image.isEmpty()) return null
  fs.mkdirSync(filesDir(), { recursive: true })
  const key = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9) + '.png'
  const png = image.toPNG()
  fs.writeFileSync(path.join(filesDir(), key), png)
  return {
    file_key: key,
    file_name: '粘贴的图片.png',
    file_size: png.length,
    mime: 'image/png',
    is_image: true
  }
})

ipcMain.handle('seek:open-file', (_event, key) => {
  const p = path.join(filesDir(), safeKey(key))
  if (!fs.existsSync(p)) return 'missing'
  return shell.openPath(p)
})

ipcMain.handle('seek:reveal-file', (_event, key) => {
  const p = path.join(filesDir(), safeKey(key))
  if (!fs.existsSync(p)) return false
  shell.showItemInFolder(p)
  return true
})

app.whenReady().then(() => {
  protocol.handle('seek-file', async (request) => {
    try {
      const url = new URL(request.url)
      const key = safeKey(decodeURIComponent(url.pathname.replace(/^\//, '')))
      const p = path.join(filesDir(), key)
      if (!key || !p.startsWith(filesDir() + path.sep) || !fs.existsSync(p)) {
        return new Response('not found', { status: 404 })
      }
      const res = await net.fetch(pathToFileURL(p).toString())
      const ext = path.extname(p).toLowerCase()
      return new Response(res.body, {
        status: 200,
        headers: {
          'content-type': MIME[ext] || res.headers.get('content-type') || 'application/octet-stream',
          'cache-control': 'no-cache'
        }
      })
    } catch (err) {
      return new Response('not found', { status: 404 })
    }
  })

  buildMenu()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
