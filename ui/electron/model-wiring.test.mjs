/**
 * Which model each bot's two halves are bound to, per bot, and what a missing one leaves.
 *
 * A bot acts when the watch model over its server says to, and it speaks with what the work
 * model writes (`say`) — one binding per bot, because the `model` a roster row claims and
 * the box a judgement reads belong to a bot rather than to the store.
 *
 * **With nothing ready the bot says nothing.** The room keeps the person's own message and
 * no line is posted on the bot's behalf, which is the ruling this file exists to hold: an
 * empty room is the honest state of an install with no model, and what a person gets instead
 * of an invented sentence is the window saying which bots are quiet and why
 * (`docs/host-rulings.md`, "A bot whose model is not ready says nothing, and the window says
 * why"). Nothing here asserts a placeholder: the kernel's `stubJudge`/`stubDecide` stay in
 * the kernel's own command line.
 *
 * **Nothing here starts a model.** The transport is `LlamaServer.fetch`, the seam the
 * kernel's own `watch-server.test.ts` uses, so a fake answers `/props`, `/apply-template`,
 * `/tokenize`, `/v1/systemone` and `/v1/chat/completions` and records what it was asked. No
 * socket is opened and no
 * process is waited on.
 *
 * **A refusal is a reading, not a crash, and it is one bot's.** A server that cannot be used
 * does not stop the window opening: the store is local and its messages are still there, the
 * bot whose row refused is left quiet by name, and every other bot goes on working. The
 * refused cases below each assert both — the reason (in `refusal`, which is the log's) and an
 * app that still works.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { makeWorld } from '../../src/fixtures.ts'
import { STUB_REPLY } from '../../src/main.ts'
import { SeekStore } from '../../src/store.ts'
import { closeHost, openHost, postMessage } from './host.js'

/** The template this fake model uses: a fixed head and tail, so the ends are stable. */
const TEMPLATE_HEAD = '<|im_start|>system\n'
const TEMPLATE_MID = '<|im_end|>\n<|im_start|>user\n'
const TEMPLATE_TAIL = '<|im_end|>\n<|im_start|>assistant\n'

/**
 * A vocabulary that makes one word one token.
 *
 * Whitespace runs and words are separate pieces, so appending `act` to a text ending in a
 * newline yields exactly one new token — the property an option needs before it can carry
 * a probability. Copied in shape from `src/watch-server.test.ts` because the property is
 * the same one; what is being pinned here is the wiring, not the numbers.
 */
function makeVocab() {
  const ids = new Map()
  let next = 100
  return (content) => {
    const pieces = content.match(/\s+|[^\s]+/g) ?? []
    return pieces.map((piece) => {
      if (!ids.has(piece)) {
        ids.set(piece, next)
        next += 1
      }
      return ids.get(piece)
    })
  }
}

/**
 * A server that answers by path and records what it was asked.
 *
 * `/props` is the answer that decides whether the server is usable at all — the model it
 * names is what the roster's claim is checked against — so it
 * is the one this file shapes per test.
 */
function fakeServer(options = {}) {
  const tokenise = makeVocab()
  const calls = []
  const fetch = async (url, init) => {
    const path = new URL(url).pathname
    const body = init.body === undefined ? {} : JSON.parse(init.body)
    calls.push({ path, method: init.method, body })
    let payload
    if (path === '/props') {
      payload = {
        chat_template: TEMPLATE_HEAD,
        build_info: 'test build',
        // The kernel's own fixture declares `gate` on the watch row, so this is the server
        // that confirms that claim unless a test says otherwise.
        model_alias: options.modelAlias === undefined ? 'gate' : options.modelAlias,
        model_path: options.modelPath === undefined ? '/models/gate.gguf' : options.modelPath,
        default_generation_settings: { n_ctx: options.nCtx === undefined ? 4096 : options.nCtx },
      }
    } else if (path === '/apply-template') {
      const messages = body.messages ?? []
      const system = messages.find((one) => one.role === 'system')?.content ?? ''
      const user = messages.find((one) => one.role === 'user')?.content ?? ''
      payload = { prompt: `${TEMPLATE_HEAD}${system}${TEMPLATE_MID}${user}${TEMPLATE_TAIL}` }
    } else if (path === '/tokenize') {
      payload = { tokens: tokenise(String(body.content)) }
    } else if (path === '/v1/systemone') {
      // The judgement's route (`src/llama.ts`, `llamaWatchModel`): one named question of type
      // `choice`, answered with a probability per declared answer. No text is generated and
      // the real server reports `output_tokens: 0`; nothing in the kernel reads it, so nothing
      // here carries it.
      payload = { answers: { respond: { probabilities: options.probabilities ?? ACT } } }
    } else if (path === '/v1/chat/completions') {
      // Stage 2's route. `choices[0].message.tool_calls` is how a model asks to speak
      // (`src/llama.ts`, `chatTurn`), and `content` is deliberately empty: the working
      // record has no path into a room (`say.ts`), so a fake that answered in `content`
      // would be testing a route that does not exist.
      payload = {
        choices: [
          {
            message: {
              content: '',
              tool_calls: options.toolCalls ?? [],
            },
          },
        ],
      }
    } else {
      return { ok: false, status: 404, text: async () => 'no such route' }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) }
  }
  return { fetch, calls }
}

/**
 * The answer a fixed cut has to be compared against: one probability per declared answer.
 *
 * Both are probabilities rather than the logprobs the old token reading carried, because the
 * endpoint this tree asks reports calibrated probabilities and generates no token at all.
 */
const ACT = { act: 0.9, ignore: 0.05 }

/**
 * What a work server says, as the call a model makes: `say(room, text)`.
 *
 * Nothing is posted on an agent's behalf (`src/README.md` line 14), so this is the only
 * shape in which words reach a room — and a test that wanted them to reach it any other
 * way would be testing a route the kernel refuses.
 */
function sayCall(room, text) {
  return [{ function: { name: 'say', arguments: JSON.stringify({ room, text }) } }]
}

/**
 * The kernel's own two-bot fixture with one bot left, written to disk.
 *
 * `makeWorld` gives two bots on purpose — it is the fixture that catches a delivery
 * written per agent instead of per bot — but **stage 1 is bound per bot**, so the world
 * this file opens holds one. Starting from the kernel's fixture rather than an invented
 * store is what makes a delivery produce the entry the rules cannot settle, which is the
 * entry a model is asked about; a store written by hand here would be this file's idea of
 * what the rules do.
 *
 * **The other bot's membership stays, and only its record goes.** Removing it too would
 * leave a room of two — the person and one bot — and `delivery.ts` calls that a direct
 * message, which `gate.ts` settles on row 2 without asking anything. The tick would then
 * answer with the placeholder while this file believed it had measured a model.
 */
async function oneBotWorld() {
  const dir = await mkdtemp(join(tmpdir(), 'seek-ui-model-'))
  const world = makeWorld()
  delete world.store.data.bots[world.botB]
  delete world.store.data.agents[world.agentB1]
  const storeFile = join(dir, 'seek.json')
  const store = new SeekStore(world.store.data, storeFile)
  await store.save()
  return { world, storeFile, dir }
}

/** The messages in one room, as the interface would draw them. */
function messagesIn(snapshot, roomId) {
  return snapshot.rooms.find((room) => room.id === roomId)?.messages ?? []
}

test('with nothing named, the bot says nothing and the window says which bots are quiet', async () => {
  const w = await oneBotWorld()
  const host = await openHost(w.storeFile)
  try {
    assert.equal(host.stage1.server, null, 'no server, so no judgement is bound')
    assert.equal(host.stage1.refusal, null, 'and nothing was refused — this is the shipped state')
    assert.deepEqual(host.stage1.quiet, ['A'], 'the bot this half has nothing for, by name')

    const snapshot = await postMessage(host, { roomId: w.world.room, text: 'the deploy is red' })

    assert.deepEqual(
      snapshot.stage1,
      { server: null, refusal: null, quiet: ['A'], pending: null, weights: null },
      'the window carries it too',
    )
    assert.deepEqual(
      snapshot.stage2,
      { server: null, refusal: null, quiet: ['A'], pending: null, weights: null },
      'and stage 2 is quiet for the same bot — nothing named, nothing refused',
    )
    assert.deepEqual(
      snapshot.modelNotReady,
      { cannotAnswer: ['A'], namedOnly: [] },
      'the model is not ready, and this bot has nothing to answer with either way',
    )
    assert.deepEqual(
      messagesIn(snapshot, w.world.room).map((one) => one.text),
      ['the deploy is red'],
      'nothing was posted on the bot’s behalf — no line stands in for an answer',
    )
    assert.equal(
      host.store.messagesOf(w.world.room).length,
      1,
      'and nothing was invented into the store either',
    )
  } finally {
    closeHost(host)
    await rm(w.dir, { recursive: true, force: true })
  }
})

test('with no judgement of its own, a bot still answers what is addressed to it', async () => {
  // The missing half here is stage 1: no server named, so nothing judges. But a mention is
  // settled by the rules (`gate.ts` row 2), and that entry reaches stage 2 without asking
  // anything — so this bot answers when it is addressed and stays quiet when it is not. That
  // is the fact the window words second: a bot left without a judgement is not a bot that
  // cannot answer, and saying so would be false about the room it is standing in.
  const w = await oneBotWorld()
  const work = fakeServer({ modelAlias: 'big', toolCalls: sayCall(w.world.room, 'the build is fine') })
  const host = await openHost(w.storeFile, {
    workServer: 'http://127.0.0.1:8081',
    workFetch: work.fetch,
  })
  try {
    assert.equal(host.stage1.server, null, 'no judgement is bound')
    assert.deepEqual(host.stage1.quiet, ['A'], 'this half has nothing for the bot')
    assert.deepEqual(host.stage2.quiet, [], 'and the words half is served')

    // A room of three, said to nobody in particular: the rules cannot settle it, and there is
    // nothing to ask.
    const unnamed = await postMessage(host, { roomId: w.world.room, text: 'the deploy is red' })
    assert.deepEqual(
      messagesIn(unnamed, w.world.room).map((one) => one.text),
      ['the deploy is red'],
      'nothing answered a message that named nobody',
    )
    assert.deepEqual(
      unnamed.modelNotReady,
      { cannotAnswer: [], namedOnly: ['A'] },
      'and the window says what naming it would do',
    )

    // The same room, with the bot named: row 2 acts with no model at all, and stage 2 speaks.
    const named = await postMessage(host, {
      roomId: w.world.room,
      text: '@A the deploy is red',
      mentions: [{ id: w.world.botA, name: 'A' }],
    })
    assert.deepEqual(
      messagesIn(named, w.world.room).map((one) => one.text),
      ['the deploy is red', '@A the deploy is red', 'the build is fine'],
      'a mention is settled by the rules, so the bot answers with no judgement behind it',
    )
    assert.deepEqual(
      named.modelNotReady,
      { cannotAnswer: [], namedOnly: ['A'] },
      'and the reading does not change: it still has no judgement of its own',
    )
  } finally {
    closeHost(host)
    await rm(w.dir, { recursive: true, force: true })
  }
})

test('a named watch server is asked, and its verdict is what acts', async () => {
  const w = await oneBotWorld()
  const recorder = fakeServer({ probabilities: ACT })
  const host = await openHost(w.storeFile, {
    server: 'http://127.0.0.1:8080',
    window: '24',
    fetch: recorder.fetch,
  })
  try {
    assert.equal(host.stage1.server, 'http://127.0.0.1:8080', 'the window can say which server')
    assert.equal(host.stage1.refusal, null)
    assert.deepEqual(host.stage1.quiet, [], 'and the half is bound for this bot')
    const askedUpFront = recorder.calls.filter((call) => call.path === '/v1/systemone').length
    assert.equal(askedUpFront, 0, 'binding measures the ids; it does not judge anything yet')

    const snapshot = await postMessage(host, { roomId: w.world.room, text: 'the batch failed' })

    assert.ok(
      recorder.calls.filter((call) => call.path === '/v1/systemone').length >= 1,
      'the message reached the model, so the verdict is the model’s',
    )
    const room = snapshot.rooms.find((one) => one.id === w.world.room)
    assert.equal(room.spend.turns, 1, 'the model said act, so a turn ran for the bot')
    assert.deepEqual(
      room.messages.map((one) => one.text),
      ['the batch failed'],
      'and no line came of it: the half that writes has no model, so nothing writes one',
    )
    assert.deepEqual(
      snapshot.modelNotReady,
      { cannotAnswer: ['A'], namedOnly: [] },
      'what the window says: the judgement is served, the words are not, so it cannot answer',
    )
  } finally {
    closeHost(host)
    await rm(w.dir, { recursive: true, force: true })
  }
})

test('the same server answering below the shipped cut keeps the bot quiet', async () => {
  // 0.55 is under the artifact's own 0.6, so the entry is settled as ignore and never
  // reaches stage 2. Without this case, "the bot answered" would be explained equally well
  // by a judge that acts on everything — which is what the placeholder does.
  const w = await oneBotWorld()
  const recorder = fakeServer({
    probabilities: { act: 0.55, ignore: 0.3 },
  })
  const host = await openHost(w.storeFile, {
    server: 'http://127.0.0.1:8080',
    window: '24',
    fetch: recorder.fetch,
  })
  try {
    const snapshot = await postMessage(host, { roomId: w.world.room, text: 'the batch failed' })

    assert.ok(
      recorder.calls.some((call) => call.path === '/v1/systemone'),
      'the model was asked — the silence is its answer, not a wiring that never called',
    )
    const messages = messagesIn(snapshot, w.world.room)
    assert.deepEqual(messages.map((one) => one.text), ['the batch failed'], 'nothing answered it')
  } finally {
    closeHost(host)
    await rm(w.dir, { recursive: true, force: true })
  }
})

test('a server serving another model leaves that bot quiet, and the store opens anyway', async () => {
  const w = await oneBotWorld()
  const recorder = fakeServer({ probabilities: ACT, modelAlias: 'other', modelPath: null })
  const host = await openHost(w.storeFile, {
    server: 'http://127.0.0.1:8080',
    window: '24',
    fetch: recorder.fetch,
  })
  try {
    assert.equal(host.stage1.server, 'http://127.0.0.1:8080', 'the half was bound to the origin named')
    assert.match(host.stage1.refusal, /serves 'other'/, "the reason names what the server serves")
    assert.match(host.stage1.refusal, /gate/, 'and what the roster claimed')
    assert.match(host.stage1.refusal, /^A: /, 'and which bot’s row claimed it')
    assert.deepEqual(host.stage1.quiet, ['A'], 'the bot it left without a judgement')

    const snapshot = await postMessage(host, { roomId: w.world.room, text: 'the deploy is red' })

    assert.deepEqual(
      messagesIn(snapshot, w.world.room).map((one) => one.text),
      ['the deploy is red'],
      'the app still works, and nothing answered the message',
    )
    assert.deepEqual(
      snapshot.modelNotReady,
      { cannotAnswer: ['A'], namedOnly: [] },
      'the window says the bot cannot answer',
    )
    assert.match(snapshot.stage1.refusal, /serves 'other'/, 'while the reading keeps the reason')
  } finally {
    closeHost(host)
    await rm(w.dir, { recursive: true, force: true })
  }
})

test('half of the pair is refused rather than guessed, and the refusal names the missing one', async () => {
  const w = await oneBotWorld()
  try {
    const noWindow = await openHost(w.storeFile, { server: 'http://127.0.0.1:8080' })
    try {
      assert.equal(noWindow.stage1.server, null)
      assert.match(noWindow.stage1.refusal, /SEEK_WINDOW/, 'a server with no budget is refused')
    } finally {
      closeHost(noWindow)
    }

    const noServer = await openHost(w.storeFile, { window: '10' })
    try {
      assert.equal(noServer.stage1.server, null)
      assert.match(noServer.stage1.refusal, /SEEK_SERVER/, 'a budget with no server is refused')
    } finally {
      closeHost(noServer)
    }
  } finally {
    await rm(w.dir, { recursive: true, force: true })
  }
})

test('every bot in the store is bound, and each answers for itself', async () => {
  // The store the window opens over can hold several bots, and the rows a binding checks are
  // one bot's: the `model` its watch row claims, the box its judgement reads, the name and
  // card a turn is filled from. So the binding is per bot — a build that bound one bot and
  // served the rest from it refused this store outright, which is what the store the host's
  // own machine carries used to hit.
  const dir = await mkdtemp(join(tmpdir(), 'seek-ui-model-'))
  try {
    const world = makeWorld()
    const storeFile = join(dir, 'seek.json')
    await new SeekStore(world.store.data, storeFile).save()

    const watch = fakeServer({ probabilities: ACT })
    const work = fakeServer({ modelAlias: 'big', toolCalls: sayCall(world.room, 'on it') })
    const host = await openHost(storeFile, {
      server: 'http://127.0.0.1:8080',
      window: '24',
      fetch: watch.fetch,
      workServer: 'http://127.0.0.1:8081',
      workFetch: work.fetch,
    })
    try {
      assert.equal(host.stage1.refusal, null, 'neither bot’s watch row was refused')
      assert.deepEqual(host.stage1.quiet, [], 'both are bound to the watch model')
      assert.deepEqual(host.stage2.quiet, [], 'and both have words')

      const snapshot = await postMessage(host, { roomId: world.room, text: 'the batch failed' })

      const room = snapshot.rooms.find((one) => one.id === world.room)
      assert.equal(room.messages.length, 3, 'the message, and one answer from each bot')
      assert.deepEqual(
        room.messages.map((one) => one.sender).sort(),
        [world.me, world.botA, world.botB].sort(),
        'each bot answered as itself, and the person is the third voice',
      )
      assert.equal(room.spend.turns, 2, 'two turns: one per bot, not one for the store')
      assert.deepEqual(
        room.spend.bots.map((one) => one.id).sort(),
        [world.botA, world.botB].sort(),
        'and the ledger names both of them',
      )
    } finally {
      closeHost(host)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a work server makes the words in the room the model’s, and the window names both', async () => {
  // Two servers, because a server serves one model and the fixture's two roster rows claim
  // two: `gate` decides whether the bot acts, `big` writes what it says
  // Binding both to one origin is the shape this test rules
  // out by measuring it — the work row's claim would be checked against `gate` and refused.
  const w = await oneBotWorld()
  const watch = fakeServer({ probabilities: ACT })
  const work = fakeServer({ modelAlias: 'big', modelPath: '/models/big.gguf', toolCalls: sayCall(w.world.room, 'the batch failed on shard 3 — I am on it') })
  const host = await openHost(w.storeFile, {
    server: 'http://127.0.0.1:8080',
    window: '24',
    fetch: watch.fetch,
    workServer: 'http://127.0.0.1:8081',
    workFetch: work.fetch,
  })
  try {
    assert.equal(host.stage1.server, 'http://127.0.0.1:8080')
    assert.equal(host.stage2.server, 'http://127.0.0.1:8081', 'the two halves are two origins')
    assert.equal(host.stage2.refusal, null)

    const snapshot = await postMessage(host, { roomId: w.world.room, text: 'the batch failed' })

    const messages = messagesIn(snapshot, w.world.room)
    assert.equal(messages.length, 2, 'the model said act, so the bot answered')
    assert.notEqual(messages[1].text, STUB_REPLY, 'and the line is not the kernel’s placeholder')
    assert.equal(
      messages[1].text,
      'the batch failed on shard 3 — I am on it',
      'it is the text the model passed to `say`, which is the only way into a room',
    )
    assert.ok(
      work.calls.some((call) => call.path === '/v1/chat/completions'),
      'the work server was asked for a turn, on the chat route',
    )
    const asked = await work.calls.find((call) => call.path === '/v1/chat/completions')
    assert.ok(Array.isArray(asked.body.tools) && asked.body.tools.length > 0, 'with the artifact’s tools')
    assert.equal(snapshot.stage2.server, 'http://127.0.0.1:8081', 'a send keeps both readings')
  } finally {
    closeHost(host)
    await rm(w.dir, { recursive: true, force: true })
  }
})

test('a refused words half leaves that bot quiet and the watch half working', async () => {
  // The fixture's work row claims `big`; this server serves `other`, so stage 2 refuses for
  // that bot and stage 1 does not. The halves are read apart and reported apart — a bot left
  // with no words says nothing at all, and it must not be mistaken for a model that answered.
  const w = await oneBotWorld()
  const watch = fakeServer({ probabilities: ACT })
  const work = fakeServer({ modelAlias: 'other', modelPath: null })
  const host = await openHost(w.storeFile, {
    server: 'http://127.0.0.1:8080',
    window: '24',
    fetch: watch.fetch,
    workServer: 'http://127.0.0.1:8081',
    workFetch: work.fetch,
  })
  try {
    assert.equal(host.stage1.server, 'http://127.0.0.1:8080', 'stage 1 is served')
    assert.deepEqual(host.stage1.quiet, [], 'and bound for the bot in the room')
    assert.match(host.stage2.refusal, /serves 'other'/, 'the reason names what the server serves')
    assert.match(host.stage2.refusal, /big/, 'and what the work row claimed')
    assert.deepEqual(host.stage2.quiet, ['A'], 'the bot left without words, by name')

    const snapshot = await postMessage(host, { roomId: w.world.room, text: 'the batch failed' })

    assert.deepEqual(
      messagesIn(snapshot, w.world.room).map((one) => one.text),
      ['the batch failed'],
      'nothing answered it: the half that writes could not be bound',
    )
    assert.equal(
      snapshot.rooms.find((one) => one.id === w.world.room).spend.turns,
      1,
      'the bot did act — the judgement was served',
    )
    assert.deepEqual(
      snapshot.modelNotReady,
      { cannotAnswer: ['A'], namedOnly: [] },
      'and the window says the bot cannot answer',
    )
    assert.match(snapshot.stage2.refusal, /serves 'other'/, 'while the reading keeps saying why')
    assert.equal(snapshot.stage1.server, 'http://127.0.0.1:8080', 'and stage 1 is still named')
  } finally {
    closeHost(host)
    await rm(w.dir, { recursive: true, force: true })
  }
})

test('a work server is not asked for anything when the watch half kept the bot quiet', async () => {
  // The two halves are one loop, in order: a turn that stage 1 settled never reaches stage 2,
  // so a work server being named costs nothing on a message the bot was right to ignore.
  const w = await oneBotWorld()
  const watch = fakeServer({
    probabilities: { act: 0.55, ignore: 0.3 },
  })
  const work = fakeServer({ modelAlias: 'big', toolCalls: sayCall(w.world.room, 'should never be said') })
  const host = await openHost(w.storeFile, {
    server: 'http://127.0.0.1:8080',
    window: '24',
    fetch: watch.fetch,
    workServer: 'http://127.0.0.1:8081',
    workFetch: work.fetch,
  })
  try {
    const snapshot = await postMessage(host, { roomId: w.world.room, text: 'the batch failed' })

    assert.deepEqual(
      messagesIn(snapshot, w.world.room).map((one) => one.text),
      ['the batch failed'],
      'nothing answered it',
    )
    assert.equal(
      work.calls.filter((call) => call.path === '/v1/chat/completions').length,
      0,
      'and the work server was never asked for a turn',
    )
  } finally {
    closeHost(host)
    await rm(w.dir, { recursive: true, force: true })
  }
})

/**
 * A hosted endpoint: the chat route and a model list, and nothing a `llama-server` answers.
 *
 * `/props`, `/apply-template` and `/tokenize` are 404 here on purpose. They are the three
 * routes the cut was measured through and the three a hosted endpoint does not have, so a
 * change that quietly asked one of them again fails on the recorded calls rather than on a
 * number — which is the only way "this half reached a model without them" can be seen.
 */
function fakeHosted(options = {}) {
  const calls = []
  const fetch = async (url, init) => {
    const path = new URL(url).pathname
    const body = init.body === undefined ? {} : JSON.parse(init.body)
    calls.push({ path, method: init.method, body })
    if (path === '/v1/models') {
      const data = options.served ?? [{ id: 'big', context_window: 1048576 }]
      return { ok: true, status: 200, text: async () => JSON.stringify({ data }) }
    }
    if (path === '/v1/chat/completions') {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [{ message: { content: '', tool_calls: options.toolCalls ?? [] } }],
          }),
      }
    }
    return { ok: false, status: 404, text: async () => 'no such route' }
  }
  return { fetch, calls }
}

test('the words half writes through a hosted endpoint once its model is named', async () => {
  // The half that writes the words is the one that may be a server you pay for, and naming
  // its model is what says so: a `llama-server` is asked `/props`, a hosted endpoint is
  // asked which names it serves. What the cut needs from that half — that what a turn says
  // reaches a room only through `say` — is unchanged, which is what the text below is.
  const w = await oneBotWorld()
  const watch = fakeServer({ probabilities: ACT })
  const work = fakeHosted({ toolCalls: sayCall(w.world.room, 'shard 3 is retrying now') })
  const host = await openHost(w.storeFile, {
    server: 'http://127.0.0.1:8080',
    window: '24',
    fetch: watch.fetch,
    // The form a provider hands out: `base_url` already ends in `/v1`, which is exactly the
    // form that would double the segment if the transport appended its own.
    workServer: 'http://127.0.0.1:8081/v1',
    workModel: 'big',
    workFetch: work.fetch,
  })
  try {
    assert.equal(host.stage2.refusal, null, 'a name its own list carries is not a refusal')
    assert.equal(host.stage2.server, 'http://127.0.0.1:8081/v1', 'the snapshot names it as it was given')

    const snapshot = await postMessage(host, { roomId: w.world.room, text: 'the batch failed' })

    assert.equal(
      messagesIn(snapshot, w.world.room)[1].text,
      'shard 3 is retrying now',
      'the hosted model wrote the words, through the one route into a room',
    )
    assert.deepEqual(
      work.calls.map((call) => `${call.method} ${call.path}`),
      ['GET /v1/models', 'POST /v1/chat/completions'],
      'one name check before the first turn, then the chat call — no /props, no template, ' +
        'no tokeniser, and no doubled /v1',
    )
    assert.equal(
      work.calls[1].body.model,
      'big',
      'the chat call names the model the endpoint itself confirmed',
    )
  } finally {
    closeHost(host)
    await rm(w.dir, { recursive: true, force: true })
  }
})

test('a model named with no server beside it is refused, and only that half is', async () => {
  // The pairing `SEEK_SERVER`/`SEEK_WINDOW` has, one half over: a model name is a fact
  // about a server, so a name with no origin names nothing to ask. The watch half is
  // served throughout — one refusal must not take the other half with it.
  const w = await oneBotWorld()
  const watch = fakeServer({ probabilities: ACT })
  const host = await openHost(w.storeFile, {
    server: 'http://127.0.0.1:8080',
    window: '24',
    fetch: watch.fetch,
    workModel: 'big',
  })
  try {
    assert.equal(host.stage1.refusal, null, 'the half that was named properly is served')
    assert.equal(host.stage2.server, null, 'the half that was not is not')
    assert.match(host.stage2.refusal, /SEEK_WORK_MODEL/, 'the reason names the variable that said it')
    assert.match(host.stage2.refusal, /SEEK_WORK_SERVER/, 'and the one that was missing')

    const snapshot = await postMessage(host, { roomId: w.world.room, text: 'the batch failed' })

    assert.deepEqual(
      messagesIn(snapshot, w.world.room).map((one) => one.text),
      ['the batch failed'],
      'nothing answered: a model name with no server names nothing to ask',
    )
    assert.deepEqual(
      snapshot.modelNotReady,
      { cannotAnswer: ['A'], namedOnly: [] },
      'and the window says the bot cannot answer',
    )
    assert.equal(snapshot.stage1.server, 'http://127.0.0.1:8080', 'while stage 1 is untouched')
  } finally {
    closeHost(host)
    await rm(w.dir, { recursive: true, force: true })
  }
})

test('the app hands the named model to the words half, read where the environment is', async () => {
  // `main.js` requires Electron and cannot be imported here, so what is checked is the
  // line that carries it, in the same text-level way `store-refusal.test.mjs` checks the
  // refusal it reports. A variable read and then not passed is the failure this catches:
  // the half would keep asking `/props` of an endpoint that has none, and the person who
  // set the variable would have no way to tell that from an endpoint that was never used.
  const source = await readFile(new URL('./main.js', import.meta.url), 'utf8')
  assert.match(source, /const MODEL_WORK_MODEL = process\.env\.SEEK_WORK_MODEL/)
  assert.match(source, /const words = await wordsFacts\(\)/, 'the words half is decided by that rule')
  assert.match(source, /^\s+workModel,$/m, 'and the model it chose is handed down')
  assert.match(source, /^\s+workApiKey,$/m, 'along with the key that belongs to that origin')
  // The middle source is this app's own file, and it is read in the one function all three
  // callers share — a launch, the window that draws it, and the save that changes it.
  assert.match(source, /settings: ownSettings\.llm,/, 'the app\'s own settings are the middle source')

  // **An endpoint named for this half outranks the server the app starts**, which is the whole
  // point: a launch must not have its words half pulled back to the model the package carries.
  // *Named* is the word that matters, and it covers both sources — a file and the environment,
  // which is how the README says to point this half at another `llama-server`. A guard built on
  // "a file named it" leaves an endpoint given in the environment silently replaced by the
  // bundled one, so what these assert is the guard itself.
  assert.match(
    source,
    /const wordsNamed = workServer !== undefined/,
    'the guard asks whether anybody named this half, not whether a file did',
  )
  assert.match(
    source,
    /if \(!wordsNamed\) workServer = started\.origin/,
    'a running bundled server does not take the words half back',
  )
  assert.match(
    source,
    /if \(!wordsNamed\) workServer = undefined/,
    'and a weights failure does not refuse a half that needs no weights',
  )
  assert.doesNotMatch(
    source,
    /if \(!wordsFromFiles\)/,
    'no guard falls back to "a file named it", which would drop an endpoint named in the environment',
  )
  // The same question, asked a fourth time: a refusal about the server this app starts belongs
  // to a half that was going to use it, and to no other.
  assert.match(
    source,
    /workModelRefusal \?\? \(wordsNamed \? undefined : startRefusal\)/,
    'the state of the bundled server reaches only a half that was going to use it',
  )
})

test('each half sends the key that belongs to its own origin, and no other', async () => {
  // Two origins can want two keys. The one in the environment is a credential the person gave
  // these servers, so it keeps reaching both; a key read out of another program's config names
  // that endpoint alone, and sending it to a server the app started on this machine is a
  // credential leaving the only origin it belongs to. So this is measured on the wire rather
  // than argued: every request either half sent, and the header it carried.
  const w = await oneBotWorld()
  const watch = fakeServer({ probabilities: ACT })
  const work = fakeHosted({ toolCalls: sayCall(w.world.room, 'shard 3 is retrying now') })
  const seen = []
  const record = (half, recorder) => async (url, init) => {
    seen.push({ half, path: new URL(url).pathname, auth: init?.headers?.Authorization })
    return recorder.fetch(url, init)
  }
  const host = await openHost(w.storeFile, {
    server: 'http://127.0.0.1:8080',
    window: '24',
    fetch: record('watch', watch),
    apiKey: 'the-environment-key',
    workServer: 'https://endpoint.test/v1',
    workModel: 'big',
    workApiKey: 'the-configured-key',
    workFetch: record('work', work),
  })
  try {
    const snapshot = await postMessage(host, { roomId: w.world.room, text: 'the batch failed' })
    assert.equal(messagesIn(snapshot, w.world.room)[1].text, 'shard 3 is retrying now')

    const auths = (half) => [...new Set(seen.filter((one) => one.half === half).map((one) => one.auth))]
    assert.ok(seen.some((one) => one.half === 'watch'), 'the watch half was asked something')
    assert.deepEqual(auths('watch'), ['Bearer the-environment-key'])
    assert.deepEqual(auths('work'), ['Bearer the-configured-key'], 'and the words half never saw the other one')
  } finally {
    closeHost(host)
    await rm(w.dir, { recursive: true, force: true })
  }
})

test('one key, when only one was given, still reaches both halves', async () => {
  // The rule before this test existed, kept measurable: `SEEK_API_KEY` belongs to the origin a
  // person named, and with two halves on origins they run themselves it is the same person's.
  const w = await oneBotWorld()
  const watch = fakeServer({ probabilities: ACT })
  const work = fakeServer({ modelAlias: 'big', toolCalls: sayCall(w.world.room, 'on it') })
  const seen = []
  const record = (half, recorder) => async (url, init) => {
    seen.push({ half, auth: init?.headers?.Authorization })
    return recorder.fetch(url, init)
  }
  const host = await openHost(w.storeFile, {
    server: 'http://127.0.0.1:8080',
    window: '24',
    fetch: record('watch', watch),
    apiKey: 'the-one-key',
    workServer: 'http://127.0.0.1:8081',
    workFetch: record('work', work),
  })
  try {
    await postMessage(host, { roomId: w.world.room, text: 'the batch failed' })
    const auths = (half) => [...new Set(seen.filter((one) => one.half === half).map((one) => one.auth))]
    assert.deepEqual(auths('watch'), ['Bearer the-one-key'])
    assert.deepEqual(auths('work'), ['Bearer the-one-key'])
  } finally {
    closeHost(host)
    await rm(w.dir, { recursive: true, force: true })
  }
})
