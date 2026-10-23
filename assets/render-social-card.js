'use strict'

// Render assets/social-card.html to assets/social-card.png (1280x640, GitHub's
// social preview size). Run with the Electron binary from the prototype:
//
//   prototype/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
//     assets/render-social-card.js --no-sandbox --disable-gpu
//
// A plain hidden window is used on purpose: offscreen rendering plus capturePage
// deadlocks in this environment, while a normal window captures reliably.

const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')

const W = 1280
const H = 640
const HTML = path.join(__dirname, 'social-card.html')
const OUT = path.join(__dirname, 'social-card.png')

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  console.log('ready')
  const win = new BrowserWindow({
    width: W,
    height: H,
    useContentSize: true,
    show: false,
    frame: false,
    resizable: false,
    backgroundColor: '#336df4',
    webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: false }
  })

  await win.loadFile(HTML)
  console.log('loaded html')

  await new Promise((r) => setTimeout(r, 600))

  let img = await win.webContents.capturePage()
  const got = img.getSize()
  console.log('captured', got.width + 'x' + got.height)

  if (got.width !== W || got.height !== H) {
    img = img.resize({ width: W, height: H, quality: 'best' })
    console.log('resized to', W + 'x' + H)
  }

  fs.writeFileSync(OUT, img.toPNG())
  console.log('wrote', OUT, img.getSize().width + 'x' + img.getSize().height, fs.statSync(OUT).size + 'B')
  app.exit(0)
})
