'use strict'

const { contextBridge, ipcRenderer } = require('electron')

/**
 * The renderer's whole vocabulary. Three asks, one read and one subscription — a renderer
 * that could reach the store directly would be a second writer, and the kernel has one.
 *
 * `attach` and `media` are the picture pair (`docs/decisions.md` row 17). They are two
 * calls rather than one because they answer different questions at different moments:
 * `attach` writes bytes once, when a person chooses a file, and `media` reads them back
 * every time a message carrying a reference is drawn. Neither hands the renderer a path —
 * it has no filesystem, so a path would be a name it cannot open.
 */
contextBridge.exposeInMainWorld('seekHost', {
  snapshot: () => ipcRenderer.invoke('seek:snapshot'),
  dataPath: () => ipcRenderer.invoke('seek:data-path'),
  post: (input) => ipcRenderer.invoke('seek:post', input),
  attach: () => ipcRenderer.invoke('seek:attach'),
  media: (reference) => ipcRenderer.invoke('seek:media', reference),
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
