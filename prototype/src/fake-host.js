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
  // **A place, not a sentence.** The settings page puts this value inside one of its own
  // sentences — `Kept in {path} on this machine, readable only by you` — so a demo that answered
  // "the prototype keeps no settings file" made the page read *Kept in the prototype keeps no
  // settings file on this machine*, which is not English. What the demo actually has is memory,
  // so it names that.
  settingsPath: 'the demo’s memory',
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

  /**
   * The same refusal for a file, and one invented attachment so the row can be seen.
   *
   * A demo cannot show a file dialog either. What it *can* do is hand back one attachment of
   * its own, so the screen a person looks at has a file in it — the bytes are named by a key
   * nothing can open, which is the honest state of a fixture: the row is drawn, and pressing
   * it answers that the demo has no file, exactly as `media` does above.
   */
  attachFile: async () => ({
    ok: true,
    file: {
      key: 'om-demo.pdf',
      name: 'design-notes.pdf',
      size: 18_432,
      mime: 'application/pdf',
    },
  }),
  openFile: async (reference) => ({
    ok: false,
    error: `the prototype keeps no file for ${reference?.name ?? 'that attachment'}`,
  }),

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
    // The other kind of bytes, and the demo's own reason to carry one: a message whose words
    // are empty is a file somebody sent, exactly as it is a picture somebody sent.
    const file = input?.file ?? null
    if (text === '' && media === null && file === null) {
      return refused('a message needs words, a picture or a file')
    }
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
      kind: media ? 'image' : file ? 'file' : 'text',
      media,
      file,
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
      silent: [],
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
      // A room made in the demo has nothing said about it yet, which the panel draws as an
      // invitation — the same `null` the store gives a room nobody has written about.
      description: null,
      announcement: null,
      tag: null,
      createdAt: new Date().toISOString(),
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

  /**
   * The window's first edit: what a room says about itself.
   *
   * The same rule the kernel's `updateRoom()` keeps — a field that did not arrive is a field
   * nobody touched, `''` is a person having cleared a text, a blank name is refused — written
   * here in eight lines because a demo that answered differently from the kernel would be
   * teaching the window a shape the real store does not have.
   */
  updateRoom: async (input) => {
    const room = roomOf(input?.roomId)
    if (!room) return refused('there is no room with that id in the demo')
    if (typeof input?.name === 'string') {
      const name = input.name.trim()
      if (name === '') return refused('a room needs a name')
      room.name = name
    }
    for (const field of ['description', 'announcement', 'tag']) {
      if (typeof input?.[field] !== 'string') continue
      const text = input[field].trim()
      room[field] = text === '' ? null : text
    }
    emit()
    return written()
  },

  /** One principal out of one room — the same refusal the kernel makes for the last one. */
  removeMember: async (input) => {
    const room = roomOf(input?.roomId)
    if (!room) return refused('there is no room with that id in the demo')
    const at = room.members.findIndex((one) => one.id === input?.principalId)
    if (at < 0) return refused('that principal is not in the room')
    if (room.members.length === 1) return refused('the last member of a room may not leave')
    room.members.splice(at, 1)
    emit()
    return written()
  },

  /** A bot deleted from the organization: gone from the people list, kept in the messages it wrote. */
  deleteBot: async (input) => {
    const id = String(input?.botId ?? '')
    const at = data.people.findIndex((one) => one.id === id && one.bot)
    if (at < 0) return refused('there is no bot with that id in the demo')
    const rooms = data.rooms.filter((room) => room.members.some((one) => one.id === id))
    if (rooms.some((room) => room.members.length === 1)) {
      return refused('that bot is the only member of a room, so it cannot be deleted')
    }
    data.people.splice(at, 1)
    for (const room of rooms) {
      room.members = room.members.filter((one) => one.id !== id)
    }
    emit()
    // `rooms` rides back because which rooms it was in is not derivable from the snapshot that
    // follows — it has already left them.
    return { ok: true, snapshot: snapshot(), botId: id, rooms: rooms.map((room) => room.id) }
  },

  deleteMessage: async (input) => {
    const id = String(input?.messageId ?? '')
    const found = data.rooms
      .flatMap((room) => room.messages.map((message) => ({ room, message })))
      .find((one) => one.message.id === id)
    if (!found) return refused('there is no message with that id in the demo')
    if (found.message.deletedAt) return refused('that message was already deleted')
    // The tombstone, in the shape the store keeps: the row stays and the content goes
    // (`src/erase.ts`), which is what the window's `deletedAt` is read for.
    const at = new Date().toISOString()
    found.message.deletedAt = at
    found.message.text = ''
    found.message.media = null
    found.message.file = null
    found.message.mentions = []
    found.message.reactions = []
    found.message.quoted = null
    found.message.forwardedFrom = null
    emit()
    return { ok: true, snapshot: snapshot(), messageId: id, roomId: found.room.id }
  },

  deleteThread: async (input) => {
    const rootId = String(input?.rootId ?? '')
    const room = data.rooms.find((one) =>
      one.messages.some((message) => message.id === rootId),
    )
    if (!room) return refused('there is no thread with that root in the demo')
    const at = new Date().toISOString()
    const taken = room.messages.filter(
      (message) => message.chain === rootId || message.id === rootId,
    )
    for (const message of taken) {
      message.deletedAt = at
      message.text = ''
      message.media = null
      message.file = null
      message.mentions = []
      message.reactions = []
      message.quoted = null
      message.forwardedFrom = null
    }
    emit()
    return {
      ok: true,
      snapshot: snapshot(),
      messageIds: taken.map((message) => message.id),
      roomId: room.id,
    }
  },

  deleteRoom: async (input) => {
    const id = String(input?.roomId ?? '')
    const at = data.rooms.findIndex((room) => room.id === id)
    if (at < 0) return refused('there is no room with that id in the demo')
    const [gone] = data.rooms.splice(at, 1)
    emit()
    return {
      ok: true,
      snapshot: snapshot(),
      roomId: gone.id,
      messageIds: gone.messages.map((message) => message.id),
    }
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
