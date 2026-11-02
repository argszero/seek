/**
 * The state dot: what each bot is doing, in the snapshot the window draws.
 *
 * `docs/design/agent-lifecycle.md` §8 item 1 — "a state dot: watching / working / asleep /
 * needy, as an avatar badge" — is the work order. What this file holds is the half the window
 * cannot check for itself: that the snapshot carries the reading, that the person is not in
 * it, and that a bot which has left the organization is not in it either (a dot beside a
 * message from someone gone would be reporting on nobody).
 *
 * **`needy` is deliberately absent, and this is where that would be noticed.** No part of the
 * kernel asks a person for a decision and waits for one, so `botStatesOf` has no producer for
 * the fourth word. The day something does, this file is where the missing state shows up.
 *
 * **The window is told, and the telling is measured.** A bot's turn and its reading wait write
 * nothing to the store: `onChanged` never says they began, so a window informed only about
 * writes would draw every bot asleep for the whole turn it is spending. The kernel reports
 * those moments to `onActivity`, and each of them arrives as a full snapshot — which is what
 * these tests read back, rather than trusting that a callback exists.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { seedOneRoom, stubDecide, stubJudge } from '../../src/main.ts'
import { applyRoster } from '../../src/roster.ts'
import { emptyData, SeekStore } from '../../src/store.ts'
import { closeHost, deleteBot, hostSnapshot, openHost, postMessage } from './host.js'
import { snapshotOf } from './snapshot.js'

/** Hold the bot until the test lets it go, so a turn can be observed while it is open. */
function gate() {
  let open = () => {}
  const opened = new Promise((resolve) => {
    open = resolve
  })
  return { opened, open: () => open() }
}

/** Timers a test fires by hand: a reading wait is armed without waiting on wall time. */
function makeTimers() {
  const pending = new Map()
  let next = 0
  return {
    set(_delayMs, run) {
      next += 1
      pending.set(next, run)
      return next
    },
    clear(handle) {
      pending.delete(handle)
    },
    /** Fire every wait that is armed, oldest first. */
    fire() {
      const armed = [...pending.entries()]
      pending.clear()
      for (const [, run] of armed) run()
    },
  }
}

const MORNING = '2026-10-24T08:00:00.000Z'

/**
 * The seeded world — one person, one bot, one room — with every state change announced as a
 * snapshot, which is exactly what `main.js` sends to the window.
 */
async function world({ decide } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'seek-ui-dot-'))
  const storeFile = join(dir, 'seek.json')
  const store = new SeekStore(emptyData(), storeFile)
  const scene = seedOneRoom(store)
  applyRoster(store, [
    // Pinned, so the reading is a fact of the store rather than of a roster row nobody wrote.
    { bot: scene.bot, role: 'watch', tools: [] },
    { bot: scene.bot, role: 'work', tools: ['say'] },
  ])
  await store.save()

  const timers = makeTimers()
  const announced = []
  let host = null
  host = await openHost(storeFile, {
    judge: stubJudge,
    decide: decide ?? stubDecide,
    wakeDelay: () => 3000,
    timers,
    // **Not `onChanged`**: that one means "an answer landed" and is counted per answer. This
    // is the hook the dot needs, and `main.js` sends the same `seek:changed` for it.
    onActivity: () => announced.push(hostSnapshot(host)),
  })

  return {
    host,
    scene,
    timers,
    announced,
    async done() {
      closeHost(host)
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/** Wait for something the kernel does on its own time. */
async function until(what, limit = 4000) {
  const stop = Date.now() + limit
  while (!what()) {
    if (Date.now() > stop) throw new Error('the reading never got there')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** Every state one bot was drawn in, in the order the window would have drawn them. */
function statesOf(snapshots, botId) {
  return snapshots.map((snapshot) => snapshot.activity[botId]).filter((state) => state !== undefined)
}

test('a bot is drawn watching, then working, then asleep as it reads and answers', { timeout: 15000 }, async () => {
  const held = gate()
  const w = await world({
    decide: async (context) => {
      await held.opened
      stubDecide(context)
    },
  })
  try {
    const sent = await postMessage(w.host, { roomId: w.scene.room, text: 'the deploy is red' })

    // The message is written and the bot has taken up its wait. `wakeDelay` is 3000 and the
    // timers are the test's, so nothing has read it yet — which is exactly what "watching"
    // means: there is something to read and it has not been read.
    assert.equal(sent.activity[w.scene.bot], 'watching', 'a bot with a wait armed is watching')

    w.timers.fire()
    await until(() => w.host.kernel.activity().working.length > 0)
    assert.equal(hostSnapshot(w.host).activity[w.scene.bot], 'working', 'a turn open is working')

    held.open()
    await w.host.kernel.whenIdle()
    assert.equal(hostSnapshot(w.host).activity[w.scene.bot], 'asleep', 'a finished turn is asleep')

    // **The window heard all three, because it was sent all three.** A callback nobody wired
    // to a broadcast is the same as no callback: the dot would stay on the last thing it was
    // told, which is the defect this hook exists against.
    const drawn = statesOf(w.announced, w.scene.bot)
    for (const state of ['watching', 'working', 'asleep']) {
      assert.ok(drawn.includes(state), `the window was never told ${state} (it saw ${drawn.join(', ')})`)
    }
  } finally {
    held.open()
    await w.host.kernel.whenIdle()
    await w.done()
  }
})

test('the person has no state and neither does a bot that left', { timeout: 10000 }, async () => {
  const w = await world()
  try {
    const snap = hostSnapshot(w.host)
    assert.equal(snap.activity[w.scene.bot], 'asleep', 'a bot with nothing to read is asleep')
    assert.equal(snap.activity[w.scene.me], undefined, 'the person this window speaks as is not a bot')

    // Throws rather than answering with a refusal: the one refusal a person can hit is a bot
    // alone in a room, and this test would be measuring that instead of the dot.
    const gone = await deleteBot(w.host, { botId: w.scene.bot })
    // `named` still has it — its message would still name it — while the state table no longer
    // does: a dot beside a message from a bot this organization no longer has would be a
    // reading about nobody.
    assert.equal(gone.snapshot.named[w.scene.bot]?.id, w.scene.bot, 'the history still names it')
    assert.equal(gone.snapshot.activity[w.scene.bot], undefined, 'but it is not drawn as doing anything')
  } finally {
    await w.done()
  }
})

test('a snapshot with no kernel reading behind it says every bot is asleep', () => {
  // The shape a caller with no kernel gets — a store that was just opened, a test, a window
  // before the loop started. It must not be an empty table: a window reading `undefined` per
  // bot could not tell "asleep" from "no such bot", and those are two different answers.
  const store = new SeekStore(emptyData(), join(tmpdir(), 'seek-ui-dot-unread.json'))
  const scene = seedOneRoom(store)
  const snap = snapshotOf(store, null)
  assert.equal(snap.activity[scene.bot], 'asleep')
  assert.deepEqual(Object.keys(snap.activity), [scene.bot], 'every bot the store offers, and no one else')
})
