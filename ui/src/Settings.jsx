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
 * **Testing the endpoint happens in the main process**, through `seekHost.models()`. The same
 * request made here would be a request from this page's origin, and an endpoint that does not
 * answer with CORS headers turns it into `Failed to fetch` with no status and no body —
 * measured on a real endpoint, not assumed. From there it is a plain request, so a refusal can
 * be quoted in the endpoint's own words.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import { t } from './catalogue.mjs'

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
  const [newOrganizationName, setNewOrganizationName] = useState('')
  const [makingOrganization, setMakingOrganization] = useState(false)
  const [renamingId, setRenamingId] = useState(null)
  const [renameText, setRenameText] = useState('')
  const [organizationNote, setOrganizationNote] = useState(null)
  const [tested, setTested] = useState(null)
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

  async function askForModels() {
    setBusy('models')
    setNote(null)
    try {
      const answer = await window.seekHost.models(candidate)
      if (!answer.ok) {
        setTested({ ok: false, kind: 'http', words: answer.error, body: answer.body })
        return []
      }
      setNote(t('ui.settings.models.none-listed', { count: answer.models.length }))
      if (answer.models.length > 0 && model.trim() !== '' && !answer.models.includes(model.trim())) {
        setTested({
          ok: false,
          kind: 'name',
          words: t('ui.settings.models.not-listed', { model: model.trim() }),
        })
      } else if (answer.models.length > 0) {
        setTested({
          ok: true,
          words: t('ui.settings.models.listed-and-there', { count: answer.models.length }),
        })
      }
      return answer.models
    } catch (error) {
      setTested({ ok: false, kind: 'offline', words: error?.message ?? String(error) })
      return []
    } finally {
      setBusy(null)
    }
  }

  async function makeOrganization() {
    const answer = await window.seekHost.createOrganization(newOrganizationName)
    if (!answer.ok) return setOrganizationNote(answer.error)
    setMakingOrganization(false)
    setNewOrganizationName('')
    setOrganizationNote(t('ui.settings.organizations.made'))
  }

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
        setTested({ ok: false, kind: 'save', words: answer.error })
        return
      }
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
              <div className="card-title">
                {t('ui.settings.models.writes')}
                <span className={`chip${tested === null ? '' : tested.ok ? ' blue' : ' bad'}`}>
                  {tested === null
                    ? t('ui.settings.test.untested')
                    : tested.ok
                      ? t('ui.settings.test.reached')
                      : t('ui.settings.test.not-reached')}
                </span>
              </div>
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
                <span className="field-row">
                  <input
                    className="field-input"
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                    placeholder={t('ui.settings.models.model-hint')}
                    data-llm="model"
                  />
                  <button
                    className="btn"
                    onClick={askForModels}
                    disabled={busy !== null}
                    data-llm="models"
                  >
                    {busy === 'models' ? t('ui.settings.models.listing') : t('ui.settings.models.list')}
                  </button>
                </span>
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

              {tested && !tested.ok && (
                <div className="llm-error" data-llm="error">
                  <div className="llm-error-title">
                    {tested.kind === 'name'
                      ? t('ui.settings.models.error-name')
                      : tested.kind === 'save'
                        ? t('ui.settings.models.error-save')
                        : t('ui.settings.models.error-http')}
                  </div>
                  <div className="llm-error-raw">
                    {t('ui.settings.models.error-own-words', { words: tested.words })}
                  </div>
                  {tested.body && <div className="llm-error-raw">{tested.body}</div>}
                </div>
              )}
              {tested?.ok && <p className="card-sub" data-llm="ok">{tested.words}</p>}
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
                    {snapshot?.stage1?.pending ?? t('ui.settings.decides.downloaded')}
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

              {makingOrganization ? (
                <div className="field-row" style={{ marginTop: 12 }}>
                  <input
                    className="field-input"
                    value={newOrganizationName}
                    autoFocus
                    placeholder={t('ui.settings.organizations.name-hint')}
                    onChange={(event) => setNewOrganizationName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') makeOrganization()
                      if (event.key === 'Escape') setMakingOrganization(false)
                    }}
                    data-organization-new-input
                  />
                  <button className="btn primary" onClick={makeOrganization} data-organization-new-save>
                    {t('ui.settings.create')}
                  </button>
                  <button className="btn" onClick={() => setMakingOrganization(false)}>
                    {t('ui.settings.cancel')}
                  </button>
                </div>
              ) : (
                <div className="field-actions">
                  <button
                    className="btn"
                    onClick={() => {
                      setNewOrganizationName('')
                      setMakingOrganization(true)
                    }}
                    data-organization-new
                  >
                    {t('ui.settings.organizations.new')}
                  </button>
                  {organizationNote && <span className="card-sub" data-organization-note>{organizationNote}</span>}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
