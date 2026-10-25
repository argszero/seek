'use strict'

/**
 * The interface's host: one store, one kernel, and the writes the composer makes.
 *
 * It is separate from `main.js` so that the whole of what the interface does to the
 * kernel is ordinary code that `node --test` can run without Electron. `main.js` adds
 * windows and IPC; every rule that touches the store is here.
 *
 * **Two writes, one path.** Saying something in a room and answering it in a thread are
 * the same call: `postMessage` with a `rootId` is a reply, without one it is a message.
 * The difference between a message and a reply is the kernel's, stated once in
 * `src/delivery.ts` — this file only carries the caller's choice of parent along.
 *
 * **Nothing in this file invents behaviour.** The pieces are composed exactly as the
 * kernel's own milestone composes them (`src/main.ts`, `runFirstMilestone`): open the
 * store, rebuild its agents from the roster beside it, then build one `Kernel` over
 * it. The one thing the interface adds is a person's write, and that is the kernel's
 * `deliver()` — not a second way into the store.
 *
 * **The bot's answer is the kernel's stub, not a model.** `stubDecide` says one fixed
 * line (`src/main.ts`, `STUB_REPLY`) and `stubJudge` acts on every entry stage 0
 * could not settle. Both are the kernel's own placeholders, taken from the kernel so
 * that "no model is wired to the interface yet" stays one fact in one place. Wiring a
 * model is a later slice, and it lands here: this is the file that constructs the
 * `Kernel`, and `decide`/`judge` are the two options it would pass instead.
 */

const { writeFile } = require('node:fs/promises')

const { meOf, snapshotOf } = require('./snapshot.js')

/** The kernel's modules, imported once. Electron's Node strips TypeScript itself. */
let modules = null

async function kernelModules() {
  if (modules) return modules
  modules = {
    store: await import('../../src/store.ts'),
    delivery: await import('../../src/delivery.ts'),
    kernel: await import('../../src/kernel.ts'),
    main: await import('../../src/main.ts'),
    roster: await import('../../src/roster.ts'),
  }
  return modules
}

/**
 * The roster a first run writes, and why it is a file rather than rows in memory.
 *
 * `docs/decisions.md` default 14 rejects the reading that `agents.yml` is a one-time seed:
 * the file **is** the roster, read on every open, and the store's `agents` shard is rebuilt
 * from it. Putting the agents into the store on first run and leaving no file would be
 * exactly the design that row rejects — configuration turned into state, with nothing left
 * for a person to edit afterwards. So the first run writes the file, and the ordinary open
 * path reads it back like any other roster.
 *
 * The shape is `default 15`'s subset, and it is not trusted: the text is parsed by the
 * kernel's own `parseRoster` on the open that follows, so a typo here fails the first
 * launch instead of quietly landing a bot with no agents.
 *
 * `model` and `prompt` are absent, which means `unset` — choosing a model is a measurement
 * (`src/README.md` line 26) and this file has no standing to pick one.
 */
const FIRST_RUN_ROSTER = `# agents.yml — the roster of agents (\`host-rulings.md\`, "Bot and agent as two objects").
#
# What is registered here is agents, not bots. Each bot is the grouping, its rows are its
# workers, and nothing caps a bot at two: a bot that later needs a third role gets a third
# row and the two that were there first need no migration.
#
# This file is the roster, and the store's agents are rebuilt from it every time the kernel
# opens the store beside it (\`docs/decisions.md\`, defaults 14 and 15). A row's id is derived
# from its bot and its role, so a row keeps the sessions and memories it had before.
#
# A first run writes this file because a fresh install has no other way to have an agent at
# all. Editing it is how a bot is given a different set of workers; deleting it is not, since
# a store with no roster beside it keeps the agents it already carries.
#
# Two spaces for \`- \`, four for a field, whole-line comments only, lists in one line.
# Anything outside that subset is an error naming the line.
agents:
  - bot: Echo
    role: watch
    # The half that cannot write: a decision model produces no text and calls no tool.
    # \`[]\` is a real answer here, not a placeholder.
    tools: []
  - bot: Echo
    role: work
    # \`say\` is the only way into a room (checklist line 14), so a work agent without it
    # could not answer at all.
    tools: [say]
`

/**
 * Whether this store holds nothing at all.
 *
 * Read over the three shards a world is made of rather than over `rooms` alone: a store
 * whose rooms are gone but whose people and bots are still there is damaged, not new, and
 * seeding a second world on top of it would bury the damage under a fresh room.
 */
function holdsNothing(store) {
  return [store.data.rooms, store.data.principals, store.data.bots].every(
    (shard) => Object.keys(shard).length === 0,
  )
}

/**
 * The world a first run lands in: one room, two people and a bot (`seedOneRoom`), and the
 * roster beside it, so the bot has an agent that can speak.
 *
 * Both pieces already exist in the kernel and are composed here rather than re-stated:
 * `seedOneRoom` writes the people, the bot, the room and the memberships, and the roster is
 * the same two rows the shipped `seek-data/agents.yml` holds. `src/` is untouched, exactly
 * as in the three slices before this one.
 *
 * Two refusals, each one a state that is not a first run:
 *
 * - **Anything in the store.** Opening an existing world must not add a room to it.
 * - **A roster already beside it.** Rows name the bots they serve, so writing our own would
 *   either overwrite a person's file or produce agents for a bot that is not there. A store
 *   that is empty with a roster beside it is a hand-made state, and the ordinary path's
 *   refusal (`no bot is 'X' in this store`) is the honest answer to it.
 *
 * `store.path` is not checked: `SeekStore.load` takes the path this function is called with,
 * so a store opened here always has one, and a branch for the other case would be a state no
 * caller can reach.
 *
 * Returns the seeded scene, or `null` when nothing was seeded.
 */
async function seedFirstRun(mods, store, rows) {
  if (rows !== undefined || !holdsNothing(store)) return null

  const scene = mods.main.seedOneRoom(store)
  // The world is on disk before the roster is: a roster written for a bot that never
  // landed would name nobody on the next open.
  await store.save()
  try {
    await writeFile(mods.roster.rosterPath(store.path), FIRST_RUN_ROSTER, {
      encoding: 'utf8',
      // Never over a file that appeared meanwhile: if one did, it wins and the read below
      // picks it up.
      flag: 'wx',
    })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
  return scene
}

/**
 * Open the kernel the interface runs on.
 *
 * A store that is not there yet is a fresh install, and a fresh install lands in a room
 * rather than on an empty window: see `seedFirstRun`. Everything after that point is the one
 * path — the roster is read, the bot's agents are rebuilt from it, and the kernel is built
 * over the store — so a first run takes no special route through the interface.
 */
async function openHost(storeFile) {
  const mods = await kernelModules()

  const store = await mods.store.SeekStore.load(storeFile)

  // Agents are rebuilt from the roster beside the store every time the kernel opens it
  // (`docs/decisions.md`, defaults 14 and 15). `undefined` means no file was found, and
  // then the store keeps the agents it already carries — that is not an empty roster.
  let rows = await mods.roster.readRosterFor(store)
  // A first run writes both halves, and the roster it wrote is then read back through this
  // same call: the file it just created is parsed by the kernel's own reader, not trusted.
  if (await seedFirstRun(mods, store, rows)) rows = await mods.roster.readRosterFor(store)
  if (rows !== undefined) mods.roster.applyRoster(store, rows)

  const kernel = new mods.kernel.Kernel(store, {
    decide: mods.main.stubDecide,
    judge: mods.main.stubJudge,
  })
  // Nothing is woken by starting: this arms the one comparator for rows that came due
  // (`§12 (c)`), and a delivery is what wakes a bot.
  await kernel.start()

  return { store, kernel, storeFile }
}

/** Stop the comparator. The table is left as it is, so nothing is lost by quitting. */
function closeHost(host) {
  host.kernel.stop()
}

/**
 * Say something in a room, and let the kernel answer.
 *
 * `input.rootId` is what makes it a reply: named, the message answers that one and
 * joins its thread; left out, it is a message that answers nothing and roots its own
 * chain.
 *
 * The three steps are the kernel's, in the order the kernel states them:
 *
 * 1. **`deliver()`**, which is synchronous by design — the message and one entry per
 *    recipient bot are appended in one uninterrupted step, so a delivery can never
 *    interleave with the pop half of a drain.
 * 2. **One save by the caller**, because `deliver()` writes to the store and does not
 *    persist it. This is that save, and it happens before anything is woken: a bot's
 *    answer that reached the disk while the message it answers did not would be a
 *    room whose order is wrong after a restart.
 * 3. **One wake per bot that received an entry**, through `Kernel.tick()` — the single
 *    wake path, which consults stage 0 first and opens a turn only for what survives
 *    it. A turn that threw comes back out of `tick()` and therefore out of here: the
 *    kernel hands a wake's failure to the caller that started that wake, and
 *    `kernel.failures` is where the *comparator's* own background wakes are recorded
 *    (`src/kernel.ts`). The message the person typed is already on disk by then, which
 *    is why the interface shows the refusal it gets rather than claiming nothing
 *    happened.
 *
 * What it returns is the snapshot to draw, taken after `whenIdle()` — so the bot's
 * answer is in it, not in the next one.
 */
async function postMessage(host, input) {
  const text = typeof input?.text === 'string' ? input.text : ''
  if (text.trim() === '') {
    throw new Error('an empty message is not a message, so nothing was sent')
  }

  const roomId = input?.roomId
  const senderId = meOf(host.store)
  if (!senderId) {
    throw new Error('this store holds nobody to speak as, so nothing was sent')
  }

  const mods = await kernelModules()
  const sent = mods.delivery.deliver(host.store, {
    roomId,
    senderId,
    text,
    // A reply names the message it answers and the kernel derives the rest of the
    // thread from it: `root_id`, the chain that message belongs to, and one hop more
    // depth (`src/delivery.ts`). Nothing here decides what a thread is. A `rootId`
    // that is not a message in this room is refused by `deliver()` itself, and that
    // refusal reaches the composer as the sentence the kernel wrote.
    rootId: typeof input?.rootId === 'string' && input.rootId !== '' ? input.rootId : undefined,
  })
  await host.store.save()

  const recipients = new Set(sent.observations.map((entry) => entry.bot_id))
  for (const botId of recipients) await host.kernel.tick(botId)
  // A wake is not awaited by `tick`'s own compaction, and "the interface is done
  // writing" has exactly one answer in the kernel.
  await host.kernel.whenIdle()

  return snapshotOf(host.store, host.storeFile)
}

module.exports = { closeHost, openHost, postMessage }
