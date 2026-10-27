import { useEffect, useState } from 'react'

import { t } from './catalogue.mjs'
import Dialog from './Dialog.jsx'
import Gutter from './Gutter.jsx'

/**
 * The groups view: the rooms in this store that are not one person's conversation with one
 * other person.
 *
 * **The prototype is the spec** (`prototype/src/js/app.js`): the rail row it labels 群组, the
 * list `renderList()` draws for `view === 'groups'`, the pane `renderGroupsPane()` draws, and
 * the form `modalNewGroup()` opens. What differs here is what this store forces, not a choice
 * of this file.
 *
 * **Which rooms are groups is the kernel's answer, not a field's.** The prototype filters on
 * `chat_mode` (`prototype/src/js/store.js:210`: `'group'` or `'topic'`), because its data has
 * a `p2p` mode to filter out. This store does not: `ui/electron/host.js` declines to ask for
 * a mode when it makes a room, and a direct message here **is a headcount** —
 * `deriveHints()` reads `direct` from `membershipsOf(room).length === 2`
 * (`src/delivery.ts:418`) and `src/rooms.ts:23` states that the domain sees one kind of Room.
 * So this view lists every room that is not two members deep, which is the same line the chat
 * screen's `messagePerson()` draws from the other side when it asks whether it and this person
 * already have a room.
 *
 * Two consequences, and both are the rule's rather than this file's:
 *
 * - a room with one member is not a conversation between two either, so it is listed here —
 *   as it would be in the prototype, where such a room's mode is still `group`;
 * - putting a third person into a two-person room moves that room into this list, because the
 *   headcount is what changed.
 *
 * **The card draws what the kernel holds.** The prototype's group card reads
 * `member_count 人 · description` and stamps `update_time`; `Room` in `src/types.ts` is `id`,
 * `name?`, `chat_mode`, `created_at`, `consecutive_agent_turns?` — no description, no update
 * time — so neither is drawn. The members are drawn instead, because those the store does
 * hold.
 *
 * **Making a group puts you in it.** The prototype's `createGroup()` builds its member list as
 * `[me, ...chosen]` (`prototype/src/js/store.js:414`), and the section heading above the list
 * says whose groups these are — 我加入的群. So the form offers everyone but you, and you are
 * added without being asked.
 *
 * **No system message is written.** The prototype's `createGroup()` appends 「X 创建了群聊…」;
 * `createRoom()` writes a room and its memberships and nothing else, and no document says a
 * room arrives with a message. Writing one here would be the window inventing a record of
 * something the kernel never did.
 *
 * **Every word here is the catalogue's** (`docs/design/i18n.md` §1), which is why this is a
 * file of its own: `ui/electron/catalogue.test.mjs` holds a view to having no words of its
 * own, and this one can be held to that from the day it exists while `App.jsx` still speaks
 * for the chat surface.
 *
 * **The two calls out of this file are navigation and a write.** `onSnapshot` is how the
 * snapshot a write answers with reaches the screen (the same one every other write arrives
 * as), and `onOpen` is the chat screen's, because entering a room moves the room list, the
 * composer and the rail at once.
 */
export default function Groups({ rooms, people, me, onOpen, onSnapshot, ask, onAsked }) {
  const [query, setQuery] = useState('')
  const [openId, setOpenId] = useState(null)

  // The form's own state, because nothing outside this view draws it. `sending` is here too:
  // two presses on Create are one group, and the second press is the one that makes a
  // duplicate.
  const [making, setMaking] = useState(false)
  // The rail's add mark can ask this view to open its form. Cleared as it is taken, for the
  // reason `Contacts.jsx` gives: one press, one form.
  useEffect(() => {
    if (!ask) return
    setMaking(true)
    onAsked()
  }, [ask, onAsked])
  const [name, setName] = useState('')
  const [chosen, setChosen] = useState([])
  const [sending, setSending] = useState(false)
  const [stopped, setStopped] = useState(null)

  const groups = rooms.filter((room) => isGroup(room))
  const others = people.filter((person) => person.id !== me)
  const wanted = query.trim().toLowerCase()
  const listed =
    wanted === '' ? groups : groups.filter((room) => room.name.toLowerCase().includes(wanted))
  const open = groups.find((room) => room.id === openId) ?? null

  /**
   * Forget the refusal the moment the form stops being the state it described.
   *
   * A refusal is a sentence about what is on screen, and the two this form makes are about
   * the name and the count. Left standing while the person types the name it asked for, it
   * says the form is still wrong when it no longer is — measured in the window on 2026-10-27:
   * `a group needs a name` was still under the field that now said `Reading circle`.
   */
  function forget() {
    setStopped(null)
  }

  function toggle(id) {
    forget()
    setChosen((current) =>
      current.includes(id) ? current.filter((one) => one !== id) : [...current, id],
    )
  }

  /** Close the form and forget what was typed in it: one press, one group. */
  function close() {
    setMaking(false)
    setStopped(null)
    setName('')
    setChosen([])
  }

  async function make() {
    if (sending) return
    // The two refusals this form makes without asking anybody. The kernel refuses a room with
    // no members at all, but the form never builds one — you are always in it — so these two
    // are states only this screen can rule out, and one round trip to be told what the form
    // already knows is a delay either way.
    if (name.trim() === '') {
      setStopped(t('ui.groups.form.name-empty'))
      return
    }
    // **Two, though the prototype's form asks for one.** Its `modalNewGroup()` refuses an
    // empty pick, because its data has a mode to keep a group apart from a direct message.
    // This store does not: the only division here is the headcount, and it is two. A group of
    // you and one other person would therefore be a direct message the moment it existed —
    // made from this screen and then absent from the list it was made in, which is a button
    // that does not do what it says. The threshold is what makes `Create` mean "a group".
    if (chosen.length < 2) {
      setStopped(t('ui.groups.form.nobody'))
      return
    }
    setSending(true)
    setStopped(null)
    try {
      // You first, then the chosen ones: `createRoom()` writes one membership per id in the
      // order it is given, and the room is listed in that order wherever it is drawn. An id
      // that is not a string is dropped by the main process rather than reaching the kernel,
      // which is also why a store with no self makes a group of the chosen alone.
      const made = await window.seekHost.createRoom({
        name,
        members: [me, ...chosen].filter((id) => typeof id === 'string' && id !== ''),
      })
      if (!made.ok) {
        // The kernel's own sentence, drawn beside the form it came from.
        setStopped(made.error)
        return
      }
      onSnapshot(made.snapshot)
      setMaking(false)
      setName('')
      setChosen([])
      // Into the group just made: making a group and staying in the list is a click that
      // appears to have done nothing.
      onOpen(made.roomId)
    } catch (failure) {
      setStopped(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setSending(false)
    }
  }

  return (
    <>
      <section className="list-col">
        {/* No count and no `+`: the count repeated a number the list shows by being as long as
            it is, and every thing this product makes is made from the rail's add mark
            (宿主, 2026-10-27: 这里的加号和数字不需要了). */}
        <header className="list-head">
          <h1>{t('ui.groups.title')}</h1>
        </header>

        <div className="list-search">
          <input
            className="field-input"
            data-groups="search"
            placeholder={t('ui.groups.search')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        {making && (
          <Dialog
            name="group"
            title={t('ui.rail.add-group')}
            submit={t('ui.groups.form.create')}
            cancel={t('ui.groups.form.cancel')}
            busy={sending}
            onSubmit={make}
            onClose={close}
          >
            <div className="dialog-fields">
              <div className="dialog-field">
                <label className="field-label" htmlFor="group-name">
                  {t('ui.groups.form.name')}
                </label>
                <input
                  id="group-name"
                  className="dialog-input"
                  data-new-group="name"
                  autoFocus
                  placeholder={t('ui.groups.form.name-hint')}
                  value={name}
                  onChange={(event) => {
                    forget()
                    setName(event.target.value)
                  }}
                />
              </div>

              <div className="dialog-field">
                <span className="field-label">{t('ui.groups.form.members')}</span>
                <ul className="dialog-people">
                  {others.map((person) => (
                    <li key={person.id}>
                      <label>
                        <input
                          type="checkbox"
                          data-new-group-member={person.id}
                          checked={chosen.includes(person.id)}
                          onChange={() => toggle(person.id)}
                        />
                        <span>{person.name}</span>
                        {/* The same word the contacts list chips a bot with: one product, one
                            word for what a bot is. */}
                        {person.bot && <span className="msg-bot">{t('ui.contacts.kind.bot')}</span>}
                      </label>
                    </li>
                  ))}
                </ul>
                {/* Why the person using the window is not in the list above. */}
                <p className="dialog-hint">{t('ui.groups.form.me-in')}</p>
              </div>
            </div>

            {/* The kernel's refusal, in the card that asked for it. */}
            {stopped && <p className="dialog-err" data-new-group="refused">{stopped}</p>}
          </Dialog>
        )}

        {/* The prototype's heading over its own list (`renderList()`: 我加入的群 + the count):
            these are the groups this store's person is in, not every group that exists. */}
        <div className="list-section-title">
          <span>{t('ui.groups.section')}</span>
          <span>{listed.length}</span>
        </div>

        <ul className="conv-list">
          {listed.map((room) => (
            <li key={room.id}>
              <button
                className={`conv${room.id === openId ? ' on' : ''}`}
                data-group-row={room.id}
                onClick={() => setOpenId(room.id)}
              >
                <span className="conv-av">{room.name.slice(0, 1).toUpperCase()}</span>
                <span className="conv-body">
                  <span className="conv-name">
                    {room.name}
                    {room.kind === 'topic' && (
                      <span className="chip blue">{t('ui.groups.kind.topic')}</span>
                    )}
                  </span>
                  {/* The count of people in it, which is also what made it a group. The
                      catalogue's own plural entry, the same one the room header draws. */}
                  <span className="conv-last">
                    {t('ui.members', { count: (room.members ?? []).length })}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>

        {listed.length === 0 && (
          <div className="empty">
            {wanted === ''
              ? t('ui.groups.none')
              : t('ui.groups.no-match', { query: query.trim() })}
          </div>
        )}
      </section>

      {/* The seam between the list and the card beside it. The grid reserved this 6px track
          before anything drew in it, so the list started 6px early and the edge could not be
          grabbed — the same gap the roster and the topics list had. */}
      <Gutter pane="list" />

      <section className="main-col">
        {open ? (
          <GroupPane room={open} me={me} onOpen={onOpen} />
        ) : (
          <div className="empty">{t('ui.groups.pick')}</div>
        )}
      </section>
    </>
  )
}

/**
 * Whether a room is a group here.
 *
 * The kernel's only stated division is the headcount: two members is a direct message
 * (`src/delivery.ts:418`), and `chat_mode` is stored and never branched on. So this is the
 * whole rule, and it is stated once, at the one place that needs it.
 */
function isGroup(room) {
  return (room.members ?? []).length !== 2
}

/** One group's card: what the store holds about it, and the way into the conversation. */
function GroupPane({ room, me, onOpen }) {
  const members = room.members ?? []
  return (
    <div className="pane" data-group-card={room.id}>
      <h2 className="pane-title">{room.name}</h2>
      <p className="pane-desc">
        {t(room.kind === 'topic' ? 'ui.groups.kind.topic-long' : 'ui.groups.kind.group-long')}
      </p>

      <div className="card">
        <div className="card-body">
          <div className="card-rows">
            <Row
              label={t('ui.groups.card.kind')}
              value={t(room.kind === 'topic' ? 'ui.groups.kind.topic' : 'ui.groups.kind.group')}
            />
            <Row label={t('ui.groups.card.members')} value={t('ui.members', { count: members.length })} />
            <Row label={t('ui.groups.card.id')} value={room.id} mono />
          </div>
        </div>
      </div>

      {/* Who is in it, which is the fact a group card can carry here: the prototype's
          description and update time have nothing behind them in this store. */}
      <div className="card">
        <div className="card-body">
          <div className="card-title">{t('ui.groups.members')}</div>
          <div className="card-rows">
            {members.map((member) => (
              <div className="card-row" key={member.id} data-group-member={member.id}>
                <span className="k">{member.name}</span>
                <span className="v">
                  {member.id === me
                    ? t('ui.groups.you')
                    : t(member.bot ? 'ui.contacts.kind.bot' : 'ui.contacts.kind.human')}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="field-actions">
        <button className="btn primary" data-group-open={room.id} onClick={() => onOpen(room.id)}>
          {t('ui.groups.open')}
        </button>
      </div>
    </div>
  )
}

/** One label/value pair of the card's table. */
function Row({ label, value, mono = false }) {
  return (
    <div className="card-row">
      <span className="k">{label}</span>
      <span className={`v${mono ? ' mono' : ''}`}>{value}</span>
    </div>
  )
}
