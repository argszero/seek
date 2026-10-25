'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('seekHost', {
  snapshot: () => ipcRenderer.invoke('seek:snapshot'),
  dataPath: () => ipcRenderer.invoke('seek:data-path'),
})
