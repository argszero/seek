/**
 * The settings page, and the only place in this window that writes a file.
 *
 * **Why a page and not an environment variable.** A downloaded app is opened by double-click,
 * and a double-click sets no variable — so the words half could only be pointed anywhere by
 * editing `~/.emrg/config.toml`, which is another program's file, or by starting Seek from a
 * terminal. This page is where a person answers the question in the place they are already
 * looking, and `settings.json` beside the app's data is where the answer is kept.
 *
 * **Two halves, drawn as two cards, and only one of them is configurable.** The judgement —
 * whether a message is worth answering — reads token probabilities from the model the package
 * carries (`src/llama.ts`), and no hosted endpoint can answer that question; it is local, it
 * costs nothing per turn, and there is nothing about it to configure. Drawing the two together
 * as one "model settings" screen is the confusion this page exists to prevent, so the second
 * card states the halves it cannot be given and shows only what is true of it.
 *
 * **Every word on this page comes from the catalogue.** `docs/design/i18n.md` §1 counts a
 * literal in a component as a bug, and §2 makes the interface's language a setting; this page
 * held sixty of them, which made it the largest single block of that bug in the window. They
 * are `ui.settings.*` keys now, read through `t()` — including the sentences this page makes up
 * in an event handler, such as what it says after a save. The one thing left as words is the
 * endpoint's own answer when a request fails: that is data quoted back, not chrome
 * (`ui.settings.models.error-own-words` is the frame around it).
 *
 * **Nothing is drawn before a catalogue is bound.** `App` returns early until
 * `seek:catalogue` has answered, so every `t()` below runs with words in hand — and a key
 * nobody shipped throws instead of drawing itself, which is the failure the lookup's docstring
 * argues for.
 *
 * **The key is never in this component.** `window.seekHost.llm()` answers whether there is one,
 * its last four characters and its length — enough to recognise which key is in place, not
 * enough to use it. The field starts empty on every draw, and an empty field means "leave the
 * key as it is" rather than "remove it", because a form that erased a credential whenever
 * someone fixed a typo in the address would be a trap.
 *
 * **This page asks the endpoint nothing.** It used to: a `List models` button beside the model
 * field, answered from the main process because a request from this page's origin to an
 * arbitrary endpoint comes back as `Failed to fetch` with no status and no body. The host took
 * that button away on 2026-10-27 (不需要 list models 按钮), and with it went the whole chain
 * behind it — the `seek:llm-models` call, its handler, and the three words the card's chip used
 * to say. What a save cannot do is now said where it always was: the page writes the file and
 * the main process re-opens the host around it, so a turn is the first thing to find out whether
 * the endpoint answers.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import { size, t } from './catalogue.mjs'

const EMPTY = {
  live: { baseUrl: null, model: null, from: null, hasKey: false, keyTail: '', keyLen: 0 },
  saved: { baseUrl: null, model: null, hasKey: false, keyTail: '', keyLen: 0 },
  refusal: null,
  settingsPath: null,
  configPath: null,
}

/** Which of the three sources the words half is reading, said in a person's words. */
function sourceLine(reading) {
  if (reading.refusal) return null
  if (reading.live.from === 'environment') return t('ui.settings.source.environment')
  if (reading.live.from === 'config') {
    return t('ui.settings.source.config', { path: reading.configPath })
  }
  if (reading.live.from === 'settings') return t('ui.settings.source.settings')
  return t('ui.settings.source.none')
}

/**
 * The settings page: what this machine's models are, and which worlds exist on it.
 *
 * **It does not make an organization.** It used to — a field at the foot of the list — and the
 * host moved that out on 2026-10-27 (创建组织，不要跳转到 settings … 在当前窗口实现就行): the page
 * now switches between worlds and deletes one, and the making happens in a form over whatever
 * view is open (`App.jsx`, the rail's add mark). The page still reads the list from the same
 * snapshot it always did.
 */
export default function Settings({ snapshot }) {
  const [reading, setReading] = useState(EMPTY)
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(null)
  // The list of organizations, from the snapshot the window already draws. `currentOrganizationId`
  // is the one open; the rest are one press away, and switching is a read of another directory
  // rather than a move of any file.
  const organizations = snapshot?.organizations ?? []
  const currentId = snapshot?.currentOrganizationId ?? null
  const [renamingId, setRenamingId] = useState(null)
  const [renameText, setRenameText] = useState('')
  const [organizationNote, setOrganizationNote] = useState(null)
  // A save that did not go through, in the main process's own words. `null` is the resting
  // state, and it is no longer three words on a chip: with nothing left on this page to ask an
  // endpoint, a chip saying `untested` would be a label a person can never change.
  const [failure, setFailure] = useState(null)
  const [note, setNote] = useState(null)

  const load = useCallback(async () => {
    if (!window.seekHost?.llm) return
    const next = await window.seekHost.llm()
    setReading(next)
    // The form starts from what is *saved*, so pressing Save twice saves the same thing. Where
    // nothing is saved yet it starts from what is in use, so an endpoint already configured on
    // this machine can be adopted by pressing Save rather than retyped.
    setBaseUrl(next.saved.baseUrl ?? next.live.baseUrl ?? '')
    setModel(next.saved.model ?? next.live.model ?? '')
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const hasSavedKey = reading.saved.hasKey
  const keyHint = hasSavedKey
    ? t('ui.settings.models.key-hint-saved', {
        tail: reading.saved.keyTail,
        length: reading.saved.keyLen,
      })
    : t('ui.settings.models.key-hint-none')

  /** The endpoint this page would ask, and the key it would ask with. */
  const candidate = useMemo(
    () => ({ baseUrl: baseUrl.trim(), apiKey: apiKey.trim() }),
    [baseUrl, apiKey],
  )

  async function saveRename(id) {
    const answer = await window.seekHost.renameOrganization({ id, name: renameText })
    if (!answer.ok) return setOrganizationNote(answer.error)
    setRenamingId(null)
    setOrganizationNote(null)
  }

  async function switchTo(id) {
    setOrganizationNote(t('ui.settings.organizations.opening'))
    const answer = await window.seekHost.switchOrganization(id)
    setOrganizationNote(answer.ok ? null : answer.error)
  }

  /**
   * Take an organization out: its row and its directory together.
   *
   * The window asks first, because this is the one step in the app that destroys a world — and
   * the question names the directory that goes, so the answer is about something a person can
   * picture. The last organization, and the open one, are refused by the main process in its own
   * words rather than by a greying-out here: a button that is not drawn says nothing about why.
   */
  async function removeOrganization(organization) {
    const yes = window.confirm(
      t('ui.settings.organizations.delete-question', { name: organization.name }),
    )
    if (!yes) return
    setOrganizationNote(t('ui.settings.organizations.deleting'))
    const answer = await window.seekHost.removeOrganization(organization.id)
    setOrganizationNote(answer.ok ? t('ui.settings.organizations.deleted') : answer.error)
  }

  async function save() {
    if (baseUrl.trim() === '') return setNote(t('ui.settings.models.address-empty'))
    if (model.trim() === '') return setNote(t('ui.settings.models.model-empty'))
    setBusy('save')
    setNote(null)
    try {
      const answer = await window.seekHost.saveLlm({ ...candidate, model: model.trim() })
      if (!answer.ok) {
        setFailure({ words: answer.error })
        return
      }
      setFailure(null)
      setReading(answer.llm)
      setApiKey('')
      setNote(t('ui.settings.models.saved'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="main-col settings-col">
      <header className="main-head">
        <h2>{t('ui.settings.title')}</h2>
      </header>

      <div className="pane">
        {/* **Two sections, and the order is the point: the machine first, the organizations
            after it.** A model is set once for this machine and every organization answers
            with it (the host ruled so on 2026-10-27), so it must not read as a property of
            the list below it — which is exactly what the previous order said: organizations
            first, models under them, one heading apart and nothing between. Said twice and
            still read the same way, so the layout says it instead of the sentence. */}
        <div className="settings-section">
          <h3 className="pane-title">{t('ui.settings.machine.title')}</h3>
          <p className="pane-desc">{t('ui.settings.models.description')}</p>

          {/* ---- the half that writes ------------------------------------------------ */}
          <div className="card">
            <div className="card-body">
              <div className="card-title">{t('ui.settings.models.writes')}</div>
              <p className="pane-desc card-sub">{t('ui.settings.models.writes-description')}</p>
              {sourceLine(reading) && <p className="card-sub source">{sourceLine(reading)}</p>}
              {reading.refusal && (
                <p className="card-sub bad-text">{reading.refusal}</p>
              )}

              <label className="field">
                <span className="field-label">{t('ui.settings.models.address')}</span>
                <input
                  className="field-input"
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder={t('ui.settings.models.address-hint')}
                  data-llm="base-url"
                />
              </label>

              <label className="field">
                <span className="field-label">{t('ui.settings.models.model')}</span>
                <input
                  className="field-input"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  placeholder={t('ui.settings.models.model-hint')}
                  data-llm="model"
                />
              </label>

              <label className="field">
                <span className="field-label">{t('ui.settings.models.api-key')}</span>
                <input
                  className="field-input"
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={keyHint}
                  data-llm="key"
                />
                <span className="card-sub">
                  {t('ui.settings.models.key-note', { path: reading.settingsPath ?? 'settings.json' })}
                </span>
              </label>

              <div className="field-actions">
                <button className="btn primary" onClick={save} disabled={busy !== null} data-llm="save">
                  {busy === 'save' ? t('ui.settings.saving') : t('ui.settings.save')}
                </button>
                {note && <span className="card-sub" data-llm="note">{note}</span>}
              </div>

              {failure && (
                <div className="llm-error" data-llm="error">
                  <div className="llm-error-title">{t('ui.settings.models.error-save')}</div>
                  <div className="llm-error-raw">
                    {t('ui.settings.models.error-own-words', { words: failure.words })}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* ---- the half that decides ---------------------------------------------- */}
          <div className="card">
            <div className="card-body">
              <div className="card-title">
                {t('ui.settings.decides.title')}
                <span className={`chip${snapshot?.stage1?.server ? ' blue' : ''}`}>
                  {snapshot?.stage1?.server
                    ? t('ui.settings.decides.ready')
                    : snapshot?.stage1?.refusal
                      ? t('ui.settings.decides.not-in-use')
                      : t('ui.settings.decides.not-started')}
                </span>
              </div>
              <p className="pane-desc card-sub">{t('ui.settings.decides.description')}</p>
              <div className="card-rows">
                <div className="card-row">
                  <span className="k">{t('ui.settings.decides.running-at')}</span>
                  <span className="v mono">{snapshot?.stage1?.server ?? '—'}</span>
                </div>
                <div className="card-row">
                  <span className="k">{t('ui.settings.decides.weights')}</span>
                  <span className="v mono">
                    {/* **Three facts, not one sentence and not the object itself.** `pending`
                        became `{received, total, file}` when the download line stopped being
                        composed in the main process (`docs/design/i18n.md` §1: its language was
                        fixed before the window had one). This row kept interpolating the value
                        whole, so on a machine with no weights it drew an object as a React child
                        — error #31, and the throw took the whole page with it: a fresh install
                        opened on an empty `#root`, measured on the `v0.1.8` download. The bytes
                        go through `size()` because §4 keeps a size in the formatting layer. */}
                    {snapshot?.stage1?.pending
                      ? t('ui.settings.decides.downloading', {
                          got: size(snapshot.stage1.pending.received),
                          all: size(snapshot.stage1.pending.total),
                        })
                      : t('ui.settings.decides.downloaded')}
                  </span>
                </div>
                {snapshot?.stage1?.refusal && (
                  <div className="card-row">
                    <span className="k">{t('ui.settings.decides.refused')}</span>
                    <span className="v bad-text">{snapshot.stage1.refusal}</span>
                  </div>
                )}
              </div>
              <p className="card-sub">{t('ui.settings.decides.nothing-to-configure')}</p>
            </div>
          </div>
        </div>

        <div className="settings-section">
          <h3 className="pane-title">{t('ui.settings.organizations.title')}</h3>
          <p className="pane-desc">{t('ui.settings.organizations.description')}</p>

          <div className="card">
            <div className="card-body">
              <ul className="organization-list">
                {organizations.map((organization) => (
                  <li key={organization.id} className="organization-row">
                    {renamingId === organization.id ? (
                      <>
                        <input
                          className="field-input"
                          value={renameText}
                          autoFocus
                          onChange={(event) => setRenameText(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') saveRename(organization.id)
                            if (event.key === 'Escape') setRenamingId(null)
                          }}
                          data-organization-rename-input={organization.id}
                        />
                        <button className="btn primary" onClick={() => saveRename(organization.id)}>
                          {t('ui.settings.save')}
                        </button>
                        <button className="btn" onClick={() => setRenamingId(null)}>
                          {t('ui.settings.cancel')}
                        </button>
                      </>
                    ) : (
                      <>
                        <span className="organization-av">{organization.name.slice(0, 1).toUpperCase()}</span>
                        <span className="organization-name">{organization.name}</span>
                        {organization.id === currentId ? (
                          <span className="chip blue">{t('ui.settings.organizations.open')}</span>
                        ) : (
                          <button className="btn" onClick={() => switchTo(organization.id)} data-organization-switch={organization.id}>
                            {t('ui.settings.organizations.switch')}
                          </button>
                        )}
                        <button
                          className="btn link"
                          onClick={() => {
                            setRenamingId(organization.id)
                            setRenameText(organization.name)
                          }}
                          data-organization-rename={organization.id}
                        >
                          {t('ui.settings.organizations.rename')}
                        </button>
                        {organization.id === currentId ? null : (
                          <button
                            className="btn link"
                            onClick={() => removeOrganization(organization)}
                            data-organization-remove={organization.id}
                          >
                            {t('ui.settings.organizations.delete')}
                          </button>
                        )}
                      </>
                    )}
                  </li>
                ))}
              </ul>

              {/* The list is where a world is opened, renamed or taken away. Making one is
                  not here: the rail's add mark does that over whatever view is open. What is
                  left of this row is the answer to the last of those three. */}
              {organizationNote && (
                <p className="card-sub" data-organization-note style={{ marginTop: 12 }}>
                  {organizationNote}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
