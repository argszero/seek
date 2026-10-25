import { useEffect, useRef, useState } from 'react'

/**
 * The shell: a Feishu-shaped window over the kernel's own store.
 *
 * The room list, the members and the messages all come from `snapshot()` in the main
 * process, which is the kernel. Nothing here decides anything about the data — this
 * file draws it and, since this slice, types into it.
 *
 * **What the composer is.** One call, `post({ roomId, text })`. The main process hands
 * it to the kernel's own `deliver()`, saves, and wakes the bots the message reached; a
 * bot that judges the message worth answering says so through `say()`. The message you
 * typed and the answer you get are therefore in the store, in that order, before either
 * is drawn — this window is a view of them, not a second copy. The line the bot answers
 * with is the kernel's stub (`src/main.ts`, `STUB_REPLY`); no model is wired yet.
 */
export default function App() {
  const [snap, setSnap] = useState(null)
  const [activeId, setActiveId] = useState(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState(null)
  const [sending, setSending] = useState(false)
  const messagesEnd = useRef(null)

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

  // The newest line is the one you just sent, or the answer to it — so the column
  // follows the conversation instead of leaving it below the fold.
  useEffect(() => {
    if (messagesEnd.current) messagesEnd.current.scrollIntoView({ block: 'end' })
  }, [active?.messages.length, activeId])

  async function send() {
    const text = draft.trim()
    if (!text || !active || sending) return
    setSending(true)
    setError(null)
    try {
      const result = await window.seekHost.post({ roomId: active.id, text })
      if (result.ok) {
        setSnap(result.snapshot)
        setDraft('')
      } else {
        // Kept in the box, so what was typed is not lost to a refusal.
        setError(result.error)
      }
    } finally {
      setSending(false)
    }
  }

  function onKeyDown(event) {
    // Enter sends; Shift+Enter is a newline, which is the rule every chat window has.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      send()
    }
  }

  if (!snap) return <div className="booting">opening the store…</div>

  const whoSaid = Object.fromEntries((active?.members ?? []).map((member) => [member.id, member]))

  return (
    <div className="app">
      <nav className="rail">
        <div className="rail-avatar" title={snap.me ?? 'me'}>
          {(snap.me ?? 'me').slice(0, 1).toUpperCase()}
        </div>
        {snap.rooms.map((room) => (
          <button
            key={room.id}
            className={`rail-item${room.id === activeId ? ' on' : ''}`}
            title={room.name}
            onClick={() => setActiveId(room.id)}
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
                onClick={() => setActiveId(room.id)}
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
        {active ? (
          <>
            <header className="main-head">
              <h2>{active.name}</h2>
              <span className="members">{active.members.length} members</span>
            </header>

            <ol className="messages">
              {active.messages.map((message) => {
                const sender = whoSaid[message.sender]
                const name = sender?.name ?? message.sender
                return (
                  <li key={message.id} className="msg">
                    <span className={`msg-av${sender?.bot ? ' bot' : ''}`}>
                      {name.slice(0, 2)}
                    </span>
                    <span className="msg-body">
                      <span className="msg-sender">
                        {name}
                        {sender?.bot && <span className="msg-bot">bot</span>}
                      </span>
                      <span className="msg-text">{message.text}</span>
                    </span>
                  </li>
                )
              })}
              {active.messages.length === 0 && <li className="empty">nothing said here yet</li>}
              <li ref={messagesEnd} aria-hidden="true" />
            </ol>

            {error && <div className="composer-err">{error}</div>}
            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault()
                send()
              }}
            >
              <textarea
                className="composer-input"
                rows={1}
                value={draft}
                placeholder={`Message ${active.name}`}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={onKeyDown}
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
    </div>
  )
}
