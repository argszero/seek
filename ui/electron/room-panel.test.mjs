/**
 * What a room is to itself, and the two ways out of one.
 *
 * Five surfaces of the prototype the window did not have until 2026-10-27, and they are one
 * subject because they are one thing: the room as a participant rather than as a container.
 * `renderSide()` with `kind: 'info'` is the panel, `modalEditChat()` the form that changes it,
 * `leaveChat` the button that leaves it, `removeFriend` the one that takes a bot out of the
 * organization, and `delMember`-shaped removal the one that takes a person out of a room.
 *
 * **Three kernel writes are new, and each is a first.** Before this, `src/rooms.ts` could only
 * *make* a room and *add* a member, and `src/bots.ts` could only *create* a bot — nothing in the
 * kernel changed something already written or took something away. So the claims split by
 * layer, and this file is the window's half: the kernel's own refusals are `src/rooms.test.ts`
 * and `src/bots.test.ts`, the bridge-and-main vocabulary is `documentation.test.mjs`'s, and the
 * two README sentences are claimed there as well. What is checked here is the chain the window
 * needs: a panel that draws facts the store holds, a form whose four texts reach the kernel, two
 * buttons that reach the two removals, and **not one class without a rule behind it** — the
 * defect this repository has now shipped twice (`dialog-input`, then the four on the
 * organizations panel, #137).
 *
 * The one thing this file deliberately does **not** have is a test for 置顶会话 and 消息免打扰,
 * the prototype's two toggles. They are absent on purpose: nothing in this product reads either
 * flag, so a switch would change a field and nothing a person could observe — the same rule that
 * leaves `Aa` and `⤢` off the composer. A test here would be a test for a control that is not
 * there, which is a fine thing to write and is not this one.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const HERE = import.meta.dirname
const ROOT = join(HERE, '..', '..')
const read = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8')

const APP = read('ui', 'src', 'App.jsx')
const CONTACTS = read('ui', 'src', 'Contacts.jsx')
const SHELL = read('ui', 'src', 'styles', 'shell.css')
const PRELOAD = read('ui', 'electron', 'preload.js')
const MAIN = read('ui', 'electron', 'main.js')
const SNAPSHOT = read('ui', 'electron', 'snapshot.js')
const HOST = read('ui', 'electron', 'host.js')
const DEMO = read('prototype', 'src', 'fake-host.js')
const TYPES = read('src', 'types.ts')
const ROOMS = read('src', 'rooms.ts')
const BOTS = read('src', 'bots.ts')

/** The slice of a file between an opener and the first closer after it. */
function slice(text, opener, closer) {
  const from = text.indexOf(opener)
  assert.notEqual(from, -1, `${opener} is gone, so this check reads nothing`)
  const to = text.indexOf(closer, from)
  assert.notEqual(to, -1, `${opener} has no ${closer} after it`)
  return text.slice(from, to)
}

/** One rule's declarations, comments removed. */
function rule(css, selector) {
  const opener = `${selector} {`
  const from = css.indexOf(opener)
  assert.notEqual(from, -1, `the sheet has no rule for ${selector}`)
  const to = css.indexOf('}', from)
  const body = css.slice(from + opener.length, to).replace(/\/\*[\s\S]*?\*\//g, '')
  const declarations = {}
  for (const line of body.split('\n')) {
    const text = line.trim().replace(/;$/, '')
    if (text === '' || !text.includes(':')) continue
    const at = text.indexOf(':')
    declarations[text.slice(0, at).trim()] = text.slice(at + 1).trim()
  }
  return declarations
}

test('a room may carry three texts, and the bot that leaves keeps the row its messages name', () => {
  // The three texts are the room's, and they are the kernel's own fields — a window that drew
  // them off a field nothing writes would draw them off `undefined` on every room in the store.
  const room = slice(TYPES, 'export interface Room {', '\n}')
  for (const field of ['description?: string', 'announcement?: string', 'tag?: string']) {
    assert.ok(room.includes(field), `Room is missing ${field}, so the panel has nothing to draw`)
  }

  // A bot is stamped, not deleted: the refusal that could delete it is unwritten, and the
  // reason is in the type — every message it wrote names it.
  const bot = slice(TYPES, 'export interface Bot {', '\n}')
  assert.match(bot, /removed_at\?: string/)

  // The three writes, each by name, in the file that owns it.
  assert.match(ROOMS, /export function updateRoom\(/)
  assert.match(ROOMS, /export function removeMember\(/)
  assert.match(BOTS, /export function removeBot\(/)
})

test('every field the form can clear travels as a string, and one nobody touched does not travel', () => {
  // `updateRoom()` draws a real distinction between "not sent" and "sent empty": the first
  // leaves a text alone and the second clears it. The bridge is where that distinction is
  // made, so it is checked here rather than assumed — a bridge that always sent all four would
  // make the panel unable to keep a field it did not open.
  const written = slice(HOST, 'async function updateRoom(', '\n}\n')
  assert.match(written, /for \(const field of \['name', 'description', 'announcement', 'tag'\]\)/)
  assert.match(written, /if \(typeof input\?\.\[field\] === 'string'\) patch\[field\] = input\[field\]/)
  // Saved once, before the snapshot: an edit drawn but not saved reverts at the next open,
  // which reads as the app forgetting what it was told.
  assert.ok(
    written.indexOf('store.save()') < written.indexOf('snapshotOf('),
    'the edit is drawn before it is saved',
  )

  // And the two removals each save once as well, for the same reason.
  for (const name of ['removeMember', 'removeBot']) {
    const call = slice(HOST, `async function ${name}(`, '\n}\n')
    assert.match(call, /store\.save\(\)/)
  }
})

test('the three calls exist on all four surfaces a person reaches them through', () => {
  // The page …
  assert.match(APP, /window\.seekHost\.updateRoom\(\{/)
  assert.match(APP, /window\.seekHost\.removeMember\(\{ roomId: active\.id, principalId \}\)/)
  assert.match(APP, /window\.seekHost\.removeMember\(\{ roomId: active\.id, principalId: me \}\)/)
  assert.match(CONTACTS, /window\.seekHost\.removeBot\(\{ botId: person\.id \}\)/)
  // … the bridge …
  for (const [name, channel] of [
    ['updateRoom', 'seek:update-room'],
    ['removeMember', 'seek:remove-member'],
    ['removeBot', 'seek:remove-bot'],
  ]) {
    assert.match(
      PRELOAD,
      new RegExp(`${name}: \\(input\\) => ipcRenderer\\.invoke\\('${channel}', input\\)`),
    )
    // … the main process …
    assert.match(MAIN, new RegExp(`ipcMain\\.handle\\('${channel}'`))
    // … and the demo, which is the window's own host with a fixture behind it: a call the
    // demo cannot answer is a prototype that breaks the moment a person presses the button.
    assert.match(DEMO, new RegExp(`${name}: async \\(input\\) =>`))
  }
  // Every one of the three tells the other windows, so a second window is not left showing a
  // room under a name that changed.
  for (const channel of ['seek:update-room', 'seek:remove-member', 'seek:remove-bot']) {
    const handler = slice(MAIN, `ipcMain.handle('${channel}'`, '\n})\n')
    assert.match(handler, /win\.webContents\.send\('seek:changed'/, `${channel} does not broadcast`)
  }
})

test('the panel draws the room’s own facts, and a removed bot is in no list of who could be added', () => {
  // What the snapshot may hand over: the three texts and the moment the room was made, each
  // read off the kernel's field rather than invented.
  for (const field of ['description', 'announcement', 'tag']) {
    assert.match(SNAPSHOT, new RegExp(`${field}: textOrNull\\(room\\.${field}\\)`))
  }
  assert.match(SNAPSHOT, /createdAt: room\.created_at/)

  // **One place reads the stamp, and two answers come out of it**: the list that may offer a
  // bot, and the map that still names one. Filtered on the stamp and never on a flag beside it.
  assert.match(SNAPSHOT, /const stamped = new Set\(/)
  assert.match(SNAPSHOT, /\.filter\(\(bot\) => bot\.removed_at !== undefined\)/)
  assert.match(SNAPSHOT, /return people\.filter\(\(one\) => !stamped\.has\(one\.id\)\)/)
  assert.match(SNAPSHOT, /function namedOf\(store\)/)
  assert.match(SNAPSHOT, /named: namedOf\(store\)/)
  // And the window looks a line's sender up there, with the room's own row layered over it —
  // built from members alone, a bot that left took its name off the sentences it wrote
  // (measured 2026-10-27: `ou_447c1cba8e4d4bee` where `Echobot` had been).
  assert.match(APP, /const whoSaid = \{ \.\.\.\(snap\.named \?\? \{\}\)/)

  // The panel itself, by its own marks: the four texts, the two answers and the way into the
  // member list. A `data-room-field` nobody sets would be the same nothing the panel draws for
  // a text nobody wrote, so each is asserted rather than counted.
  for (const mark of [
    'data-room-field="name"',
    'data-room-field="description"',
    'data-room-field="announcement"',
    'data-room-field="tag"',
    'data-room-edit="open"',
    'data-room-leave="leave"',
    'data-room-info="open"',
  ]) {
    assert.ok(APP.includes(mark), `the panel has no ${mark}`)
  }
  // The four fields of the form, each one a box the kernel accepts.
  for (const field of ['name', 'description', 'announcement', 'tag']) {
    assert.ok(
      APP.includes(`data-room-edit="${field}"`),
      `the edit form has no ${field} field, so updateRoom() can never be sent one`,
    )
  }

  // The two ways out, each on the surface that can see who it is about: a member out of the
  // room from the people list, a bot out of the organization from its own card.
  assert.match(APP, /data-people-remove=\{person\.id\}/)
  assert.match(CONTACTS, /data-contact-remove=\{person\.id\}/)
  // The bot's button is a bot's: a person is the one this organization is, and taking them out
  // is not something this product offers.
  assert.match(CONTACTS, /\{person\.bot && \(\s*<button/)
})

test('one column holds one panel at a time, and the room’s panel does not outlive the thread', () => {
  // The side column is the thread's and the room's. Drawing both would be two answers to one
  // question, so the thread stands down while the panel is up — and the shell's class, which
  // is what makes the column exist in the grid, is on for either.
  //
  // **Both gates and the class read one condition.** They were three separate expressions, and
  // the class was the one that named the chat view, so the panel it was meant to lay out was a
  // 6px sliver on the other four views (see the test at the foot of this file).
  assert.match(APP, /\{sideOpen && openThread !== null && !infoOpen && \(/)
  assert.match(APP, /\{sideOpen && infoOpen && \(/)
  assert.match(APP, /\{`app\$\{sideOpen \? ' with-thread' : ''\}/)
})

test('every class the new panel draws has a rule, and the two buttons are the two shapes', () => {
  // The defect this repository has shipped twice is a class with no rule: the browser's own
  // input for `.dialog-input` and an unstyled `<ul>` for the organizations panel. Each new
  // class is named with the rule that draws it, so a rename on either side fails here.
  for (const selector of [
    '.room-info-mark',
    '.room-col .room-body',
    '.room-name',
    '.room-sub',
    '.room-members',
    '.room-member',
    '.room-member-name',
    '.room-member-me',
    '.room-manage',
    '.room-tag',
    '.room-actions',
    '.btn.danger',
    '.people-remove',
  ]) {
    rule(SHELL, selector)
  }

  // The two answers are not the same button twice: 编辑 keeps the room and 退出 ends it, so the
  // second is the danger shape the prototype uses (`data-role="leave-chat"`, `.btn danger`).
  assert.notEqual(rule(SHELL, '.btn.danger').background, undefined)
  assert.equal(rule(SHELL, '.btn.danger').color, 'var(--R500)')
  // And the member's way out is red too, for the same reason, while the way in is not.
  assert.equal(rule(SHELL, '.people-remove').color, 'var(--R500)')

  // The mark is the chat header's, so it is sized like the count beside it rather than like the
  // rail's glyphs: 26px is the composer's hit area and the thread's close button.
  const mark = rule(SHELL, '.room-info-mark')
  assert.equal(mark.width, '26px')
  assert.equal(mark.height, '26px')

  // The panel scrolls, because 退出 is at its foot: a panel taller than the window with no
  // scroll is a button a person cannot reach.
  assert.equal(rule(SHELL, '.room-col .room-body')['overflow-y'], 'auto')
})

/** A track list split on its top-level spaces, so `minmax(0, 1fr)` stays one track. */
function tracks(value) {
  const out = []
  let depth = 0
  let current = ''
  for (const ch of value.trim()) {
    if (ch === '(') depth += 1
    if (ch === ')') depth -= 1
    if (/\s/.test(ch) && depth === 0) {
      if (current !== '') out.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current !== '') out.push(current)
  return out
}

test('the side column is laid out wherever the panel is drawn, not only in the chat view', () => {
  // **The class that declares the column belongs to the panel, not to a view.** It was keyed to
  // `view === 'chat'` while the panel is drawn on every view that reads a room, so on the other
  // four `.app` declared five tracks for seven children: the panel wrapped onto a second,
  // implicit row and measured **6px** wide, its contents painted from y 780 to y 1030 in a
  // window 780 tall (measured 2026-10-27 at 1180×780 — chat 380px, Bots/Groups/Topics 6px).
  // The guard is the shape of the agreement rather than the pixels: one condition, read by the
  // class and by both panels, so a fifth place cannot decide it differently.
  const condition = slice(APP, 'const sideOpen =', '\n')
  assert.ok(
    !condition.includes("'chat'"),
    'the side column is keyed to the chat view again, which is the 6px sliver',
  )
  assert.doesNotMatch(
    APP,
    /\(openThread \|\| infoOpen\) && view === 'chat'/,
    'the old form is back: the panel is drawn on views whose grid has no track for it',
  )
  assert.match(APP, /className=\{`app\$\{sideOpen \? ' with-thread' : ''\}/)
  assert.equal(
    APP.split('sideOpen &&').length - 1,
    2,
    'the two side panels are not both gated on the same condition that declares the column',
  )

  // Seven tracks: rail, seam, list, seam, the room, seam, the panel. `rule()` reads one
  // declaration per line and this value spans three, so it is taken here whole.
  const block = slice(SHELL, '.app.with-thread {', '}')
  const value = /grid-template-columns:([\s\S]*?);/.exec(block)[1]
  const found = tracks(value)
  assert.equal(found.length, 7, `.app.with-thread declares ${found.length} tracks: ${found.join(' | ')}`)
  assert.equal(found[5], 'var(--gutter-w)', 'the panel has no seam beside it')
  assert.equal(found[6], 'minmax(var(--side-min), var(--side-w))', 'the last track is not the side panel')
})
