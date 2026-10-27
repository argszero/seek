import { useState } from 'react'

import { t, when } from './catalogue.mjs'
import Gutter from './Gutter.jsx'

/**
 * The topics view: every thread in this store, whichever room it started in.
 *
 * **The prototype is the spec** (`prototype/src/js/app.js`): the rail row it labels 话题, the
 * list `renderList()` draws for `view === 'topics'`, the pane `renderTopicsPane()` draws, and
 * what a click on a row does (`openTopic()` — into the room, with that thread open). What
 * differs here is what this store forces, not a choice of this file.
 *
 * **Which messages are topics is the kernel's answer, not a count kept beside it.** A thread
 * is three facts a message carries (`src/types.ts`, written by `deliver()`): `chain` is the
 * root of the run, `root_id` the message it answers, `depth` how many hops from the root. A
 * message that caused nothing roots its own chain — `chain === message.id` — so a topic is a
 * message that is its own chain's root **and** has something in that chain, which is the line
 * the prototype's `topics()` draws too (`!m.root_id && counts[m.message_id]`): a message
 * nobody answered is not a topic. This file therefore reads no counter and keeps none.
 *
 * **The count is the whole chain, and that is deliberately bigger than the prototype's.** Its
 * `topics()` counts the messages whose `root_id` is the root — one hop. This window's thread
 * panel groups by `chain` instead (`App.jsx`: `messages.filter((m) => m.chain === openThread)`),
 * and `ui/electron/snapshot.js` states why it may: "the interface groups by `chain` and never
 * by anything it computes itself, so 'which messages are one thread' has one answer". A row
 * saying "3 replies" beside a panel listing four messages would be that one answer given
 * twice, and the count here would be the one to lose. So N counts the whole chain — every
 * message whose `chain` is the root, the root itself excluded — and a thread with replies to
 * its replies says a larger number here than the prototype said for the same thread.
 *
 * **The pane answers the topic that was chosen.** The prototype's `renderTopicsPane()` draws
 * every topic as a card, in a pane beside a list that already holds every topic: one fact
 * drawn twice. Everything that card says is kept — the root message's words, the room, the
 * reply count and the last reply's time — for the one topic picked, which is what the contacts
 * and groups views do in the same column.
 *
 * **No search box, because the prototype's topics list has none.** Its groups and contacts
 * lists filter on `q`; the topics branch goes straight to the section heading. Following that
 * is why this file has no `query` state, not an oversight.
 *
 * **`chat_mode` is not consulted.** `kind: 'topic'` on a room means a room where every message
 * starts its own topic; this view is about threads, which any room can have, and `chat_mode`
 * is stored and never branched on (`src/rooms.ts`).
 *
 * **Time is the locale's.** `when()` (`catalogue.mjs`) formats the instant with
 * `Intl.DateTimeFormat` for the catalogue's locale — `docs/design/i18n.md` §4 asks for absolute
 * dates formatted per locale, and the prototype's `listTime()` also draws 昨天 and weekday
 * names, which are translated words this store has no key for yet. So every row carries a
 * date and a time, and no relative word is written here to be translated later.
 *
 * **Every word here is the catalogue's** (`docs/design/i18n.md` §1), which is why this is a
 * file of its own: `ui/electron/catalogue.test.mjs` holds a view to having no words of its
 * own, and this one is held to that from the day it exists.
 *
 * **The one call out of this file is navigation.** `onOpen(roomId, rootId)` is the main
 * screen's, because opening a thread moves the room list, the composer, the rail and the
 * thread panel at once — the same reason the groups view's way in lives there.
 */
export default function Topics({ rooms, onOpen }) {
  const [openKey, setOpenKey] = useState(null)

  // Newest thread first, as the prototype sorts it. The comparison is on `created_at`, whose
  // ISO form orders lexicographically, so it does not depend on a locale or on `Date` parsing
  // a shape it was not given.
  const topics = topicsOf(rooms)
  // Braced rather than a bare arrow, and the comments kept clear of angle brackets: this view
  // is held to a scan that reads whatever sits between two angle brackets as words a person
  // sees, so it cannot tell an arrow from a tag, or a comment from prose. The form here is the
  // one that scan can read, which keeps the guard's teeth in both directions.
  const open = topics.find((topic) => {
    return keyOf(topic) === openKey
  }) ?? null
  // With nothing to pick, the pane says how a topic starts rather than asking for a choice
  // that is not on offer.
  const whenNone = topics.length === 0 ? t('ui.topics.none-hint') : t('ui.topics.pick')

  return (
    <>
      <section className="list-col">
        <header className="list-head">
          <h1>{t('ui.topics.title')}</h1>
          <span className="list-tools">
            <span className="count">{topics.length}</span>
          </span>
        </header>

        {/* The prototype's heading over its own list (`renderList()`: 全部话题 + the count):
            every thread in this store, across every room. */}
        <div className="list-section-title">
          <span>{t('ui.topics.section')}</span>
          <span>{topics.length}</span>
        </div>

        <ul className="conv-list">
          {topics.map((topic) => (
            <li key={keyOf(topic)}>
              <button
                className={`conv${keyOf(topic) === openKey ? ' on' : ''}`}
                data-topic-row={keyOf(topic)}
                onClick={() => setOpenKey(keyOf(topic))}
              >
                <span className="conv-av">{topic.room.name.slice(0, 1).toUpperCase()}</span>
                <span className="conv-body">
                  <span className="conv-name">{said(topic.root)}</span>
                  {/* Which room it is in, and how much was said in it — one sentence, so a
                      language may order the two halves as it needs to. */}
                  <span className="conv-last">
                    {t('ui.topics.row', {
                      room: topic.room.name,
                      count: topic.replies.length,
                    })}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>

        {topics.length === 0 && <div className="empty">{t('ui.topics.none')}</div>}
      </section>

      {/* The same seam the chat view draws: this list is a column a person can widen. */}
      <Gutter pane="list" />

      <section className="main-col">
        {open ? (
          <TopicPane topic={open} onOpen={onOpen} />
        ) : (
          <div className="empty">{whenNone}</div>
        )}
      </section>
    </>
  )
}

/**
 * Every topic in the store, newest first.
 *
 * One pass collects the chains that have something in them, and one more takes the roots
 * among them. Both read the kernel's own `chain`, so a store that groups its threads some
 * other way would need no change here — there is no other way to group them.
 */
function topicsOf(rooms) {
  const topics = []
  for (const room of rooms) {
    const messages = room.messages ?? []
    const inChain = new Map()
    for (const message of messages) {
      if (message.chain === message.id) continue
      const chain = inChain.get(message.chain)
      if (chain) chain.push(message)
      else inChain.set(message.chain, [message])
    }
    for (const message of messages) {
      // Only a root can be a topic: a reply's chain is somebody else's id.
      if (message.chain !== message.id) continue
      const replies = inChain.get(message.id)
      // A message nobody answered is not a topic — the prototype's own `topics()` rule.
      if (!replies || replies.length === 0) continue
      topics.push({ room, root: message, replies })
    }
  }
  // Newest reply first. `created_at` is ISO, so comparing the strings is the order the store
  // wrote them in, whatever the machine's locale or its date parsing.
  return topics.sort((left, right) => {
    const one = String(left.replies.at(-1).at)
    const other = String(right.replies.at(-1).at)
    return one === other ? 0 : one < other ? 1 : -1
  })
}

/** A topic's identity: the room it is in and the message that roots it. */
function keyOf(topic) {
  return `${topic.room.id}:${topic.root.id}`
}

/**
 * What a message says, for a line that has one line to say it in.
 *
 * A picture carries its words in `media`, and a message may have none at all, so neither case
 * is drawn as an empty row: the catalogue says what a picture is, the same way it says what a
 * bot is. The prototype's `bodyText()` does the same with its own two words.
 */
function said(message) {
  if (typeof message.text === 'string' && message.text !== '') return message.text
  // Two lookups rather than one chosen by a conditional: a key written inside an expression
  // is a key `catalogue.test.mjs` cannot see, and a view holding one word the languages do
  // not ship is the whole failure that file exists to catch.
  if (message.kind === 'image') return t('ui.topics.said.picture')
  // An attachment is named rather than described: the row in the message column says the
  // file's name, and a topic card that said "a file" would make two surfaces disagree about
  // one message that is the same fact in both.
  if (message.kind === 'file' && message.file) {
    return t('ui.topics.said.file', { name: message.file.name })
  }
  return t('ui.topics.said.nothing')
}

/** Who wrote a message, by the name the room's roster holds for them. */
function nameOf(room, id) {
  const member = (room.members ?? []).find((one) => one.id === id)
  return member ? member.name : id
}

/** One topic's card: what the store holds about it, and the way into the thread. */
function TopicPane({ topic, onOpen }) {
  const root = topic.root
  const last = topic.replies.at(-1)
  return (
    <div className="pane" data-topic-card={keyOf(topic)}>
      <h2 className="pane-title">{said(root)}</h2>
      <p className="pane-desc">
        {t('ui.topics.started-by', {
          name: nameOf(topic.room, root.sender),
          room: topic.room.name,
        })}
      </p>

      <div className="card">
        <div className="card-body">
          <div className="card-rows">
            <Row label={t('ui.topics.card.room')} value={topic.room.name} />
            <Row
              label={t('ui.topics.card.replies')}
              value={t('ui.topics.reply-count', { count: topic.replies.length })}
            />
            <Row label={t('ui.topics.card.last')} value={when(last.at)} />
            <Row label={t('ui.topics.card.id')} value={root.id} mono />
          </div>
        </div>
      </div>

      <div className="field-actions">
        <button
          className="btn primary"
          data-topic-open={keyOf(topic)}
          onClick={() => onOpen(topic.room.id, root.id)}
        >
          {t('ui.topics.open')}
        </button>
      </div>
    </div>
  )
}

/** One label/value pair of the card's table — the shape the other two views' cards draw. */
function Row({ label, value, mono = false }) {
  return (
    <div className="card-row">
      <span className="k">{label}</span>
      <span className={`v${mono ? ' mono' : ''}`}>{value}</span>
    </div>
  )
}
