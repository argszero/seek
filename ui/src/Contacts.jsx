import { useEffect, useState } from 'react'

import { t } from './catalogue.mjs'
import Dialog from './Dialog.jsx'
import Gutter from './Gutter.jsx'

/**
 * The contacts view: everyone in this organization except the person looking, and a card for
 * whichever of them is chosen.
 *
 * **The prototype is the spec** (`prototype/src/js/app.js`): the rail row it labels 机器人, the
 * list `renderList()` draws for `view === 'contacts'`, and the card `renderContactPane()`
 * draws. What differs here is what this store forces, not a choice of this file:
 *
 * - **The list is everyone but me, each row saying which kind.** The prototype's `friends()`
 *   excludes `is_self` and chips each row 机器人 or 人, and this store's `people` arrives with
 *   a `bot` flag beside a `kind` (`ui/electron/snapshot.js`), so the chip is a fact rather
 *   than a guess.
 * - **The card draws what the kernel holds.** The prototype's person card carries English
 *   name, department, city, e-mail, mobile and employee number; `Principal` in `src/types.ts`
 *   is `id`, `kind`, `name`, `avatar`, `description`, and a bot adds the four fields the host
 *   asked for (`Bot`). A row for a field nothing stores would be a promise nothing keeps, so
 *   a person's card shows the kind, the description and the id, and a bot's adds the three
 *   it may carry.
 * - **The list is not sorted.** `peopleOf()` reads them in the order the store wrote them and
 *   says why — a list that reorders itself between two snapshots moves under a person's
 *   cursor while they are choosing. `docs/design/i18n.md` asks for locale-aware sorting *or*
 *   an order explicitly defined; this order is defined, in that docstring.
 *
 * **Every word here is the catalogue's** (`docs/design/i18n.md` §1), which is why this is a
 * file of its own rather than a component inside `App.jsx`: `catalogue.test.mjs` holds a
 * component whose text nodes carry no words of their own, and this view can be held to that
 * from the day it exists while `App.jsx` still speaks for the chat surface.
 *
 * **This file writes nothing to the store by itself except a bot.** `onMessage` is the main
 * screen's, because opening a conversation is navigation and the room list, the composer and
 * the rail all move with it; a bot is made from the list that holds bots, so that call is
 * here, beside its form.
 */
export default function Contacts({ people, me, firstLaw, refusal, onMessage, onSnapshot, ask, onAsked }) {
  const [query, setQuery] = useState('')
  const [openId, setOpenId] = useState(null)

  // The form's own state, because nothing outside this view draws it. `sending` is here too:
  // two presses on Add are one bot, and the second press is the one that makes a duplicate.
  const [making, setMaking] = useState(false)
  // The rail's add mark can ask this view to open its form. The ask is cleared as it is taken,
  // so it is one press for one form rather than a form that reopens every time somebody comes
  // back to this view.
  useEffect(() => {
    if (!ask) return
    setMaking(true)
    onAsked()
  }, [ask, onAsked])
  const [name, setName] = useState('')
  const [gender, setGender] = useState('')
  const [position, setPosition] = useState('')
  const [personality, setPersonality] = useState('')
  const [sending, setSending] = useState(false)
  const [stopped, setStopped] = useState(null)
  const [note, setNote] = useState(null)
  // Taking a bot out of the organization: one call in flight, and the kernel's own sentence
  // when it refuses (the one refusal a person can hit is a bot alone in a room).
  const [removing, setRemoving] = useState(false)
  const [removal, setRemoval] = useState(null)

  const others = people.filter((person) => person.id !== me)
  const wanted = query.trim().toLowerCase()
  const listed =
    wanted === '' ? others : others.filter((person) => person.name.toLowerCase().includes(wanted))
  const open = others.find((person) => person.id === openId) ?? null

  /**
   * Close the form, and forget what was typed in it.
   *
   * The dialog is one of four in this window and is opened from the rail's add mark, so it can
   * be cancelled at any point: a name half typed for one bot must not be the name the next one
   * is made with, and a refusal about the bot that was never made must not be waiting either.
   */
  function close() {
    setMaking(false)
    setStopped(null)
    setName('')
    setGender('')
    setPosition('')
    setPersonality('')
  }

  /**
   * Take one bot out of this organization.
   *
   * **The prototype's 移出这个组织, and it is the bot's own write** — `removeBot()` stamps the bot
   * and removes every membership it held (`src/bots.ts`), and the row stays so the messages it
   * wrote still name somebody. Nothing here re-checks any of that; the card closes because the
   * bot it was about is no longer in the list it came from.
   */
  async function takeOut(person) {
    if (removing) return
    setRemoving(true)
    setRemoval(null)
    setNote(null)
    try {
      const outcome = await window.seekHost.removeBot({ botId: person.id })
      if (!outcome.ok) {
        setRemoval(outcome.error)
        return
      }
      onSnapshot(outcome.snapshot)
      setOpenId(null)
    } catch (failure) {
      setRemoval(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setRemoving(false)
    }
  }

  async function add() {
    if (sending) return
    if (name.trim() === '') {
      // The one refusal this form can make without asking anybody. The kernel refuses an
      // empty name too, but a round trip to be told what this already knows is a delay.
      setStopped(t('ui.contacts.form.name-empty'))
      return
    }
    setSending(true)
    setStopped(null)
    setNote(null)
    try {
      const made = await window.seekHost.addBot({ name, gender, position, personality })
      if (!made.ok) {
        setStopped(made.error)
        return
      }
      onSnapshot(made.snapshot)
      // The card opens on the bot just made: a person who filled in four fields wants to see
      // what they came to, and the list is otherwise a row that looks like the others.
      setOpenId(made.botId)
      setMaking(false)
      setName('')
      setGender('')
      setPosition('')
      setPersonality('')
      // A bot with no roster rows is a bot that cannot answer, which is the whole reason
      // `roster` rides back from the bridge.
      if (made.roster === 'none') setNote(t('ui.contacts.form.no-roster'))
    } catch (failure) {
      setStopped(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setSending(false)
    }
  }

  return (
    <>
      <section className="list-col">
        {/* **No count and no `+`.** The count was a second number for a list you can see the
            length of, and the `+` was one of four ways in; every thing this product makes is
            now made from the rail's add mark (宿主, 2026-10-27: 这里的加号和数字不需要了). */}
        <header className="list-head">
          <h1>{t('ui.contacts.title')}</h1>
        </header>

        <div className="list-search">
          <input
            className="field-input"
            data-contacts="search"
            placeholder={t('ui.contacts.search')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        {/* **A make can answer with something a snapshot cannot show** — a bot with no roster
            rows cannot answer at all — and that line outlives the dialog it was made in, so it
            belongs beside the list rather than in a card that has just closed. */}
        {note && (
          <div className="composer-err" data-new-bot="note">
            {note}
          </div>
        )}

        {/* The refusals go here, beside the list, in the kernel's own words. */}
        {refusal && (
          <div className="composer-err" data-contacts="refused">
            {refusal}
          </div>
        )}
        {/* A bot that may not be taken out is a refusal about the card on the right, and the
            card has just closed — so it is drawn here, beside the list the bot came from, in
            the kernel's own sentence. */}
        {removal && (
          <div className="composer-err" data-contacts="removal-refused">
            {removal}
          </div>
        )}
        {making && (
          <Dialog
            name="bot"
            title={t('ui.rail.add-bot')}
            submit={t('ui.contacts.form.add')}
            cancel={t('ui.contacts.form.cancel')}
            busy={sending}
            onSubmit={add}
            onClose={close}
          >
            <div className="dialog-fields">
              <div className="dialog-field">
                <label className="field-label" htmlFor="bot-name">
                  {t('ui.contacts.form.name')}
                </label>
                <input
                  id="bot-name"
                  className="dialog-input"
                  data-new-bot="name"
                  autoFocus
                  value={name}
                  onChange={(event) => {
                    // A refusal names what is wrong with what is on screen; the person fixing
                    // it is the moment it stops being true, so it goes with the first keystroke
                    // rather than on the next press of Create.
                    setStopped(null)
                    setName(event.target.value)
                  }}
                />
              </div>

              <div className="dialog-field">
                <label className="field-label" htmlFor="bot-gender">
                  {t('ui.contacts.form.gender')}
                </label>
                <select
                  id="bot-gender"
                  className="dialog-input"
                  data-new-bot="gender"
                  value={gender}
                  onChange={(event) => setGender(event.target.value)}
                >
                  {/* The values are the store's (`Bot.gender` is written as it was typed, and
                      the three here are the ones the form offers); the words are the
                      catalogue's. */}
                  <option value="">{t('ui.contacts.not-said')}</option>
                  {GENDERS.map((one) => (
                    <option key={one.value} value={one.value}>
                      {t(one.key)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="dialog-field">
                <label className="field-label" htmlFor="bot-position">
                  {t('ui.contacts.form.position')}
                </label>
                <input
                  id="bot-position"
                  className="dialog-input"
                  data-new-bot="position"
                  placeholder={t('ui.contacts.form.position-hint')}
                  value={position}
                  onChange={(event) => setPosition(event.target.value)}
                />
              </div>

              <div className="dialog-field">
                <label className="field-label" htmlFor="bot-personality">
                  {t('ui.contacts.form.personality')}
                </label>
                <textarea
                  id="bot-personality"
                  className="dialog-input"
                  data-new-bot="personality"
                  rows={3}
                  placeholder={t('ui.contacts.form.personality-hint')}
                  value={personality}
                  onChange={(event) => setPersonality(event.target.value)}
                />
              </div>
            </div>

            {/* The kernel's refusal, in the card that asked for it. */}
            {stopped && <p className="dialog-err" data-new-bot="refused">{stopped}</p>}

            {/* The rule, quoted where the bot is made. `firstLaw` comes from the snapshot, which
                reads it from `ui/electron/law.js` — one copy for the three screens. */}
            <p className="dialog-hint" data-new-bot="law">
              {t('ui.contacts.form.law', { law: firstLaw })}
            </p>
          </Dialog>
        )}

        <ul className="conv-list">
          {listed.map((person) => {
            const under = lineUnder(person)
            return (
              <li key={person.id}>
                <button
                  className={`conv${person.id === openId ? ' on' : ''}`}
                  data-contact-row={person.id}
                  onClick={() => setOpenId(person.id)}
                >
                  <span className="conv-av">{person.name.slice(0, 1).toUpperCase()}</span>
                  <span className="conv-body">
                    <span className="conv-name">
                      {person.name}
                      <span className={`chip${person.bot ? '' : ' blue'}`}>
                        {t(person.bot ? 'ui.contacts.kind.bot' : 'ui.contacts.kind.human')}
                      </span>
                    </span>
                    {/* The prototype's line under the name — absent where there is nothing to
                        put in it, rather than a row padded to keep a shape. */}
                    {under !== null && <span className="conv-last">{under}</span>}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>

        {listed.length === 0 && (
          <div className="empty">
            {wanted === ''
              ? t('ui.contacts.nobody')
              : t('ui.contacts.no-match', { query: query.trim() })}
          </div>
        )}
      </section>

      {/* The same seam the chat view draws: this list is a column a person can widen. */}
      <Gutter pane="list" />

      <section className="main-col">
        {open ? (
          <ContactCard
            person={open}
            firstLaw={firstLaw}
            onMessage={onMessage}
            onRemove={takeOut}
            removing={removing}
          />
        ) : (
          <div className="empty">{t('ui.contacts.pick')}</div>
        )}
      </section>
    </>
  )
}

/** The three genders the form offers. The values are the store's, the words the catalogue's. */
const GENDERS = [
  { value: '女', key: 'ui.contacts.gender.female' },
  { value: '男', key: 'ui.contacts.gender.male' },
  { value: '其他', key: 'ui.contacts.gender.other' },
]

/** What a row says under a name: what it does, else what it is for, else nothing. */
function lineUnder(person) {
  const said = person.position ?? person.description
  if (said !== null && said !== undefined && said !== '') return said
  // The prototype's `botLine() || '机器人'`: a bot made before those fields existed still gets
  // a line, and the line is what it is. A person gets none — the chip beside the name already
  // says 人, and a line repeating it is a row saying what the row above it just said.
  return person.bot ? t('ui.contacts.kind.bot') : null
}

/** One person's card: what the store holds about them, and the way into a conversation. */
function ContactCard({ person, firstLaw, onMessage, onRemove, removing }) {
  return (
    <div className="pane" data-contact-card={person.id}>
      <h2 className="pane-title">{person.name}</h2>
      <p className="pane-desc">
        {t(person.bot ? 'ui.contacts.kind.bot-long' : 'ui.contacts.kind.human-long')}
      </p>

      <div className="card">
        <div className="card-body">
          <div className="card-rows">
            <Row label={t('ui.contacts.card.kind')} value={t(person.bot ? 'ui.contacts.kind.bot' : 'ui.contacts.kind.human')} />
            {person.bot && (
              <Row label={t('ui.contacts.card.gender')} value={genderWord(person.gender)} />
            )}
            {person.bot && (
              <Row label={t('ui.contacts.card.position')} value={said(person.position)} />
            )}
            <Row label={t('ui.contacts.card.description')} value={said(person.description)} />
            <Row label={t('ui.contacts.card.id')} value={person.id} mono />
          </div>
        </div>
      </div>

      {/* A personality is several lines, so it is its own block rather than a row aligned
          against a label column that would fold it. */}
      {person.bot && (
        <div className="card">
          <div className="card-body">
            <div className="card-title">{t('ui.contacts.card.personality')}</div>
            <p className="pane-desc" data-contact-field="personality">
              {person.personality ?? t('ui.contacts.card.nothing-said')}
            </p>
          </div>
        </div>
      )}

      {person.bot && (
        <div className="card">
          <div className="card-body">
            <div className="card-title">{t('ui.contacts.card.law')}</div>
            <p className="pane-desc" data-contact-field="law">
              {firstLaw}
            </p>
          </div>
        </div>
      )}

      <div className="field-actions">
        <button
          className="btn primary"
          data-contact-message={person.id}
          onClick={() => onMessage(person)}
        >
          {t('ui.contacts.message')}
        </button>
        {/* **The prototype's 移出这个组织**, and only on a bot's card: a person is the one this
            organization *is*, and taking them out is not a thing this product offers. It is a
            second button rather than a menu item because it is the one other thing a card is
            for, and it is on the danger side of the pair where the prototype puts it. */}
        {person.bot && (
          <button
            className="btn danger"
            data-contact-remove={person.id}
            disabled={removing}
            onClick={() => onRemove(person)}
          >
            {t('ui.contacts.take-out')}
          </button>
        )}
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

/** A stored string, or the catalogue's word for one nobody wrote. */
function said(value) {
  return value === null || value === undefined || value === '' ? t('ui.contacts.not-said') : value
}

/**
 * A stored gender, in the language this window speaks.
 *
 * `Bot.gender` holds what was typed, so a value this catalogue knows is drawn through it and
 * anything else is drawn as it stands: a word the store holds and the window has no
 * translation for is data, and replacing it with "not said" would be the window inventing an
 * absence.
 */
function genderWord(value) {
  const known = GENDERS.find((one) => one.value === value)
  return known ? t(known.key) : said(value)
}
