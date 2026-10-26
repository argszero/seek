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
  // The fourth write: a bot, with the four things a person fills in when adding one
  // (姓名／性别／职位／性格). `roster` comes back with it because a bot that could not be
  // given roster rows is a bot that cannot answer, and the window says so.
  addBot: (input) => ipcRenderer.invoke('seek:add-bot', input),
  /**
   * The settings page, and the four calls behind it.
   *
   * `llm` reads what is in use and what is saved; `saveLlm` writes the words half and makes it
   * the one turns use; `models` asks an endpoint what it serves. **The key is written and never
   * read back** — `llm` answers `hasKey`, `keyTail` and `keyLen`, so the window can say which
   * key is in place without ever holding it. And `models` is a call from the main process
   * rather than a `fetch` here, because a renderer's request to an arbitrary endpoint fails at
   * the origin boundary with a sentence that names nothing.
   */
  /**
   * The organizations on this machine.
   *
   * The list itself arrives with the snapshot, which is the read every render starts from, so
   * there is no call here that only lists them. `switchOrganization()` opens another one, which
   * is a read of a different directory and never a move of a file; `createOrganization` and
   * `renameOrganization` write a name into the list, and a name is a label — it is shown there
   * and nowhere else, so two organizations may carry the same one. `removeOrganization` takes
   * one out of the list and moves its directory to the trash, which is the Finder's own call and
   * so is recoverable.
   */
  switchOrganization: (id) => ipcRenderer.invoke('seek:org-switch', id),
  createOrganization: (name) => ipcRenderer.invoke('seek:org-create', name),
  renameOrganization: (input) => ipcRenderer.invoke('seek:org-rename', input),
  removeOrganization: (id) => ipcRenderer.invoke('seek:org-remove', id),
  llm: () => ipcRenderer.invoke('seek:llm'),
  saveLlm: (input) => ipcRenderer.invoke('seek:llm-save', input),
  models: (input) => ipcRenderer.invoke('seek:llm-models', input),
  settingsPath: () => ipcRenderer.invoke('seek:settings-path'),
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
