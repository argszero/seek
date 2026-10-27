import { useEffect, useRef, useState } from 'react'

import Contacts from './Contacts.jsx'
import Dialog from './Dialog.jsx'
import Gutter from './Gutter.jsx'
import Groups from './Groups.jsx'
import Icon from './icons.jsx'
import Settings from './Settings.jsx'
import Topics from './Topics.jsx'
import { fileSize, size, t, weightsSentence, when, whenShort } from './catalogue.mjs'
import {
  ADD_MENU,
  ADD_TITLE,
  NAV_ICON,
  RAIL,
  RAIL_TAIL,
  TAIL_ICON,
  THEME_TO_DARK,
  THEME_TO_LIGHT,
} from './rail.mjs'
import { peopleInRoom } from './people-in-room.mjs'
import { roomToOpen } from './room-to-open.mjs'
/**
 * Tokens are counts, so they are drawn by `Intl.NumberFormat` rather than by string
 * arithmetic: `1204` and `1,204` are the same figure and only one of them reads as one.
 * Constructed once, because a formatter built per render is a locale lookup per message.
 */
const TOKENS = new Intl.NumberFormat()

/**
 * The composer's marks, at the client's size.
 *
 * Measured off Feishu's own composer on 2026-10-27: every mark in the field's right-hand row is
 * an **18px glyph inside a 26×26 hit area**, 4px apart, drawn in `--N600`. It is a constant
 * rather than a literal per button because the three must agree — a send arrow at 20 beside two
 * at 18 looks like the one that matters and is instead the one drawn wrong.
 */
const COMPOSER_ICON = 18

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
 * The emoji a person may put *into their words*, which is a different list from the six above.
 *
 * The two are not the same kind of fact and the kernel says so (`src/types.ts`): a reaction
 * is an `emoji_type`, a *name* the open platform defined (`THUMBSUP`), because a reaction row
 * is a count over names; an emoji typed into a sentence is part of the text and is whatever
 * character the person chose. So this list is the prototype's own
 * (`prototype/src/js/app.js`, five rows of eight) and nothing here reaches the store as
 * anything but the words of a message.
 */
const DRAFT_EMOJI = [
  '😀', '😄', '😁', '😆', '😅', '😂', '🙂', '😉',
  '😊', '😍', '😘', '😜', '🤪', '🤔', '🤨', '😐',
  '😴', '😭', '😤', '😡', '👍', '👎', '👌', '✌️',
  '🙏', '👏', '💪', '👀', '🎉', '🎊', '❤️', '💔',
  '🔥', '✨', '⭐', '✅', '❌', '⚠️', '💡', '📌',
]

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
 * The emoji a composer's smiley offers, in place above the marks rather than as a card.
 *
 * A picker that opened a modal would be a second window for a keystroke-sized choice, and the
 * client does not do that either: the grid belongs to the field it writes into. It stays open
 * across several picks — choosing three in a row is one thought — and closes when the mark is
 * pressed again, which is why the mark carries `aria-expanded`.
 *
 * The glyphs are text, so the button is the character and nothing else: no key, no name, no
 * lookup. See `DRAFT_EMOJI` for why this is not the reaction table.
 */
function EmojiPop({ onPick }) {
  return (
    <span className="emoji-pop" data-emoji="picked">
      {DRAFT_EMOJI.map((glyph) => (
        <button
          key={glyph}
          type="button"
          className="emoji-pick"
          data-emoji-now={glyph}
          onClick={() => onPick(glyph)}
        >
          {glyph}
        </button>
      ))}
    </span>
  )
}

/**
 * One attachment, drawn as a row a person can open.
 *
 * **Four facts, three of them on screen.** The name says *which* file — the key is opaque by
 * design, so it is the only thing that can. The size says how big without opening it. The mime
 * is not drawn: it is what the main process needs to hand the bytes to the right application,
 * and a person reading a row that says `application/vnd.openxmlformats-…` has been told
 * something they did not ask. The fourth is the key, and it is on the row as a hook rather than
 * as words.
 *
 * **The states are the ones `Picture` has, minus the drawing.** `ready` is the file sitting
 * beside the store; `opening` is the copy in flight; a refusal is the main process's sentence —
 * which is what a store moved without its `media/` directory answers, and what a machine with
 * no application for the type answers. Nothing here decides any of those; it shows them.
 */
function FileRow({ file }) {
  const [state, setState] = useState('ready')
  const [refusal, setRefusal] = useState(null)

  async function open() {
    if (state === 'opening') return
    setState('opening')
    const result = await window.seekHost.openFile(file)
    // A file that opened draws nothing further: the application is on screen and this row is
    // not the place to report it. A file that did not open says why, in the words it was told.
    if (result.ok) {
      setState('opened')
    } else {
      setRefusal(result.error)
      setState('refused')
    }
  }

  return (
    <span className="msg-file" data-file={state}>
      <button
        className="msg-file-open"
        type="button"
        data-file-open={file.key}
        title={t('ui.chat.file-open')}
        onClick={open}
      >
        <span className="msg-file-mark">
          <Icon name="file" size={20} />
        </span>
        <span className="msg-file-name">{file.name}</span>
        <span className="msg-file-size">{fileSize(file.size)}</span>
      </button>
      {state === 'opening' && <span className="msg-file-state">{t('ui.chat.file-opening')}</span>}
      {state === 'refused' && (
        <span className="msg-file-state" data-file-refused={file.key}>
          {refusal}
        </span>
      )}
    </span>
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
 * **Which of those two it is looking at is not drawn.** It used to be, in a strip per half,
 * and a person was shown an origin, a variable name and the words `stage 1` over a bot that
 * was simply working — `docs/host-rulings.md`, "The window does not speak to a developer".
 * A half that fell back or was refused says so on stderr (`ui/electron/main.js`), which is
 * where the one reader who can change it is already looking, and the window stays silent.
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
  // The theme is the document's, not this component's: `main.jsx` sets `data-theme` before the
  // first frame out of what the last launch saved, so this state starts at that answer rather
  // than at a default that would paint the window light and then repaint it.
  const [theme, setTheme] = useState(() =>
    document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light',
  )
  const dark = theme === 'dark'

  // The add mark over the navigation and the menu it opens; `ask` is the view the menu has just
  // been told to open a form on, and it is cleared by that view as it takes it — one press, one
  // form, and no form reopening by itself when somebody comes back to the view later.
  const [addOpen, setAddOpen] = useState(false)
  const [ask, setAsk] = useState(null)
  const clearAsk = () => setAsk(null)

  /**
   * The organization being made, over whatever is on screen.
   *
   * `null` when there is nothing to make; an object once the form is open, carrying either the
   * refusal the main process gave or the line that says the world now exists. It is not a view:
   * the host's ruling on 2026-10-27 is that making an organization must not take the window
   * anywhere (创建组织，不要跳转到 settings … 在当前窗口实现就行), which is why this is a form over
   * the current view rather than a field at the foot of the settings page.
   */
  const [orgForm, setOrgForm] = useState(null)
  const [orgName, setOrgName] = useState('')
  const [orgBusy, setOrgBusy] = useState(false)

  // A menu nobody can dismiss is a trap, so the two ways out are wired while it is open: a
  // press anywhere outside it, and Escape. Both listeners live on `window` because the press
  // that dismisses the menu is, by definition, on something that is not inside it.
  useEffect(() => {
    if (!addOpen) return undefined
    const away = (event) => {
      if (!event.target.closest?.('.rail-add, .rail-menu')) setAddOpen(false)
    }
    const key = (event) => {
      if (event.key === 'Escape') setAddOpen(false)
    }
    window.addEventListener('pointerdown', away)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('pointerdown', away)
      window.removeEventListener('keydown', key)
    }
  }, [addOpen])

  /**
   * The rail's theme button, and what it changes.
   *
   * `tokens.css` already carries both palettes behind `[data-theme='light']` and
   * `[data-theme='dark']`; the attribute on `<html>` is the whole switch, which is how the
   * prototype does it (`app.js`: `document.documentElement.setAttribute('data-theme', …)`).
   * The write is saved so the next launch opens in the same one.
   *
   * **A save that fails is not drawn.** The toggle has already changed what the person is
   * looking at, and a strip reporting a settings write over a window that is behaving would be
   * noise about the wrong thing; the main process logs it. What a person can see stays the
   * truth of what the window is doing.
   */
  function flipTheme() {
    const next = dark ? 'light' : 'dark'
    setTheme(next)
    document.documentElement.setAttribute('data-theme', next)
    window.seekHost.saveTheme?.(next)
  }

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
  /**
   * The room's own panel, and the form that edits it.
   *
   * **A third thing in the side column, beside the thread.** The column already held one panel
   * (`openThread`), and the prototype puts 会话信息 there too (`renderSide()`, `kind: 'info'`);
   * `infoOpen` is a second reading of the same column rather than a fourth column, because a
   * window with both open would be two answers to one question. When both are true the panel
   * wins — a person who just pressed 资料 is asking about the room, not about a thread.
   *
   * The four fields are the edit form's own state, exactly as a bot's four are `Contacts.jsx`'s:
   * nothing else on this screen draws what is half-typed, and a form cancelled at any point must
   * not be the next one's starting text.
   */
  const [infoOpen, setInfoOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editAnnouncement, setEditAnnouncement] = useState('')
  const [editTag, setEditTag] = useState('')
  const [savingRoom, setSavingRoom] = useState(false)
  // What a write to this room answered with when it was not the snapshot: a refusal, and the one
  // note a leave makes. Kept apart from `error` because the places they are drawn are different
  // — this one is inside the panel it is about.
  const [roomError, setRoomError] = useState(null)
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
  /**
   * **The one confirmation every deletion goes through.**
   *
   * `{kind, id}` while a card is asking, `null` otherwise: `message` and `thread` are a message
   * id (a thread is named by its root), `room` is a room id. One piece of state rather than
   * three, because the card is one card and the question is the same question — what is about
   * to go — asked about three sizes of thing.
   */
  const [asking, setAsking] = useState(null)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState(null)
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
  // Which composer's emoji picker is open, if either. Two instances on screen at once while a
  // thread is open, so this is `'room'`, `'thread'` or `null` rather than a flag — the same
  // reason the two mention sets are two.
  const [emojiOn, setEmojiOn] = useState(null)
  // Where the caret was when an emoji was pressed. A press is a click away from the field, so
  // the caret is read before the click and put back after React has written the new value —
  // `useEffect` below, which is the only place a selection survives a re-render.
  const roomInput = useRef(null)
  const threadInput = useRef(null)
  const pendingCaret = useRef(null)
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

  // Who the room's people panel lists: its own members, then whoever else the store offers to
  // be put in it (`people-in-room.mjs` — the two are different lists, and a member the store
  // no longer offers still needs a row to be taken out by).
  const roomPeople = peopleInRoom(active, snap?.people ?? [])

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

  /**
   * Put the caret back where the emoji went in.
   *
   * A `textarea`'s value is React's, so writing an emoji into it re-renders the field and the
   * browser puts the caret at the end — which is right only for somebody who was typing at the
   * end. `insertEmoji()` therefore records the position it wrote at, and this effect (no
   * dependency list, so it runs after every render) restores it and clears the record. It runs
   * with nothing pending on almost every render and costs one comparison.
   */
  useEffect(() => {
    const pending = pendingCaret.current
    if (pending === null) return
    pendingCaret.current = null
    if (!pending.field) return
    pending.field.focus()
    pending.field.setSelectionRange(pending.at, pending.at)
  })

  async function send(text, rootId, media, mention, file) {
    const body = typeof text === 'string' ? text.trim() : ''
    // A picture may go with no words at all — the caption is optional (`media` names the
    // bytes, and `deliver()` accepts an image with an empty text); a text message may not.
    // An attachment is the same case for the same reason: a file with no caption is still a
    // file somebody sent, which is the whole of what the row then says.
    if (!active || sending || (body === '' && !media && !file)) return
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
        // An attachment is the third kind, and it carries four facts rather than two because a
        // reader needs them: the name to say which file, the size to say how big without
        // opening it, the mime to choose an application. `fileFor()` (`src/delivery.ts`) owns
        // both halves of the invariant; this line only hands the facts over.
        ...(file
          ? {
              kind: 'file',
              file: { key: file.key, name: file.name, size: file.size, mime: file.mime },
            }
          : {}),
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

  /**
   * Choose a file of any kind and send it, with whatever is in the box as its caption.
   *
   * The sibling of `attachInto` and deliberately not the same call: a picture is one of four
   * types the window can draw and the judgement can read (`seek:attach`), while an attachment
   * is anything the person's machine can open (`seek:attach-file`). Both write the bytes
   * before answering, so the message that names them cannot point at nothing.
   */
  async function attachFileInto(rootId, mention) {
    if (!active || sending) return
    setSending(true)
    setError(null)
    try {
      const picked = await window.seekHost.attachFile()
      if (!picked.ok) {
        if (!picked.cancelled) setError({ where: rootId ? 'thread' : 'room', message: picked.error })
        return
      }
      await send(rootId ? threadDraft : draft, rootId, undefined, mention, picked.file)
    } finally {
      setSending(false)
    }
  }

  /**
   * Put one emoji into the words being written, where the caret is.
   *
   * **Into the text, never into the store as a reaction.** The two look alike on screen and are
   * different facts: a reaction is `emoji_type`, a name the kernel counts operators under
   * (`toggleReaction()` in `src/delivery.ts`), and this is a character in a sentence that
   * happens to be an emoji. Which is why this function has no call to `seekHost` in it.
   */
  function insertEmoji(where, glyph) {
    const current = where === 'room' ? draft : threadDraft
    const field = where === 'room' ? roomInput.current : threadInput.current
    // The caret, and the selection it may be the start of: typing over a selection replaces
    // it, which is what every field on this machine does.
    const at = field && typeof field.selectionStart === 'number' ? field.selectionStart : current.length
    const end = field && typeof field.selectionEnd === 'number' ? field.selectionEnd : at
    const next = current.slice(0, at) + glyph + current.slice(Math.max(at, end))
    if (where === 'room') setDraft(next)
    else setThreadDraft(next)
    pendingCaret.current = { field, at: at + glyph.length }
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
  /**
   * One row of the add menu: go where the thing is made, and open the form that makes it.
   *
   * Both halves, or the menu is a redirect: a row that only switched view would leave the
   * person pressing that view's own `+` for something they had already asked for.
   */
  function addTo(next) {
    setView(next)
    setAsk(next)
    setAddOpen(false)
  }

  /**
   * One row of the add menu, whichever kind it is.
   *
   * A row that names a view goes there and asks that view for the form; the organization's row
   * names no view, so it opens the form here. Splitting the two at the row rather than inside
   * `addTo` keeps `addTo`'s promise — every row that calls it really does end up in a view with
   * a form open — and keeps this file from special-casing one menu row by its destination.
   */
  function addRow(item) {
    setAddOpen(false)
    if (item.view) return addTo(item.view)
    setOrgName('')
    setOrgForm({})
  }

  /**
   * Make the organization, and leave the window where it was.
   *
   * The new world is not opened: the host's rule for an organization that has just been made is
   * that it is made, not entered (宿主：made — open it when you want to work in it), so the answer
   * is a line saying so. Switching is on the settings page, where the list of worlds is.
   */
  async function createOrg() {
    if (orgBusy) return
    setOrgBusy(true)
    const answer = await window.seekHost.createOrganization(orgName)
    setOrgBusy(false)
    if (!answer.ok) return setOrgForm({ error: answer.error })
    setOrgName('')
    setOrgForm({ note: t('ui.settings.organizations.made') })
  }

  function startMaking() {
    setNewName('')
    setPicked((snap?.people ?? []).map((person) => person.id))
    setMaking(true)
    setError(null)
  }

  // The rail's add mark asks this view for its form, and the ask is cleared as it is taken: one
  // press, one dialog. Same mechanism as `Contacts.jsx` and `Groups.jsx`, because the three
  // forms are now one shape opened from one place.
  useEffect(() => {
    if (ask !== 'chat') return
    startMaking()
    clearAsk()
  }, [ask])

  /**
   * Forget the room form's refusal, and only that one.
   *
   * `error` on this screen is every refusal the chat view shows — the room form's, the
   * composer's, the thread's, the member panel's — so a blanket `setError(null)` on typing a
   * room's name would also wipe a sentence about something else. This one clears the room
   * form's own and leaves the rest alone.
   */
  function forgetNewRoom() {
    setError((was) => (was?.where === 'new-room' ? null : was))
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
   * Take one person out of the room on show.
   *
   * `addToRoom`'s twin, and the same envelope: the kernel's `removeMember()` decides — it refuses
   * a principal who is not in the room and refuses the last member, in sentences this window
   * draws unchanged. Its refusal goes where its sibling's does, beside the people list it is
   * about, because that is the list the row was in.
   */
  async function removeFromRoom(principalId) {
    if (!active || adding) return
    setAdding(true)
    setError(null)
    try {
      const outcome = await window.seekHost.removeMember({ roomId: active.id, principalId })
      if (outcome.ok) setSnap(outcome.snapshot)
      else setError({ where: 'add-member', message: outcome.error })
    } finally {
      setAdding(false)
    }
  }

  /**
   * Leave the room on show — the same write, with the person this window speaks as.
   *
   * **The room does not disappear, and that is the store being honest.** A room list here is
   * every room the organization holds, not the rooms one person is in; leaving therefore takes
   * this person out of the room's members and leaves the room where it was. What changes is the
   * composer: `deliver()` refuses a sender who is not a member, in its own sentence, which is
   * the sentence a person sees when they try to speak in a room they have left — instead of a
   * room that silently swallows what they type.
   */
  async function leaveRoom() {
    if (!active || adding) return
    const me = snap.me
    if (!me) return
    setAdding(true)
    setRoomError(null)
    try {
      const outcome = await window.seekHost.removeMember({ roomId: active.id, principalId: me })
      if (outcome.ok) {
        setSnap(outcome.snapshot)
        setInfoOpen(false)
      } else setRoomError(outcome.error)
    } finally {
      setAdding(false)
    }
  }

  /**
   * Take away what the card is asking about.
   *
   * **One function for three calls, because the three answers arrive in the same envelope** —
   * a snapshot, or the kernel's own sentence. What differs is what the window does with the
   * snapshot afterwards: a deleted room leaves the list on its own (its memberships went with
   * it, and that list is the rooms this person is in), so the panel showing it closes; and a
   * deleted thread whose panel is open closes the panel, because the panel's way in is a root
   * whose replies are now tombstones.
   */
  async function confirmRemove() {
    if (!asking || removing) return
    setRemoving(true)
    setRemoveError(null)
    try {
      const outcome =
        asking.kind === 'message'
          ? await window.seekHost.deleteMessage({ messageId: asking.id })
          : asking.kind === 'thread'
            ? await window.seekHost.deleteThread({ rootId: asking.id })
            : await window.seekHost.deleteRoom({ roomId: asking.id })
      if (outcome.ok) {
        setSnap(outcome.snapshot)
        setAsking(null)
        if (asking.kind === 'room') setInfoOpen(false)
        if (asking.kind === 'thread' && openThread === asking.id) setOpenThread(null)
      } else setRemoveError(outcome.error)
    } finally {
      setRemoving(false)
    }
  }

  /**
   * Open the edit form, filled with what the room says now.
   *
   * **Read off the room, not off a copy.** The four boxes start as the four stored texts, and an
   * absent one starts empty — a room nobody has written about is a room whose box is blank, not
   * one whose box says "null".
   */
  function openEdit() {
    if (!active) return
    setRoomError(null)
    setEditName(active.name)
    setEditDescription(active.description ?? '')
    setEditAnnouncement(active.announcement ?? '')
    setEditTag(active.tag ?? '')
    setEditing(true)
  }

  /**
   * Save the four texts, once.
   *
   * **All four always travel**, and an emptied box travels as `''` rather than as nothing: that
   * is the difference `updateRoom()` draws between "nobody touched this field" and "a person
   * cleared it", and a form that only sent what changed could not express the second. The name is
   * the one the kernel refuses when it is blank, in its own sentence — nothing is checked here
   * that the kernel already answers.
   */
  async function saveRoom() {
    if (!active || savingRoom) return
    setSavingRoom(true)
    setRoomError(null)
    try {
      const outcome = await window.seekHost.updateRoom({
        roomId: active.id,
        name: editName,
        description: editDescription,
        announcement: editAnnouncement,
        tag: editTag,
      })
      if (outcome.ok) {
        setSnap(outcome.snapshot)
        setEditing(false)
      } else setRoomError(outcome.error)
    } finally {
      setSavingRoom(false)
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

  /**
   * Who wrote a line, looked up in everyone the store has ever named and then in this room.
   *
   * **A message does not stop having an author when the author leaves.** Built from the room's
   * members alone, a line whose sender had been taken out of the room — or out of the
   * organization — fell back to the raw id and read `ou_447c1cba8e4d4bee` (measured
   * 2026-10-27, after a bot that had spoken was taken out). `snap.named` is the store's own
   * answer to "who is this", stamped bots included; membership is layered over it because a
   * member's row is the one that carries what this room knows about them.
   */
  const whoSaid = { ...(snap.named ?? {}), ...Object.fromEntries((active?.members ?? []).map((member) => [member.id, member])) }

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
        remove: (message) => {
          setMoreOn(null)
          setAsking({ kind: 'message', id: message.id })
        },
      }
    : null

  /**
   * Whether this view has a column beside the room for a side panel, and therefore whether the
   * window is laid out for one.
   *
   * **The side column belongs to the panel, not to the view it happens to be open on.** The
   * class that declares those two extra tracks used to be keyed to `view === 'chat'`, and the
   * panel itself is drawn wherever the window is reading a room — so on the four other views
   * `.app` declared five tracks and the panel was its seventh child: it wrapped onto a second
   * implicit row, measured 6px wide, and its contents painted from y 780 to y 1030 in a window
   * 780 tall (measured 2026-10-27, 1180×780: chat 380px, Bots and Groups and Topics 6px).
   *
   * Settings is the one view that is not reading a room: it is a page of its own beside the
   * rail, and a room's panel next to it would be a column about something that page is not
   * about. So it is named here, once, and both panels and the class read this.
   */
  const sideOpen = view !== 'settings' && Boolean(active) && (openThread !== null || infoOpen)

  return (
    <div
      className={`app${sideOpen ? ' with-thread' : ''}${
        view === 'settings' ? ' with-settings' : ''
      }`}
    >
      {/* The prototype's column, in the prototype's order (`renderRail()`,
          `prototype/src/js/app.js`): the avatar as *who this is*, four navigation rows, a
          spacer, then the theme toggle and settings at the foot.

          **Rooms are not here.** They were, one initial per room, and that was not the
          prototype: its rail is fixed navigation, and the rooms live in the conversation list
          column beside it (`chatRow()`). A column of rooms where the spec has five fixed rows
          is a different window, and it left no way to reach *messages* at all.
          The host named this column on 2026-10-27: 左侧头像／消息／机器人／话题导航、图标、
          位置 — all of it from the prototype. */}
      <nav className="rail">
        {/* The top of the column: who this is, and the mark that makes things.
            The avatar is **not** a button — the prototype says so in as many words (`app.js`:
            左上角头像只是个「这是谁」，不是按钮), and changing organization is on the settings
            page. The dot is its green presence mark, decoration rather than a fact this store
            keeps.

            The ring at the other end is measured off the client (2026-10-27): 24×24, rounded
            6, a 16px glyph, 12px in from the column's right edge, and centred on the avatar's
            own line. Its menu hangs off the ring's top edge and to the right, which is where
            the client puts it — the panel starts 6px short of the column's edge and covers the
            list beside it rather than fitting inside 156px. */}
        <div className="rail-top">
          <div className="rail-avatar" title={snap.me ?? t('ui.chat.me')}>
            <span className="rail-avatar-face">{(snap.me ?? '?').slice(0, 1).toUpperCase()}</span>
            <span className="presence" />
          </div>
          <button
            className={`rail-add${addOpen ? ' open' : ''}`}
            title={t(ADD_TITLE)}
            aria-haspopup="menu"
            aria-expanded={addOpen}
            onClick={() => setAddOpen(!addOpen)}
            data-role="add"
          >
            <Icon name="add" size={16} />
          </button>
          {/* The three rows are `ADD_MENU`: the client's menu cut down to what this product can
              make. A thing we cannot make is not a row. */}
          {addOpen && (
            <ul className="rail-menu" role="menu" data-menu="add">
              {ADD_MENU.map((item) => (
                <li key={item.view ?? item.makes}>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => addRow(item)}
                    data-add={item.view ?? item.makes}
                  >
                    <Icon name={item.icon} size={16} />
                    <span>{t(item.label)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {RAIL.map((item) => (
          <button
            key={item.view}
            className={`rail-btn${view === item.view ? ' active' : ''}`}
            title={t(item.label)}
            onClick={() => setView(item.view)}
            data-view={item.view}
          >
            <Icon name={item.icon} size={NAV_ICON} />
            <span className="rail-label">{t(item.label)}</span>
          </button>
        ))}
        <div className="rail-spacer" />
        <button
          className="rail-btn"
          title={t(dark ? THEME_TO_LIGHT : THEME_TO_DARK)}
          onClick={flipTheme}
          data-role="toggle-theme"
        >
          <Icon name={dark ? 'sun' : 'moon'} size={TAIL_ICON} />
          {/* The toggle wears a word like every row above it: an icon-only tile in a column
              of labelled rows reads as a different kind of control, and this one acts on
              the window rather than on the view. The word names the action — `切换到深色`
              while the window is light — which is what its title already said. */}
          <span className="rail-label">{t(dark ? THEME_TO_LIGHT : THEME_TO_DARK)}</span>
        </button>
        <button
          className={`rail-btn${view === RAIL_TAIL.view ? ' active' : ''}`}
          title={t(RAIL_TAIL.label)}
          onClick={() => setView(RAIL_TAIL.view)}
          data-view={RAIL_TAIL.view}
        >
          <Icon name={RAIL_TAIL.icon} size={TAIL_ICON} />
          <span className="rail-label">{t(RAIL_TAIL.label)}</span>
        </button>
      </nav>

      {/* The rail's own seam, drawn once for every view: the rail is the one column present in
          all of them, and a seam per view would be four copies of the same edge. */}
      <Gutter pane="rail" />

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
          ask={ask === 'contacts'}
          onAsked={clearAsk}
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
          ask={ask === 'groups'}
          onAsked={clearAsk}
        />
      ) : view === 'topics' ? (
        <Topics
          rooms={snap.rooms}
          // The way in: into the room the thread is in, with that thread open.
          onOpen={openTopic}
          // And the way out: a thread is deleted whole, from its root, through the same
          // confirmation card every other deletion uses.
          onDelete={(roomId, rootId) => setAsking({ kind: 'thread', id: rootId, roomId })}
        />
      ) : (
        <>
      <section className="list-col">
        {/* **No count, no `+`** (宿主, 2026-10-27: 这里的加号和数字不需要了). The count repeated a
            number the list already shows by being as long as it is, and making a room moved to
            the rail's add mark with the other three things this product can make. */}
        <header className="list-head">
          <h1>{t('ui.chat.title')}</h1>
        </header>

        {making && (
          <Dialog
            name="room"
            title={t('ui.rail.add-room')}
            submit={t('ui.chat.create')}
            cancel={t('ui.chat.cancel')}
            busy={sending}
            onSubmit={makeRoom}
            onClose={() => {
              setMaking(false)
              setError(null)
              setNewName('')
            }}
          >
            <div className="dialog-fields">
              <div className="dialog-field">
                <label className="field-label" htmlFor="room-name">
                  {t('ui.chat.room-name')}
                </label>
                <input
                  id="room-name"
                  className="dialog-input"
                  data-new-room="name"
                  autoFocus
                  placeholder={t('ui.chat.room-name-hint')}
                  value={newName}
                  onChange={(event) => {
                    forgetNewRoom()
                    setNewName(event.target.value)
                  }}
                />
              </div>

              <div className="dialog-field">
                <span className="field-label">{t('ui.chat.room-members')}</span>
                <ul className="dialog-people">
                  {(snap.people ?? []).map((person) => (
                    <li key={person.id}>
                      <label>
                        <input
                          type="checkbox"
                          data-new-room-member={person.id}
                          checked={picked.includes(person.id)}
                          onChange={() => {
                    forgetNewRoom()
                    togglePick(person.id)
                  }}
                        />
                        <span>{person.name}</span>
                        {person.bot && <span className="msg-bot">{t('ui.chat.bot')}</span>}
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            {error?.where === 'new-room' && (
              <p className="dialog-err" data-new-room="refused">
                {error.message}
              </p>
            )}
            {/* Not disabled when nobody is ticked: an empty room is a thing the kernel has a
                sentence for, and a disabled button would replace that sentence with a silence. */}
          </Dialog>
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
                  {/* The name and, at the other end of the same line, when this room was
                      last spoken in — the shape the client's list has, measured 2026-10-27.
                      The time is the last message's own `at`, which the snapshot copies off
                      the kernel's `created_at`; a room nobody has spoken in has no time and
                      draws none, rather than the time it was made. */}
                  <span className="conv-top">
                    <span className="conv-name">{room.name}</span>
                    {room.messages.length > 0 && (
                      <span className="conv-time">{whenShort(room.messages.at(-1).at)}</span>
                    )}
                  </span>
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

      {/* The seam between the list and the room. It is the same component every other
          two-column view draws, so the roster and the topics list are resizable too — they
          used to be pinned, with the grid still reserving a 6px track that nothing occupied. */}
      <Gutter pane="list" />

      <section className="main-col">
        {/* The one notice here that is about this person's own data: a store the kernel
            would not open is why every list under it is empty, and the kernel's own
            paragraph is the only place the way out of it is written down. */}
        <StoreRefused refusal={snap.storeRefusal} />
        {/* A first run fetching its weights is a download, and it is drawn while it runs and
            if it stops. It is one line rather than one per half, because `half()` in
            `ui/electron/main.js` hands both halves the same reading and a shared fact drawn
            twice reads as two problems. **Which half is on which model server is not drawn
            at all** — `docs/host-rulings.md`, "The window does not speak to a developer" —
            since a person can do nothing with an origin, a variable name or the phrase
            `stage 1`; a half that refused says so on stderr instead. */}
        {snap.stage1?.pending ? (
          <WeightsArriving facts={snap.stage1.pending} />
        ) : snap.stage1?.weights ? (
          <WeightsRefused weights={snap.stage1.weights} />
        ) : null}
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
              {/* **What this room is**, in the column the thread already uses. The prototype
                  puts it behind one mark in the chat header (`data-role="chat-info"`,
                  `renderSide()`) and calls it 会话信息 for a group and 资料 for a one-to-one,
                  because those are two different questions about two different things. The
                  mark is the same either way; the panel's title is the one that differs. */}
              <button
                className="room-info-mark"
                data-room-info="open"
                title={
                  active.kind === 'p2p'
                    ? t('ui.chat.info-hint-p2p')
                    : t('ui.chat.info-hint')
                }
                aria-pressed={infoOpen}
                onClick={() => {
                  setInfoOpen((open) => !open)
                  setRoomError(null)
                }}
              >
                <Icon name="info" size={16} />
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
                  {roomPeople.map((person) => {
                    // `inside` compares two facts the snapshot carries — who this room holds,
                    // and who the store knows. It decides what to draw, never who may join:
                    // the Add button goes to the kernel, which refuses in its own sentence.
                    const inside = active.members.some((member) => member.id === person.id)
                    return (
                      <li key={person.id} className="people-row">
                        <span className="people-name">{person.name}</span>
                        {person.bot && <span className="msg-bot">{t('ui.chat.bot')}</span>}
                        {inside ? (
                          // **A member is a way out, not a badge.** The state used to be a
                          // label saying "in this room", which answers a question nobody asked
                          // twice: the row is only listed as inside because the room holds it.
                          // The way out is the same write from the other end —
                          // `removeMember()` — and it refuses the last member in the kernel's
                          // own sentence, which is the one case a person can actually hit.
                          <button
                            className="people-remove"
                            data-people-remove={person.id}
                            disabled={adding}
                            onClick={() => removeFromRoom(person.id)}
                          >
                            {t('ui.chat.take-out')}
                          </button>
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
              {/* **One box, and the three choices inside it.** Measured off the client on
                  2026-10-27: a 48px rounded field with the editor on the left and the marks on
                  the right — five 26×26 hit areas holding 18px glyphs, 4px apart, a 1px rule,
                  then the send arrow. Ours used to be four bordered boxes side by side with the
                  words "@", "Picture" and "Send" in them, which is not the client's shape and,
                  for the last two, not even a shape a picture can be drawn in.
                  The marks are the four the message can carry before it has words — an emoji
                  in them, a name it addresses, a picture and a file — and of the client's five
                  slots the two that stay undrawn are `Aa`, a font picker this product has no
                  fonts for, and `⤢`, a window state it does not keep. */}
              <div className="composer-box">
                <textarea
                  ref={roomInput}
                  className="composer-input"
                  rows={1}
                  value={draft}
                  placeholder={t('ui.chat.message-hint', { room: active.name })}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => keyDown(event, draft, undefined, roomMention)}
                />
                <div className="composer-tools">
                  {/* The client's five marks, of which four are drawn: the smiley, the @, the
                      picture and the plus. `Aa` (typography) and `⤢` (expand) are not — the
                      first is a font picker this product does not have and the second is a
                      window state it does not keep. The four that are drawn each do their
                      job: an emoji goes into the words, a name goes onto the message, a
                      picture is one kind of bytes and a file is the other. */}
                  <button
                    className="composer-tool"
                    type="button"
                    data-emoji="open"
                    title={t('ui.chat.emoji-hint')}
                    aria-expanded={emojiOn === 'room'}
                    onClick={() => setEmojiOn((open) => (open === 'room' ? null : 'room'))}
                    disabled={sending}
                  >
                    <Icon name="emoji" size={COMPOSER_ICON} />
                  </button>
                  {/* The @ sits beside the picture for the same reason the picture does: it is
                      a choice about the message, made before the words, and it survives an
                      empty box — "hey" typed after naming Echo still addresses Echo. */}
                  <button
                    className="composer-tool"
                    type="button"
                    data-mention="open"
                    title={t('ui.chat.mention-hint')}
                    aria-expanded={roomMention.open}
                    onClick={roomMention.toggleOpen}
                    disabled={sending}
                  >
                    <Icon name="mention" size={COMPOSER_ICON} />
                  </button>
                  {/* A picture is a separate choice from a caption, and the button works with
                      the box empty — which is the whole point of sending a picture. */}
                  <button
                    className="composer-tool"
                    type="button"
                    data-attach="open"
                    title={t('ui.chat.attach')}
                    onClick={() => attachInto(undefined, roomMention)}
                    disabled={sending}
                  >
                    <Icon name="picture" size={COMPOSER_ICON} />
                  </button>
                  {/* The other kind of bytes. A file is not a picture with a different name:
                      it is opened by an application rather than drawn in the column, and the
                      kernel keeps the two apart (`MessageMedia` and `MessageFile`). */}
                  <button
                    className="composer-tool"
                    type="button"
                    data-file="open"
                    title={t('ui.chat.attach-file')}
                    onClick={() => attachFileInto(undefined, roomMention)}
                    disabled={sending}
                  >
                    <Icon name="file" size={COMPOSER_ICON} />
                  </button>
                  <button
                    className="composer-send"
                    type="submit"
                    title={t('ui.chat.send')}
                    aria-label={t('ui.chat.send')}
                    disabled={sending || draft.trim() === ''}
                  >
                    <Icon name="send" size={COMPOSER_ICON} />
                  </button>
                </div>
                {emojiOn === 'room' && (
                  <EmojiPop onPick={(glyph) => insertEmoji('room', glyph)} />
                )}
              </div>
            </form>
          </>
        ) : (
          <div className="empty">{t('ui.chat.no-room')}</div>
        )}
      </section>

      {sideOpen && openThread !== null && !infoOpen && (
        <>
          {/* The thread panel's own seam. It sits to the panel's left, so it reads the drag
              with the opposite sign (`dir` in `resize.mjs`): the panel grows as the pointer
              moves toward the room. */}
          <Gutter pane="side" />
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
            {/* The same box as the room's, because it is the same kind of box: the thread is
                narrower, not a different control. */}
            <div className="composer-box">
              <textarea
                ref={threadInput}
                className="composer-input"
                rows={1}
                value={threadDraft}
                placeholder={t('ui.chat.reply-hint')}
                onChange={(event) => setThreadDraft(event.target.value)}
                onKeyDown={(event) => keyDown(event, threadDraft, openThread, threadMention)}
              />
              <div className="composer-tools">
                {/* The same four marks as the room's, in the same order, because this is the
                    same kind of box — a thread is narrower, not a different control. */}
                <button
                  className="composer-tool"
                  type="button"
                  data-emoji="open-thread"
                  title={t('ui.chat.emoji-hint')}
                  aria-expanded={emojiOn === 'thread'}
                  onClick={() => setEmojiOn((open) => (open === 'thread' ? null : 'thread'))}
                  disabled={sending}
                >
                  <Icon name="emoji" size={COMPOSER_ICON} />
                </button>
                {/* A reply may name somebody too, and needs it more than a room message does:
                    the bot that wrote the message being answered is woken by the reply itself
                    (`repliesToMe`), but anybody else in the room has to be named to hear it. */}
                <button
                  className="composer-tool"
                  type="button"
                  data-mention="open-thread"
                  title={t('ui.chat.reply-mention-hint')}
                  aria-expanded={threadMention.open}
                  onClick={threadMention.toggleOpen}
                  disabled={sending}
                >
                  <Icon name="mention" size={COMPOSER_ICON} />
                </button>
                <button
                  className="composer-tool"
                  type="button"
                  data-attach="open-thread"
                  title={t('ui.chat.attach')}
                  onClick={() => attachInto(openThread, threadMention)}
                  disabled={sending}
                >
                  <Icon name="picture" size={COMPOSER_ICON} />
                </button>
                <button
                  className="composer-tool"
                  type="button"
                  data-file="open-thread"
                  title={t('ui.chat.attach-file')}
                  onClick={() => attachFileInto(openThread, threadMention)}
                  disabled={sending}
                >
                  <Icon name="file" size={COMPOSER_ICON} />
                </button>
                <button
                  className="composer-send"
                  type="submit"
                  title={t('ui.chat.reply')}
                  aria-label={t('ui.chat.reply')}
                  disabled={sending || threadDraft.trim() === ''}
                >
                  <Icon name="send" size={COMPOSER_ICON} />
                </button>
              </div>
              {emojiOn === 'thread' && (
                <EmojiPop onPick={(glyph) => insertEmoji('thread', glyph)} />
              )}
            </div>
          </form>
          </aside>
        </>
      )}
        </>
      )}

      {/* **What this room is**, in the column the thread uses — the prototype's
          `renderSide()` with `kind: 'info'`. One panel at a time in one column: a window that
          drew both would be two answers to "tell me about this room".

          It draws **what the store holds and nothing it does not**. The prototype's panel
          carries two toggles — 置顶会话 and 消息免打扰 — and they are deliberately absent: nothing
          in this product reads either one, so a switch here would be a control that changes a
          flag and nothing a person could observe. That is the same rule as the `Aa` and `⤢`
          marks the composer leaves out. The rest of the prototype's panel is here, and the two
          things it could only draw from a store we do not have (a 群主 chip, a member count
          that is not the list itself) are not invented. */}
      {sideOpen && infoOpen && (
        <>
          <Gutter pane="side" />
          <aside className="thread-col room-col" data-room-panel={active.id}>
            <header className="thread-head">
              <h3>
                {active.kind === 'p2p' ? t('ui.room.title-p2p') : t('ui.room.title')}
              </h3>
              <button
                className="thread-close"
                data-room-info="close"
                title={t('ui.room.close')}
                onClick={() => setInfoOpen(false)}
              >
                ×
              </button>
            </header>

            <div className="room-body">
              <h4 className="room-name" data-room-field="name">
                {active.name}
              </h4>
              <p className="room-sub">
                {active.kind === 'p2p' ? t('ui.room.kind-p2p') : t('ui.room.kind-group')}
                {' · '}
                {t('ui.room.made', { when: when(active.createdAt) })}
              </p>

              {/* The refusal of the last write, in the panel it was made from. */}
              {roomError && (
                <div className="composer-err" data-room="refused">
                  {roomError}
                </div>
              )}

              <div className="card">
                <div className="card-body">
                  <div className="card-title">{t('ui.room.about')}</div>
                  <p className="pane-desc" data-room-field="description">
                    {active.description ?? t('ui.room.nothing-said')}
                  </p>
                </div>
              </div>

              {/* A notice and a label are a group's, not a one-to-one's: nobody else reads
                  either, and the prototype draws both only for `chat_mode !== 'p2p'`. */}
              {active.kind !== 'p2p' && (
                <div className="card">
                  <div className="card-body">
                    <div className="card-title">{t('ui.room.announcement')}</div>
                    <p className="pane-desc" data-room-field="announcement">
                      {active.announcement ?? t('ui.room.nothing-announced')}
                    </p>
                  </div>
                </div>
              )}

              <div className="card">
                <div className="card-body">
                  <div className="card-title">
                    {t('ui.members', { count: active.members.length })}
                  </div>
                  <ul className="room-members">
                    {active.members.map((member) => (
                      <li key={member.id} className="room-member" data-room-member={member.id}>
                        <span className="room-member-name">{member.name}</span>
                        {member.bot && <span className="msg-bot">{t('ui.chat.bot')}</span>}
                        {member.id === snap.me && (
                          <span className="room-member-me">{t('ui.room.me')}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                  {/* Who goes is the people list's job — it is the one list that knows both
                      who is in and who could be, and `removeMember()` refuses the last member
                      in its own sentence either way. */}
                  <button className="room-manage" onClick={() => setPeopleOpen(true)}>
                    {t('ui.room.manage')}
                  </button>
                </div>
              </div>

              {active.tag !== null && active.kind !== 'p2p' && (
                <p className="room-tag" data-room-field="tag">
                  {t('ui.room.tag', { tag: active.tag })}
                </p>
              )}

              <div className="room-actions">
                <button className="btn" data-room-edit="open" onClick={openEdit}>
                  {t('ui.room.edit')}
                </button>
                <button
                  className="btn danger"
                  data-room-leave="leave"
                  disabled={adding}
                  onClick={leaveRoom}
                >
                  {t('ui.room.leave')}
                </button>
                {/* Leaving is one row; this is the room. It sits beside `Leave` rather than
                    inside a menu because a person looking for "get rid of this room" looks
                    here — and it asks before it writes, since nothing on this screen can be
                    brought back afterwards. */}
                <button
                  className="btn danger"
                  data-room-delete="ask"
                  disabled={adding}
                  onClick={() => setAsking({ kind: 'room', id: active.id })}
                >
                  {t('ui.room.delete')}
                </button>
              </div>
            </div>
          </aside>
        </>
      )}

      {/* **Editing what a room says about itself** — the window's first edit, in the same card
          the four "make something" forms use. It sends all four texts, always: an emptied box
          is a person having cleared a text, which `updateRoom()` stores as absent, and a form
          that sent only what changed could not say that. */}
      {editing && active && (
        <Dialog
          name="room"
          title={t('ui.room.edit')}
          submit={t('ui.room.save')}
          cancel={t('ui.room.cancel')}
          busy={savingRoom}
          onSubmit={saveRoom}
          onClose={() => {
            setEditing(false)
            setRoomError(null)
          }}
        >
          <div className="dialog-fields">
            <div className="dialog-field">
              <label className="field-label" htmlFor="room-name">
                {t('ui.room.field.name')}
              </label>
              <input
                id="room-name"
                className="dialog-input"
                data-room-edit="name"
                autoFocus
                value={editName}
                onChange={(event) => {
                  setRoomError(null)
                  setEditName(event.target.value)
                }}
              />
            </div>

            <div className="dialog-field">
              <label className="field-label" htmlFor="room-description">
                {t('ui.room.field.description')}
              </label>
              <textarea
                id="room-description"
                className="dialog-input"
                data-room-edit="description"
                rows={3}
                value={editDescription}
                onChange={(event) => setEditDescription(event.target.value)}
              />
            </div>

            {active.kind !== 'p2p' && (
              <>
                <div className="dialog-field">
                  <label className="field-label" htmlFor="room-announcement">
                    {t('ui.room.field.announcement')}
                  </label>
                  <textarea
                    id="room-announcement"
                    className="dialog-input"
                    data-room-edit="announcement"
                    rows={3}
                    value={editAnnouncement}
                    onChange={(event) => setEditAnnouncement(event.target.value)}
                  />
                </div>

                <div className="dialog-field">
                  <label className="field-label" htmlFor="room-tag">
                    {t('ui.room.field.tag')}
                  </label>
                  <input
                    id="room-tag"
                    className="dialog-input"
                    data-room-edit="tag"
                    placeholder={t('ui.room.field.tag-hint')}
                    value={editTag}
                    onChange={(event) => setEditTag(event.target.value)}
                  />
                </div>
              </>
            )}
          </div>

          {/* The kernel's sentence, in the card that asked for it. The blank name is the one
              refusal a person meets here, and `updateRoom()` is where it is worded. */}
          {roomError && <p className="dialog-err" data-room-edit="refused">{roomError}</p>}
        </Dialog>
      )}

      {/* **The one question a deletion asks.** A mask and two answers, because the three
          deletions are one shape of thing: something is about to stop existing in this store
          and nothing in the app can bring it back. The title is the button that opened it, so
          the card says what it is about to do rather than "are you sure"; the line under it
          says what goes with it — a group takes everything said in it, a topic takes its
          replies. The kernel's own sentence lands here too, so a refusal is read in the card
          that asked for it. */}
      {asking && (
        <Dialog
          name="delete"
          title={
            asking.kind === 'room'
              ? t('ui.room.delete')
              : asking.kind === 'thread'
                ? t('ui.topics.delete')
                : t('ui.chat.delete')
          }
          submit={
            asking.kind === 'room'
              ? t('ui.room.delete')
              : asking.kind === 'thread'
                ? t('ui.topics.delete')
                : t('ui.chat.delete')
          }
          cancel={t('ui.chat.cancel')}
          busy={removing}
          onSubmit={confirmRemove}
          onClose={() => {
            setAsking(null)
            setRemoveError(null)
          }}
        >
          <p className="dialog-note">
            {asking.kind === 'room'
              ? t('ui.room.delete-ask')
              : asking.kind === 'thread'
                ? t('ui.topics.delete-ask')
                : t('ui.chat.delete-ask')}
          </p>
          {removeError && <p className="dialog-err">{removeError}</p>}
        </Dialog>
      )}

      {/* **Making an organization, over the window rather than instead of it.**
          One field and two buttons, because that is all an organization is: a name and a
          directory of its own. It opens from the rail's add mark, which is in every view, so it
          works from wherever the person is reading — and it leaves them there, which is the
          whole point of it not being a page. A press outside or Escape closes it. */}
      {orgForm && (
        <Dialog
          name="organization"
          title={t('ui.rail.add-organization')}
          submit={t('ui.settings.create')}
          cancel={t('ui.settings.cancel')}
          busy={orgBusy}
          onSubmit={createOrg}
          onClose={() => setOrgForm(null)}
        >
          {/* **A label above the field, not a placeholder standing in for one.** This is the
              shape the bot form uses (`Contacts.jsx`, `field-label` over its name field) and
              the host asked for this form to be like that one — 创建组织，和创建机器人一样. It also
              survives typing, where a placeholder does not. */}
          <div className="dialog-field">
            <label className="field-label" htmlFor="organization-name">
              {t('ui.rail.organization-name')}
            </label>
            <input
              id="organization-name"
              className="dialog-input"
              value={orgName}
              autoFocus
              placeholder={t('ui.rail.organization-name-hint')}
              onChange={(event) => {
                // The refusal is about the name that is no longer there once typing starts.
                setOrgForm((was) => (was?.error ? { ...was, error: null } : was))
                setOrgName(event.target.value)
              }}
              data-org-name
            />
            {/* What the name is for, said in the catalogue's own words: it labels this list
                and nothing else — it never becomes the name of the person inside the world
                (宿主, 2026-10-27: 组织名与「我」无关). A placeholder cannot carry that, because
                it leaves the moment there is something to read. */}
            <p className="dialog-hint">{t('ui.settings.organizations.name-hint')}</p>
          </div>
          {orgForm.error && <p className="dialog-err" data-org-refused>{orgForm.error}</p>}
          {orgForm.note && <p className="dialog-note" data-org-made>{orgForm.note}</p>}
        </Dialog>
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
 * lines read as two problems rather than as one download. A strip that is arriving carries no
 * modifier and takes the base colours on purpose — a first run fetching its weights is the app
 * working, and painting it with `refused` would report it as broken. (It wore a `waiting` class
 * until 2026-10-27; no rule ever answered to that name, and the base colours were what it drew
 * all along, so the class said something the sheet did not.)
 *
 * **The sentence is written here, from three facts.** It used to be composed in
 * `ui/electron/weights-fetch.js` and handed over finished, which fixed its language before the
 * window had one: a first run drew `0.2 GB of 2.2 GB — LFM2.5-VL-3B-Q4_0.gguf` underneath a
 * heading the catalogue had already translated (`docs/design/i18n.md` §1). The numbers go
 * through `size()` because §4 puts a file size in the formatting layer, and the file's own name
 * is left alone — §7 keeps a file key as an identifier in every language.
 */
function WeightsArriving({ facts }) {
  if (!facts) return null
  const got = size(facts.received)
  const all = size(facts.total)

  return (
    <div className="weights" data-weights="waiting">
      <strong>{t('ui.chat.weights-arriving')}</strong>
      <span className="weights-why">
        {facts.file === null
          ? t('ui.weights.arriving-amount-no-file', { got, all })
          : t('ui.weights.arriving-amount', { got, all, file: facts.file })}
      </span>
    </div>
  )
}

/**
 * Why the weights did not arrive, in the language this window speaks.
 *
 * The other half of `WeightsArriving`, and drawn in the same place for the same reason: the
 * weights are one directory shared by both halves, so `half()` in `ui/electron/main.js` hands
 * both of them the same reading. A line each printed the same sentence twice, and two identical
 * lines read as two problems rather than as one download that stopped.
 *
 * **Every word here is the catalogue's, including the diagnosis.** The facts that cross from the
 * main process carry which places were tried and never what one of them said
 * (`snapshot.js`, `weightsOf`): `fetch failed` is Node's sentence, `the server answered 404` is
 * this build's own, and neither is something a person can do anything with. `docs/host-rulings.md`
 * — "The window does not speak to a developer" — sends that detail to stderr, where
 * `describe()` in `weights-fetch.js` writes it and where whoever built or configured this install
 * is already looking. §4 is why the joining is here and not in that layer: `"A, B and C"` is the
 * language's, not a `; `.
 *
 * **The last clause is drawn only when it is true.** A download that stopped is continued by the
 * next launch — `model-weights.js` resumes from the `.part` bytes — while a build with no address
 * configured fetches nothing however often it is launched, and a sentence promising otherwise
 * would be a person's wasted evening.
 */
function WeightsRefused({ weights }) {
  if (!weights) return null

  return (
    <div className="weights refused" data-weights="refused">
      <strong>{t('ui.chat.weights-refused')}</strong>
      <span className="weights-why">{weightsSentence(weights)}</span>
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
  // An attachment is drawn on the same rule: the kernel's `kind` says so and the four facts are
  // in the message. A `file` whose `file` is missing is a message nobody can draw, and
  // `fileFor()` in `src/delivery.ts` refuses to write one — so this reads as a row or not at
  // all, never as a row of blanks.
  const attachment = message.kind === 'file' && message.file ? message.file : null
  // The reactions the store holds, and nothing this file counted: `operators[]` is the fact
  // (`src/types.ts`), so the number drawn beside a glyph is that array's length and "mine"
  // is whether the person this window speaks as is in it. A reaction nobody has reacted with
  // has no entry at all — the kernel deletes a row whose last operator took it back.
  const reactions = message.reactions ?? []
  // **A deleted message is a tombstone, not a gap.** The kernel keeps the row — an observation,
  // a reply's `chain` and a turn all name it — and takes the content away (`src/erase.ts`), so
  // what is left to draw is who spoke, and that it was taken back. The hover toolbar goes with
  // the content: there is nothing to quote, forward or react to, and a menu offering `Delete`
  // on a message already deleted would be a button with one outcome.
  const deleted = Boolean(message.deletedAt)
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
        {attachment && <FileRow file={attachment} />}
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
        {deleted && (
          <span className="msg-deleted" data-msg-deleted={message.id}>
            {t('ui.chat.deleted')}
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
        {/* The thread's way in belongs to the message that **roots** the chain: the count is the
            chain's, so a chip on every reply would be one number drawn four times (Feishu draws
            it once, on the root). **A tombstone with no replies gets neither an invitation nor a
            count** — there is nothing left to answer — while a root taken back that still has
            live replies keeps its count, because those replies are still there to read. */}
        {chip && message.chain === message.id && (!deleted || replies > 0) && (
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
        {actions && !deleted && (
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
            {/* The second item, and the second platform action this build has: taking the
                message back. It opens the one confirmation card rather than writing at once,
                because a deletion is the one thing here with no undo. */}
            <button data-delete-msg={message.id} onClick={() => actions.remove(message)}>
              {t('ui.chat.delete')}
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
  // A file's row is its name, so the conversation list says the same thing the row does rather
  // than "nothing" — which is what a room whose last message was a spreadsheet would read as.
  if (message?.kind === 'file' && message.file) {
    return t('ui.chat.said.file', { name: message.file.name })
  }
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
