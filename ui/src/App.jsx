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
 * is stage 1, and that half is a real model when the app was started with a server
 * (`ui/electron/host.js`); the line it answers with is still the kernel's stub
 * (`src/main.ts`, `STUB_REPLY`), because stage 2 has no model yet. `StageOne` below is
 * where the window says which of those two it is looking at.
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
 * The bot's answer lands in the room rather than in the panel, because the stub agent
 * says its line without naming what it answers (`stubDecide`: no `replyTo`); an agent
 * that answers into the thread is the model-wiring slice, not this one.
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

  async function send(text, rootId) {
    const body = text.trim()
    if (!body || !active || sending) return
    setSending(true)
    setError(null)
    try {
      // A reply is the same call with a parent named; the kernel decides the rest of
      // the thread from it.
      const result = await window.seekHost.post({ roomId: active.id, text: body, rootId })
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
          <span className="count">{snap.rooms.length}</span>
        </header>
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
                    {room.messages.at(-1)?.text ?? 'no messages yet'}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="main-col">
        {/* Which half of the bot is real, above the room because it is a fact about the
            app rather than about this conversation. */}
        <StageOne stage1={snap.stage1} />
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
        <span className="stage1-why">the answer itself is still the kernel&apos;s placeholder</span>
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
 * One message, drawn the same way in the room and in the panel.
 *
 * `chip` is the thread's way in: a count when the chain has replies, and an invitation
 * when it has none — because a thread that cannot be started from the message it would
 * belong to is a panel nobody can open.
 */
function Line({ message, sender, replies, inThread, onOpen, chip = false }) {
  const name = sender?.name ?? message.sender
  return (
    <li className={`msg${inThread ? ' on' : ''}`}>
      <span className={`msg-av${sender?.bot ? ' bot' : ''}`}>{name.slice(0, 2)}</span>
      <span className="msg-body">
        <span className="msg-sender">
          {name}
          {sender?.bot && <span className="msg-bot">bot</span>}
        </span>
        <span className="msg-text">{message.text}</span>
        {chip && (
          <button className="msg-thread" data-thread-for={message.id} onClick={() => onOpen(message)}>
            {replies > 0 ? `${replies} ${replies === 1 ? 'reply' : 'replies'}` : 'reply in thread'}
          </button>
        )}
      </span>
    </li>
  )
}
