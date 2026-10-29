/**
 * A send is a send: the words are written, and the room answers on its own time.
 *
 * This is the rule that makes the composer usable. Until 2026-10-29 `postMessage()` awaited
 * the whole turn, so pressing *send* disabled the box for as long as a model took to talk and
 * the person's own line did not appear until the bot had finished — a chat window that stops
 * accepting words while somebody else is typing, which is what a real room never does.
 *
 * **The bot is held behind a gate, and the gate is the measurement.** A send that waited for
 * the answer would never return while the gate is shut, so "the message came back before the
 * bot spoke" is observed here rather than assumed. What the window is told afterwards is the
 * other half: `onChanged` is `main.js`'s one broadcast (`seek:changed`), and it must fire once
 * the bot has finished — otherwise a send would put the person's line on screen and leave the
 * answer nowhere.
 *
 * The third test is the same deal read from the failure side. A turn nobody awaits still
 * cannot fail into a void: it is recorded on `kernel.failures` beside the comparator's own
 * background wakes, named to `onError` for the log, and the message it would have answered
 * stays on disk — there is nothing to take back, so nothing is taken back.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { applyRoster } from '../../src/roster.ts'
import { seedOneRoom, STUB_REPLY, stubDecide, stubJudge } from '../../src/main.ts'
import { emptyData, SeekStore } from '../../src/store.ts'
import { closeHost, hostSnapshot, openHost, postMessage } from './host.js'

/** Hold the bot until the test lets it go. */
function gate() {
  let open = () => {}
  const opened = new Promise((resolve) => {
    open = resolve
  })
  return { opened, open: () => open() }
}

/** Wait for something the kernel does on its own time, without pinning the clock. */
async function until(what, limit = 4000) {
  const stop = Date.now() + limit
  while (!what()) {
    if (Date.now() > stop) throw new Error('the room never got there')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/**
 * The seeded world, with a bot that answers only when it is let through and every change
 * the host announces kept in `changes` — the snapshot a window would have drawn.
 */
async function world({ decide, onError } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'seek-ui-send-'))
  const storeFile = join(dir, 'seek.json')
  const store = new SeekStore(emptyData(), storeFile)
  const scene = seedOneRoom(store)
  applyRoster(store, [
    { bot: 'Echo', role: 'watch', tools: [] },
    { bot: 'Echo', role: 'work', tools: ['say'] },
  ])
  await store.save()

  const changes = []
  let host = null
  host = await openHost(storeFile, {
    judge: stubJudge,
    ...(decide === undefined ? { decide: stubDecide } : { decide }),
    onChanged: () => changes.push(hostSnapshot(host)),
    ...(onError === undefined ? {} : { onError }),
  })

  return {
    host,
    scene,
    changes,
    storeFile,
    async done() {
      closeHost(host)
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/** The words in one room of a snapshot, newest last. */
function saidIn(snapshot, roomId) {
  const room = snapshot.rooms.find((one) => one.id === roomId)
  return (room?.messages ?? []).map((one) => ({ sender: one.sender, text: one.text }))
}

test('a send comes back while the bot is still answering', { timeout: 10000 }, async () => {
  const held = gate()
  const w = await world({
    decide: async (context) => {
      await held.opened
      stubDecide(context)
    },
  })
  try {
    // **Raced against a clock, so a regression fails here rather than hanging.** A send that
    // went back to awaiting the turn would wait for a bot the test never lets through, and a
    // stuck test is a worse report than a wrong one.
    const sent = await Promise.race([
      postMessage(w.host, { roomId: w.scene.room, text: 'the deploy is red' }),
      new Promise((resolve) => setTimeout(() => resolve('the send was still waiting'), 1000)),
    ])
    assert.notEqual(sent, 'the send was still waiting', 'a send does not wait for the answer')

    assert.deepEqual(
      saidIn(sent, w.scene.room),
      [{ sender: w.scene.me, text: 'the deploy is red' }],
      'the snapshot is the room as it stood when the message was written',
    )
    assert.equal(w.changes.length, 0, 'the bot has not spoken, so there is nothing to announce')

    // Written, and therefore sent — the disk is what "it was sent" means, and the answer to
    // that question cannot depend on a model having finished.
    const reloaded = await SeekStore.load(w.storeFile)
    assert.deepEqual(
      reloaded.messagesOf(w.scene.room).map((message) => message.sender_id),
      [w.scene.me],
      'the person\'s line is on disk, with no answer yet',
    )
  } finally {
    held.open()
    await w.host.kernel.whenIdle()
    await w.done()
  }
})

/**
 * The answer half of the same deal: it is announced, and the announcement is a snapshot.
 *
 * The bot here answers at once, so this measures only what happens *after* a send — whether
 * anything is said at all. A send that returns a snapshot and never announces would show the
 * person their own line and leave the room's answer nowhere, which is the failure that makes
 * "don't wait" unsafe on its own.
 */
test('the answer is announced once, and the announcement carries it', async () => {
  const w = await world()
  try {
    await postMessage(w.host, { roomId: w.scene.room, text: 'is anyone there' })
    await until(() => w.changes.length > 0)

    assert.equal(w.changes.length, 1, 'one announcement for one answer')
    assert.deepEqual(
      saidIn(w.changes.at(-1), w.scene.room),
      [
        { sender: w.scene.me, text: 'is anyone there' },
        { sender: w.scene.bot, text: STUB_REPLY },
      ],
      'and the snapshot it carries has the answer in it',
    )
  } finally {
    await w.host.kernel.whenIdle()
    await w.done()
  }
})

test('a turn that threw is recorded and logged, and the message stays sent', async () => {
  const boom = new Error('the model stopped mid-sentence')
  const logged = []
  const stray = []
  const strayed = (reason) => stray.push(reason)
  process.on('unhandledRejection', strayed)
  const w = await world({
    decide: () => {
      throw boom
    },
    onError: (error, botId) => logged.push({ error, botId }),
  })
  try {
    const sent = await postMessage(w.host, { roomId: w.scene.room, text: 'still there?' })
    assert.deepEqual(
      saidIn(sent, w.scene.room),
      [{ sender: w.scene.me, text: 'still there?' }],
      'a failed answer is not a failed message',
    )

    await w.host.kernel.whenIdle()
    await until(() => logged.length > 0)

    assert.equal(w.host.kernel.failures.length, 1, 'the wake is on the kernel\'s own record')
    assert.equal(w.host.kernel.failures[0].error, boom)
    assert.equal(w.host.kernel.failures[0].botId, w.scene.bot)
    assert.deepEqual(logged, [{ error: boom, botId: w.scene.bot }], 'and named to the log')

    // A promise nobody holds must not become an unhandled rejection — that is the failure
    // mode of starting work in the background and walking away.
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(stray, [], 'nothing was dropped as an unhandled rejection')

    const reloaded = await SeekStore.load(w.storeFile)
    assert.equal(reloaded.messagesOf(w.scene.room).length, 1, 'the message is still on disk')
  } finally {
    process.off('unhandledRejection', strayed)
    await w.done()
  }
})
