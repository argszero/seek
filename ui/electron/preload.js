'use strict'

const { contextBridge, ipcRenderer } = require('electron')

/**
 * The renderer's whole vocabulary. Three asks and one subscription — a renderer that
 * could reach the store directly would be a second writer, and the kernel has one.
 */
contextBridge.exposeInMainWorld('seekHost', {
  snapshot: () => ipcRenderer.invoke('seek:snapshot'),
  dataPath: () => ipcRenderer.invoke('seek:data-path'),
  post: (input) => ipcRenderer.invoke('seek:post', input),
  /**
   * Told when the kernel changed the store by itself — a bot answering a message, or a
   * schedule row coming due — so the window is not only correct after *it* typed.
   * Returns the unsubscribe, because a component that mounts twice must not leave two
   * listeners behind.
   */
  onChanged: (listener) => {
    const handler = (_event, snapshot) => listener(snapshot)
    ipcRenderer.on('seek:changed', handler)
    return () => ipcRenderer.off('seek:changed', handler)
  },
})
