import { useEffect, useRef, useState } from 'react'

import Contacts from './Contacts.jsx'
import Groups from './Groups.jsx'
import Settings from './Settings.jsx'
import Topics from './Topics.jsx'
import { t } from './catalogue.mjs'
import { roomToOpen } from './room-to-open.mjs'

/**
 * Tokens are counts, so they are drawn by `Intl.NumberFormat` rather than by string
 * arithmetic: `1204` and `1,204` are the same figure and only one of them reads as one.
 * Constructed once, because a formatter built per render is a locale lookup per message.
 */
const TOKENS = new Intl.NumberFormat()

/**
 * The hover toolbar's four glyphs, and the emoji its square picks from.
 *
 * The paths are not drawn here and not adapted from an icon set: each one is the pixel mask
 * of the same glyph in the reference screenshots, folded row by row into a path and checked
 * against the mask by drawing it back (`prototype/src/js/icons.js`, where the measurements
 * live). They are **filled** rather than stroked — the shape carries the meaning at 16px, and
 * a 1.6px outline at that size reads as a smudge — so the `<svg>` below says
 * `fill="currentColor" stroke="none"` rather than inheriting the stroked default.
 *
 * The emoji table is the join between what a person sees and what the kernel stores: Feishu's
 * `emoji_type` is a *name* (`THUMBSUP`, not `👍`), and `toggleReaction()` takes the name. A
 * reaction whose name this window has no glyph for is drawn as its name rather than dropped —
 * `emojiGlyph()` below — because a row of reactions is the store's, not this file's.
 */
const ACTION_GLYPHS = {
  reply: (
    <path
      fillRule="evenodd"
      d="M6.4 5H17.6A1.9 1.9 0 0 1 19.5 6.9V16.1A1.9 1.9 0 0 1 17.6 18H15.6L15.3 19.35H10.9L10.6 18H6.4A1.9 1.9 0 0 1 4.5 16.1V6.9A1.9 1.9 0 0 1 6.4 5ZM9.75 10.3a1.15 1.15 0 1 0 0 2.3 1.15 1.15 0 0 0 0-2.3ZM13.5 10.3a1.15 1.15 0 1 0 0 2.3 1.15 1.15 0 0 0 0-2.3ZM17.25 10.3a1.15 1.15 0 1 0 0 2.3 1.15 1.15 0 0 0 0-2.3Z"
    />
  ),
  forward: (
    <path d="M12.75 5L14.25 5.75L15 6.5L15.75 7.25L16.5 8L17.25 8.75L18 9.5L18.75 10.25L19.5 11L19.5 11.75L19.5 12.5L18.75 13.25L18.75 14L18 14.75L17.25 15.5L16.5 16.25L15.75 17L15 17.75L14.25 18.5L12.75 18.5L12.75 15.6L7.5 15.6L7.5 16.25L6 17L4.5 17.75L4.5 15.5L4.5 14.75L5.25 14L5.25 13.25L6 12.5L6 11.75L6.75 11L8.25 10.25L9 9.5L12 8.75L12.75 8Z" />
  ),
  topic: (
    <path
      fillRule="evenodd"
      d="M7.7 5H17.9A1.7 1.7 0 0 1 19.6 6.7V17.3A1.7 1.7 0 0 1 17.9 19H7.7A1.7 1.7 0 0 1 6 17.3V13.5L4.5 12.6A.6.6 0 0 1 4.5 11.4L6 10.5V6.7A1.7 1.7 0 0 1 7.7 5ZM9.95 9.4h5.9a1.15 1.15 0 0 1 0 2.3h-5.9a1.15 1.15 0 0 1 0-2.3ZM9.95 13.2h5.9a1.15 1.15 0 0 1 0 2.3h-5.9a1.15 1.15 0 0 1 0-2.3Z"
    />
  ),
  more: (
    <>
      <circle cx="4.7" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19.3" cy="12" r="1.8" />
    </>
  ),
}

const EMOJI = [
  { type: 'THUMBSUP', glyph: '👍' },
  { type: 'OK', glyph: '✅' },
  { type: 'SMILE', glyph: '😄' },
  { type: 'PARTY', glyph: '🎉' },
  { type: 'EYES', glyph: '👀' },
  { type: 'HEART', glyph: '❤️' },
]

/** The glyph for a stored `emoji_type`, or the name itself when there is none. */
function emojiGlyph(type) {
  return EMOJI.find((one) => one.type === type)?.glyph ?? type
}

/**
 * One of the toolbar's four glyphs.
 *
 * Filled, and `aria-hidden` because the button that holds it carries the title: a screen
 * reader announcing "picture" beside "Reply" says the same thing twice.
 */
function ActionGlyph({ name }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
      {ACTION_GLYPHS[name]}
    </svg>
  )
}

/**
 * The shell: a messenger window over the kernel's own store.
 *
 * The room list, the members, the messages and the threads all come from `snapshot()`
 * in the main process, which is the kernel. Nothing here decides anything about the
 * data — this file draws it, types into it, and since this slice opens a thread.
 *
 * **What the composer is.** One call, `post({ roomId, text })`. The main process hands
 * it to the kernel's own `deliver()`, saves, and wakes the bots the message reached; a
 * bot that judges the message worth answering says so through `say()`. The message you
 * typed and the answer you get are therefore in the store, in that order, before either
 * is drawn — this window is a view of them, not a second copy. **Whether** the bot answers
 * is stage 1, and **what it says** is stage 2; each half is a real model when the app was
 * started with the server that carries it (`ui/electron/host.js`), and each is the
 * kernel's own placeholder when it was not (`stubJudge`, `stubDecide` in `src/main.ts`).
 * `StageOne` and `StageTwo` below are where the window says which of those two it is
 * looking at, one strip each because either half can be refused alone.
 *
 * **What the thread panel is.** A thread is not a second conversation this file keeps:
 * the kernel already records it. A message that answers another carries `root_id`, the
 * `chain` of the run it belongs to and one hop more `depth` (`src/delivery.ts`), and a
 * message that answers nothing roots its own chain. So the panel groups by `chain` —
 * the kernel's fact — and a reply is the same `post()` call with a `rootId`. Nothing
 * here invents a grouping rule, and no thread exists that the store does not have.
 *
 * The panel answers the message the thread belongs to, which is what makes every reply
 * in it one hop from that message, the way thread replies sit under the parent.
 * The bot's answer lands in the panel when stage 2 is bound, because `workOverServer`
 * names the entry that woke the turn and the kernel's own chain follows it there; with
 * no work server the answer lands in the room, because `stubDecide` says its line
 * without naming what it answers.
 *
 * **Who a message addresses.** A message may carry `mentions[]` — the open-platform field, each
 * entry a `{id, name}` pair (`src/types.ts`) — and rule 15 of `docs/design/data-model.md`
 * says that field is *"what the interface draws as blue @-text"*. So this file does both
 * halves: the composer names who it addresses, and a line draws the pairs its message
 * carries. The drawing reads the message and never the roster, because a mention records
 * who was named when it was said — renaming somebody today does not rewrite what was sent
 * last week. **@ is a choice, not a syntax**: typing the character inserts nothing, and a
 * mention only exists because the person picked a name, which is the same rule `chip` and
 * `media` follow — the window never guesses a fact out of the text. What the kernel does
 * with the array is stage 0's free pass: a bot named in `mentions[]` wakes on that pass
 * instead of waiting for the watch model to judge it (`src/gate.ts`, row 2).
 */
export default function App() {
  const [snap, setSnap] = useState(null)
  const [activeId, setActiveId] = useState(null)
  // Which column this window is showing. Two, because the settings page is not a room: it is
  // where the endpoint is chosen, and a room list beside it would suggest it belongs to one.
  const [view, setView] = useState('chat')
  const [draft, setDraft] = useState('')
  // The chain root of the thread on show, or null. A chain's root is the message the
  // whole run belongs to, which is exactly what the panel replies to.
  const [openThread, setOpenThread] = useState(null)
  const [threadDraft, setThreadDraft] = useState('')
  const [error, setError] = useState(null)
  const [sending, setSending] = useState(false)
  // Making a room: the form's own three facts, and nothing the kernel does not also hold.
  // `picked` is a plain list of principal ids, so what the person chose is exactly what the
  // kernel's `createRoom()` is given — its "named twice" and "no members" refusals are about
  // the choice, not about this state's shape.
  const [making, setMaking] = useState(false)
  const [newName, setNewName] = useState('')
  const [picked, setPicked] = useState([])
  // Who is in the room on show, and who could be: the panel the member count opens.
  // `adding` is only ever the one call in flight, so a second press cannot race the first.
  const [peopleOpen, setPeopleOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  // Making a bot, and looking at one, moved to `Contacts.jsx`: the four fields a bot is —
  // 姓名／性别／职位／性格 — are that view's own state until `Add` hands them to the main process,
  // and nothing on this screen draws them. What stays here is the snapshot the add hands back,
  // which is the same snapshot every other write on this screen arrives as.
  // The hover toolbar's surfaces, one at a time: the emoji picker on one message, the message
  // the next thing sent will quote, and the message waiting to be forwarded. `moreOn` is the
  // fourth — the *more* menu, whose one item copies the message's words. None of these is
  // store state: a picker nobody is looking at is not a fact about the world, and the moment
  // one of them writes, the kernel's own snapshot is what this window redraws from.
  const [picking, setPicking] = useState(null)
  const [quoting, setQuoting] = useState(null)
  const [forwarding, setForwarding] = useState(null)
  const [moreOn, setMoreOn] = useState(null)
  // The glyph the emoji square shows. Feishu's square remembers the last one used, and that
  // is a fact about this window's session rather than about the store — so it lives here and
  // starts at the same 👍 the reference screenshot shows.
  const [lastEmoji, setLastEmoji] = useState('THUMBSUP')
  // One line answering an action that wrote nothing a snapshot could show — a copy that
  // reached the clipboard, a forward that landed in another room. Cleared by the next thing
  // the person does, so it never turns into a claim about a state that has moved on.
  const [note, setNote] = useState(null)
  // Who each composer's next message addresses. Two instances rather than one list, because
  // the room's composer and the thread's are on screen at the same time when a thread is
  // open: a chip picked in one box must not silently name somebody in a message sent from
  // the other. See `useMentions` below for what one of these is.
  const roomMention = useMentions()
  const threadMention = useMentions()
  const messagesEnd = useRef(null)
  const threadEnd = useRef(null)

  useEffect(() => {
    // **One rule for every snapshot, because the first one may have nothing in it.** The
    // window is made before the store is opened (`ui/electron/main.js`), so this snapshot
    // can arrive while there is no store and answer `rooms: []`; the one sent when the store
    // opens is then the first that has a room to offer. A handler that picked the room only
    // out of the first answer would open nothing for the rest of the session — the rooms
    // listed, none of them open, no composer (issue #120). `roomToOpen` is that one rule,
    // and it fills only a `null`, so a room somebody is already reading is never taken from
    // them by a later snapshot.
    const adopt = (next) => {
      setSnap(next)
      setActiveId((current) => roomToOpen(current, next.rooms))
    }
    window.seekHost.snapshot().then(adopt)
    // The kernel changes the store by itself when a bot answers. Without this the
    // window would only be right immediately after *you* typed.
    return window.seekHost.onChanged(adopt)
  }, [])

  const active = snap?.rooms.find((room) => room.id === activeId) ?? null
  const messages = active?.messages ?? []

  // The thread, as the kernel groups it: every message whose chain is that root, the
  // root among them, in the order the store wrote them. A message whose `chain` is its
  // own id is the root of its chain; any other is a reply in one.
  const thread = openThread ? messages.filter((message) => message.chain === openThread) : []
  const repliesIn = {}
  for (const message of messages) {
    if (message.chain !== message.id) repliesIn[message.chain] = (repliesIn[message.chain] ?? 0) + 1
  }

  // The newest line is the one you just sent, or the answer to it — so the column
  // follows the conversation instead of leaving it below the fold.
  useEffect(() => {
    if (messagesEnd.current) messagesEnd.current.scrollIntoView({ block: 'end' })
  }, [messages.length, activeId])

  useEffect(() => {
    if (threadEnd.current) threadEnd.current.scrollIntoView({ block: 'end' })
  }, [thread.length, openThread])

  async function send(text, rootId, media, mention) {
    const body = typeof text === 'string' ? text.trim() : ''
    // A picture may go with no words at all — the caption is optional (`media` names the
    // bytes, and `deliver()` accepts an image with an empty text); a text message may not.
    if (!active || sending || (body === '' && !media)) return
    setSending(true)
    setError(null)
    setNote(null)
    try {
      // A reply is the same call with a parent named; the kernel decides the rest of
      // the thread from it. A picture is the same call with `kind` and `media`, and the
      // kernel's own `mediaFor` is what refuses a picture it will not accept.
      const result = await window.seekHost.post({
        roomId: active.id,
        text: body,
        rootId,
        ...(media ? { kind: 'image', media: { key: media.key, mime: media.mime } } : {}),
        // Who this message names. Sent as the pairs the person picked, and the kernel stores
        // them on the message verbatim (`mentionsOf` in `ui/electron/host.js` copies them and
        // decides nothing); an empty list is a message that addresses the room.
        mentions: mention.addressed,
        // What this message quotes, when the toolbar's reply button named one. An id and
        // nothing else: `deliver()` reads that message out of the store and keeps the
        // snapshot of it, so the quotation cannot say anything the store does not hold.
        ...(quoting ? { quoteOf: quoting.messageId } : {}),
      })
      if (result.ok) {
        setSnap(result.snapshot)
        // The quotation belonged to the message that just went out; a strip left behind
        // would quietly quote the same person into the next message as well.
        setQuoting(null)
        // The mention belonged to the message that just went out, so the next one starts
        // addressing nobody — a chip left behind would silently name somebody in a message
        // written after the person stopped thinking about it.
        mention.clear()
        if (rootId) setThreadDraft('')
        else setDraft('')
      } else {
        // Kept in the box, so what was typed is not lost to a refusal.
        setError({ where: rootId ? 'thread' : 'room', message: result.error })
      }
    } finally {
      setSending(false)
    }
  }

  /**
   * Choose a picture and send it, with whatever is in the box as its caption.
   *
   * The bytes are written before this call returns (`seek:attach` in the main process), and
   * the message that names them is posted second — the order `deliver()` requires, since an
   * `image` whose reference points at nothing is refused. A cancelled dialog is not a
   * failure and draws nothing; a file the app cannot read is a sentence in the composer.
   */
  async function attachInto(rootId, mention) {
    if (!active || sending) return
    setSending(true)
    setError(null)
    try {
      const picked = await window.seekHost.attach()
      if (!picked.ok) {
        if (!picked.cancelled) setError({ where: rootId ? 'thread' : 'room', message: picked.error })
        return
      }
      await send(rootId ? threadDraft : draft, rootId, picked.media, mention)
    } finally {
      setSending(false)
    }
  }

  function keyDown(event, text, rootId, mention) {
    // Enter sends; Shift+Enter is a newline. Fixed, not a setting.
    //
    // `isComposing` is the part that is easy to leave out and painful to live with: while an
    // input method is composing, Enter commits the candidate, and without this guard the Enter
    // that picks a Chinese word would send a half-typed line instead.
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault()
      send(text, rootId, undefined, mention)
    }
  }

  function openThreadOf(message) {
    setOpenThread(message.chain)
    setThreadDraft('')
    setError(null)
  }

  /**
   * One reaction, and the kernel decides which direction.
   *
   * `seek:react` carries `toggleReaction()` (`src/delivery.ts`): the person who is not in
   * `operators[]` is added, and the one who is, is taken out — the same call, because a
   * second press *is* the undo. That is why this file has no "remove" path to keep in step
   * with an "add" one, and why the reaction row below is drawn from the snapshot rather than
   * from an optimistic guess: the store answers with what it now holds.
   */
  async function reactTo(message, emojiType) {
    if (!active) return
    setPicking(null)
    setMoreOn(null)
    setNote(null)
    setError(null)
    try {
      const result = await window.seekHost.react({
        roomId: active.id,
        messageId: message.id,
        emojiType,
      })
      if (result.ok) {
        setSnap(result.snapshot)
        setLastEmoji(emojiType)
      } else {
        setError({ where: 'room', message: result.error })
      }
    } catch (failure) {
      setError({ where: 'room', message: failure instanceof Error ? failure.message : String(failure) })
    }
  }

  /** Reply with a quotation: the next message from either box carries this one's words. */
  function startQuote(message) {
    setPicking(null)
    setMoreOn(null)
    setForwarding(null)
    setNote(null)
    setQuoting({ messageId: message.id, senderId: message.sender, text: message.text })
  }

  /** Forward: pick the room it goes to, then send it there. */
  function startForward(message) {
    setPicking(null)
    setMoreOn(null)
    setQuoting(null)
    setNote(null)
    setForwarding({ roomId: active.id, messageId: message.id, senderId: message.sender })
  }

  /**
   * Send a forward into a room.
   *
   * **`forwardOf` names where the original is**, as a `{roomId, messageId}` pair, because the
   * message being forwarded was said in this room and is going to another one — the kernel
   * reads it out of the store and copies its words, kind and picture (`src/delivery.ts`).
   * Nothing is typed here and nothing of the forward's own is passed: the kernel refuses a
   * forward carrying content beside the address, since that would be a second copy of a fact
   * the store already holds.
   */
  async function forwardInto(targetId) {
    const source = forwarding
    if (!source || sending) return
    setSending(true)
    setError(null)
    try {
      const result = await window.seekHost.post({
        roomId: targetId,
        text: '',
        forwardOf: { roomId: source.roomId, messageId: source.messageId },
      })
      if (result.ok) {
        setSnap(result.snapshot)
        const target = result.snapshot.rooms.find((room) => room.id === targetId)
        setNote(t('ui.chat.forwarded-into', { room: target?.name ?? t('ui.chat.that-room') }))
      } else {
        setError({ where: 'room', message: result.error })
      }
    } catch (failure) {
      setError({ where: 'room', message: failure instanceof Error ? failure.message : String(failure) })
    } finally {
      setSending(false)
      setForwarding(null)
    }
  }

  /**
   * The *more* menu's one item: the message's words, onto the platform clipboard.
   *
   * From the main process rather than from `navigator.clipboard` here, because a page's own
   * write is gated on a user gesture and the prototype measured that a scripted press is
   * answered with a failure while a real one works — the same call from the main process has
   * no such gate. A picture with no caption has no words, and the call says so.
   */
  async function copyMessage(message) {
    setMoreOn(null)
    setError(null)
    try {
      const result = await window.seekHost.copy(message.text)
      if (result.ok) setNote(t('ui.chat.copied'))
      else setError({ where: 'room', message: result.error })
    } catch (failure) {
      setError({ where: 'room', message: failure instanceof Error ? failure.message : String(failure) })
    }
  }

  function enterRoom(roomId) {
    setActiveId(roomId)
    // A thread belongs to a room; leaving the room leaves the thread behind it. The member
    // panel answers "who is in this room", so it belongs to a room the same way.
    setOpenThread(null)
    setPeopleOpen(false)
    // So does a mention: the picker lists this room's members, and a name chosen in one room
    // is not a name the next room holds. Dropping both is why the list can stay the room's.
    roomMention.clear()
    threadMention.clear()
    setError(null)
  }

  /**
   * Open the form, with everyone already chosen.
   *
   * The default is everyone this store knows, because that is the room a person usually
   * wants — the people and bots they already have — and because the kernel refuses an empty
   * room, so a form that opened with nothing ticked would open on a refusal.
   */
  function startMaking() {
    setNewName('')
    setPicked((snap?.people ?? []).map((person) => person.id))
    setMaking(true)
    setError(null)
  }

  function togglePick(id) {
    setPicked((current) =>
      current.includes(id) ? current.filter((one) => one !== id) : [...current, id],
    )
  }

  /**
   * Make the room, and go into it.
   *
   * One call to the main process, which hands it to the kernel's own `createRoom()` — the
   * room and its members are written in one step there, so there is no window in which this
   * window could see a room nobody is in. **Nothing here refuses anything**: the kernel's own
   * sentences are what the form shows, which is why `Create` stays clickable with nobody
   * ticked — a disabled button would say "not allowed" where the kernel says *why*
   * ("a room with no members: … nothing could ever be said in it").
   */
  async function makeRoom() {
    if (sending) return
    setSending(true)
    setError(null)
    try {
      const made = await window.seekHost.createRoom({ name: newName, members: picked })
      if (made.ok) {
        setSnap(made.snapshot)
        // The room that was just made is the one to look at: creating a room and staying in
        // the old one is a click that appears to have done nothing.
        enterRoom(made.roomId)
        setMaking(false)
        setNewName('')
      } else {
        setError({ where: 'new-room', message: made.error })
      }
    } finally {
      setSending(false)
    }
  }

  /**
   * Put somebody into the room on show, and stay in it.
   *
   * One call to the main process, which hands it to the kernel's own `addMember()` — the
   * room's memberships are the kernel's rows and this window holds no copy of them, so the
   * snapshot that comes back is what says who is in the room now.
   *
   * **Nothing here decides who may join.** The panel marks who is already in, because that is
   * a fact the snapshot states, and any Add it offers goes to the kernel — which is the one
   * that refuses, in its own words. The panel stays open after a success on purpose: the row
   * that just changed is the proof the click did something, and closing the panel would hide
   * it behind a list the person would have to re-open to check.
   */
  async function addToRoom(principalId) {
    if (!active || adding) return
    setAdding(true)
    setError(null)
    try {
      const outcome = await window.seekHost.addMember({ roomId: active.id, principalId })
      if (outcome.ok) setSnap(outcome.snapshot)
      else setError({ where: 'add-member', message: outcome.error })
    } finally {
      setAdding(false)
    }
  }

  /**
   * Open the conversation with one person, making it if this store has none.
   *
   * A conversation here is a room of exactly two, and **the kernel stores no "is a direct
   * message" flag to look for**: `Room.chat_mode` is stored and never branched on, and
   * `ui/electron/host.js` says so where it declines to ask for it. So "do these two already
   * have a room" is asked of the membership rows, which is the only place that answer exists —
   * a room whose two members are exactly me and them.
   *
   * **The name is taken once, at the moment of making it.** `createRoom` keeps whatever name
   * it is given, so renaming the person afterwards leaves the room under the name it was made
   * with — the same as any other room made from the list. Taking it here is what makes the
   * rail row readable now, which is the whole point of the button.
   *
   * A room that is refused lands beside the list in the kernel's own sentence, because
   * `createRoom()` is the one that refuses and this file re-checks none of it.
   */
  async function messagePerson(person) {
    if (!snap || !snap.me || person.id === snap.me || sending) return
    const already = snap.rooms.find((room) => {
      const ids = (room.members ?? []).map((member) => member.id)
      return ids.length === 2 && ids.includes(snap.me) && ids.includes(person.id)
    })
    if (already) {
      setView('chat')
      enterRoom(already.id)
      return
    }
    setSending(true)
    setError(null)
    try {
      const made = await window.seekHost.createRoom({
        name: person.name,
        members: [snap.me, person.id],
      })
      if (!made.ok) {
        setError({ where: 'contacts', message: made.error })
        return
      }
      setSnap(made.snapshot)
      // Making a conversation and staying in the list is a click that appears to have done
      // nothing, which is the same reason `makeRoom` goes into the room it just made.
      setView('chat')
      enterRoom(made.roomId)
    } finally {
      setSending(false)
    }
  }

  /**
   * Go into a room another view chose.
   *
   * A group is a room, so the way in is the way every room is entered: the chat screen draws
   * it, the rail marks it and the composer writes into it. The view switch is here rather
   * than inside `Groups.jsx` because a file that both draws a list and changes which screen is
   * on would be two things, and because this screen is the only place that knows the chat half
   * is where a room lives.
   */
  function openGroup(roomId) {
    setView('chat')
    enterRoom(roomId)
  }

  /**
   * Go into the thread another view chose.
   *
   * Two moves, in this order, and the order is the whole of it: `enterRoom()` clears the
   * thread, because a thread belongs to a room and leaving one leaves its thread behind. So
   * entering first and opening second is what makes the pair land — the reverse would clear
   * the thread that was just opened and leave the room's own list on screen.
   */
  function openTopic(roomId, rootId) {
    setView('chat')
    enterRoom(roomId)
    setOpenThread(rootId)
  }

  if (!snap) return <div className="booting">{t('ui.chat.opening-store')}</div>

  const whoSaid = Object.fromEntries((active?.members ?? []).map((member) => [member.id, member]))

  /**
   * What a message's toolbar may call, as one object.
   *
   * `Line` stays a drawing component: it is handed these and never reaches into this file's
   * state, which is the same rule the composer follows with `post()`. Two of the four are
   * toggles on a surface rather than writes — pressing the emoji square twice closes the
   * picker — and the other two (`quote`, `forward`) put a message *into* the next thing sent,
   * which is state about the composer rather than about the store.
   */
  const actions = active
    ? {
        lastEmoji,
        pickingId: picking,
        moreOnId: moreOn,
        forwardingId: forwarding?.messageId ?? null,
        // Every room this store holds, because forwarding is *sending it somewhere else* and
        // this window is the only one a person can name that somewhere in.
        rooms: snap.rooms,
        forwardInto,
        pickEmoji: (message) => {
          setMoreOn(null)
          setPicking((current) => (current === message.id ? null : message.id))
        },
        react: reactTo,
        quote: startQuote,
        forward: startForward,
        more: (message) => {
          setPicking(null)
          setMoreOn((current) => (current === message.id ? null : message.id))
        },
        copy: copyMessage,
      }
    : null

  return (
    <div
      className={`app${openThread && view === 'chat' ? ' with-thread' : ''}${
        view === 'settings' ? ' with-settings' : ''
      }`}
    >
      <nav className="rail">
        <div className="rail-avatar" title={snap.me ?? t('ui.chat.me')}>
          {(snap.me ?? 'me').slice(0, 1).toUpperCase()}
        </div>
        {snap.rooms.map((room) => (
          <button
            key={room.id}
            className={`rail-item${view === 'chat' && room.id === activeId ? ' on' : ''}`}
            title={room.name}
            onClick={() => enterRoom(room.id)}
          >
            {room.name.slice(0, 1).toUpperCase()}
          </button>
        ))}
        {/* Everyone in this organization but me, one rail above the way to its endpoint: a
            person is not a conversation, and the list that holds them is where a bot is added
            and where a conversation with one starts. This is the prototype's rail row, and
            the word on it is the prototype's too — 机器人 (`prototype/src/js/app.js`). */}
        <button
          className={`rail-item${view === 'contacts' ? ' on' : ''}`}
          title={t('ui.contacts.title')}
          onClick={() => setView((now) => (now === 'contacts' ? 'chat' : 'contacts'))}
          data-view="contacts"
        >
          🤖
        </button>
        {/* The rooms that are not one conversation between two, beside the people they are
            made of — the prototype's rail order, where 群组 follows 机器人. */}
        <button
          className={`rail-item${view === 'groups' ? ' on' : ''}`}
          title={t('ui.groups.title')}
          onClick={() => setView((now) => (now === 'groups' ? 'chat' : 'groups'))}
          data-view="groups"
        >
          👥
        </button>
        {/* Every thread in this store, whichever room it started in — the prototype's rail
            order after 群组. */}
        <button
          className={`rail-item${view === 'topics' ? ' on' : ''}`}
          title={t('ui.topics.title')}
          onClick={() => setView((now) => (now === 'topics' ? 'chat' : 'topics'))}
          data-view="topics"
        >
          💬
        </button>
        {/* The way to the endpoint, at the end of the column and away from the rooms: what is
            on the other side of it is not a conversation. */}
        <button
          className={`rail-item rail-tail${view === 'settings' ? ' on' : ''}`}
          title={t('ui.settings.title')}
          onClick={() => setView((now) => (now === 'settings' ? 'chat' : 'settings'))}
          data-view="settings"
        >
          ⚙
        </button>
      </nav>

      {view === 'settings' ? (
        <Settings snapshot={snap} />
      ) : view === 'contacts' ? (
        <Contacts
          people={snap.people ?? []}
          me={snap.me}
          firstLaw={snap.firstLaw}
          // A room this view asked for and did not get is the kernel's sentence, drawn beside
          // the list it was asked from.
          refusal={error?.where === 'contacts' ? error.message : null}
          onMessage={messagePerson}
          onSnapshot={setSnap}
        />
      ) : view === 'groups' ? (
        <Groups
          rooms={snap.rooms}
          people={snap.people ?? []}
          me={snap.me}
          onOpen={openGroup}
          // The snapshot a group answers with is the same one every other write arrives as,
          // and it is what makes the new row appear before the screen changes.
          onSnapshot={setSnap}
        />
      ) : view === 'topics' ? (
        <Topics
          rooms={snap.rooms}
          // The way in: into the room the thread is in, with that thread open.
          onOpen={openTopic}
        />
      ) : (
        <>
      <section className="list-col">
        <header className="list-head">
          <h1>{t('ui.chat.title')}</h1>
          {/* `space-between` with three children would centre the count; the tools are one
              group so the heading and the group are the two ends. */}
          <span className="list-tools">
            <span className="count">{snap.rooms.length}</span>
            {/* A store whose only room the seed made is a store where the room list is a
                constant. This is the way out of that, and it is one button. */}
            <button
              className="list-new"
              data-new-room="open"
              title={t('ui.chat.new-room')}
              onClick={startMaking}
            >
              +
            </button>
          </span>
        </header>

        {/* The refusal goes here, beside the form, in the kernel's own words. */}
        {error?.where === 'new-room' && (
          <div className="composer-err" data-new-room="refused">
            {error.message}
          </div>
        )}

        {making && (
          <form
            className="new-room"
            data-new-room="form"
            onSubmit={(event) => {
              event.preventDefault()
              makeRoom()
            }}
          >
            <input
              className="new-room-name"
              placeholder={t('ui.chat.room-name-hint')}
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
            />
            <ul className="new-room-people">
              {(snap.people ?? []).map((person) => (
                <li key={person.id}>
                  <label>
                    <input
                      type="checkbox"
                      data-new-room-member={person.id}
                      checked={picked.includes(person.id)}
                      onChange={() => togglePick(person.id)}
                    />
                    <span className="new-room-who">{person.name}</span>
                    {person.bot && <span className="msg-bot">{t('ui.chat.bot')}</span>}
                  </label>
                </li>
              ))}
            </ul>
            <div className="new-room-actions">
              {/* Not disabled when nobody is ticked: an empty room is a thing the kernel
                  has a sentence for, and a disabled button would replace that sentence
                  with a silence. */}
              <button type="submit" data-new-room="create" disabled={sending}>
                {t('ui.chat.create')}
              </button>
              <button
                type="button"
                data-new-room="cancel"
                onClick={() => {
                  setMaking(false)
                  setError(null)
                }}
              >
                {t('ui.chat.cancel')}
              </button>
            </div>
          </form>
        )}

        <ul className="conv-list">
          {snap.rooms.map((room) => (
            <li key={room.id}>
              <button
                className={`conv${room.id === activeId ? ' on' : ''}`}
                onClick={() => enterRoom(room.id)}
              >
                <span className="conv-av">{room.name.slice(0, 1).toUpperCase()}</span>
                <span className="conv-body">
                  <span className="conv-name">{room.name}</span>
                  <span className="conv-last">
                    {room.messages.length === 0
                      ? t('ui.chat.no-messages')
                      : lastLineOf(room.messages.at(-1))}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="main-col">
        {/* Which half of the bot is real, above the room because it is a fact about the
            app rather than about this conversation. Two strips, because the two halves
            are two servers and either can refuse alone. */}
        <StoreRefused refusal={snap.storeRefusal} />
        {/* A first run fetching its weights is one fact about the process, not one per
            server: `half()` in `ui/electron/main.js` hands both halves the same `pending`
            while the download runs, so drawing each half's strip printed the same sentence
            twice, one line under the other. It is drawn once here, and the two strips come
            back when the download ends. They stay two because a *refusal* is per half —
            only the download is shared. */}
        {snap.stage1?.pending ? (
          <WeightsArriving text={snap.stage1.pending} />
        ) : (
          <>
            <StageOne stage1={snap.stage1} />
            <StageTwo stage2={snap.stage2} />
          </>
        )}
        {active ? (
          <>
            <header className="main-head">
              <h2>{active.name}</h2>
              {/* The count is the way in. The one screen that answers "who is in this room" is
                  also the one that changes it, because a member list that cannot grow is a
                  read-only list — and this store's rooms are made by people. */}
              <button
                className="members"
                data-people="open"
                title={t('ui.chat.members-hint')}
                onClick={() => setPeopleOpen((open) => !open)}
              >
                {t('ui.members', { count: active.members.length })}
              </button>
              {/* What this room has cost, next to who is in it. A number and nothing
                  around it, because the ruling forbids the frame a budget would need. */}
              <Spend spend={active.spend} />
            </header>

            {peopleOpen && (
              <div className="people-panel" data-people="panel">
                {/* The refusal goes beside the list it belongs to, in the kernel's words. */}
                {error?.where === 'add-member' && (
                  <div className="composer-err" data-people="refused">
                    {error.message}
                  </div>
                )}
                <ul className="people-list">
                  {(snap.people ?? []).map((person) => {
                    // `inside` compares two facts the snapshot carries — who this room holds,
                    // and who the store knows. It decides what to draw, never who may join:
                    // the Add button goes to the kernel, which refuses in its own sentence.
                    const inside = active.members.some((member) => member.id === person.id)
                    return (
                      <li key={person.id} className="people-row">
                        <span className="people-name">{person.name}</span>
                        {person.bot && <span className="msg-bot">{t('ui.chat.bot')}</span>}
                        {inside ? (
                          <span className="people-state" data-people-in={person.id}>
                            {t('ui.chat.in-this-room')}
                          </span>
                        ) : (
                          <button
                            className="people-add"
                            data-people-add={person.id}
                            disabled={adding}
                            onClick={() => addToRoom(person.id)}
                          >
                            {t('ui.chat.add')}
                          </button>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </div>
            )}

            <ol className="messages">
              {messages.map((message) => (
                <Line
                  key={message.id}
                  message={message}
                  sender={whoSaid[message.sender]}
                  replies={repliesIn[message.chain] ?? 0}
                  inThread={openThread !== null && message.chain === openThread}
                  onOpen={openThreadOf}
                  me={snap.me}
                  actions={actions}
                  chip
                />
              ))}
              {messages.length === 0 && <li className="empty">{t('ui.chat.nothing-said')}</li>}
              <li ref={messagesEnd} aria-hidden="true" />
            </ol>

            {error?.where === 'room' && <div className="composer-err">{error.message}</div>}
            {/* One line answering an action whose result a snapshot cannot show — a copy that
                reached the clipboard, a forward that landed in another room. Cleared by the
                next thing the person does, so it never outlives the moment it describes. */}
            {note && <div className="composer-note">{note}</div>}
            <QuoteStrip quoting={quoting} whoSaid={whoSaid} onClear={() => setQuoting(null)} />
            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault()
                send(draft, undefined, undefined, roomMention)
              }}
            >
              <Mentions members={active.members} mention={roomMention} />
              <textarea
                className="composer-input"
                rows={1}
                value={draft}
                placeholder={t('ui.chat.message-hint', { room: active.name })}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => keyDown(event, draft, undefined, roomMention)}
              />
              {/* The @ sits beside the picture for the same reason the picture does: it is a
                  choice about the message, made before the words, and it survives an empty box
                  — "hey" typed after naming Echo still addresses Echo. */}
              <button
                className="composer-mention"
                type="button"
                data-mention="open"
                title={t('ui.chat.mention-hint')}
                onClick={roomMention.toggleOpen}
                disabled={sending}
              >
                @
              </button>
              {/* Beside the box rather than inside it: a picture is a separate choice
                  from a caption, and the button works with the box empty — which is the
                  whole point of sending a picture. */}
              <button
                className="composer-attach"
                type="button"
                title={t('ui.chat.attach')}
                onClick={() => attachInto(undefined, roomMention)}
                disabled={sending}
              >
                {t('ui.chat.picture')}
              </button>
              <button className="composer-send" type="submit" disabled={sending || draft.trim() === ''}>
                {t('ui.chat.send')}
              </button>
            </form>
          </>
        ) : (
          <div className="empty">{t('ui.chat.no-room')}</div>
        )}
      </section>

      {openThread && active && (
        <aside className="thread-col">
          <header className="thread-head">
            <h3>{t('ui.chat.thread')}</h3>
            <button className="thread-close" title={t('ui.chat.close-thread')} onClick={() => setOpenThread(null)}>
              ×
            </button>
          </header>

          <ol className="thread-list">
            {thread.map((message) => (
              <Line
                key={message.id}
                message={message}
                sender={whoSaid[message.sender]}
                replies={repliesIn[message.chain] ?? 0}
                inThread={false}
                onOpen={openThreadOf}
                me={snap.me}
                actions={actions}
              />
            ))}
            {thread.length === 0 && <li className="empty">{t('ui.chat.thread-empty')}</li>}
            <li ref={threadEnd} aria-hidden="true" />
          </ol>

          {error?.where === 'thread' && <div className="composer-err">{error.message}</div>}
          <QuoteStrip quoting={quoting} whoSaid={whoSaid} onClear={() => setQuoting(null)} />
          <form
            className="thread-composer"
            onSubmit={(event) => {
              event.preventDefault()
              send(threadDraft, openThread, undefined, threadMention)
            }}
          >
            <Mentions members={active.members} mention={threadMention} />
            <textarea
              className="thread-composer-input"
              rows={1}
              value={threadDraft}
              placeholder={t('ui.chat.reply-hint')}
              onChange={(event) => setThreadDraft(event.target.value)}
              onKeyDown={(event) => keyDown(event, threadDraft, openThread, threadMention)}
            />
            {/* A reply may name somebody too, and needs it more than a room message does: the
                bot that wrote the message being answered is woken by the reply itself
                (`repliesToMe`), but anybody else in the room has to be named to hear it. */}
            <button
              className="thread-mention"
              type="button"
              data-mention="open-thread"
              title={t('ui.chat.reply-mention-hint')}
              onClick={threadMention.toggleOpen}
              disabled={sending}
            >
              @
            </button>
            <button
              className="thread-attach"
              type="button"
              title={t('ui.chat.attach')}
              onClick={() => attachInto(openThread, threadMention)}
              disabled={sending}
            >
              {t('ui.chat.picture')}
            </button>
            <button className="thread-send" type="submit" disabled={sending || threadDraft.trim() === ''}>
              {t('ui.chat.reply')}
            </button>
          </form>
        </aside>
      )}
        </>
      )}
    </div>
  )
}

/**
 * Who one composer's next message addresses.
 *
 * Two of these exist — one per composer — because both boxes are on screen while a thread is
 * open, so one shared list would let a chip picked in one box name somebody in a message sent
 * from the other. The state belongs to the message being typed, which is why `send()` calls
 * `clear()` the moment one goes out: a mention that outlived its message would attach itself
 * to the next one, silently.
 *
 * **The pair is the kernel's own `{id, name}`** (`src/types.ts`, `Mention`), built from the
 * member the snapshot already lists — so no name is invented here and nothing is looked up
 * when the message is drawn.
 */
function useMentions() {
  const [addressed, setAddressed] = useState([])
  const [open, setOpen] = useState(false)

  return {
    addressed,
    open,
    toggleOpen: () => setOpen((was) => !was),
    /**
     * Name somebody, or unname them — one handler for both directions, which is why the × on
     * a chip and the name in the picker cannot disagree about what "addressed" means.
     */
    toggle: (person) =>
      setAddressed((current) =>
        current.some((one) => one.id === person.id)
          ? current.filter((one) => one.id !== person.id)
          : [...current, { id: person.id, name: person.name }],
      ),
    clear: () => {
      setAddressed([])
      setOpen(false)
    },
  }
}

/**
 * The names this message addresses: the chips chosen so far, and the room's who's-who.
 *
 * **Only the room's own members are offered, and that follows from delivery rather than from
 * a rule invented here.** `deliver()` gives an observation to the bots in the room the message
 * was written in (`src/delivery.ts`), so a mention naming anybody outside it would be a blue @
 * that wakes nobody — a name that looks like it did something. The kernel has no refusal about
 * mentions and this file does not invent one: it offers the list the room already states.
 *
 * Both pieces are inside the composer's own form and take a line of it (`flex-basis: 100%`
 * with `flex-wrap`), so the chips sit above the box without a second container, a second
 * border, or a second place for this layout to disagree with the messages above.
 */
/**
 * What the next message will quote.
 *
 * One strip per composer, both drawn from one piece of state, because the reply button on any
 * message — in the room or in the thread panel — puts *that one* message into *whichever box
 * sends next*. Drawn above the box rather than inside it, the way the mention chips are, so
 * the box keeps one border and one shape. A picture with no caption has no words to quote, so
 * the strip says what it is instead of drawing an empty line.
 */
function QuoteStrip({ quoting, whoSaid, onClear }) {
  if (!quoting) return null
  const name = whoSaid?.[quoting.senderId]?.name ?? quoting.senderId
  return (
    <div className="quote-strip" data-quoting={quoting.messageId}>
      <span className="quote-strip-name">{t('ui.chat.replying-to', { name })}</span>
      <span className="quote-strip-text">{quoting.text === '' ? t('ui.chat.said.picture') : quoting.text}</span>
      <button className="quote-strip-x" type="button" title={t('ui.chat.stop-quoting')} onClick={onClear}>
        ×
      </button>
    </div>
  )
}

function Mentions({ members, mention }) {
  return (
    <>
      {mention.addressed.length > 0 && (
        <span className="mention-row" data-mention="picked">
          <span className="mention-lead">{t('ui.chat.addressing')}</span>
          {mention.addressed.map((one) => (
            <span className="mention-chip" data-mention-chip={one.id} key={one.id}>
              @{one.name}
              <button
                className="mention-drop"
                type="button"
                title={t('ui.chat.stop-addressing', { name: one.name })}
                data-mention-drop={one.id}
                onClick={() => mention.toggle(one)}
              >
                ×
              </button>
            </span>
          ))}
        </span>
      )}
      {mention.open && (
        <span className="mention-pick" data-mention="picker">
          {members.map((member) => (
            <button
              key={member.id}
              className={`mention-who${
                mention.addressed.some((one) => one.id === member.id) ? ' on' : ''
              }`}
              type="button"
              data-mention-pick={member.id}
              onClick={() => mention.toggle(member)}
            >
              {member.name}
              {member.bot && <span className="msg-bot">{t('ui.chat.bot')}</span>}
            </button>
          ))}
        </span>
      )}
    </>
  )
}

/**
 * Why the window holds no rooms, when the kernel would not open the store.
 *
 * **Drawn first, because it is the reason for everything under it.** A store this version
 * refuses is not a slow start: nothing will arrive, the room list will stay empty, and no
 * amount of waiting or typing changes it. The kernel wrote a paragraph saying what to do
 * about it — restore a backup, move the file aside — and this strip is the only place a
 * person can read it, because an app started from Finder writes its stderr to `/dev/null`.
 *
 * It reads `storeRefusal` and never `error` on purpose: `error` says "the store is not open
 * yet", which is true for a moment on every single start and is not a failure. Drawing the
 * two as one line would show a broken install as a slow one —
 * one layer down from the two model strips.
 */
function StoreRefused({ refusal }) {
  if (!refusal) return null

  return (
    <div className="store refused" data-store="refused">
      <strong>{t('ui.chat.store-refused')}</strong>
      <span className="store-why">{refusal}</span>
    </div>
  )
}

/**
 * The weights, while they arrive — one line, because there is one download.
 *
 * Both halves are served by the server those weights feed, and `half()` in
 * `ui/electron/main.js` hands them the same `pending` for exactly that reason. So this is
 * not a per-half strip: a strip each printed the same sentence twice, and two identical
 * lines read as two problems rather than as one download. `waiting` takes the base colours
 * on purpose — a first run fetching its weights is the app working, and painting it with
 * `refused` would report it as broken.
 */
function WeightsArriving({ text }) {
  if (!text) return null

  return (
    <div className="weights waiting" data-weights="waiting">
      <strong>{t('ui.chat.weights-arriving')}</strong>
      <span className="weights-why">{text}</span>
    </div>
  )
}

/**
 * What the bot's judgement is, in one standing line.
 *
 * Three readings, and the difference between them is the whole point of drawing it. A
 * fourth — the weights arriving — is not here: the download is one fact for both halves,
 * so it is one line (`WeightsArriving`), drawn above these two.
 *
 * - **no server** — the state a build with no model server ships in. The bot decides with the kernel's
 *   placeholder, and the line names the two variables that would change that, because a
 *   mode nobody can switch is a mode nobody knows they are in.
 * - **bound** — stage 1 is the measured watch model at that origin. The origin is named
 *   because a verdict without the model that gave it is a number that looks like a
 * measurement, and the line also says the *answer* is still
 *   the placeholder: stage 1 is whether to act, stage 2 is what to say
 *   (`src/main.ts`, `STUB_REPLY`), and one line drawn for both would be a lie about one.
 * - **refused** — a server was named and this build did not use it. Drawn in the error
 *   colour with the kernel's own sentence: the app still works, and the one thing it must
 *   not do is keep working in a different mode than the person asked for, silently.
 *
 * A strip rather than a toast: it is a fact about the process, so it stays until the fact
 * changes, and it is never something the person has to catch before it disappears.
 */
function StageOne({ stage1 }) {
  if (!stage1) return null

  if (stage1.refusal) {
    return (
      <div className="stage1 refused" data-stage1="refused">
        <strong>{t('ui.chat.stage1-refused')}</strong>
        <span className="stage1-why">{stage1.refusal}</span>
      </div>
    )
  }

  if (stage1.server) {
    return (
      <div className="stage1 bound" data-stage1="bound">
        <strong>{t('ui.chat.stage1-asks', { origin: stage1.server })}</strong>
        <span className="stage1-why">{t('ui.chat.stage1-asks-why')}</span>
      </div>
    )
  }

  return (
    <div className="stage1" data-stage1="placeholder">
      <strong>{t('ui.chat.stage1-placeholder')}</strong>
      <span className="stage1-why">{t('ui.chat.stage1-placeholder-why')}</span>
    </div>
  )
}

/**
 * Stage 2 — what the bot says, which is a different server from stage 1's.
 *
 * It keeps its own strip rather than sharing one: a store whose watch row is served and
 * whose work row claims another model is a real state, and one strip for both would let
 * the working half hide the refused one. `bound` means a model wrote the words, and
 * `placeholder` means `STUB_REPLY` did — a difference a reader has to be able to see,
 * because a stub line looks exactly like a bot that thought.
 */
function StageTwo({ stage2 }) {
  if (!stage2) return null

  if (stage2.refusal) {
    return (
      <div className="stage2 refused" data-stage2="refused">
        <strong>{t('ui.chat.stage2-refused')}</strong>
        <span className="stage2-why">{stage2.refusal}</span>
      </div>
    )
  }

  if (stage2.server) {
    return (
      <div className="stage2 bound" data-stage2="bound">
        <strong>{t('ui.chat.stage2-asks', { origin: stage2.server })}</strong>
        <span className="stage2-why">{t('ui.chat.stage2-asks-why')}</span>
      </div>
    )
  }

  return (
    <div className="stage2" data-stage2="placeholder">
      <strong>{t('ui.chat.stage2-placeholder')}</strong>
      <span className="stage2-why">{t('ui.chat.stage2-placeholder-why')}</span>
    </div>
  )
}

/**
 * What the bots in this room have spent, as a number and nothing else.
 *
 * `docs/host-rulings.md` — "No spending cap" — shapes this, and it forbids more than it
 * asks for: no budget field, no "quiet because spent" state, no limit a bot stops at. So
 * there is no bar to fill, no percentage of anything, and no remaining figure, because
 * every one of those would draw a limit the product does not have and a reader would
 * believe the drawing. A progress bar toward nothing is a promise in a picture.
 *
 * What the ruling does require is that the spend be **recorded and visible**, and that is
 * what this draws: the turns `turn.ts` wrote down, summed by the snapshot. `0 tokens` is
 * a real reading rather than a hole — the build that ships has no model server, its bot
 * answers through the kernel's placeholder, and a placeholder calls no model, so nothing
 * was spent. The title carries the per-bot split: the first question a cost raises is
 * *who* spent it, and the ruling's answer sends that reader to a persona or a gate, which
 * one total cannot reach.
 */
function Spend({ spend }) {
  if (!spend) return null
  const total = spend.input_tokens + spend.output_tokens
  const perBot = spend.bots
    .map((bot) => `${bot.name}: ${TOKENS.format(bot.input_tokens + bot.output_tokens)}`)
    .join(' · ')
  return (
    <span
      className="spend"
      data-spend={total}
      data-spend-turns={spend.turns}
      data-spend-in={spend.input_tokens}
      data-spend-out={spend.output_tokens}
      title={perBot === '' ? t('ui.chat.no-turn-yet') : perBot}
    >
      {t('ui.chat.spend', { count: total })}
    </span>
  )
}

/**
 * One message, drawn the same way in the room and in the panel.
 *
 * `chip` is the thread's way in: a count when the chain has replies, and an invitation
 * when it has none — because a thread that cannot be started from the message it would
 * belong to is a panel nobody can open.
 */
function Line({ message, sender, replies, inThread, onOpen, chip = false, me = null, actions = null }) {
  const name = sender?.name ?? message.sender
  // A picture is drawn because the kernel's `kind` says so,
  // never because the text looks like one: a message whose kind disowns its bytes is one
  // every reader drops in silence, and guessing from the text is the same drop, later.
  const picture = message.kind === 'image' && message.media ? message.media : null
  // The reactions the store holds, and nothing this file counted: `operators[]` is the fact
  // (`src/types.ts`), so the number drawn beside a glyph is that array's length and "mine"
  // is whether the person this window speaks as is in it. A reaction nobody has reacted with
  // has no entry at all — the kernel deletes a row whose last operator took it back.
  const reactions = message.reactions ?? []
  return (
    <li className={`msg${inThread ? ' on' : ''}`}>
      <span className={`msg-av${sender?.bot ? ' bot' : ''}`}>{name.slice(0, 2)}</span>
      <span className="msg-body">
        <span className="msg-sender">
          {name}
          {sender?.bot && <span className="msg-bot">{t('ui.chat.bot')}</span>}
        </span>
        {/* Where a forward came from. Drawn above the words rather than inside them: the
            kernel keeps `forwarded_from` as its own field (`src/types.ts`), and the words
            below it are the original's — copied, not retyped. */}
        {message.forwardedFrom && (
          <span className="msg-forwarded" data-forwarded-from={message.forwardedFrom.messageId}>
            <ActionGlyph name="forward" />
            <span>{t('ui.chat.forwarded-from', { name: message.forwardedFrom.name })}</span>
          </span>
        )}
        {/* What a reply answered, as the store kept it: the name and the first 160 characters
            of the quoted message, snapshotted when the reply was sent (`QUOTE_CHARS` in
            `src/delivery.ts`). Read from the message and never looked up now, so a reply goes
            on quoting what it answered even after that message is gone. */}
        {message.quoted && (
          <span className="msg-quote" data-quote-of={message.quoted.messageId}>
            <span className="msg-quote-name">{message.quoted.name}</span>
            <span className="msg-quote-text">{message.quoted.text}</span>
          </span>
        )}
        {picture && <Picture media={picture} />}
        {/* Who the message named, drawn from the pairs the message carries and never from the
            roster: `@Echo` said last week keeps the name it was said with, because a message
            is an immutable shared fact (`docs/design/data-model.md`, rule 15). Drawn above the
            words rather than inside them: the kernel stores `text` and `mentions[]` as two
            fields, so threading the names back into the sentence would be a rendering guess
            this file has no business making. */}
        {message.mentions.length > 0 && (
          <span className="msg-mentions">
            {message.mentions.map((one) => (
              <span className="msg-mention" data-mention-of={one.id} key={one.id}>
                @{one.name}
              </span>
            ))}
          </span>
        )}
        {message.text !== '' && <span className="msg-text">{message.text}</span>}
        {reactions.length > 0 && (
          <span className="msg-reactions">
            {reactions.map((reaction) => {
              const mine = me !== null && reaction.operators.includes(me)
              const count = reaction.operators.length
              return (
                <button
                  key={reaction.emojiType}
                  className={`reaction${mine ? ' mine' : ''}`}
                  data-react={reaction.emojiType}
                  title={t('ui.reactions', { count })}
                  onClick={() => actions?.react(message, reaction.emojiType)}
                >
                  <span className="reaction-glyph">{emojiGlyph(reaction.emojiType)}</span>
                  <span className="reaction-count">{count}</span>
                </button>
              )
            })}
          </span>
        )}
        {chip && (
          <button className="msg-thread" data-thread-for={message.id} onClick={() => onOpen(message)}>
            {replies > 0 ? t('ui.replies', { count: replies }) : t('ui.reply-in-thread')}
          </button>
        )}
        {/* The hover toolbar: one white square for the emoji, then one white pill holding four
            icons 24px apart. It is a child of `msg-body` rather than of the row, so `left:100%`
            puts it against the right edge of *this message's words* — a short message gets it
            right behind the text instead of at the far end of the column (`shell.css`,
            `.msg-actions`). Every button is a real write or a real surface: an emoji toggles a
            reaction, reply quotes, forward carries, the topic glyph opens the thread the store
            already records, and *more* offers the one platform action this build has. Nothing
            here is drawn for a behaviour that does not exist. */}
        {actions && (
          <span className="msg-actions">
            <button
              className="act-emoji"
              data-react-pick={message.id}
              title={t('ui.chat.react-hint')}
              onClick={() => actions.pickEmoji(message)}
            >
              <span>{emojiGlyph(actions.lastEmoji)}</span>
            </button>
            <span className="act-seg">
              <button data-quote-msg={message.id} title={t('ui.chat.quote-hint')} onClick={() => actions.quote(message)}>
                <ActionGlyph name="reply" />
              </button>
              <button data-forward-msg={message.id} title={t('ui.chat.forward-hint')} onClick={() => actions.forward(message)}>
                <ActionGlyph name="forward" />
              </button>
              <button data-open-topic={message.id} title={t('ui.chat.open-thread-hint')} onClick={() => onOpen(message)}>
                <ActionGlyph name="topic" />
              </button>
              <button data-msg-more={message.id} title={t('ui.chat.more')} onClick={() => actions.more(message)}>
                <ActionGlyph name="more" />
              </button>
            </span>
          </span>
        )}
        {/* The emoji picker, in place under the square rather than as a modal: the six the
            toolbar offers, with the ones this person already reacted with highlighted. The
            `mine` flag is the same array read twice — `operators[]` is the whole fact
            (`src/types.ts`), so a picker and a reaction row cannot disagree. */}
        {actions && actions.pickingId === message.id && (
          <span className="react-pop">
            {EMOJI.map((one) => {
              const mine =
                me !== null &&
                reactions.some((r) => r.emojiType === one.type && r.operators.includes(me))
              return (
                <button
                  key={one.type}
                  className={`react-pick${mine ? ' mine' : ''}`}
                  data-react-now={one.type}
                  title={one.type}
                  onClick={() => actions.react(message, one.type)}
                >
                  {one.glyph}
                </button>
              )
            })}
          </span>
        )}
        {/* Forward: which room it goes to. The list is the store's own room list — a forward
            names the room the original is in and the room it lands in, and both are facts the
            snapshot already carries, so no name is invented here. */}
        {actions && actions.forwardingId === message.id && (
          <span className="forward-pop">
            <span className="forward-lead">{t('ui.chat.forward-lead')}</span>
            {actions.rooms.map((room) => (
              <button
                key={room.id}
                data-forward-into={room.id}
                title={t('ui.chat.forward-into', { room: room.name })}
                onClick={() => actions.forwardInto(room.id)}
              >
                {room.name}
              </button>
            ))}
          </span>
        )}
        {/* The *more* menu. One item, because one platform action is what this build has:
            copying the words. A menu drawn with entries nothing answers would be the same
            lie as a toolbar button that does nothing. */}
        {actions && actions.moreOnId === message.id && (
          <span className="more-menu">
            <button data-copy-msg={message.id} onClick={() => actions.copy(message)}>
              {t('ui.chat.copy')}
            </button>
          </span>
        )}
      </span>
    </li>
  )
}

/**
 * What a conversation's second line says about its newest message.
 *
 * A picture with a caption says the caption; a picture without one says that it is a
 * picture. The alternative — drawing `text` — is an empty second line, which reads as a
 * room somebody spoke in and said nothing, while the thing they sent is one click away.
 */
function lastLineOf(message) {
  if (typeof message?.text === 'string' && message.text !== '') return message.text
  if (message?.kind === 'image') return t('ui.chat.said.picture')
  return t('ui.chat.said.nothing')
}

/**
 * One picture message's bytes, drawn.
 *
 * The snapshot carries a *reference* — `{key, mime}`, the kernel's own pair — and never
 * the bytes, so the window asks for them once per message as it draws. Three readings, and
 * the third is why this is a component rather than an `<img src>` with a guess in it:
 *
 * - **shown** — the bytes are beside the store and are drawn.
 * - **opening** — the read is in flight. Nothing is claimed yet.
 * - **missing** — the bytes are not there, and the kernel's sentence says so. A message
 *   that names a picture it cannot show is still a message; drawing a broken frame would
 *   make it look like a rendering accident instead of a file that is gone
 *   (`media.js`, on a store moved without its `media/` directory).
 */
function Picture({ media }) {
  const [src, setSrc] = useState(null)
  const [missing, setMissing] = useState(null)

  useEffect(() => {
    let live = true
    setSrc(null)
    setMissing(null)
    window.seekHost.media(media).then((read) => {
      if (!live) return
      if (read.ok) setSrc(read.dataUrl)
      else setMissing(read.error)
    })
    // The reference's two strings are the dependency, not the object: a snapshot is a new
    // object every time the store changes, and re-reading every picture on every message
    // would be one disk read per picture per keystroke elsewhere in the room.
    return () => {
      live = false
    }
  }, [media.key, media.mime])

  if (missing) {
    return (
      <span className="msg-pic-missing" data-picture="missing">
        {missing}
      </span>
    )
  }
  if (!src) {
    return (
      <span className="msg-pic-opening" data-picture="opening">{t('ui.chat.opening-picture')}</span>
    )
  }
  return <img className="msg-pic" data-picture="shown" src={src} alt={media.key} />
}
