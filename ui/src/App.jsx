import { useEffect, useState } from 'react'

/**
 * The shell's first slice: a Feishu-shaped window over the kernel's own store.
 *
 * It reads only. Nothing here decides anything — the room list, the members and the
 * messages come from `snapshot()` in the main process, which is the kernel. That is
 * the whole point of this slice: prove the interface can be carried by the kernel's
 * data before any of the prototype's behaviour is ported onto it.
 */
export default function App() {
  const [snap, setSnap] = useState(null)
  const [activeId, setActiveId] = useState(null)

  useEffect(() => {
    window.seekHost.snapshot().then((next) => {
      setSnap(next)
      setActiveId(next.rooms[0]?.id ?? null)
    })
  }, [])

  if (!snap) return <div className="booting">opening the store…</div>

  const active = snap.rooms.find((room) => room.id === activeId) ?? null

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
              {active.messages.map((message) => (
                <li key={message.id} className="msg">
                  <span className="msg-av">{message.sender.slice(0, 2)}</span>
                  <span className="msg-body">
                    <span className="msg-sender">{message.sender}</span>
                    <span className="msg-text">{message.text}</span>
                  </span>
                </li>
              ))}
              {active.messages.length === 0 && <li className="empty">nothing said here yet</li>}
            </ol>
          </>
        ) : (
          <div className="empty">no room in this store</div>
        )}
      </section>
    </div>
  )
}
