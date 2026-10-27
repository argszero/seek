'use strict'

/**
 * The prototype's Electron shell: **a window, a menu, and nothing else.**
 *
 * It used to be a second application — a data file under `userData`, a private `seek-file:`
 * scheme, eight IPC handlers for attachments and two for the store. All of that is gone with
 * the second renderer it served: the demo's data is a fixture inside the page
 * (`src/fixture.js`) and its host is a fake (`src/fake-host.js`), so there is nothing here
 * for a main process to own.
 *
 * What is left is the part that cannot be faked from the renderer: a window with the app's
 * own title-bar treatment, and a menu, so copying and pasting work.
 */
const { app, BrowserWindow, Menu, shell } = require('electron')
const path = require('path')
const fs = require('fs')

// The app mark. It lives at the repo root so there is one source of truth for the icon;
// `node assets/render-icons.js` regenerates every size from assets/icon.svg.
const APP_ICON = path.join(__dirname, '..', 'assets', 'icon.png')

/** What `npm run build` produces, and the only page this shell will load. */
const PAGE = path.join(__dirname, 'dist', 'index.html')

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
      // No preload: the host the page talks to is inside the page.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })

  // A build that has not run yet is the one failure this shell can have, and an empty window
  // says nothing about it. Say what to run instead.
  if (!fs.existsSync(PAGE)) {
    win.loadURL(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(
          '<body style="font:13px -apple-system;padding:32px">' +
            '<p><b>The prototype has not been built.</b></p>' +
            '<p>Run <code>npm run build</code> in <code>prototype/</code>, then start it again.</p>',
        ),
    )
    return
  }

  win.loadFile(PAGE)

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

  win.on('closed', () => {
    win = null
  })
}

/** The usual macOS set, so copying, pasting and reloading work while looking at the demo. */
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
        { role: 'selectAll', label: '全选' },
      ],
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
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    { role: 'windowMenu', label: '窗口' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(() => {
  buildMenu()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
