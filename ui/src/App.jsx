import { useEffect, useRef, useState } from 'react'

/**
 * The shell: a Feishu-shaped window over the kernel's own store.
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
 * in it one hop from that message, the way Feishu's thread replies sit under the parent.
 * The bot's answer lands in the panel when stage 2 is bound, because `workOverServer`
 * names the entry that woke the turn and the kernel's own chain follows it there; with
 * no work server the answer lands in the room, because `stubDecide` says its line
 * without naming what it answers.
 */
export default function App() {
  const [snap, setSnap] = useState(null)
  const [activeId, setActiveId] = useState(null)
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
  const messagesEnd = useRef(null)
  const threadEnd = useRef(null)

  useEffect(() => {
    window.seekHost.snapshot().then((next) => {
      setSnap(next)
      setActiveId((current) => current ?? next.rooms[0]?.id ?? null)
    })
    // The kernel changes the store by itself when a bot answers. Without this the
    // window would only be right immediately after *you* typed.
    return window.seekHost.onChanged((next) => setSnap(next))
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

  async function send(text, rootId, media) {
    const body = typeof text === 'string' ? text.trim() : ''
    // A picture may go with no words at all — the caption is optional (`media` names the
    // bytes, and `deliver()` accepts an image with an empty text); a text message may not.
    if (!active || sending || (body === '' && !media)) return
    setSending(true)
    setError(null)
    try {
      // A reply is the same call with a parent named; the kernel decides the rest of
      // the thread from it. A picture is the same call with `kind` and `media`, and the
      // kernel's own `mediaFor` is what refuses a picture it will not accept.
      const result = await window.seekHost.post({
        roomId: active.id,
        text: body,
        rootId,
        ...(media ? { kind: 'image', media: { key: media.key, mime: media.mime } } : {}),
      })
      if (result.ok) {
        setSnap(result.snapshot)
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
  async function attachInto(rootId) {
    if (!active || sending) return
    setSending(true)
    setError(null)
    try {
      const picked = await window.seekHost.attach()
      if (!picked.ok) {
        if (!picked.cancelled) setError({ where: rootId ? 'thread' : 'room', message: picked.error })
        return
      }
      await send(rootId ? threadDraft : draft, rootId, picked.media)
    } finally {
      setSending(false)
    }
  }

  function keyDown(event, text, rootId) {
    // Enter sends; Shift+Enter is a newline, which is the rule every chat window has.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      send(text, rootId)
    }
  }

  function openThreadOf(message) {
    setOpenThread(message.chain)
    setThreadDraft('')
    setError(null)
  }

  function enterRoom(roomId) {
    setActiveId(roomId)
    // A thread belongs to a room; leaving the room leaves the thread behind it.
    setOpenThread(null)
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

  if (!snap) return <div className="booting">opening the store…</div>

  const whoSaid = Object.fromEntries((active?.members ?? []).map((member) => [member.id, member]))

  return (
    <div className={`app${openThread ? ' with-thread' : ''}`}>
      <nav className="rail">
        <div className="rail-avatar" title={snap.me ?? 'me'}>
          {(snap.me ?? 'me').slice(0, 1).toUpperCase()}
        </div>
        {snap.rooms.map((room) => (
          <button
            key={room.id}
            className={`rail-item${room.id === activeId ? ' on' : ''}`}
            title={room.name}
            onClick={() => enterRoom(room.id)}
          >
            {room.name.slice(0, 1).toUpperCase()}
          </button>
        ))}
      </nav>

      <section className="list-col">
        <header className="list-head">
          <h1>Chats</h1>
          {/* `space-between` with three children would centre the count; the tools are one
              group so the heading and the group are the two ends. */}
          <span className="list-tools">
            <span className="count">{snap.rooms.length}</span>
            {/* A store whose only room the seed made is a store where the room list is a
                constant. This is the way out of that, and it is one button. */}
            <button
              className="list-new"
              data-new-room="open"
              title="new room"
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
              placeholder="room name (optional)"
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
                    {person.bot && <span className="msg-bot">bot</span>}
                  </label>
                </li>
              ))}
            </ul>
            <div className="new-room-actions">
              {/* Not disabled when nobody is ticked: an empty room is a thing the kernel
                  has a sentence for, and a disabled button would replace that sentence
                  with a silence. */}
              <button type="submit" data-new-room="create" disabled={sending}>
                Create
              </button>
              <button
                type="button"
                data-new-room="cancel"
                onClick={() => {
                  setMaking(false)
                  setError(null)
                }}
              >
                Cancel
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
                      ? 'no messages yet'
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
        <StageOne stage1={snap.stage1} />
        <StageTwo stage2={snap.stage2} />
        {active ? (
          <>
            <header className="main-head">
              <h2>{active.name}</h2>
              <span className="members">{active.members.length} members</span>
            </header>

            <ol className="messages">
              {messages.map((message) => (
                <Line
                  key={message.id}
                  message={message}
                  sender={whoSaid[message.sender]}
                  replies={repliesIn[message.chain] ?? 0}
                  inThread={openThread !== null && message.chain === openThread}
                  onOpen={openThreadOf}
                  chip
                />
              ))}
              {messages.length === 0 && <li className="empty">nothing said here yet</li>}
              <li ref={messagesEnd} aria-hidden="true" />
            </ol>

            {error?.where === 'room' && <div className="composer-err">{error.message}</div>}
            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault()
                send(draft)
              }}
            >
              <textarea
                className="composer-input"
                rows={1}
                value={draft}
                placeholder={`Message ${active.name}`}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => keyDown(event, draft)}
              />
              {/* Beside the box rather than inside it: a picture is a separate choice
                  from a caption, and the button works with the box empty — which is the
                  whole point of sending a picture. */}
              <button
                className="composer-attach"
                type="button"
                title="Attach a picture"
                onClick={() => attachInto()}
                disabled={sending}
              >
                Picture
              </button>
              <button className="composer-send" type="submit" disabled={sending || draft.trim() === ''}>
                Send
              </button>
            </form>
          </>
        ) : (
          <div className="empty">no room in this store</div>
        )}
      </section>

      {openThread && active && (
        <aside className="thread-col">
          <header className="thread-head">
            <h3>Thread</h3>
            <button className="thread-close" title="Close the thread" onClick={() => setOpenThread(null)}>
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
              />
            ))}
            {thread.length === 0 && <li className="empty">this thread has nothing in it</li>}
            <li ref={threadEnd} aria-hidden="true" />
          </ol>

          {error?.where === 'thread' && <div className="composer-err">{error.message}</div>}
          <form
            className="thread-composer"
            onSubmit={(event) => {
              event.preventDefault()
              send(threadDraft, openThread)
            }}
          >
            <textarea
              className="thread-composer-input"
              rows={1}
              value={threadDraft}
              placeholder="Reply in thread"
              onChange={(event) => setThreadDraft(event.target.value)}
              onKeyDown={(event) => keyDown(event, threadDraft, openThread)}
            />
            <button
              className="thread-attach"
              type="button"
              title="Attach a picture"
              onClick={() => attachInto(openThread)}
              disabled={sending}
            >
              Picture
            </button>
            <button className="thread-send" type="submit" disabled={sending || threadDraft.trim() === ''}>
              Reply
            </button>
          </form>
        </aside>
      )}
    </div>
  )
}

/**
 * What the bot's judgement is, in one standing line.
 *
 * Three readings, and the difference between them is the whole point of drawing it:
 *
 * - **no server** — the state this build ships in. The bot decides with the kernel's
 *   placeholder, and the line names the two variables that would change that, because a
 *   mode nobody can switch is a mode nobody knows they are in.
 * - **bound** — stage 1 is the measured watch model at that origin. The origin is named
 *   because a verdict without the model that gave it is a number that looks like a
 *   measurement (`docs/decisions.md` row 24), and the line also says the *answer* is still
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
        <strong>the model server was not used</strong>
        <span className="stage1-why">{stage1.refusal}</span>
      </div>
    )
  }

  if (stage1.server) {
    return (
      <div className="stage1 bound" data-stage1="bound">
        <strong>stage 1 asks {stage1.server}</strong>
        <span className="stage1-why">
          whether it answers is the model&apos;s verdict; what it says is stage 2, below
        </span>
      </div>
    )
  }

  return (
    <div className="stage1" data-stage1="placeholder">
      <strong>no model server</strong>
      <span className="stage1-why">
        the bot decides with the kernel&apos;s placeholder — set SEEK_SERVER and SEEK_WINDOW
        to ask a real model
      </span>
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
 * because a stub line looks exactly like a bot that thought (`docs/decisions.md` row 27).
 */
function StageTwo({ stage2 }) {
  if (!stage2) return null

  if (stage2.refusal) {
    return (
      <div className="stage2 refused" data-stage2="refused">
        <strong>the work server was not used</strong>
        <span className="stage2-why">{stage2.refusal}</span>
      </div>
    )
  }

  if (stage2.server) {
    return (
      <div className="stage2 bound" data-stage2="bound">
        <strong>stage 2 asks {stage2.server}</strong>
        <span className="stage2-why">the words in the room are the model&apos;s, written through its `say` call</span>
      </div>
    )
  }

  return (
    <div className="stage2" data-stage2="placeholder">
      <strong>no work server</strong>
      <span className="stage2-why">
        the bot says the kernel&apos;s placeholder line — set SEEK_WORK_SERVER to let a model
        write the reply
      </span>
    </div>
  )
}

/**
 * One message, drawn the same way in the room and in the panel.
 *
 * `chip` is the thread's way in: a count when the chain has replies, and an invitation
 * when it has none — because a thread that cannot be started from the message it would
 * belong to is a panel nobody can open.
 */
function Line({ message, sender, replies, inThread, onOpen, chip = false }) {
  const name = sender?.name ?? message.sender
  // A picture is drawn because the kernel's `kind` says so (`docs/decisions.md` row 17),
  // never because the text looks like one: a message whose kind disowns its bytes is one
  // every reader drops in silence, and guessing from the text is the same drop, later.
  const picture = message.kind === 'image' && message.media ? message.media : null
  return (
    <li className={`msg${inThread ? ' on' : ''}`}>
      <span className={`msg-av${sender?.bot ? ' bot' : ''}`}>{name.slice(0, 2)}</span>
      <span className="msg-body">
        <span className="msg-sender">
          {name}
          {sender?.bot && <span className="msg-bot">bot</span>}
        </span>
        {picture && <Picture media={picture} />}
        {message.text !== '' && <span className="msg-text">{message.text}</span>}
        {chip && (
          <button className="msg-thread" data-thread-for={message.id} onClick={() => onOpen(message)}>
            {replies > 0 ? `${replies} ${replies === 1 ? 'reply' : 'replies'}` : 'reply in thread'}
          </button>
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
  if (message?.kind === 'image') return 'a picture'
  return 'no words'
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
      <span className="msg-pic-opening" data-picture="opening">
        opening the picture…
      </span>
    )
  }
  return <img className="msg-pic" data-picture="shown" src={src} alt={media.key} />
}
