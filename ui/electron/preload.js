'use strict'

const { contextBridge, ipcRenderer } = require('electron')

/**
 * The renderer's whole vocabulary, and every write it has is here. There are three — a
 * message, a room, and one more member — because a renderer that could reach the store
 * directly would be a second writer, and the kernel has one.
 *
 * `attach` and `media` are the picture pair. They are two
 * calls rather than one because they answer different questions at different moments:
 * `attach` writes bytes once, when a person chooses a file, and `media` reads them back
 * every time a message carrying a reference is drawn. Neither hands the renderer a path —
 * it has no filesystem, so a path would be a name it cannot open.
 *
 * `createRoom` and `addMember` are the other two writes, and each is a call rather than a
 * store handle for the same reason. A room is made by the kernel's own `createRoom()`
 * (`src/rooms.ts`), which writes the room and its members in one step and refuses an empty
 * room, a duplicate member and a member nobody has heard of; a membership is written by the
 * kernel's own `addMember()`, which refuses a room this store does not hold, a principal it
 * has never heard of, and one already in the room. The renderer sends a name and who is in
 * it, or a room and one person — and it is told why when the kernel says no.
 */
contextBridge.exposeInMainWorld('seekHost', {
  snapshot: () => ipcRenderer.invoke('seek:snapshot'),
  dataPath: () => ipcRenderer.invoke('seek:data-path'),
  post: (input) => ipcRenderer.invoke('seek:post', input),
  createRoom: (input) => ipcRenderer.invoke('seek:create-room', input),
  addMember: (input) => ipcRenderer.invoke('seek:add-member', input),
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
