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
  if (reading.live.from === 'environment') {
    return 'Right now this half is the endpoint you started Seek with, from the environment. What you save here will not be used until you start it without those variables.'
  }
  if (reading.live.from === 'config') {
    return `Right now this half is the endpoint already configured on this machine (${reading.configPath}). Save below and this half becomes yours instead.`
  }
  if (reading.live.from === 'settings') return 'This half is the endpoint saved below.'
  return 'No endpoint is configured: this half is the model the app carries, which cannot write a turn that calls a tool.'
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
    ? `saved · ends ${reading.saved.keyTail} · ${reading.saved.keyLen} characters · type a new one to replace it`
    : 'no key saved'

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
      setNote(`${answer.models.length} models`)
      if (answer.models.length > 0 && model.trim() !== '' && !answer.models.includes(model.trim())) {
        setTested({ ok: false, kind: 'name', words: `the list has no “${model.trim()}”` })
      } else if (answer.models.length > 0) {
        setTested({ ok: true, words: `${answer.models.length} models, and this one is there` })
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
    setOrganizationNote('made — open it when you want to work in it')
  }

  async function saveRename(id) {
    const answer = await window.seekHost.renameOrganization({ id, name: renameText })
    if (!answer.ok) return setOrganizationNote(answer.error)
    setRenamingId(null)
    setOrganizationNote(null)
  }

  async function switchTo(id) {
    setOrganizationNote('opening…')
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
      `Delete “${organization.name}” and its directory? Rooms, messages, pictures and its roster go with it.`,
    )
    if (!yes) return
    setOrganizationNote('deleting…')
    const answer = await window.seekHost.removeOrganization(organization.id)
    setOrganizationNote(answer.ok ? 'moved to the trash' : answer.error)
  }

  async function save() {
    if (baseUrl.trim() === '') return setNote('the address is empty')
    if (model.trim() === '') return setNote('the model name is empty')
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
      setNote('saved — this half uses it from the next turn')
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="main-col settings-col">
      <header className="main-head">
        <h2>Settings</h2>
      </header>

      <div className="pane">
        <h3 className="pane-title">Organizations</h3>
        <p className="pane-desc">
          Each organization is its own world on this machine: its own person, its own bots, its
          own rooms, messages, pictures and roster, all in its own directory. Switching reads the
          other one; it moves and deletes nothing. A name here is a label for the list — it never
          becomes the name of the person inside.
        </p>

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
                        Save
                      </button>
                      <button className="btn" onClick={() => setRenamingId(null)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="organization-av">{organization.name.slice(0, 1).toUpperCase()}</span>
                      <span className="organization-name">{organization.name}</span>
                      {organization.id === currentId ? (
                        <span className="chip blue">open</span>
                      ) : (
                        <button className="btn" onClick={() => switchTo(organization.id)} data-organization-switch={organization.id}>
                          Switch
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
                        Rename
                      </button>
                      {organization.id === currentId ? null : (
                        <button
                          className="btn link"
                          onClick={() => removeOrganization(organization)}
                          data-organization-remove={organization.id}
                        >
                          Delete
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
                  placeholder="a name — shown in this list and nowhere else"
                  onChange={(event) => setNewOrganizationName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') makeOrganization()
                    if (event.key === 'Escape') setMakingOrganization(false)
                  }}
                  data-organization-new-input
                />
                <button className="btn primary" onClick={makeOrganization} data-organization-new-save>
                  Create
                </button>
                <button className="btn" onClick={() => setMakingOrganization(false)}>
                  Cancel
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
                  New organization
                </button>
                {organizationNote && <span className="card-sub" data-organization-note>{organizationNote}</span>}
              </div>
            )}
          </div>
        </div>

        <h3 className="pane-title">Models</h3>
        <p className="pane-desc">
          Seek asks two models two different questions. One decides whether a message is worth
          answering, the other writes the answer. The first is the app's own and is not
          configurable; the second is yours.
        </p>

        {/* ---- the half that writes ------------------------------------------------ */}
        <div className="card">
          <div className="card-body">
            <div className="card-title">
              Writes the words
              <span className={`chip${tested === null ? '' : tested.ok ? ' blue' : ' bad'}`}>
                {tested === null ? 'untested' : tested.ok ? 'reached' : 'not reached'}
              </span>
            </div>
            <p className="pane-desc card-sub">
              Remote · an OpenAI-compatible endpoint. Save below and this half uses it from the
              next turn.
            </p>
            {sourceLine(reading) && <p className="card-sub source">{sourceLine(reading)}</p>}
            {reading.refusal && (
              <p className="card-sub bad-text">{reading.refusal}</p>
            )}

            <label className="field">
              <span className="field-label">Address</span>
              <input
                className="field-input"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="https://…/v1"
                data-llm="base-url"
              />
            </label>

            <label className="field">
              <span className="field-label">Model</span>
              <span className="field-row">
                <input
                  className="field-input"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  placeholder="the name the endpoint serves"
                  data-llm="model"
                />
                <button
                  className="btn"
                  onClick={askForModels}
                  disabled={busy !== null}
                  data-llm="models"
                >
                  {busy === 'models' ? 'asking…' : 'List models'}
                </button>
              </span>
            </label>

            <label className="field">
              <span className="field-label">API key</span>
              <input
                className="field-input"
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={keyHint}
                data-llm="key"
              />
              <span className="card-sub">
                Kept in {reading.settingsPath ?? 'settings.json'} on this machine, readable only
                by you. It reaches this endpoint's requests and nothing else — the store stays
                local, and the judgement never leaves this machine at all.
              </span>
            </label>

            <div className="field-actions">
              <button className="btn primary" onClick={save} disabled={busy !== null} data-llm="save">
                {busy === 'save' ? 'saving…' : 'Save'}
              </button>
              {note && <span className="card-sub" data-llm="note">{note}</span>}
            </div>

            {tested && !tested.ok && (
              <div className="llm-error" data-llm="error">
                <div className="llm-error-title">
                  {tested.kind === 'name'
                    ? 'That model is not on this endpoint'
                    : tested.kind === 'save'
                      ? 'Not saved'
                      : 'The request did not get through'}
                </div>
                <div className="llm-error-raw">in its own words: {tested.words}</div>
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
              Decides whether to answer
              <span className={`chip${snapshot?.stage1?.server ? ' blue' : ''}`}>
                {snapshot?.stage1?.server ? 'ready' : snapshot?.stage1?.refusal ? 'not in use' : 'not started'}
              </span>
            </div>
            <p className="pane-desc card-sub">
              Local · the model the app carries. It reads token probabilities to answer one
              question — answer or stay quiet — and never writes a word into a room.
            </p>
            <div className="card-rows">
              <div className="card-row">
                <span className="k">running at</span>
                <span className="v mono">{snapshot?.stage1?.server ?? '—'}</span>
              </div>
              <div className="card-row">
                <span className="k">weights</span>
                <span className="v mono">{snapshot?.stage1?.pending ?? 'downloaded'}</span>
              </div>
              {snapshot?.stage1?.refusal && (
                <div className="card-row">
                  <span className="k">refused</span>
                  <span className="v bad-text">{snapshot.stage1.refusal}</span>
                </div>
              )}
            </div>
            <p className="card-sub">
              There is nothing to configure here: a hosted endpoint reports text, and this
              question is answered by probabilities. That is why the two halves are two cards.
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}
