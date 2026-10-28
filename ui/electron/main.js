'use strict'

/**
 * The Electron main process: it *is* the kernel's host.
 *
 * Electron 45 carries Node 24, which strips TypeScript itself, so `src/` runs here as
 * it stands — no build step for the kernel, and no second process to supervise. That
 * was measured before this file was written rather than assumed: importing
 * `../../src/store.ts` in a ready main process builds a `SeekStore`.
 *
 * This file adds windows and IPC and nothing else. What the interface may do to the
 * kernel — read a snapshot, post a message — is `host.js`, which runs under plain
 * `node --test`. The renderer never touches the filesystem and never holds a store
 * handle: it asks, and the kernel answers.
 */

const { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, shell } = require('electron')
const { readFile, stat: statOf } = require('node:fs/promises')
const { basename, join } = require('node:path')
const { mkdtempSync, readFileSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { randomUUID } = require('node:crypto')

const {
  WORK_MODEL_WITHOUT_SERVER,
  addBot,
  addMember,
  closeHost,
  createRoom,
  deleteMessage,
  deleteRoom,
  deleteThread,
  openHostOrRefuse,
  postMessage,
  reactToMessage,
  deleteBot,
  removeMember,
  updateRoom,
} = require('./host.js')
const {
  BY_MIME,
  dropMedia,
  mimeForPath,
  pathForKey,
  readMedia,
  saveAttachment,
  saveMedia,
} = require('./media.js')

/**
 * The largest attachment this app keeps beside a store: 25 MB.
 *
 * A picture has four types and no limit worth stating (a screenshot is small); an attachment
 * may be anything, and the bytes go in `media/` beside `seek.json`, which a person copies
 * around and which is backed up with their machine. 25 MB is a number chosen to be said out
 * loud rather than discovered: above it the window quotes the size and this limit, which is a
 * refusal a person can act on.
 */
const ATTACHMENT_LIMIT = 25 * 1024 * 1024
const { defaultConfigPath, readConfiguredEndpoint, wordsHalfFrom } = require('./llm-config.js')
const { defaultSettingsPath, llmOf, readSettings, writeSettings } = require('./settings.js')
const {
  createOrganization,
  directoryOf,
  layoutOf,
  openOrganizations,
  removeOrganization,
  renameOrganization,
  switchOrganization,
  writeIndex,
} = require('./organizations.js')
const { describe, ensureWeights } = require('./weights-fetch.js')
const {
  WATCH_WINDOW,
  bundledServerPath,
  serverChoiceFrom,
  startBundledServer,
  weightsDirectory,
} = require('./server.js')
const { snapshotOf } = require('./snapshot.js')

const DEV_URL = process.env.SEEK_UI_DEV_URL
const DATA_DIR = process.env.SEEK_DATA_DIR || join(app.getPath('userData'), 'seek-data')

/**
 * The organizations on this machine, and which one is open.
 *
 * `ORGANIZATIONS` is filled at start-up by `openOrganizations()`; `STORE_FILE` is then that
 * organization's own `seek.json`, inside its own directory. **A store path is no longer a
 * constant**: it is derived from the organization that is open, so switching is one assignment
 * rather than a second code path through the app. Everything else that builds a path from the
 * store — the `media/` directory, the roster beside it — follows for free, which is why an
 * organization is a directory and not a prefix on one filename.
 */
let ORGANIZATIONS = null
let STORE_FILE = null

/** The organization that is open, or `null` before the index has been read. */
function currentOrganization() {
  return ORGANIZATIONS?.organizations.find((one) => one.id === ORGANIZATIONS.current) ?? null
}

/** Point the app at an organization's directory. One assignment, and the whole app follows. */
function useOrganizationDirectory(id) {
  STORE_FILE = layoutOf(DATA_DIR).storePath(id)
}
// This machine's own preferences, ours to write — unlike `~/.emrg/config.toml` next door, which
// belongs to the host's agent runtime and is only ever read. `SEEK_SETTINGS_FILE` exists for the
// same reason `SEEK_DATA_DIR` does: a test names a directory it made rather than a person's.
const SETTINGS_FILE = process.env.SEEK_SETTINGS_FILE || defaultSettingsPath(app.getPath('userData'))

/**
 * The model servers, as the person started the app with them.
 *
 * **Four variables, and each half of the bot takes its own.** Stage 1 needs two facts and
 * neither has a default this app may invent: `SEEK_SERVER` is which `llama-server` decides
 * *whether* the bot acts, and `SEEK_WINDOW` is how much one judgement may read.
 * Stage 2 needs two: `SEEK_WORK_SERVER` is which server
 * writes the *words*, and `SEEK_WORK_MODEL` is which model on that server does the
 * writing. It is a separate origin because a server serves one model while
 * the roster's watch and work rows may name two — the work
 * row's model "belongs to the other server". A turn's prompt is checked against that
 * server's own window per turn, so this half takes no budget.
 *
 * **`SEEK_WORK_MODEL` is what lets the words half be a hosted endpoint.** A `llama-server`
 * is asked for `/props`: its template, its window, the model it serves. An
 * OpenAI-compatible endpoint — the one a person's own `base_url` and API key already point
 * at — answers none of those three and cannot be asked for them; what it does answer is
 * `GET /v1/models`, one entry per model, so naming the model is how this half learns which
 * one is writing. Left unset in the environment, the endpoint configured on this machine is
 * read instead — the paragraph below — and with neither, the server is a `llama-server` and is
 * asked `/props` exactly as before. Set with no `SEEK_WORK_SERVER`, the app refuses rather than
 * guesses, because a model name is a fact about a server and on its own says nothing to
 * ask. Set it and the words half's prompt is posted to a server that may not be this
 * machine: the store and the judgement stay local, and what a turn says is assembled here
 * and sent to the endpoint you named.
 *
 * **And with none of that set, the words half is read from the endpoint this machine already
 * has configured** (`~/.emrg/config.toml`, `[llm]`): `llm-config.js` holds that rule and why it
 * exists. A double-click cannot set a variable, so without this a downloaded package could only
 * ever write through the model it carries — the one measured not to call the tool a turn speaks
 * through. The environment always wins, and the two sources never merge.
 *
 * They are read here rather than in `host.js` so that the one place the environment is
 * consulted is the process that owns it — `host.js` takes them as arguments and stays
 * runnable under `node --test`.
 *
 * **With nothing named anywhere and no config to read, nothing changes**: that half is the
 * kernel's placeholder on a store that has one, or the server this app carries, and the window
 * says which. `SEEK_SERVER` without `SEEK_WINDOW` is a refusal rather than a guess, and the
 * window shows it.
 */
const MODEL_SERVER = process.env.SEEK_SERVER
const MODEL_WINDOW = process.env.SEEK_WINDOW
const MODEL_WORK_SERVER = process.env.SEEK_WORK_SERVER
const MODEL_WORK_MODEL = process.env.SEEK_WORK_MODEL

/**
 * The credential the named servers ask for, if any.
 *
 * `llama-server` takes one with `--api-key`, and a hosted endpoint that speaks the same
 * chat API refuses every request without one. It belongs to the servers rather than to a
 * half: one origin is one key, and both halves may point at the same origin or at two
 * that want the same one.
 *
 * Empty or whitespace-only is not a credential — `llama.ts`'s `headersOf` sends no header
 * for it — so a variable set to nothing is the same as the variable being absent, rather
 * than a request that comes back a 401 reading like a wrong key.
 */
const MODEL_API_KEY = process.env.SEEK_API_KEY

/**
 * The server the app starts for itself, when nobody named one.
 *
 * A person who double-clicks the app cannot set an environment variable, so the four above
 * could only ever be supplied from a terminal — which left every downloaded app on the
 * kernel's placeholder. The package now carries `llama-server` (`extraResources`), and this
 * is where it is started, fed to both halves and stopped. The decision lives in `server.js`,
 * including the rule that a person who *did* name a server is not overruled.
 */
let modelServer = null

/**
 * Why the server this app started is no longer in use, or `null` while it is.
 *
 * The same fact a server the person *named* reports, in the same place: `snapshot.js` draws
 * `refusal` as "a server that was in use and is not", and a bundled server that died
 * mid-run is exactly that. It is held here rather than thrown because the window must stay
 * open — the store is local and every message in it is still readable.
 */
let modelServerRefusal = null

/**
 * The weights: how far the download has got, and why it stopped.
 *
 * A first run fetches 2.1 GB before any model exists, so this is the state the window spends
 * the longest in, and it is two readings rather than one — "still arriving, this far" and
 * "stopped, and why" — because they are drawn in different colours and only the second is a
 * failure. `null` in both means nothing is being fetched and nothing went wrong, which is
 * every launch after the first.
 *
 * **Both are facts, and neither is a sentence**, which is the language rule rather than a
 * coincidence: how far the download has got is three numbers and a file name, and why it stopped
 * is one of three shapes — nobody named a host, one host said its piece, or several did — so
 * every language can put each into its own words. They travel as those facts (named in
 * `ui/electron/snapshot.js`, drawn in `ui/src/App.jsx`), because a sentence composed here would
 * be English in every language this app runs in (`docs/design/i18n.md` §1).
 *
 * The one English phrase that survives is `describe(why)`, and it is not drawn: it is the
 * kernel's own statement about a half it cannot use, and the log line beside it (§7 keeps log
 * lines English).
 */
let weightsPending = null
let weightsWhy = null

/** The kernel, opened once, and the one window that may be told when it changes. */
let host = null
let win = null

/**
 * Why the kernel would not open the store, or `null` when it did.
 *
 * Held beside `host` rather than thrown, because a store this version refuses is exactly the
 * state the window must be able to describe. See the ready handler below for what went wrong
 * when it was an exception instead.
 */
let storeRefusal = null

/**
 * The two facts the kernel's halves were opened with, held at module scope.
 *
 * They live here rather than inside `start()` because a settings save re-opens the host: the
 * judgement half is a server this app started and must not be restarted just because someone
 * re-pointed the words half, so the reopen reads these back rather than deciding them again.
 */
let server = MODEL_SERVER
let serverWindow = MODEL_WINDOW
let startRefusal = null

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    // The three columns have floors (`--list-min`, `--room-min`, `--side-min` in tokens.css) and
    // with a side panel open their sum is 1134: rail 156 + three seams + list 280 + room 380 +
    // panel 300. A window narrower than that cannot draw them — the last track is painted past
    // the frame, which is how the panel used to end up 6px wide — so the window stops here.
    minWidth: 1134,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1f2329' : '#f5f6f7',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  if (DEV_URL) win.loadURL(DEV_URL)
  else win.loadFile(join(__dirname, '..', 'dist', 'index.html'))
  win.on('closed', () => {
    win = null
  })
  return win
}

/** What the interface is allowed to see: a plain, serialisable read of the store. */
function snapshotNow() {
  // The model-server facts replace each half's own reading and nothing else: the origin each
  // half was bound to is still true, and `server` is what the window prints beside it. They
  // are stated in the order they win — a download under way is the newest fact, the reason it
  // stopped is the next, and a server that died while the window was open is the last.
  const half = (stage) => {
    if (weightsPending !== null) return { ...stage, pending: weightsPending, refusal: null, weights: null }
    // The weights failure keeps its own field and clears `refusal`: the window draws those facts
    // in its own language, so the kernel's English sentence about the same thing has no business
    // reaching a screen. Two producers, two shapes, and the sentence stops at the process edge.
    if (weightsWhy !== null) return { ...stage, pending: null, refusal: null, weights: weightsWhy }
    if (modelServerRefusal !== null) return { ...stage, pending: null, refusal: modelServerRefusal }
    return stage
  }
  const snapshot = snapshotOf(
    host?.store ?? null,
    STORE_FILE,
    half(host?.stage1 ?? null),
    half(host?.stage2 ?? null),
    storeRefusal,
  )
  // The organizations, as the window may see them: an id to name, a name to draw, and which one
  // is open. The directory is not here — it is a path on this machine, and the window has no
  // business with one.
  return {
    ...snapshot,
    organizations: (ORGANIZATIONS?.organizations ?? []).map((one) => ({
      id: one.id,
      name: one.name,
    })),
    currentOrganizationId: ORGANIZATIONS?.current ?? null,
  }
}

/** Tell the window the facts changed, if there is a window listening. */
function pushChanged() {
  if (win && !win.isDestroyed()) win.webContents.send('seek:changed', snapshotNow())
}

ipcMain.handle('seek:snapshot', () => snapshotNow())
ipcMain.handle('seek:data-path', () => STORE_FILE)
ipcMain.handle('seek:settings-path', () => SETTINGS_FILE)

/**
 * The window's palette, saved beside the endpoint.
 *
 * `tokens.css` has carried `[data-theme='light']` and `[data-theme='dark']` since it was
 * transcribed, and nothing ever set the attribute — so the dark palette was a file that no
 * window could reach. The prototype's rail has the toggle (`renderRail()` in
 * `prototype/src/js/app.js`) and persists it in its own store; the switch is the same and the
 * store is this one, which is where the endpoint lives.
 *
 * **The default is the prototype's, not the operating system's**: `store.js` seeds `theme` to
 * `'light'`, so a first launch is light on a dark desktop rather than depending on it. Any
 * other value in the file — a hand-edited `purple`, or a number — is not a palette this window
 * has, and it answers the default rather than being passed on to be drawn.
 */
ipcMain.handle('seek:theme', async () => {
  const read = await readSettings(SETTINGS_FILE)
  const saved = read.settings?.theme
  return saved === 'dark' || saved === 'light' ? saved : 'light'
})

/**
 * Save it, and the reason a refusal here is quiet.
 *
 * The toggle has already repainted the window by the time this is called, so a person sees the
 * theme they asked for either way; what fails is the memory of it. `writeSettings` writes the
 * whole object it read, so this cannot disturb the endpoint saved in the same file — and a
 * refusal is logged and answered rather than thrown, because a strip about a settings write
 * over a window that is behaving would report the wrong thing.
 */
ipcMain.handle('seek:theme-save', async (_event, theme) => {
  if (theme !== 'dark' && theme !== 'light') return { ok: false, error: 'not a theme this window has' }
  try {
    await writeSettings(SETTINGS_FILE, { theme })
  } catch (error) {
    console.error(`seek: the theme could not be saved — ${error.message}`)
    return { ok: false, error: error.message }
  }
  return { ok: true, theme }
})

/**
 * The words this window puts around what people and bots typed.
 *
 * `docs/design/i18n.md` §1 — no user-visible string is written into code — and the window is
 * the surface that had none of it: the kernel's report has been read out of
 * `src/i18n/<tag>.json` by key since the milestone, while the window wrote its own English.
 *
 * **Read at run time, from the catalogue the kernel loads.** Bundling the file into the page
 * would make `src/i18n.ts`'s promise false for the window — that a language added by writing
 * a file needs no code change — and the file already travels in a download (`extraResources`
 * carries `i18n/*.json`, checked by `packaging.test.mjs`), so the read is one call at start-up
 * rather than a build step that has to be kept in step with it.
 *
 * **The language is the kernel's own default**, `DEFAULT_LOCALE`: "the language a run speaks
 * unless it is told otherwise". Nothing here invents a second answer to what tells it —
 * `docs/design/i18n.md` §2 says the interface language is a setting and does not say where
 * that setting lives, so this handler is where that choice will land rather than a decision
 * taken quietly in the renderer.
 */
ipcMain.handle('seek:catalogue', async () => {
  const { DEFAULT_LOCALE, catalogueFor } = await import('../../src/i18n.ts')
  return catalogueFor(DEFAULT_LOCALE)
})

/**
 * Re-open the host over a different organization's store.
 *
 * **Switching moves nothing.** Each organization is a directory that already exists; this
 * closes the kernel over one store and opens it over another. No file is copied, renamed or
 * deleted, which is the entire reason the host asked for isolation rather than for profiles.
 *
 * The judgement half is *not* re-decided: the model server is a fact about the machine and it
 * is already running, so it is passed through unchanged — a switch that spent a minute loading
 * a 1.7 GB model to show a different set of rooms would be a switch nobody makes twice.
 */
async function openOrganization(id) {
  const next = switchOrganization(ORGANIZATIONS, id)
  if (next.refusal) return { ok: false, error: next.refusal }
  ORGANIZATIONS = await writeIndex(layoutOf(DATA_DIR).indexPath, next.index)
  useOrganizationDirectory(ORGANIZATIONS.current)
  if (host !== null) {
    closeHost(host)
    host = null
  }
  // A store that has never been opened gets seeded here, by `openHost`'s own first-run path —
  // one seeded room, Echo and the roster beside it, exactly as a first launch does. That is why
  // creating an organization needs no seeding of its own.
  const words = await wordsFacts()
  const opened = await openHostOrRefuse(STORE_FILE, {
    server,
    window: serverWindow,
    workServer: words.filesNamed ? words.workServer : server,
    workModel: words.workModel,
    workApiKey: words.workApiKey,
    apiKey: MODEL_API_KEY,
    serverRefusal: startRefusal ?? undefined,
    workServerRefusal:
      words.refusal ??
      words.workModelRefusal ??
      (words.filesNamed ? undefined : startRefusal) ??
      undefined,
  })
  host = opened.host
  storeRefusal = opened.refusal
  if (storeRefusal) console.error(`seek: the store was not opened for ${id} — ${storeRefusal}`)
  pushChanged()
  return { ok: true, snapshot: snapshotNow() }
}

/**
 * Make an organization: a name, and a directory of its own.
 *
 * The host settled what this asks for (2026-10-26T20:03): the name and nothing else. It is a
 * label — shown in the list and nowhere else — so nothing here asks it to be unique, and nothing
 * writes it into a store. The directory is not filled here either: an organization's world is
 * seeded the first time it is opened, by the same path a first launch takes. Creating one does
 * not switch to it, so a person can name three in a row.
 */
ipcMain.handle('seek:org-create', async (_event, name) => {
  const made = createOrganization(ORGANIZATIONS, name, { id: `org-${randomUUID()}` })
  if (made.refusal) return { ok: false, error: made.refusal }
  ORGANIZATIONS = await writeIndex(layoutOf(DATA_DIR).indexPath, made.index)
  pushChanged()
  return { ok: true, organization: made.organization, snapshot: snapshotNow() }
})

/**
 * Rename an organization. **Only the label moves**: the store is not opened, not read and not
 * written, because the name appears in no part of a world — least of all in the name of the
 * person inside it (host, 2026-10-26T20:03).
 */
ipcMain.handle('seek:org-rename', async (_event, input) => {
  const renamed = renameOrganization(ORGANIZATIONS, input?.id, input?.name)
  if (renamed.refusal) return { ok: false, error: renamed.refusal }
  ORGANIZATIONS = await writeIndex(layoutOf(DATA_DIR).indexPath, renamed.index)
  pushChanged()
  return { ok: true, snapshot: snapshotNow() }
})

ipcMain.handle('seek:org-switch', (_event, id) => openOrganization(id))

/**
 * Take an organization out of the list, and move its directory to the trash.
 *
 * **The order matters.** The list is written first and the directory is trashed afterwards: a
 * failure in the move leaves a directory that came out of the list but is still on disk — which
 * a person can find — rather than a directory nobody can reach. `shell.trashItem` is the same
 * call the Finder makes, so an organization worth recovering can be recovered.
 *
 * The organization that is open cannot be removed while it is open: removing it would mean the
 * app is looking at a world whose directory is in the trash. The window closes it first, by
 * switching to another, and the kernel over it is closed here.
 */
ipcMain.handle('seek:org-remove', async (_event, id) => {
  if (id === ORGANIZATIONS?.current) {
    return { ok: false, error: 'open another organization first: the one being shown cannot be removed' }
  }
  const removed = removeOrganization(ORGANIZATIONS, id)
  if (removed.refusal) return { ok: false, error: removed.refusal }
  const directory = directoryOf(DATA_DIR, id)
  ORGANIZATIONS = await writeIndex(layoutOf(DATA_DIR).indexPath, removed.index)
  let trashed = true
  try {
    await shell.trashItem(directory)
  } catch (error) {
    trashed = false
    console.error(`seek: ${directory} was not moved to the trash — ${error.message}`)
  }
  pushChanged()
  return { ok: true, trashed, snapshot: snapshotNow() }
})

/** What the settings page draws: the endpoint in use, the one saved, and why neither is one. */
ipcMain.handle('seek:llm', () => llmForWindow())

/**
 * Save the words half, then make it the one in use.
 *
 * The two are one call because they are one thing a person did. A save that only wrote a file
 * would leave the window showing an endpoint that turns do not use, which is the state this
 * page exists to make impossible.
 *
 * **A key is only written when one was typed.** The field arrives empty on every draw (the
 * renderer never holds the key), so treating empty as "remove it" would erase the key every
 * time someone changed the address. Removing a key is not part of this page yet, and a button
 * that did it silently would be worse than not having it.
 */
ipcMain.handle('seek:llm-save', async (_event, input) => {
  const baseUrl = typeof input?.baseUrl === 'string' ? input.baseUrl.trim() : ''
  const model = typeof input?.model === 'string' ? input.model.trim() : ''
  const apiKey = typeof input?.apiKey === 'string' ? input.apiKey.trim() : ''
  if (!/^https?:\/\/./.test(baseUrl)) {
    return { ok: false, error: 'the address has to start with http:// or https://' }
  }
  if (model === '') return { ok: false, error: 'the model name is empty' }
  const llm = { baseUrl: baseUrl.replace(/\/+$/, ''), model }
  if (apiKey !== '') llm.apiKey = apiKey
  try {
    await writeSettings(SETTINGS_FILE, { llm })
  } catch (error) {
    return { ok: false, error: `the settings file could not be written (${error.message})` }
  }
  await reopenHost()
  return { ok: true, llm: await llmForWindow() }
})

/**
 * The composer's one call.
 *
 * A refusal comes back as `{ ok: false, error }` rather than as a rejected renderer
 * call, because the interface has to *show* it: a message that was silently not sent,
 * or sent into a room that does not exist, is the one failure a chat window cannot
 * have. The kernel's own errors (`unknown room`, `sender is not a member`, an empty
 * text) are already sentences, so they are passed through rather than re-worded here.
 */
ipcMain.handle('seek:post', async (_event, input) => {
  try {
    const snapshot = await postMessage(host, input ?? {})
    if (win && !win.isDestroyed()) win.webContents.send('seek:changed', snapshot)
    return { ok: true, snapshot }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
})

/**
 * The hover toolbar's emoji square: one person's reaction, added or taken back.
 *
 * The same envelope as `seek:post`, and for the same reason — a refusal has to be *shown*,
 * and a rejected renderer call would put the kernel's sentence in a console nobody reads.
 * It broadcasts, because a reaction is written into the store and every window drawing that
 * room has to see it. **One call both ways**: pressing the same emoji twice is the undo, so
 * there is no second channel for removing one (`toggleReaction()` in `src/delivery.ts`).
 */
ipcMain.handle('seek:react', async (_event, input) => {
  try {
    const snapshot = await reactToMessage(host, input ?? {})
    if (win && !win.isDestroyed()) win.webContents.send('seek:changed', snapshot)
    return { ok: true, snapshot }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
})

/**
 * The toolbar's *more* menu, whose one item copies a message's words.
 *
 * Copying writes no store, so nothing broadcasts and this is not a capability in the sense
 * the other writes are: it is the window handing a string to the platform's clipboard.
 * **It is a call rather than a `navigator.clipboard` write in the page**, because the page's
 * own copy path is gated on a user gesture and answered a programmatic press with a failure
 * — measured on the prototype, where a scripted click reported "复制失败" while a real one
 * worked. A message with no words (a picture alone) has nothing to copy, and says so rather
 * than clearing the clipboard into silence.
 */
ipcMain.handle('seek:copy', (_event, text) => {
  if (typeof text !== 'string' || text === '') {
    return { ok: false, error: 'this message has no words to copy' }
  }
  clipboard.writeText(text)
  return { ok: true }
})

/**
 * Make a room, and tell every window the new snapshot.
 *
 * The same envelope as `seek:post`, for the same reason: a room that was refused has to be
 * *shown*, and a rejected renderer call would put the kernel's sentence in a console nobody
 * is reading. `roomId` is what the window needs and a snapshot cannot say — "the room that
 * was just made" is not derivable from a room list that may already have held one with that
 * name.
 */
ipcMain.handle('seek:create-room', async (_event, input) => {
  try {
    const made = await createRoom(host, input ?? {})
    if (win && !win.isDestroyed()) win.webContents.send('seek:changed', made.snapshot)
    return { ok: true, snapshot: made.snapshot, roomId: made.roomId }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
})

/**
 * Put one more person into a room, and tell every window the new snapshot.
 *
 * The same envelope as `seek:post`, with one thing `seek:create-room` needs and this does
 * not: no second return field. A room that just gained a member is the room it already was,
 * so there is no id here that a snapshot cannot say — `seek:create-room` hands back `roomId`
 * only because "the room that was just made" is not derivable from a room list.
 */
ipcMain.handle('seek:add-member', async (_event, input) => {
  try {
    const snapshot = await addMember(host, input ?? {})
    if (win && !win.isDestroyed()) win.webContents.send('seek:changed', snapshot)
    return { ok: true, snapshot }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
})

/**
 * Change what a room says about itself, and tell every window the new snapshot.
 *
 * The same envelope as `seek:add-member`: one write, one snapshot, and the kernel's own
 * sentence when it refuses. Nothing rides back beside the snapshot, because unlike a made room
 * or a made bot there is nothing the window cannot derive — the room it edited is the room it
 * was already showing.
 */
ipcMain.handle('seek:update-room', async (_event, input) => {
  try {
    const snapshot = await updateRoom(host, input ?? {})
    if (win && !win.isDestroyed()) win.webContents.send('seek:changed', snapshot)
    return { ok: true, snapshot }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
})

/**
 * Take one principal out of a room.
 *
 * `seek:update-room`'s twin, and for the same reason it carries nothing but the snapshot. The
 * window learns *why* the kernel refused in `error`, which is where the last member learns that
 * a room may not be emptied.
 */
ipcMain.handle('seek:remove-member', async (_event, input) => {
  try {
    const snapshot = await removeMember(host, input ?? {})
    if (win && !win.isDestroyed()) win.webContents.send('seek:changed', snapshot)
    return { ok: true, snapshot }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
})

/**
 * Delete a bot from the organization.
 *
 * `rooms` rides back for the same reason `botId` does on the way in: which rooms a bot was in
 * is not derivable from the snapshot that follows — it has already left them.
 */
ipcMain.handle('seek:delete-bot', async (_event, input) => {
  try {
    const gone = await deleteBot(host, input ?? {})
    if (win && !win.isDestroyed()) win.webContents.send('seek:changed', gone.snapshot)
    return { ok: true, snapshot: gone.snapshot, botId: gone.botId, rooms: gone.rooms }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
})

/**
 * Take a message back, and remove the blob it named.
 *
 * **The store is written first and the bytes after**, in that order on purpose: a store that
 * says the picture is gone while the file is still there is a store a person can repair by
 * hand, and the other order would hand a message a reference to a file already deleted — the
 * one state `readMedia` draws as "the picture is missing". The removal is `dropMedia`, which
 * tolerates a blob somebody already removed.
 */
ipcMain.handle('seek:delete-message', async (_event, input) => {
  try {
    const gone = await deleteMessage(host, input ?? {})
    for (const blob of [gone.media, gone.file]) {
      if (blob) dropMedia(STORE_FILE, blob.key)
    }
    if (win && !win.isDestroyed()) win.webContents.send('seek:changed', gone.snapshot)
    return {
      ok: true,
      snapshot: gone.snapshot,
      messageId: gone.messageId,
      roomId: gone.roomId,
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
})

/**
 * Take a thread back — the root and its replies, at one instant — and their blobs with it.
 *
 * `messageIds` rides back because the window cannot read them off the snapshot that follows: a
 * deleted message is still in the snapshot, as a tombstone, so "which ones did this call take"
 * is not derivable from it.
 */
ipcMain.handle('seek:delete-thread', async (_event, input) => {
  try {
    const gone = await deleteThread(host, input ?? {})
    for (const blob of gone.blobs) dropMedia(STORE_FILE, blob.key)
    if (win && !win.isDestroyed()) win.webContents.send('seek:changed', gone.snapshot)
    return {
      ok: true,
      snapshot: gone.snapshot,
      messageIds: gone.messageIds,
      roomId: gone.roomId,
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
})

/**
 * Delete a room, its messages, its memberships, and the blobs they named.
 *
 * The room leaves the snapshot's list on its own: that list is the rooms this person is in, and
 * this call takes the memberships away. So what rides back beside the snapshot is only what the
 * window may want to name — which room went.
 */
ipcMain.handle('seek:delete-room', async (_event, input) => {
  try {
    const gone = await deleteRoom(host, input ?? {})
    for (const blob of gone.blobs) dropMedia(STORE_FILE, blob.key)
    if (win && !win.isDestroyed()) win.webContents.send('seek:changed', gone.snapshot)
    return { ok: true, snapshot: gone.snapshot, roomId: gone.roomId, messageIds: gone.messageIds }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
})

/**
 * Make a bot, and tell every window the new snapshot.
 *
 * The same envelope as `seek:create-room`, for the same reason `roomId` is there: `botId` is
 * what the window needs and a snapshot cannot say — "the bot that was just made" is not
 * derivable from a list that may already hold one with that name, and two bots called 周敏 is
 * a state this app allows on purpose.
 *
 * `roster` rides back because it is the difference between a bot that answers and one that
 * cannot: `'appended'` means the two rows are in `agents.yml`, `'none'` means the store has no
 * roster file and the bot is therefore mute until one is written. The window draws that rather
 * than leaving a person with a bot that is silently deaf.
 */
ipcMain.handle('seek:add-bot', async (_event, input) => {
  try {
    const made = await addBot(host, input ?? {})
    if (win && !win.isDestroyed()) win.webContents.send('seek:changed', made.snapshot)
    return { ok: true, snapshot: made.snapshot, botId: made.botId, roster: made.roster }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
})

/**
 * Choose a picture, and put its bytes where this machine keeps them.
 *
 * The dialog is here rather than in the renderer because a renderer with
 * `contextIsolation` has no filesystem — and because the bytes must be written *before*
 * the message that names them is posted: `deliver()` refuses an `image` whose reference
 * points at nothing (`src/delivery.ts`), so the order is the kernel's requirement, not a
 * preference of this file.
 *
 * Three answers, and the interface draws all three apart:
 *
 * - `{ ok: true, media }` — a picture is on disk and the composer may post it.
 * - `{ ok: false, cancelled: true }` — the person closed the dialog. Not a failure, and
 *   nothing to draw.
 * - `{ ok: false, error }` — the file is there and unusable, named in a sentence. The one
 *   refusal this file adds is the extension: `@electron/get`-style guessing is not
 *   available, the dialog hands back a path and no mime, and writing bytes under a type
 *   `mediaFor` will refuse leaves a file in `media/` that no message ever points at.
 */
ipcMain.handle('seek:attach', async () => {
  try {
    if (!win || win.isDestroyed()) throw new Error('there is no window to ask in')
    const picked = await dialog.showOpenDialog(win, {
      title: 'Attach a picture',
      properties: ['openFile'],
      filters: [{ name: 'Pictures', extensions: [...new Set([...BY_MIME.values()])] }],
    })
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, cancelled: true }

    const filePath = picked.filePaths[0]
    const mime = mimeForPath(filePath)
    if (!mime) {
      return {
        ok: false,
        error:
          `this app sends ${[...BY_MIME.keys()].join(', ')} and cannot tell what ` +
          `${basename(filePath)} is: the file dialog hands back a name with no type on it, ` +
          'so the extension is the only thing there is to read',
      }
    }
    const bytes = await readFile(filePath)
    const media = saveMedia(STORE_FILE, { bytes, mime, name: basename(filePath) })
    return { ok: true, media }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
})

/**
 * Choose a file of any kind and keep its bytes beside the store.
 *
 * **The sibling of `seek:attach`, and the difference is the closed set.** A picture has to be
 * one of four types because the window draws it and the kernel refuses a `media.mime` that is
 * not `image/*`; an attachment is opened by whatever application the machine has, so nothing
 * here is refused for its type — only for being too large to keep beside a store that a
 * person may copy around, which is a size this app states rather than a type it guesses.
 *
 * A cancelled dialog is not a failure: it answers `cancelled`, and the window draws nothing.
 */
ipcMain.handle('seek:attach-file', async () => {
  try {
    if (!win || win.isDestroyed()) throw new Error('there is no window to ask in')
    const picked = await dialog.showOpenDialog(win, {
      title: 'Attach a file',
      properties: ['openFile'],
    })
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, cancelled: true }

    const filePath = picked.filePaths[0]
    const stat = await statOf(filePath)
    if (stat.size > ATTACHMENT_LIMIT) {
      return {
        ok: false,
        error:
          `${basename(filePath)} is ${stat.size} bytes and this app keeps attachments up to ` +
          `${ATTACHMENT_LIMIT}: the bytes go beside the store, so a store a person copies ` +
          'around carries them, and there has to be a size at which that stops',
      }
    }
    const bytes = await readFile(filePath)
    const file = saveAttachment(STORE_FILE, { bytes, name: basename(filePath) })
    return { ok: true, file }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
})

/**
 * Open an attachment with whatever application this machine uses for it.
 *
 * **A copy under the name the person gave it**, not the blob itself. The bytes live beside
 * the store under a key this app made up (`om-…​.pdf`), and handing that path to the system
 * would open a file called `om-lq3k2-8f1a.pdf` — the person's own name is the one thing that
 * survives the trip, so it is what the copy is called. The copy goes in the temporary
 * directory rather than back into the store: nothing this app opens should be editable and
 * then silently differ from the bytes the message points at.
 */
ipcMain.handle('seek:open-file', async (_event, reference) => {
  try {
    const key = typeof reference?.key === 'string' ? reference.key : ''
    const name = typeof reference?.name === 'string' && reference.name !== '' ? reference.name : key
    const source = pathForKey(STORE_FILE, key)
    const dir = mkdtempSync(join(tmpdir(), 'seek-attachment-'))
    const target = join(dir, basename(name))
    writeFileSync(target, readFileSync(source))
    const refusal = await shell.openPath(target)
    if (refusal !== '') return { ok: false, error: refusal }
    return { ok: true }
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return {
        ok: false,
        error:
          'the file is not beside this store any more: the message is the store\'s and the ' +
          'bytes are the client\'s, so a store moved without its media/ directory keeps the ' +
          'row and loses the file',
      }
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
})

/**
 * One picture's bytes, as a string the renderer can draw.
 *
 * The snapshot carries the reference and never the bytes: the store is rewritten whole on
 * every save and a snapshot is taken after every delivery, so inlining a picture there
 * would re-serialise it on every unrelated message. A `data:` URL per picture, asked for
 * once per message as it is drawn, keeps the snapshot a description of the store.
 */
ipcMain.handle('seek:media', (_event, reference) => {
  try {
    return { ok: true, ...readMedia(STORE_FILE, reference ?? {}) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
})

/**
 * Start the app: open the kernel, then make the window — in that order, and the window is
 * made **whatever the kernel answered**.
 *
 * **A refusal must not be able to stop the window from being made.** This used to be
 * `app.whenReady().then(async () => { host = await openHost(...); createWindow() })`, and a
 * store this version would not read made `openHost` throw: `createWindow()` never ran, the
 * `activate` handler below was never registered, and the failure surfaced as an
 * `UnhandledPromiseRejectionWarning` on a stderr the Finder-launched app writes to
 * `/dev/null`. The person saw an app that did nothing at all — no window, no dialog, no
 * sentence — while the kernel had written a paragraph explaining exactly what to do. Found
 * on a real install, where a store from an older build sat in `~/Library/Application
 * Support/Seek`; no driver in this repository had ever started the app over one, because
 * every driver passed `SEEK_DATA_DIR` pointing at an empty directory.
 *
 * So the store's answer is a fact held in `storeRefusal` and drawn by the window, in the
 * same shape stage 1 and stage 2 refuse in. A store that opened leaves it `null` and nothing
 * changes.
 */
/**
 * This app's own settings, as the one fact `wordsHalfFrom` takes from a file we can write.
 *
 * A broken file is answered as a *refusal from this source* rather than as silence: silence
 * would fall through to the config of another program and quietly use an endpoint nobody
 * chose, while the person's own file sits there being ignored. Either way the window can say
 * which of the two happened.
 */
async function readOwnSettings() {
  const read = await readSettings(SETTINGS_FILE)
  if (read.refusal) return { llm: { refusal: read.refusal } }
  return { llm: llmOf(read.settings) }
}

/**
 * Which endpoint the words half is, and why it is not one.
 *
 * One function and not three blocks, because three callers need the same answer: the launch,
 * the window that draws it, and the save that changes it. Each sentence here is a fact the
 * window shows rather than a rule invented at a call site.
 */
async function wordsFacts() {
  const llmConfigPath = defaultConfigPath(app.getPath('home'))
  const ownSettings = await readOwnSettings()
  const wordsHalf = wordsHalfFrom({
    env: {
      SEEK_WORK_SERVER: MODEL_WORK_SERVER,
      SEEK_WORK_MODEL: MODEL_WORK_MODEL,
      SEEK_API_KEY: MODEL_API_KEY,
    },
    settings: ownSettings.llm,
    config: readConfiguredEndpoint(llmConfigPath),
  })
  const from = wordsHalf?.from ?? null
  const workServer = wordsHalf?.workServer
  // True when the words half is a file's endpoint rather than the server this app starts,
  // which is what decides whether a weights failure takes that half down with it. Either
  // file-based source counts: both name an endpoint this machine already reaches.
  const filesNamed = (from === 'config' || from === 'settings') && workServer !== undefined
  // **A model named with no server of your own is refused before the download, not after
  // it.** The server this app starts serves the model it carries, so a name given with no
  // origin is not a fact about it — and waiting until `stageTwoFor` ran would spend the
  // 1.7 GB first. The sentence is that layer's, read from it rather than written again.
  const workModelRefusal =
    from === 'environment' && wordsHalf.workModel !== undefined && workServer === undefined
      ? WORK_MODEL_WITHOUT_SERVER
      : null
  return {
    llmConfigPath,
    from,
    workServer,
    workModel: wordsHalf?.workModel,
    workApiKey: wordsHalf?.workApiKey,
    refusal: wordsHalf?.refusal ?? null,
    filesNamed,
    workModelRefusal,
  }
}

/**
 * What the window may know about the words half.
 *
 * **The key never crosses this line.** The window is told whether there is one and its last
 * four characters — enough to recognise which key is in use and not enough to use it, which is
 * the same rule `llm-config.js` states about logs and refusals.
 *
 * `live` is what a turn would use right now; `saved` is what is in our file. They differ when
 * the environment overrides the file, and the window says so rather than showing one number
 * that is only sometimes true.
 */
async function llmForWindow() {
  const words = await wordsFacts()
  const read = await readSettings(SETTINGS_FILE)
  const table = read.settings?.llm && typeof read.settings.llm === 'object' ? read.settings.llm : {}
  const key = typeof words.workApiKey === 'string' ? words.workApiKey.trim() : ''
  const savedKey = typeof table.apiKey === 'string' ? table.apiKey.trim() : ''
  return {
    live: {
      baseUrl: words.workServer ?? null,
      model: words.workModel ?? null,
      from: words.from,
      hasKey: key !== '',
      keyTail: key === '' ? '' : key.slice(-4),
      keyLen: key.length,
    },
    saved: {
      baseUrl: typeof table.baseUrl === 'string' ? table.baseUrl : null,
      model: typeof table.model === 'string' ? table.model : null,
      hasKey: savedKey !== '',
      keyTail: savedKey === '' ? '' : savedKey.slice(-4),
      keyLen: savedKey.length,
    },
    refusal: words.refusal,
    settingsPath: SETTINGS_FILE,
    configPath: words.llmConfigPath,
  }
}

/**
 * Re-open the host so a saved endpoint is the one turns actually use.
 *
 * **Why a re-open and not a restart of the app.** The words half is bound when the host opens
 * — `stageTwoFor` builds the call once — so a saved file alone would not be read until the
 * next launch, and a person who just typed an address would have no way to tell whether it
 * worked. Closing the kernel first is not optional: two kernels over one store are two
 * writers, and the kernel has one.
 *
 * The judgement half is untouched. It is the server this app started, it is held at module
 * scope, and it is passed back unchanged — re-pointing the words half must not spend 1.7 GB
 * of download or a minute of model loading.
 */
async function reopenHost() {
  if (host === null) return
  const words = await wordsFacts()
  const serverForHost = words.filesNamed ? words.workServer : server
  closeHost(host)
  const opened = await openHostOrRefuse(STORE_FILE, {
    server,
    window: serverWindow,
    workServer: serverForHost,
    workModel: words.workModel,
    workApiKey: words.workApiKey,
    apiKey: MODEL_API_KEY,
    serverRefusal: startRefusal ?? undefined,
    workServerRefusal:
      words.refusal ??
      words.workModelRefusal ??
      (words.filesNamed ? undefined : startRefusal) ??
      undefined,
  })
  host = opened.host
  storeRefusal = opened.refusal
  if (storeRefusal) console.error(`seek: the store was not opened after a settings change — ${storeRefusal}`)
  if (host?.stage2?.refusal) console.error(`seek: a bot has no words model — ${host.stage2.refusal}`)
  pushChanged()
}

async function start() {
  // **The window is made first, before anything that can take minutes.** A first run fetches
  // 2.1 GB before a model exists, and a launch that opened the window afterwards would spend
  // that whole download showing nothing at all — indistinguishable from an app that did not
  // start, which is the failure `openHostOrRefuse` was written for one layer down. The
  // snapshot reports "the store is not open yet" in the meantime, which is a state it already
  // had for exactly this moment.
  createWindow()
  registerActivate()

  // **The organization list is read before a store is opened.** `STORE_FILE` is derived from it, so
  // a launch that opened a store first would open the one at the root — the pre-organizations path —
  // and every organization made afterwards would sit beside a store nothing reads.
  const listed = await openOrganizations({ root: DATA_DIR })
  if (listed.refusal) {
    // A damaged index is not replaced with a fresh organization: that would look exactly like a
    // person's rooms disappearing. The window opens on the sentence instead.
    storeRefusal = listed.refusal
    console.error(`seek: the organization list was not read — ${listed.refusal}`)
    ORGANIZATIONS = null
    STORE_FILE = join(DATA_DIR, 'seek.json')
  } else {
    ORGANIZATIONS = listed.index
    useOrganizationDirectory(ORGANIZATIONS.current)
  }

  // **Nobody named a server, so the app starts the one it carries.**
  // `serverChoiceFrom` reads the environment and nothing else, and it answers `named` for a
  // person who did — a terminal run is not overruled by a package that holds a binary.
  const choice = serverChoiceFrom(process.env)
  server = MODEL_SERVER
  serverWindow = MODEL_WINDOW
  startRefusal = null

  // **Which server writes the words: the environment, or the endpoint already configured on
  // this machine.** `llm-config.js` holds the rule and the reason; two consequences matter
  // here. First, the two sources never merge — an environment that names this half is used
  // whole, and the config is read only when it is silent. Second, a config-provided endpoint
  // is not a name in the environment, so `serverChoiceFrom` above still answers `start`: the
  // app fetches its weights and starts the server it carries for the *judgement*, while the
  // words go to that endpoint. That is the shape the two halves have had since they were
  // split — one origin each — and this is the first time a downloaded app can reach the
  // second one without a terminal.
  const words = await wordsFacts()
  const llmConfigPath = words.llmConfigPath
  let workServer = words.workServer
  const workModel = words.workModel
  const workApiKey = words.workApiKey
  let workServerRefusal = words.refusal
  const wordsFromFiles = words.filesNamed
  const workModelRefusal = words.workModelRefusal
  // **Whether somebody named this half an origin — in a file or in the environment.** The two
  // sources rank differently (`llm-config.js` says in which order), but they answer one
  // question the same way: this half has a server of its own. `filesNamed` answers only the
  // narrower question, so a guard built on it pulls back a half named in the environment —
  // which is the half the README says to point at another `llama-server` with
  // `SEEK_WORK_SERVER`, and the failure is silent: the words come from the model the package
  // carries, which writes prose instead of the `say` call a turn speaks through. What the
  // bundled server may serve is a half nobody named at all.
  const wordsNamed = workServer !== undefined

  if (wordsFromFiles) {
    // Said out loud and without the key, for the reason the weight host is said out loud: a
    // launch that quietly reached a remote model would be indistinguishable in a terminal
    // from one that never left this machine.
    console.error(
      `seek: the words half is ${workServer}, model '${workModel}' (from ${llmConfigPath})`,
    )
  }

  if (choice.mode === 'start') {
    // `process.resourcesPath` is a packaged app's `Contents/Resources`, which is where
    // `extraResources` puts `server/`. An unpackaged run points at Electron's own resources
    // instead, so it is given the directory the packaging copies *from* — otherwise the only
    // way to see this code run would be to build a `.app` first.
    const resources = app.isPackaged ? process.resourcesPath : join(__dirname, '..', 'resources')
    const weightsDir = weightsDirectory(app.getPath('userData'))

    // The weights come first, because a server started over files that are not there refuses
    // by design and the reason would be the wrong one. `SEEK_WEIGHTS_BASE` names one host and
    // only that one; unset means the ruled order, mirror first and the canonical host after it
    // (`weights-fetch.js`).
    const arrived = await ensureWeights({
      dir: weightsDir,
      base: process.env.SEEK_WEIGHTS_BASE,
      onProgress: (reading) => weightProgress(reading),
    })
    weightsPending = null
    if (!arrived.ok) {
      // Offline, a host that refused, a file that stopped short: the facts go to the window,
      // which draws them in the language it is running in and adds the one thing a person has
      // to know next — that a second launch continues where this one stopped.
      weightsWhy = arrived.why
      // The kernel is told in English, which is what it speaks: this sentence is its own
      // reading of a half it cannot use, and it is the same string the log below prints.
      startRefusal = describe(arrived.why)
      server = undefined
      // Only the judgement is starved by missing weights. A words half somebody named — in a
      // file or in the environment — reads no file from this machine, so refusing it here
      // would take down a half that is ready, and the window would say two things are broken
      // where one is.
      if (!wordsNamed) workServer = undefined
      console.error(`seek: the weights did not arrive — ${startRefusal}`)
      pushChanged()
    } else {
      // Which host served them is said out loud, because a run that quietly fell back would
      // otherwise be indistinguishable in the log from one the first host served — and the
      // difference is the whole reason the order is a ruling.
      if (arrived.fetched) {
        console.error(`seek: the weights arrived from ${arrived.host} (${arrived.bytes} bytes)`)
      }
      const started = await startBundledServer({
        binaryPath: bundledServerPath(resources),
        weightsDir,
        log: (line) => console.error(`seek: model server — ${line}`),
        // Only a server the app has *already opened on* is this handler's business. Before
        // that, a child that exits is `startBundledServer`'s answer — it returns the refusal
        // itself — and reporting it here as well would say it twice, in the wrong order.
        onStop: (how) => {
          if (modelServer !== null) serverStopped(how)
        },
      })
      if (started.refusal) {
        // No binary, a model that would not load: every one of them is a state a first run can
        // be in, and each is said rather than crashed. Both halves are refused together
        // because one server answers for both — the roster's two rows name no model of their
        // own (`FIRST_RUN_ROSTER`), so there is one origin and not two.
        startRefusal = started.refusal
        server = undefined
        if (!wordsNamed) workServer = undefined
      } else {
        modelServer = started
        server = started.origin
        // How much one judgement may read: `src/main.ts` asks the measured watch model with
        // `--window 24`, and the kernel leaves the number out
        // because the runtime cannot know one. This file *is* the caller, so it lives here.
        serverWindow = WATCH_WINDOW
        // The server this app started answers for the judgement. It answers for the words too
        // only when nobody named one for that half — an endpoint given in a file *or in the
        // environment* outranks it, or the half would be pulled back to the model that cannot
        // call the tool a turn speaks through.
        if (!wordsNamed) workServer = started.origin
        console.error(`seek: the model server is ${started.origin}`)
      }
    }
  }

  const opened = await openHostOrRefuse(STORE_FILE, {
    server,
    window: serverWindow,
    workServer,
    workModel,
    workApiKey,
    apiKey: MODEL_API_KEY,
    serverRefusal: startRefusal ?? undefined,
    // A refusal already known about this half wins, and the state of the server this app
    // starts only reaches it when that server is the one it was going to use.
    workServerRefusal:
      workServerRefusal ?? workModelRefusal ?? (wordsNamed ? undefined : startRefusal) ?? undefined,
  })
  host = opened.host
  storeRefusal = opened.refusal
  // Said here, where the app was started, as well as in the window where the person is
  // looking — the same two places a refused model server is said, and for the same reason.
  if (storeRefusal) console.error(`seek: the store was not opened — ${storeRefusal}`)
  // A server the person named and this build did not use is said twice — here, where the
  // app was started, and in the window, where they are looking. The window is the one that
  // matters; this line is what makes a refusal visible in a terminal that has no window
  // attached to it yet. Each half is said on its own, because either can refuse alone.
  // One line each, and each refuses per bot: the sentences inside name the bot whose roster
  // row was refused, so three bots that refused for three reasons are three lines.
  if (host?.stage1?.refusal) {
    console.error(`seek: a bot has no watch model — ${host.stage1.refusal}`)
  }
  if (host?.stage2?.refusal) {
    console.error(`seek: a bot has no words model — ${host.stage2.refusal}`)
  }
  // The window was made before any of this, so what is left is telling it what it now knows:
  // the store is open, the halves are bound or refused, or the store itself was refused.
  pushChanged()
}

/** One `activate` handler, however many times `start` runs. */
function registerActivate() {
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}

/**
 * The bundled server stopped after the app had opened on it.
 *
 * Nothing restarts it. A server that dies is a fact about this run, and a restart loop would
 * hide the reason behind a spinner while the child's own last words — the only place a
 * llama.cpp start-up failure explains itself — scroll away unread. Both halves take the
 * sentence because both were bound to the one process.
 *
 * The kernel keeps the judge it was built with, which is now pointed at a dead origin; a
 * message that asks it gets a transport failure, and the strip above the room says why.
 */
function serverStopped({ reason, code, signal, tail }) {
  const how =
    reason === 'exited'
      ? `stopped (exit ${code}${signal ? `, ${signal}` : ''})`
      : String(reason ?? 'stopped')
  const said = String(tail ?? '').trim() || 'it said nothing'
  modelServerRefusal = `the model server this app started ${how}: ${said}`
  modelServer = null
  console.error(`seek: the model server stopped — ${modelServerRefusal}`)
  pushChanged()
}

/**
 * The download's reading, kept and then pushed to the window.
 *
 * The reading is stored exactly as it arrives — facts, not a sentence, for the reason
 * `weights-fetch.js` states — and the pushes are throttled: a 2.1 GB body arrives in thousands
 * of chunks, and re-rendering the window once per chunk would spend the download's own bandwidth
 * on IPC. Half a second is finer than a person reads and coarse enough that the message never
 * grows to a queue.
 */
const PROGRESS_INTERVAL_MS = 500
let lastPushed = 0

function weightProgress(reading) {
  weightsPending = reading
  const now = Date.now()
  if (now - lastPushed < PROGRESS_INTERVAL_MS) return
  lastPushed = now
  pushChanged()
}

app.whenReady().then(start)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (host) closeHost(host)
    app.quit()
  }
})

// The comparator is disarmed on the way out. Nothing is lost by it: a row that came
// due while nothing was sweeping is caught by the next start, once (`§12 (c)`).
app.on('before-quit', () => {
  if (host) closeHost(host)
  // **The child does not die with the app.** A process started without `detached` is
  // reparented when its parent goes, not killed, so a quit that only closed the store would
  // leave a `llama-server` holding a model in memory behind every launch. `stop()` sends
  // SIGTERM synchronously, before its first `await`, so calling it here is enough.
  if (modelServer) modelServer.stop()
})
