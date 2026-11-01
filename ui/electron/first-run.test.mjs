/**
 * What a fresh install opens on.
 *
 * A store with nothing in it used to open on an empty window that said "no room in this
 * store", and even a seeded room would have had no agent able to answer — the kernel's
 * `seedOneRoom` writes people, a bot and a room, and deliberately writes no agents, because
 * agents are the roster's (`src/main.ts`). So a first run has to make **both** halves, and
 * this file measures that it makes them, that they work, and that it makes them only once.
 *
 * The world is the kernel's own (`seedOneRoom`) and the roster is read back through the
 * kernel's own `parseRoster` on the open that follows, so nothing here is this file's idea
 * of either shape. `src/` is untouched: the slice composes two functions that already exist.
 */
import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { seedOneRoom, STUB_REPLY, stubDecide, stubJudge } from '../../src/main.ts'
import { applyRoster, parseRoster, ROSTER_FILE } from '../../src/roster.ts'
import { emptyData, SeekStore } from '../../src/store.ts'
import { closeHost, openHost, hostSnapshot, postMessage } from './host.js'

/**
 * Send, and wait for the room to answer.
 *
 * `postMessage()` hands its snapshot back as soon as the message is written, because a bot
 * answers on its own time — that is what keeps the composer usable while it talks
 * (`ui/electron/host.js`). A test about the answer is therefore a test about what happens
 * after that: this waits for the kernel and then reads the room again, which is the same
 * two steps `main.js` takes before it tells the window the facts changed.
 */
async function postAndWait(host, input) {
  await postMessage(host, input)
  await host.kernel.whenIdle()
  return hostSnapshot(host)
}


/** An empty directory — what a fresh install has — and its clean-up. */
async function freshDirectory() {
  const dir = await mkdtemp(join(tmpdir(), 'seek-ui-first-run-'))
  return {
    dir,
    storeFile: join(dir, 'seek.json'),
    rosterFile: join(dir, ROSTER_FILE),
    async done() {
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/** The one room in a store, and its bot, read off the store the kernel actually holds. */
function world(store) {
  const [roomId] = Object.keys(store.data.rooms)
  const [botId] = Object.keys(store.data.bots)
  return { roomId, botId, people: Object.keys(store.data.principals) }
}

/** A store that already holds a world and a roster — what `world()` builds in `host.test.mjs`. */
async function existingWorld(storeFile) {
  const store = new SeekStore(emptyData(), storeFile)
  const scene = seedOneRoom(store)
  applyRoster(store, [
    { bot: 'Echo', role: 'watch', tools: [] },
    { bot: 'Echo', role: 'work', tools: ['say'] },
  ])
  await store.save()
  return scene
}

/**
 * The whole claim, end to end: the app opens on a room, and the bot in it answers.
 *
 * Asserted through `postMessage` rather than by reading the shards, because "the bot
 * answers" is the product's claim and a store that merely contains a bot does not make it.
 */
test('a directory with nothing in it opens on a room whose bot answers', async () => {
  const f = await freshDirectory()
  // The two halves are handed in, because what this file measures is the world a first run
  // makes: an install with no model leaves the bot silent (`model-wiring.test.mjs`), and the
  // question here is whether there is a bot to be silent.
  const host = await openHost(f.storeFile, { judge: stubJudge, decide: stubDecide })
  try {
    const { roomId, botId, people } = world(host.store)

    assert.equal(Object.keys(host.store.data.rooms).length, 1, 'one room, seeded')
    assert.equal(host.store.data.rooms[roomId].name, 'the first room')
    assert.equal(Object.keys(host.store.data.bots).length, 1, 'and one bot in it')
    // One person and nobody else. A first launch used to seed a second one — a stranger called
    // `someone else` whose only purpose was to make the room a group — and a stranger in
    // somebody's organization is not a thing the window should hand them (host, 2026-10-27).
    assert.equal(people.length, 1, 'the person who speaks, and no one else')
    // The interface speaks as the first person in the store (`meOf`), so that must be the
    // human and not the bot.
    assert.equal(host.store.data.principals[people[0]].name, 'me')
    assert.equal(host.store.data.bots[people[0]], undefined, 'and it is not a bot')

    // The roster is a file, and the kernel's own parser is what read it.
    const rows = parseRoster(await readFile(f.rosterFile, 'utf8'), f.rosterFile)
    assert.deepEqual(
      rows.map((row) => [row.role, row.tools]),
      [
        ['watch', []],
        ['work', ['say', 'read', 'glob', 'grep']],
      ],
      'a watch half that cannot write, and a work half that can speak and look back',
    )

    // And the bot holds those agents: a roster nobody applied would fail here.
    const agents = Object.values(host.store.data.agents).filter((agent) => agent.bot_id === botId)
    assert.deepEqual(agents.map((agent) => agent.role).sort(), ['watch', 'work'])

    const snapshot = await postAndWait(host, { roomId, text: 'is this thing on' })
    const room = snapshot.rooms.find((one) => one.id === roomId)
    assert.deepEqual(
      room.messages.map((message) => message.text),
      ['is this thing on', STUB_REPLY],
      'what a person typed, and the answer the bot gave it',
    )
  } finally {
    closeHost(host)
    await f.done()
  }
})

/**
 * A first run happens once. The second open must add no room and no bot, or a window
 * restarted twenty times would hold twenty worlds — and a roster a person edited must not
 * be written back over, or the file would keep coming back to what it shipped as.
 */
test('opening the same store again seeds nothing and leaves the roster as it is', async () => {
  const f = await freshDirectory()
  const first = await openHost(f.storeFile)
  const rosterAfterFirstRun = await readFile(f.rosterFile, 'utf8')
  assert.equal(Object.keys(first.store.data.rooms).length, 1)
  closeHost(first)

  const second = await openHost(f.storeFile)
  try {
    assert.equal(Object.keys(second.store.data.rooms).length, 1, 'still one room')
    assert.equal(Object.keys(second.store.data.bots).length, 1, 'still one bot')
    assert.equal(
      await readFile(f.rosterFile, 'utf8'),
      rosterAfterFirstRun,
      'the file it wrote the first time is not rewritten',
    )
  } finally {
    closeHost(second)
  }

  // A person's edit survives the next open.
  await writeFile(f.rosterFile, `${rosterAfterFirstRun}# edited by hand\n`, 'utf8')
  const third = await openHost(f.storeFile)
  try {
    assert.match(await readFile(f.rosterFile, 'utf8'), /# edited by hand/)
  } finally {
    closeHost(third)
    await f.done()
  }
})

/**
 * A store that already holds a world is not a first run, even with no roster beside it: the
 * window it opens on keeps its own room and gains nothing.
 */
test('a store that already holds a world is left alone', async () => {
  const f = await freshDirectory()
  await existingWorld(f.storeFile)

  const host = await openHost(f.storeFile)
  try {
    assert.equal(Object.keys(host.store.data.rooms).length, 1, 'no second room was added')
    assert.equal(Object.keys(host.store.data.bots).length, 1, 'no second bot was added')
    await assert.rejects(access(f.rosterFile), 'and no roster was written beside it')
  } finally {
    closeHost(host)
    await f.done()
  }
})

/**
 * A roster beside an empty store is a hand-made state: its rows name bots that are not
 * there. The kernel refuses them, and that refusal is the answer — inventing the bots a
 * roster happens to name would make configuration create a world.
 */
test('an empty store with a roster beside it is refused rather than seeded', async () => {
  const f = await freshDirectory()
  await writeFile(f.rosterFile, 'agents:\n  - bot: Echo\n    role: work\n    tools: [say]\n', 'utf8')

  await assert.rejects(() => openHost(f.storeFile), /no bot is 'Echo'/)
  // Nothing was written: the world is not half-made on the way to a refusal.
  await assert.rejects(access(f.storeFile), 'no store file was created')
  assert.match(await readFile(f.rosterFile, 'utf8'), /tools: \[say\]/, 'the roster is untouched')
  await f.done()
})
