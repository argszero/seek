/**
 * The fake host: `window.seekHost`, over the fixture instead of over a kernel.
 *
 * **Why this file exists at all.** The window talks to its data through one object,
 * `window.seekHost`, put there by `ui/electron/preload.js` over IPC. The prototype is the
 * same window, so it needs the same object; what it must not need is the kernel. This
 * supplies every call that bridge supplies, reads and writes `fixture.js`, and re-emits
 * `onChanged` after a write — so a message sent in the demo is a message in the demo, and
 * not a still picture of one.
 *
 * **Every method here is checked against the window's own call sites.** `ui/electron/
 * prototype.test.mjs` reads `window.seekHost.<name>` out of `ui/src/**` and asserts this
 * file answers each one: a window that grew a call this file does not answer would be a
 * prototype that dies on a click, and the test is what makes that impossible to ship.
 */
import en from '../../src/i18n/en.json'
import zhCN from '../../src/i18n/zh-CN.json'
import { makeFixture } from './fixture.js'

const CATALOGUES = { en, 'zh-CN': zhCN }

/**
 * Which words the demo speaks.
 *
 * The window's own default is `en` (`src/i18n.ts`, `DEFAULT_LOCALE`), and the prototype is
 * the window, so that is the default here too — a demo that spoke a different language than
 * the app would be showing a screen the app does not have. `?locale=zh-CN` asks for the
 * other catalogue, which is how the Chinese window gets looked at without editing a file.
 */
const ASKED = new URLSearchParams(window.location.search).get('locale')
export const LOCALE = ASKED && CATALOGUES[ASKED] ? ASKED : 'en'

/** The demo's store, and the only mutable thing in this file. */
const data = makeFixture()

/** Who is listening for a change, which is what `onChanged` registers. */
const listeners = new Set()

/**
 * Tell everyone listening that the store moved.
 *
 * **What a listener is handed is a snapshot, not a nudge.** The window takes the argument as
 * its new state (`ui/src/App.jsx`: `onChanged(adopt)`, and `adopt` reads `next.rooms`), which
 * is what the real bridge gives it (`ui/electron/preload.js`: `listener(snapshot)`). This
 * function used to call `listener(undefined)` and got away with it only while the window
 * re-read the store itself and ignored the argument; once every snapshot went through one
 * `adopt` (2026-10-27, PR #122), that made *every write in the demo* a crash — the window
 * unmounted on the first change. Found by making an organization here: pressing Create blanked
 * the screen with `Cannot read properties of undefined (reading 'rooms')`.
 */
function emit() {
  const next = snapshot()
  for (const listener of [...listeners]) {
    try {
      listener(next)
    } catch (error) {
      console.error('[seek prototype] a listener failed', error)
    }
  }
}

/** A fresh copy each time: React compares by identity, and a shared object would never change. */
function snapshot() {
  return structuredClone({
    rooms: data.rooms,
    people: data.people,
    me: data.me,
    storeFile: 'the prototype has no store — this is fixture data',
    stage1: data.stage1,
    stage2: data.stage2,
    storeRefusal: data.storeRefusal,
    firstLaw: data.firstLaw,
    organizations: data.organizations,
    currentOrganizationId: data.currentOrganizationId,
  })
}

const roomOf = (id) => data.rooms.find((room) => room.id === id)
const principalName = (id) =>
  id === data.meId ? data.me : (data.people.find((one) => one.id === id)?.name ?? id)

let sequence = 0
function freshId(prefix) {
  sequence += 1
  return `${prefix}-${sequence}`
}

/** A write's answer, in the shape every call site reads: a snapshot and nothing else. */
const written = () => ({ ok: true, snapshot: snapshot() })
const refused = (error) => ({ ok: false, error })

/**
 * What the settings page reads: the endpoint in use, the one saved, and whether a key is
 * held. **Never the key itself** — `ui/electron/main.js` answers `hasKey`, `keyTail` and
 * `keyLen` for exactly that reason, and a demo that handed over a key would be teaching the
 * window to read one.
 */
const llm = {
  live: {
    baseUrl: 'http://127.0.0.1:8787/v1',
    model: 'lfm2.5-vl-3b',
    from: 'demo',
    hasKey: false,
    keyTail: '',
    keyLen: 0,
  },
  saved: {
    baseUrl: null,
    model: null,
    hasKey: false,
    keyTail: '',
    keyLen: 0,
  },
  refusal: null,
  settingsPath: 'the prototype keeps no settings file',
  configPath: 'the prototype reads no config file',
}

/** A theme that lasts one session: the demo has no settings file to remember one in. */
let theme = 'light'

export const fakeHost = {
  // ---- reads ------------------------------------------------------------
  snapshot: async () => snapshot(),

  onChanged: (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },

  catalogue: async () => CATALOGUES[LOCALE],

  theme: async () => theme,

  dataPath: async () => 'the prototype keeps no data directory',

  llm: async () => structuredClone(llm),

  models: async () => ({ ok: true, models: ['lfm2.5-vl-3b', 'deepseek-flash', 'deepseek-pro'] }),

  /**
   * A picture, read back. The fixture carries none, so this answers what a store would
   * answer for a reference it cannot open — the window draws that as a missing picture
   * rather than as an empty one, and the demo shows that screen honestly instead of
   * pretending to have a file.
   */
  media: async (reference) => ({
    ok: false,
    error: `the prototype has no file for ${reference?.key ?? 'that reference'}`,
  }),

  /** Attaching opens a real file dialog, which a demo has no business doing. */
  attach: async () => null,

  // ---- writes -----------------------------------------------------------
  saveTheme: async (next) => {
    theme = next === 'dark' ? 'dark' : 'light'
    emit()
    return { ok: true }
  },

  post: async (input) => {
    const room = roomOf(input?.roomId)
    if (!room) return refused('there is no room with that id in the demo')
    const text = typeof input?.text === 'string' ? input.text.trim() : ''
    const media = input?.media ?? null
    if (text === '' && media === null) return refused('a message needs words or a picture')
    // A thread is the kernel's own three facts: what this answers, which run it belongs to,
    // and how far from that run's root it sits. Replying to a reply stays in the first
    // reply's chain, which is the rule the room above already follows.
    const parent = input?.rootId ? room.messages.find((one) => one.id === input.rootId) : null
    if (input?.rootId && !parent) return refused('there is no message to answer in this room')
    const id = freshId('m')
    room.messages.push({
      id,
      sender: data.meId,
      text,
      kind: media ? 'image' : 'text',
      media,
      at: new Date().toISOString(),
      mentions: Array.isArray(input?.mentions) ? input.mentions.map((one) => ({ ...one })) : [],
      reactions: [],
      quoted:
        typeof input?.quoteOf === 'string'
          ? quoteOf(room, input.quoteOf)
          : null,
      forwardedFrom: null,
      rootId: parent ? parent.id : null,
      chain: parent ? parent.chain : id,
      depth: parent ? parent.depth + 1 : 0,
    })
    emit()
    return written()
  },

  react: async (input) => {
    const room = roomOf(input?.roomId)
    if (!room) return refused('there is no room with that id in the demo')
    const message = room.messages.find((one) => one.id === input?.messageId)
    if (!message) return refused('there is no message with that id in this room')
    const type = String(input?.emojiType ?? '')
    if (type === '') return refused('a reaction needs an emoji')
    // One call both ways, like the kernel's own `toggleReaction()`: a second press on the
    // same emoji is the undo, so there is no `unreact` beside this.
    const existing = message.reactions.find((one) => one.emojiType === type)
    if (existing) {
      const at = existing.operators.indexOf(data.meId)
      if (at === -1) existing.operators.push(data.meId)
      else existing.operators.splice(at, 1)
      if (existing.operators.length === 0) {
        message.reactions = message.reactions.filter((one) => one !== existing)
      }
    } else {
      message.reactions.push({ emojiType: type, operators: [data.meId] })
    }
    emit()
    return written()
  },

  copy: async (text) => {
    try {
      await navigator.clipboard.writeText(String(text ?? ''))
      return { ok: true }
    } catch (error) {
      return refused(error instanceof Error ? error.message : String(error))
    }
  },

  createRoom: async (input) => {
    const name = typeof input?.name === 'string' ? input.name.trim() : ''
    if (name === '') return refused('a room needs a name')
    const members = Array.isArray(input?.members) ? input.members : []
    const id = freshId('room')
    data.rooms.push({
      id,
      name,
      // The kernel's own rule: a room of two is a direct message whatever it is called
      // (`src/rooms.ts`), and the interface reads this field rather than counting.
      kind: members.length + 1 === 2 ? 'p2p' : 'group',
      spend: { turns: 0, input_tokens: 0, output_tokens: 0, bots: [] },
      members: [
        { id: data.meId, name: data.me, bot: false },
        ...members.map((principalId) => ({
          id: principalId,
          name: principalName(principalId),
          bot: data.people.some((one) => one.id === principalId && one.bot),
        })),
      ],
      messages: [],
    })
    emit()
    return { ok: true, snapshot: snapshot(), roomId: id }
  },

  addMember: async (input) => {
    const room = roomOf(input?.roomId)
    if (!room) return refused('there is no room with that id in the demo')
    const id = String(input?.principalId ?? '')
    if (room.members.some((one) => one.id === id)) return refused('that principal is already in the room')
    room.members.push({
      id,
      name: principalName(id),
      bot: data.people.some((one) => one.id === id && one.bot),
    })
    emit()
    return written()
  },

  addBot: async (input) => {
    const name = typeof input?.name === 'string' ? input.name.trim() : ''
    if (name === '') return refused('a bot needs a name')
    const id = freshId('bot')
    data.people.push({
      id,
      name,
      bot: true,
      kind: 'bot',
      description: null,
      gender: typeof input?.gender === 'string' && input.gender !== '' ? input.gender : null,
      position: typeof input?.position === 'string' && input.position !== '' ? input.position : null,
      personality:
        typeof input?.personality === 'string' && input.personality !== '' ? input.personality : null,
    })
    emit()
    // `roster` rides back because a bot with no roster rows cannot answer, and the window
    // says so — the demo hands back the ordinary answer rather than a second one.
    return { ok: true, snapshot: snapshot(), botId: id, roster: 'written' }
  },

  createOrganization: async (name) => {
    const wanted = typeof name === 'string' ? name.trim() : ''
    if (wanted === '') return refused('an organization needs a name')
    data.organizations.push({ id: freshId('org'), name: wanted })
    emit()
    return written()
  },

  renameOrganization: async (input) => {
    const found = data.organizations.find((one) => one.id === input?.id)
    if (!found) return refused('there is no organization with that id in the demo')
    const wanted = typeof input?.name === 'string' ? input.name.trim() : ''
    if (wanted === '') return refused('an organization needs a name')
    found.name = wanted
    emit()
    return written()
  },

  switchOrganization: async (id) => {
    if (!data.organizations.some((one) => one.id === id)) {
      return refused('there is no organization with that id in the demo')
    }
    data.currentOrganizationId = id
    emit()
    return written()
  },

  removeOrganization: async (id) => {
    const at = data.organizations.findIndex((one) => one.id === id)
    if (at === -1) return refused('there is no organization with that id in the demo')
    if (data.organizations.length === 1) return refused('the last organization cannot be removed')
    data.organizations.splice(at, 1)
    if (data.currentOrganizationId === id) data.currentOrganizationId = data.organizations[0].id
    emit()
    return written()
  },

  saveLlm: async (input) => {
    const baseUrl = typeof input?.baseUrl === 'string' ? input.baseUrl.trim() : ''
    const model = typeof input?.model === 'string' ? input.model.trim() : ''
    if (!/^https?:\/\/./.test(baseUrl)) {
      return refused('the address has to start with http:// or https://')
    }
    if (model === '') return refused('the model name is empty')
    llm.saved.baseUrl = baseUrl.replace(/\/+$/, '')
    llm.saved.model = model
    const apiKey = typeof input?.apiKey === 'string' ? input.apiKey.trim() : ''
    // A key is only recorded when one was typed, exactly as the app does it: the field
    // arrives empty on every draw, so reading empty as "remove it" would erase the key
    // every time somebody changed the address.
    if (apiKey !== '') {
      llm.saved.hasKey = true
      llm.saved.keyTail = apiKey.slice(-4)
      llm.saved.keyLen = apiKey.length
    }
    emit()
    return { ok: true, llm: structuredClone(llm) }
  },
}

/** The snapshot of a message being quoted, so a reply carries what it answered. */
function quoteOf(room, messageId) {
  const found = room.messages.find((one) => one.id === messageId)
  if (!found) return null
  return { messageId: found.id, name: principalName(found.sender), text: found.text }
}
