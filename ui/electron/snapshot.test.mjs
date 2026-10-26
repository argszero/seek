/**
 * The bridge between the kernel and the interface.
 *
 * `snapshotOf` is the only thing the renderer ever sees, so what it decides is what the
 * interface can show: which rooms exist, who is in them, and what was said. It runs
 * under plain `node --test` — no Electron — because the whole point of the split is
 * that this mapping is ordinary code, not something only a running app can exercise.
 *
 * **The messages are made by the kernel's own `deliver()`, not written out here.** A
 * fixture that spells a message out by hand is this file's idea of the shape, and two
 * fields had already drifted apart under exactly that: this file wrote `at` and
 * `kind`, the kernel writes `created_at` and `chat_mode`, so `snapshotOf` reading the
 * wrong name was `undefined` on every real message while these tests stayed green. The
 * store is the real one (`src/store.ts`) for the same reason.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { deliver } from '../../src/delivery.ts'
import { emptyData, SeekStore } from '../../src/store.ts'
import { runTurn } from '../../src/turn.ts'
import { snapshotOf } from './snapshot.js'

const AT = '2026-10-25T01:00:00.000Z'

/** A store with one room, one person, one bot and two messages it actually delivered. */
function seeded() {
  const store = new SeekStore(emptyData())
  store.data.principals['pr_me'] = { id: 'pr_me', kind: 'human', name: 'argszero' }
  store.data.bots['bo_watch'] = { id: 'bo_watch', name: 'watch-bot' }
  store.data.rooms['rm_ops'] = { id: 'rm_ops', name: 'Ops room', chat_mode: 'group', created_at: AT }
  store.data.memberships['mb_1'] = {
    id: 'mb_1',
    room_id: 'rm_ops',
    principal_id: 'pr_me',
    joined_at: AT,
    role: 'owner',
  }
  store.data.memberships['mb_2'] = {
    id: 'mb_2',
    room_id: 'rm_ops',
    principal_id: 'bo_watch',
    joined_at: AT,
    role: 'member',
  }
  deliver(store, { roomId: 'rm_ops', senderId: 'pr_me', text: 'the deploy is red', now: AT })
  deliver(store, {
    roomId: 'rm_ops',
    senderId: 'bo_watch',
    text: 'looking at it now',
    now: '2026-10-25T01:01:00.000Z',
  })
  return store
}

test('a room reaches the interface with its members, its bots marked, and its messages in order', () => {
  const snapshot = snapshotOf(seeded(), '/tmp/seek.json')

  assert.equal(snapshot.rooms.length, 1, 'one room is one room')
  const room = snapshot.rooms[0]
  assert.equal(room.id, 'rm_ops')
  assert.equal(room.name, 'Ops room')
  // The order messages were written in is the order the interface shows them in; a
  // reader that sorted by anything else would put the reply above its cause.
  assert.deepEqual(room.messages.map((m) => m.text), ['the deploy is red', 'looking at it now'])
  assert.deepEqual(room.members.map((m) => m.id), ['pr_me', 'bo_watch'], 'both members are visible')
})

/**
 * A rename read off the wrong source is `undefined` on every message, and nothing
 * complains — which is how `message.at` and `room.kind` lived here. Both are pinned to
 * the value the kernel wrote, so the next drift is red rather than invisible.
 */
test('the fields the interface renames carry what the kernel wrote', () => {
  const room = snapshotOf(seeded(), '/tmp/seek.json').rooms[0]

  assert.equal(room.messages[0].at, AT, "`at` is the message's `created_at`")
  assert.equal(room.messages[1].at, '2026-10-25T01:01:00.000Z', 'and a later message is later')
  assert.equal(room.kind, 'group', "`kind` is the room's `chat_mode`")
})

/** The interface draws a different avatar for a bot, so the flag has to be true where it is. */
test('a bot is marked as a bot and a person is not', () => {
  const room = snapshotOf(seeded(), '/tmp/seek.json').rooms[0]
  const byId = Object.fromEntries(room.members.map((m) => [m.id, m]))
  assert.equal(byId.bo_watch.bot, true)
  assert.equal(byId.pr_me.bot, false)
  assert.equal(byId.bo_watch.name, 'watch-bot', 'the name comes from the roster row, not the id')
})

/**
 * The composer speaks as this id, so it must be a person: a store whose first entry were
 * taken for the user would have a bot signing the messages a human typed.
 */
test('the interface speaks as a person, never as a bot', () => {
  const store = seeded()
  assert.equal(snapshotOf(store, '/tmp/seek.json').me, 'pr_me')
  assert.equal(store.data.bots.pr_me, undefined, 'and that id is not in the bots map')
})

/**
 * A thread is the kernel's own three facts, and the interface groups by nothing else:
 * `root_id` names the message a reply answers, `chain` names the root of the run it
 * belongs to, and `depth` says how many hops from that root it sits. Read off the wrong
 * field, every message would look like a root — one thread per message, no error
 * anywhere — which is the failure this pins.
 *
 * The reply is made by `deliver()` with a `rootId`, so the chain under test is the one
 * the kernel writes, not one this file composed.
 */
test('a reply reaches the interface inside the thread the kernel put it in', () => {
  const store = seeded()
  const [root, other] = store.messagesOf('rm_ops')
  deliver(store, {
    roomId: 'rm_ops',
    senderId: 'pr_me',
    text: 'in the thread',
    rootId: root.id,
    now: '2026-10-25T01:02:00.000Z',
  })

  const messages = snapshotOf(store, '/tmp/seek.json').rooms[0].messages
  assert.equal(messages[0].rootId, null, 'a message that answers nothing has no parent')
  assert.equal(messages[0].chain, messages[0].id, 'and it roots a chain of its own')
  assert.equal(messages[0].depth, 0, 'at the top of it')
  assert.equal(messages[1].chain, other.id, 'a second message that answers nothing roots its own too')
  assert.equal(messages[2].rootId, root.id, 'the reply names the message it answers')
  assert.equal(messages[2].chain, root.id, "and belongs to that message's chain")
  assert.equal(messages[2].depth, 1, 'one hop from the root it joined')
})

/** A store with nothing in it is a state the interface has to render, not an error. */
test('an empty store is an empty room list, not a failure', () => {
  const snapshot = snapshotOf(new SeekStore(emptyData()), '/tmp/seek.json')
  assert.deepEqual(snapshot.rooms, [])
  assert.equal(snapshot.error, undefined, 'an empty store is not an error')
})

/** A room may carry no name at all, and the rail draws the first character of it. */
test('a room with no name is drawn by its id rather than throwing', () => {
  const store = new SeekStore(emptyData())
  store.data.rooms['oc_1'] = { id: 'oc_1', chat_mode: 'group', created_at: AT }
  assert.equal(snapshotOf(store, '/tmp/seek.json').rooms[0].name, 'oc_1')
})

/** The main process may ask before the store is open; the interface must not get a crash. */
test('a store that is not open yet says so instead of throwing', () => {
  const snapshot = snapshotOf(null, null)
  assert.deepEqual(snapshot.rooms, [])
  assert.match(snapshot.error, /not open yet/)
  // Both halves are read out of the same absent host, so a window that opened before the
  // store carries two placeholder readings rather than two missing fields — a strip whose
  // fact is `undefined` is drawn by whatever the renderer does with `undefined`, which is
  // how a fallback starts looking like a configuration.
  assert.deepEqual(snapshot.stage1, { server: null, refusal: null, pending: null })
  assert.deepEqual(snapshot.stage2, { server: null, refusal: null, pending: null })
})

/**
 * Which stage 1 the window is looking at — three readings that must not collapse into two.
 *
 * "no server" is the state this build ships in; "a server in use" is the measured watch
 * model; "a server that was named and not used" is a failure. A window that drew the third
 * like the first would be showing a fallback as a configuration, which is the one thing a
 * silent switch of mode cannot be allowed to do.
 */
test('the snapshot says which stage 1 it is, and a refusal is not the same reading as silence', () => {
  const off = snapshotOf(seeded(), '/tmp/seek.json')
  assert.deepEqual(off.stage1, { server: null, refusal: null, pending: null }, 'nothing named, nothing refused')

  const bound = snapshotOf(seeded(), '/tmp/seek.json', { server: 'http://127.0.0.1:8080' })
  assert.deepEqual(bound.stage1, { server: 'http://127.0.0.1:8080', refusal: null, pending: null })

  const refused = snapshotOf(seeded(), '/tmp/seek.json', { refusal: 'it serves another model' })
  assert.deepEqual(refused.stage1, { server: null, refusal: 'it serves another model', pending: null })

  const shut = snapshotOf(null, null, { refusal: 'why not' })
  assert.equal(shut.stage1.refusal, 'why not', 'a store that is not open still says why')
})

/**
 * A picture reaches the interface as the kernel's own reference, never as bytes.
 *
 * The design gives the kernel `media` on a message — one `{key, mime}` —
 * and says the bytes are the client's business. The snapshot is the seam between the two,
 * so it is the one place where getting this wrong is silent: a `kind` dropped here draws a
 * picture message as a text message with nothing in it, and a `media` dropped here draws a
 * message that claims a picture and can never show it.
 *
 * The message is delivered by the kernel itself, as every message in this file is: a
 * fixture written out by hand would be this test's idea of the shape.
 */
test('a picture message arrives with its kind and its reference, and the bytes stay behind', () => {
  const store = seeded()
  deliver(store, {
    roomId: 'rm_ops',
    senderId: 'pr_me',
    text: '',
    kind: 'image',
    media: { key: 'om-abc123-ffffffff.png', mime: 'image/png' },
    now: '2026-10-25T01:02:00.000Z',
  })

  const snapshot = snapshotOf(store, '/tmp/seek.json')
  const picture = snapshot.rooms[0].messages.at(-1)

  assert.equal(picture.kind, 'image', 'the kind is what makes the window draw a picture')
  assert.deepEqual(
    picture.media,
    { key: 'om-abc123-ffffffff.png', mime: 'image/png' },
    'the reference is carried whole — a key without its mime cannot be drawn',
  )
  assert.equal(picture.text, '', 'a captionless picture has no words, and the window decides what to say')
  assert.equal(
    JSON.stringify(picture).includes('base64'),
    false,
    'the bytes are the client’s and never travel in a snapshot, which is taken after every delivery',
  )
})

test('a text message says it carries no picture rather than leaving the field off', () => {
  // `null` rather than `undefined`, because a renderer branching on `kind` should not have
  // to distinguish "no picture" from "this snapshot predates pictures": one reading draws
  // nothing, the other is indistinguishable from a bug.
  const snapshot = snapshotOf(seeded(), '/tmp/seek.json')
  for (const message of snapshot.rooms[0].messages) {
    assert.equal(message.kind, 'text')
    assert.equal(message.media, null)
  }
})

/**
 * Who a room that does not exist yet could be given.
 *
 * `rooms[].members` answers "who is in this room", and until this field existed that was
 * the only roster the window ever saw — so the people it could offer a new room were
 * exactly the people already in one, and a combination nobody had made yet was
 * unreachable. The case that proves the two questions differ is a principal in no room at
 * all: absent from every `members` list, and required here.
 *
 * The order is the store's own (`principals`, then `bots`, as written), because a list that
 * reorders itself between two snapshots moves under the cursor of somebody choosing.
 */
test('everyone the store knows is offered to a room that does not exist yet', () => {
  const store = seeded()
  // Two principals no room holds: a person and a bot. The picker's whole reason.
  store.data.principals['pr_later'] = { id: 'pr_later', kind: 'human', name: 'later' }
  store.data.bots['bo_work'] = { id: 'bo_work', name: 'work-bot' }

  const snapshot = snapshotOf(store, '/tmp/seek.json')

  assert.deepEqual(
    snapshot.people.map((person) => person.id),
    ['pr_me', 'pr_later', 'bo_watch', 'bo_work'],
    "every principal and every bot, people first because that is the order they were written",
  )
  assert.deepEqual(
    snapshot.rooms[0].members.map((member) => member.id),
    ['pr_me', 'bo_watch'],
    'and the room still says only who is in it — the two lists are two questions',
  )
  assert.deepEqual(
    snapshot.people.filter((person) => person.bot).map((person) => person.id),
    ['bo_watch', 'bo_work'],
    'a bot is marked as a bot, in the roster as in a room',
  )
})

/**
 * A principal the store holds no name for is still somebody a room can be given, and the
 * id is what the store files them under — the same fallback `members` already makes.
 */
test('a person with no name is offered under their id', () => {
  const store = new SeekStore(emptyData())
  store.data.principals['pr_anon'] = { id: 'pr_anon', kind: 'human' }

  assert.deepEqual(snapshotOf(store, '/tmp/seek.json').people, [
    { id: 'pr_anon', name: 'pr_anon', bot: false },
  ])
})

/** A store that is not open yet has no roster, and an absent list is not a crash. */
test('a store that is not open yet offers nobody', () => {
  assert.deepEqual(snapshotOf(null, null).people, [])
})

/**
 * Who a message names, carried to the interface as the kernel's own pairs.
 *
 * `docs/design/data-model.md` rule 15 says `mentions[]` is "what the interface draws as blue
 * @-text", so a snapshot without it is a window that cannot draw a mention at all — and
 * nothing would fail, because the message keeps carrying one where no reader looks. The other
 * half of the same field is that `deliver()` derives each bot's `mentionsMe` from exactly this
 * array, which makes a dropped mention also a message that wakes nobody in a room where a
 * person named somebody.
 *
 * **The pair is the message's, not a lookup.** A mention records who was named when it was
 * said, so renaming the bot afterwards must not rewrite what was already written — that is
 * what "an immutable shared fact" means, and it is why this snapshot copies the pair instead
 * of resolving the id against the roster.
 */
test('a message arrives with the people it names, and an old message keeps the name it was said with', () => {
  const store = seeded()
  deliver(store, {
    roomId: 'rm_ops',
    senderId: 'pr_me',
    text: 'over to you',
    mentions: [{ id: 'bo_watch', name: 'watch-bot' }],
    now: '2026-10-25T01:02:00.000Z',
  })

  const named = snapshotOf(store, '/tmp/seek.json').rooms[0].messages.at(-1)
  assert.deepEqual(named.mentions, [{ id: 'bo_watch', name: 'watch-bot' }])

  store.data.bots.bo_watch.name = 'renamed-bot'
  assert.deepEqual(
    snapshotOf(store, '/tmp/seek.json').rooms[0].messages.at(-1).mentions,
    [{ id: 'bo_watch', name: 'watch-bot' }],
    'the mentioned name is the one the message carries, not the roster read at draw time',
  )
})

test('a message that names nobody says so rather than leaving the field off', () => {
  // `[]` rather than `undefined`, for the reason `media` is `null`: a renderer facing two
  // kinds of nothing draws whatever `undefined` does, and one of them is a bug.
  for (const message of snapshotOf(seeded(), '/tmp/seek.json').rooms[0].messages) {
    assert.deepEqual(message.mentions, [])
  }
})

/**
 * What the room has spent, read off the ledger rather than counted here.
 *
 * `docs/host-rulings.md` — "No spending cap" — asks for the spend recorded and visible
 * and for nothing else: no budget, no remaining figure, no limit it stops at. The
 * snapshot's whole job in that is to carry the numbers the turns already hold. So the
 * test makes its turns the way the kernel makes them — `runTurn` opens the session and
 * writes the row — rather than spelling a ledger out here, which is the mistake this
 * file's own docblock records twice over.
 */
test('a room carries what its bots spent, per bot and in total, read off the turns', async () => {
  const store = seeded()
  store.data.agents['ag_work'] = {
    id: 'ag_work',
    bot_id: 'bo_watch',
    role: 'work',
    home: '/tmp/home',
    model: 'big',
    prompt: 'work-v1',
    tools: ['say'],
  }

  await runTurn(store, { agentId: 'ag_work', roomId: 'rm_ops', entries: [] }, () => ({
    input_tokens: 1_204,
    output_tokens: 312,
  }))
  // A reminder's turn has no room (§12): it is the bot's own work, counted against no
  // room — so this second turn must not move the figure the room header shows.
  await runTurn(store, { agentId: 'ag_work', entries: [] }, () => ({
    input_tokens: 999,
    output_tokens: 1,
  }))

  const room = snapshotOf(store, '/tmp/seek.json').rooms[0]

  assert.deepEqual(
    { turns: room.spend.turns, input: room.spend.input_tokens, output: room.spend.output_tokens },
    { turns: 1, input: 1_204, output: 312 },
  )
  // Per bot as well as per room: the first question a cost raises is who spent it.
  assert.deepEqual(room.spend.bots, [
    { id: 'bo_watch', name: 'watch-bot', turns: 1, input_tokens: 1_204, output_tokens: 312 },
  ])
})

test('a room nothing has been spent in reads zeros, which is a reading rather than a gap', () => {
  // The build that ships names no model server, so its bot answers through the kernel's
  // placeholder, which calls no model and spends nothing. Drawing nothing at all would
  // leave a reader unable to tell "nothing spent" from "nothing measured".
  const room = snapshotOf(seeded(), '/tmp/seek.json').rooms[0]
  assert.deepEqual(room.spend, { turns: 0, input_tokens: 0, output_tokens: 0, bots: [] })
})
