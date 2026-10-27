'use strict'

const { contextBridge, ipcRenderer } = require('electron')

/**
 * The renderer's whole vocabulary, and every write it has is here. There are four — a
 * message, a room, one more member and a reaction — because a renderer that could reach the
 * store directly would be a second writer, and the kernel has one.
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
  /**
   * The rail's theme toggle, and the two calls behind it.
   *
   * `tokens.css` carries both palettes and the attribute on `<html>` is the whole switch, so
   * the renderer can flip it alone — but it cannot say it with any permanence: a theme that
   * lasts one launch is a button that undoes itself at the next start. The answer is saved
   * beside the endpoint, in the same settings file, and read before the first frame.
   *
   * Which is why `theme` is a call rather than a constant here: the value is on disk.
   */
  theme: () => ipcRenderer.invoke('seek:theme'),
  saveTheme: (theme) => ipcRenderer.invoke('seek:theme-save', theme),
  post: (input) => ipcRenderer.invoke('seek:post', input),
  /**
   * The hover toolbar's emoji square: one person's reaction on one message.
   *
   * `input` is `{roomId, messageId, emojiType}` and the principal is the person the store
   * speaks as — the renderer never names who is reacting, for the same reason it never names
   * who is sending. **One call both ways**: a second press on the same emoji is the undo, so
   * there is no `unreact` beside this (`toggleReaction()` in `src/delivery.ts`).
   */
  react: (input) => ipcRenderer.invoke('seek:react', input),
  /** The *more* menu's one item: a message's words, onto the platform clipboard. */
  copy: (text) => ipcRenderer.invoke('seek:copy', text),
  createRoom: (input) => ipcRenderer.invoke('seek:create-room', input),
  addMember: (input) => ipcRenderer.invoke('seek:add-member', input),
  // The fourth write: a bot, with the four things a person fills in when adding one
  // (姓名／性别／职位／性格). `roster` comes back with it because a bot that could not be
  // given roster rows is a bot that cannot answer, and the window says so.
  addBot: (input) => ipcRenderer.invoke('seek:add-bot', input),
  /**
   * The three writes that change something already written.
   *
   * `updateRoom` is the first edit this window has ever made — a room's name, its description,
   * its announcement, its tag — and `removeMember` and `deleteBot` are the first two that take
   * something away. They are three calls and not a store handle or a generic "patch" for the
   * reason every write above is a call: the kernel's own functions decide what may change and
   * refuse in their own sentences (`src/rooms.ts`, `src/bots.ts`), and a renderer that could
   * write the store directly would be a second author of it.
   *
   * **Deleting a bot is not taking a person out of a room**, which is why they are two calls
   * rather than one with a flag: the first stamps a bot and removes every membership it held,
   * the second removes one membership. A window that offered one button for both would be
   * asking the kernel a question with two answers.
   */
  updateRoom: (input) => ipcRenderer.invoke('seek:update-room', input),
  removeMember: (input) => ipcRenderer.invoke('seek:remove-member', input),
  deleteBot: (input) => ipcRenderer.invoke('seek:delete-bot', input),
  /**
   * The three that take something back: a message, a thread (the window calls it a topic), and
   * a room.
   *
   * Three calls and not one with a flag, for the reason the three above are separate: they are
   * three different questions. A thread is not a message — the kernel stamps a whole run at one
   * instant — and a room is not a thread: it takes its memberships with it.
   */
  deleteMessage: (input) => ipcRenderer.invoke('seek:delete-message', input),
  deleteThread: (input) => ipcRenderer.invoke('seek:delete-thread', input),
  deleteRoom: (input) => ipcRenderer.invoke('seek:delete-room', input),
  /**
   * The settings page, and the three calls behind it.
   *
   * `llm` reads what is in use and what is saved; `saveLlm` writes the words half and makes it
   * the one turns use. **The key is written and never read back** — `llm` answers `hasKey`,
   * `keyTail` and `keyLen`, so the window can say which key is in place without ever holding
   * it. There is no call here that asks an endpoint what it serves: the window's `List models`
   * button went on 2026-10-27, and the handler behind it went with the button.
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
  settingsPath: () => ipcRenderer.invoke('seek:settings-path'),
  /**
   * The words the window puts around what was typed, read once from the catalogue the
   * kernel's own report is printed from. A read rather than an affordance — nothing a person
   * clicks changes because of it, except that a count is spelled the way the language spells
   * it — which is why the documentation guard files it as plumbing rather than as one of
   * the capabilities both READMEs have to claim.
   */
  catalogue: () => ipcRenderer.invoke('seek:catalogue'),
  attach: () => ipcRenderer.invoke('seek:attach'),
  /**
   * A file of any kind, beside the picture call and deliberately not the same one.
   *
   * `attach` answers `{media}`, a `{key, mime}` pair the kernel draws as a picture; this
   * answers `{file}`, a `{key, name, size, mime}` the kernel draws as a row with a name and a
   * size. Two carriers because they are two kinds (`src/types.ts`): a picture is shown to the
   * judgement and a file is opened by a person.
   */
  attachFile: () => ipcRenderer.invoke('seek:attach-file'),
  /** Open an attachment with whatever application this machine uses for it. */
  openFile: (reference) => ipcRenderer.invoke('seek:open-file', reference),
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
