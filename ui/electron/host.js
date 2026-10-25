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
 * Open the kernel the interface runs on.
 *
 * A store that is not there yet is an empty one, not an error: the interface opens on
 * a store with no rooms in it and says so. Seeding a world, and choosing a roster for
 * a store that has none, are onboarding — a separate slice.
 */
async function openHost(storeFile) {
  const mods = await kernelModules()

  const store = await mods.store.SeekStore.load(storeFile)

  // Agents are rebuilt from the roster beside the store every time the kernel opens it
  // (`docs/decisions.md`, defaults 14 and 15). `undefined` means no file was found, and
  // then the store keeps the agents it already carries — that is not an empty roster.
  const rows = await mods.roster.readRosterFor(store)
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
