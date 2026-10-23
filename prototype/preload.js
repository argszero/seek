'use strict'

const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('seekHost', {
  load: () => ipcRenderer.invoke('seek:load'),
  save: (state) => ipcRenderer.invoke('seek:save', state),
  dataPath: () => ipcRenderer.invoke('seek:data-path'),
  openDataFolder: () => ipcRenderer.invoke('seek:open-data-folder'),
  setTheme: (theme) => ipcRenderer.invoke('seek:set-theme', theme),

  // Attachments: pick from the system dialog, ingest dropped paths, or grab the
  // clipboard image pasted over the composer.
  pick: (kind) => ipcRenderer.invoke('seek:pick', kind),
  ingest: (paths) => ipcRenderer.invoke('seek:ingest', paths),
  pasteImage: () => ipcRenderer.invoke('seek:paste-image'),
  openFile: (key) => ipcRenderer.invoke('seek:open-file', key),
  revealFile: (key) => ipcRenderer.invoke('seek:reveal-file', key),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file)
    } catch (err) {
      return ''
    }
  },

  platform: process.platform
})
