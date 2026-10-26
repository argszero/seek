import { useEffect, useRef, useState } from 'react'

/**
 * Tokens are counts, so they are drawn by `Intl.NumberFormat` rather than by string
 * arithmetic: `1204` and `1,204` are the same figure and only one of them reads as one.
 * Constructed once, because a formatter built per render is a locale lookup per message.
 */
const TOKENS = new Intl.NumberFormat()

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
 *
 * **Who a message addresses.** A message may carry `mentions[]` — Feishu's own field, each
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
  // Who each composer's next message addresses. Two instances rather than one list, because
  // the room's composer and the thread's are on screen at the same time when a thread is
  // open: a chip picked in one box must not silently name somebody in a message sent from
  // the other. See `useMentions` below for what one of these is.
  const roomMention = useMentions()
  const threadMention = useMentions()
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

  async function send(text, rootId, media, mention) {
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
        // Who this message names. Sent as the pairs the person picked, and the kernel stores
        // them on the message verbatim (`mentionsOf` in `ui/electron/host.js` copies them and
        // decides nothing); an empty list is a message that addresses the room.
        mentions: mention.addressed,
      })
      if (result.ok) {
        setSnap(result.snapshot)
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
    // Enter sends; Shift+Enter is a newline, which is the rule every chat window has.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      send(text, rootId, undefined, mention)
    }
  }

  function openThreadOf(message) {
    setOpenThread(message.chain)
    setThreadDraft('')
    setError(null)
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
        <StoreRefused refusal={snap.storeRefusal} />
        <StageOne stage1={snap.stage1} />
        <StageTwo stage2={snap.stage2} />
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
                title="who is in this room"
                onClick={() => setPeopleOpen((open) => !open)}
              >
                {active.members.length} members
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
                        {person.bot && <span className="msg-bot">bot</span>}
                        {inside ? (
                          <span className="people-state" data-people-in={person.id}>
                            in this room
                          </span>
                        ) : (
                          <button
                            className="people-add"
                            data-people-add={person.id}
                            disabled={adding}
                            onClick={() => addToRoom(person.id)}
                          >
                            Add
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
                send(draft, undefined, undefined, roomMention)
              }}
            >
              <Mentions members={active.members} mention={roomMention} />
              <textarea
                className="composer-input"
                rows={1}
                value={draft}
                placeholder={`Message ${active.name}`}
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
                title="who this message addresses"
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
                title="Attach a picture"
                onClick={() => attachInto(undefined, roomMention)}
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
              send(threadDraft, openThread, undefined, threadMention)
            }}
          >
            <Mentions members={active.members} mention={threadMention} />
            <textarea
              className="thread-composer-input"
              rows={1}
              value={threadDraft}
              placeholder="Reply in thread"
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
              title="who this reply addresses"
              onClick={threadMention.toggleOpen}
              disabled={sending}
            >
              @
            </button>
            <button
              className="thread-attach"
              type="button"
              title="Attach a picture"
              onClick={() => attachInto(openThread, threadMention)}
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
function Mentions({ members, mention }) {
  return (
    <>
      {mention.addressed.length > 0 && (
        <span className="mention-row" data-mention="picked">
          <span className="mention-lead">addressing</span>
          {mention.addressed.map((one) => (
            <span className="mention-chip" data-mention-chip={one.id} key={one.id}>
              @{one.name}
              <button
                className="mention-drop"
                type="button"
                title={`stop addressing ${one.name}`}
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
              {member.bot && <span className="msg-bot">bot</span>}
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
 * two as one line would show a broken install as a slow one (`docs/decisions.md` row 20,
 * one layer down from the two model strips).
 */
function StoreRefused({ refusal }) {
  if (!refusal) return null

  return (
    <div className="store refused" data-store="refused">
      <strong>the store was not opened</strong>
      <span className="store-why">{refusal}</span>
    </div>
  )
}

/**
 * What the bot's judgement is, in one standing line.
 *
 * Four readings, and the difference between them is the whole point of drawing it:
 *
 * - **waiting** — a first run is fetching the weights, and this is how far it has got. Not a
 *   failure and not the neutral "no server" state either: the model server exists and is
 *   unusable for a reason that is being fixed while the line is read, so it is drawn in the
 *   ordinary colour with a number in it rather than in the error colour.
 * - **no server** — the state a build with no model server ships in. The bot decides with the kernel's
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

  // Before `refusal`, because a download under way is the newer fact: while the weights are
  // arriving nothing has been refused yet, and a half that showed its older refusal over an
  // active download would report a failure that is being repaired as it is read.
  if (stage1.pending) {
    return (
      <div className="stage1 waiting" data-stage1="waiting">
        <strong>the weights are arriving</strong>
        <span className="stage1-why">{stage1.pending}</span>
      </div>
    )
  }

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

  if (stage2.pending) {
    return (
      <div className="stage2 waiting" data-stage2="waiting">
        <strong>the weights are arriving</strong>
        <span className="stage2-why">{stage2.pending}</span>
      </div>
    )
  }

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
      title={perBot === '' ? 'no turn has run in this room yet' : perBot}
    >
      {TOKENS.format(total)} tokens
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
