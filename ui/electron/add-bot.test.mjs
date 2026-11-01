/**
 * The window's fourth write: a bot, with the card the person filled in.
 *
 * The prototype's own flow is the spec (`prototype/src/js/app.js`, `modalAddFriend`): four
 * fields — 姓名 / 性别 / 职位 / 性格 — a name that is required, and a bot that is a member of
 * this organization and nothing else. What this file measures is the half the window cannot
 * show on its own: that the bot reaches the store **and** that it can speak afterwards, which
 * is a second fact and lives in a second place.
 *
 * **The second place is `agents.yml`.** The design says the roster *is* that file, read on
 * every open, and a bot with no `work` row makes the kernel's own turn throw rather than go
 * quietly deaf (`src/turn.ts`, `makeTurn`). So a bot added in the window has to be given rows
 * there, and the last test re-opens the store to prove the file it wrote is a roster the
 * kernel still reads.
 *
 * Nothing here starts a model or an Electron: `openHost` runs under plain `node --test`, and it
 * is handed the kernel's own two placeholders — the way a test hands it a transport — because
 * what is being measured is a bot made in the window and the rows that let it speak, not a
 * model. That is why the answers below are `STUB_REPLY`.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { seedOneRoom, STUB_REPLY, stubDecide, stubJudge } from '../../src/main.ts'
import { applyRoster, parseRoster } from '../../src/roster.ts'
import { emptyData, SeekStore } from '../../src/store.ts'
import { addBot, closeHost, createRoom, openHost, hostSnapshot, postMessage } from './host.js'

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


/**
 * A store with the seeded world and a roster **file** beside it.
 *
 * A file rather than rows applied in memory, because the file is the thing `addBot` appends
 * to: a harness without one would be measuring the branch where a bot is created mute.
 */
const ROSTER_YAML = `agents:
  - bot: Echo
    role: watch
    tools: []
  - bot: Echo
    role: work
    tools: [say]
`

async function world({ withRoster = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'seek-ui-bot-'))
  const storeFile = join(dir, 'seek.json')
  const rosterFile = join(dir, 'agents.yml')
  const store = new SeekStore(emptyData(), storeFile)
  const scene = seedOneRoom(store)
  if (withRoster) {
    await writeFile(rosterFile, ROSTER_YAML, 'utf8')
    applyRoster(store, parseRoster(ROSTER_YAML, rosterFile))
  } else {
    // The store keeps the agents it already carries when no file is beside it, so the seeded
    // bot's rows are applied in memory and no file exists for `addBot` to append to.
    applyRoster(store, [
      { bot: 'Echo', role: 'watch', tools: [] },
      { bot: 'Echo', role: 'work', tools: ['say'] },
    ])
  }
  await store.save()

  const host = await openHost(storeFile, { judge: stubJudge, decide: stubDecide })
  return {
    host,
    scene,
    storeFile,
    rosterFile,
    async done() {
      closeHost(host)
      await rm(dir, { recursive: true, force: true })
    },
  }
}

test('a bot made in the window is in the store and in the snapshot the window draws', async () => {
  const w = await world()
  try {
    const made = await addBot(w.host, {
      name: '关龙',
      gender: '男',
      position: '接口与联调',
      personality: '先给结论再给理由；改接口前列出谁会被影响。',
    })

    assert.equal(made.roster, 'appended', 'a roster file is beside this store, so rows were added')
    const person = made.snapshot.people.find((one) => one.id === made.botId)
    assert.deepEqual(person, {
      id: made.botId,
      name: '关龙',
      bot: true,
      kind: 'bot',
      description: null,
      gender: '男',
      position: '接口与联调',
      personality: '先给结论再给理由；改接口前列出谁会被影响。',
    })

    // On disk, not merely in the handle the window is holding.
    const reloaded = await SeekStore.load(w.storeFile)
    assert.equal(reloaded.data.bots[made.botId].name, '关龙')
    assert.equal(reloaded.data.bots[made.botId].personality, '先给结论再给理由；改接口前列出谁会被影响。')
  } finally {
    await w.done()
  }
})

/**
 * The half that makes the bot real: it answers.
 *
 * A bot whose rows were never written cannot be woken at all — `makeTurn` throws on a bot
 * with no `work` agent — so the answer below is the proof that the file `addBot` appended to
 * is the file the kernel reads.
 */
test('the new bot answers in a room, which is what its two roster rows are for', async () => {
  const w = await world()
  try {
    const made = await addBot(w.host, { name: '李静', gender: '女', position: '排期与提醒' })
    const room = await createRoom(w.host, {
      name: 'with the new bot',
      members: [w.scene.me, made.botId],
    })

    const snapshot = await postAndWait(w.host, {
      roomId: room.roomId,
      text: '排期发我一份',
    })
    const drawn = snapshot.rooms.find((one) => one.id === room.roomId)
    assert.equal(drawn.messages.length, 2, 'what was typed, and the answer to it')
    assert.equal(drawn.messages[1].sender, made.botId, 'the new bot is the one that answered')
    assert.equal(drawn.messages[1].text, STUB_REPLY)
  } finally {
    await w.done()
  }
})

test('the rows appended to agents.yml name the bot by id, and the file still parses', async () => {
  const w = await world()
  try {
    const made = await addBot(w.host, { name: '周敏' })
    const text = await readFile(w.rosterFile, 'utf8')

    // By id, because two bots may be called the same thing and a name that is ambiguous makes
    // the whole roster refuse (`src/roster.ts`). The Echo rows a person may have edited are
    // still there: this appends, it does not rewrite.
    assert.match(text, new RegExp(`- bot: ${made.botId}\\n    role: watch\\n    tools: \\[\\]\\n`))
    assert.match(
      text,
      new RegExp(`- bot: ${made.botId}\\n    role: work\\n    tools: \\[say, read, glob, grep\\]\\n`),
    )
    assert.ok(text.includes('  - bot: Echo\n    role: watch\n'), 'the rows that were there are there')

    // The kernel's own reader, over the text as it now stands: no rows of ours missing, and
    // the parse is what would catch a shape this file got wrong.
    const rows = parseRoster(text, w.rosterFile)
    assert.equal(rows.filter((row) => row.bot === made.botId).length, 2)
    assert.equal(rows.filter((row) => row.bot === 'Echo').length, 2)

    // And the store's agents shard holds them, with the ids `agentIdFor` derives — so a reopen
    // lands the same rows on the same agents instead of orphaning them.
    const reloaded = await SeekStore.load(w.storeFile)
    const agents = reloaded.agentsOf(made.botId)
    assert.deepEqual(
      agents.map((agent) => [agent.role, agent.tools]),
      [
        ['watch', []],
        ['work', ['say', 'read', 'glob', 'grep']],
      ],
    )
  } finally {
    await w.done()
  }
})

/**
 * A reopen is the test that matters most: the roster is a file, so a bot whose rows only
 * existed in this process would be a bot that vanished from the roster on the next launch —
 * present in `bots`, absent from `agents`, and therefore mute with nothing to explain it.
 */
test('after a reopen the new bot still has its agents, because the file carries them', async () => {
  const w = await world()
  try {
    const made = await addBot(w.host, { name: '张伟', position: '联调' })
    closeHost(w.host)

    const reopened = await openHost(w.storeFile)
    try {
      assert.deepEqual(
        reopened.store.agentsOf(made.botId).map((agent) => agent.role).sort(),
        ['watch', 'work'],
      )
      assert.equal(reopened.store.data.bots[made.botId].position, '联调')
    } finally {
      closeHost(reopened)
    }
  } finally {
    // `done()` closes the host this test already closed; `closeHost` is idempotent.
    await w.done()
  }
})

test('a name is required, and a refusal leaves both the store and the roster alone', async () => {
  const w = await world()
  const before = await readFile(w.rosterFile, 'utf8')
  try {
    await assert.rejects(() => addBot(w.host, { name: '   ' }), /a bot with no name/)

    assert.equal(await readFile(w.rosterFile, 'utf8'), before, 'not one byte was appended')
    const reloaded = await SeekStore.load(w.storeFile)
    assert.equal(Object.keys(reloaded.data.bots).length, 1, 'the seeded Echo is still the only bot')
  } finally {
    await w.done()
  }
})

/**
 * A store with no roster file beside it: the bot is created and is mute.
 *
 * Writing a fresh file here would be worse than saying so — the shard would be rebuilt from
 * one bot's rows and every existing agent would lose its job. So the answer is a value the
 * window can draw, and the assertion is that nothing was written.
 */
test('with no roster file the bot is created and reported mute, rather than given a roster of one', async () => {
  const w = await world({ withRoster: false })
  try {
    const made = await addBot(w.host, { name: '陈晨' })

    assert.equal(made.roster, 'none')
    assert.ok(made.snapshot.people.some((one) => one.id === made.botId))
    await assert.rejects(() => readFile(w.rosterFile, 'utf8'), /ENOENT/, 'no file was invented')

    // The seeded bot's agents are untouched: the shard is what a file would have replaced.
    const reloaded = await SeekStore.load(w.storeFile)
    assert.deepEqual(
      reloaded.agentsOf(w.scene.bot).map((agent) => agent.role).sort(),
      ['watch', 'work'],
    )
    assert.deepEqual(reloaded.agentsOf(made.botId), [])
  } finally {
    await w.done()
  }
})
