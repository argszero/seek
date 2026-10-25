/**
 * Stage 1 is a real model when one is named, and the window is told which one it got.
 *
 * The interface's whole claim so far was a room that answers; the answer was the kernel's
 * stub and the *decision* to answer was a stub too, so a bot spoke on every message. What
 * this file measures is the half that changed: with `SEEK_SERVER`/`SEEK_WINDOW` set, the
 * verdict comes from the watch model over that server — so the bot speaks when the model
 * says to and stays quiet when it says not to. What it says is still `STUB_REPLY`, and
 * that is the other thing pinned here: this slice wires stage 1 only.
 *
 * **Nothing here starts a model.** The transport is `LlamaServer.fetch`, the seam the
 * kernel's own `watch-server.test.ts` uses, so a fake answers `/props`, `/apply-template`,
 * `/tokenize` and `/completion` and records what it was asked. No socket is opened and no
 * process is waited on.
 *
 * **A refusal is a reading, not a crash.** A server that cannot be used does not stop the
 * window opening: the store is local and its messages are still there, so the app falls
 * back to the placeholder and says *which* server it did not use and why. The last tests
 * here are the refused cases, and each one asserts both halves — the reason, and an app
 * that still works.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
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
 * names is what the roster's claim is checked against (`docs/decisions.md` row 24) — so it
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
    } else if (path === '/completion') {
      payload = { completion_probabilities: [{ top_logprobs: options.candidates ?? [] }] }
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

/** The reading a fixed cut has to be compared against: one `act`, one `ignore`. */
const ACTS = [
  { token: 'act', logprob: Math.log(0.9) },
  { token: 'ignore', logprob: Math.log(0.05) },
]

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

test('with no server named, the placeholder decides and the window is told there is none', async () => {
  const w = await oneBotWorld()
  const host = await openHost(w.storeFile)
  try {
    assert.equal(host.stage1.server, null, 'no server, so stage 1 is the kernel placeholder')
    assert.equal(host.stage1.refusal, null, 'and nothing was refused — this is the shipped state')

    const snapshot = await postMessage(host, { roomId: w.world.room, text: 'the deploy is red' })

    assert.deepEqual(snapshot.stage1, { server: null, refusal: null }, 'the window carries it too')
    assert.deepEqual(
      snapshot.stage2,
      { server: null, refusal: null },
      'and stage 2 is the placeholder too — nothing named, nothing refused',
    )
    const messages = messagesIn(snapshot, w.world.room)
    assert.equal(messages.length, 2, 'what was typed, and the placeholder acting on it')
    assert.equal(messages[1].text, STUB_REPLY, "and the line is the kernel's stub")
  } finally {
    closeHost(host)
    await rm(w.dir, { recursive: true, force: true })
  }
})

test('a server named with a window asks the model, and its verdict is what makes the bot speak', async () => {
  const w = await oneBotWorld()
  const recorder = fakeServer({ candidates: ACTS })
  const host = await openHost(w.storeFile, {
    server: 'http://127.0.0.1:8080',
    window: '24',
    fetch: recorder.fetch,
  })
  try {
    assert.equal(host.stage1.server, 'http://127.0.0.1:8080', 'the window can say which server')
    assert.equal(host.stage1.refusal, null)
    const askedUpFront = recorder.calls.filter((call) => call.path === '/completion').length
    assert.equal(askedUpFront, 0, 'binding measures the ids; it does not judge anything yet')

    const snapshot = await postMessage(host, { roomId: w.world.room, text: 'the batch failed' })

    assert.ok(
      recorder.calls.filter((call) => call.path === '/completion').length >= 1,
      'the message reached the model, so the verdict is the model’s',
    )
    const messages = messagesIn(snapshot, w.world.room)
    assert.equal(messages.length, 2, 'the model said act, so the bot answers')
    assert.equal(messages[1].text, STUB_REPLY, 'and what it says is still stage 2’s placeholder')
    assert.equal(snapshot.stage1.server, 'http://127.0.0.1:8080', 'a send keeps the strip on screen')
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
    candidates: [
      { token: 'act', logprob: Math.log(0.55) },
      { token: 'ignore', logprob: Math.log(0.3) },
    ],
  })
  const host = await openHost(w.storeFile, {
    server: 'http://127.0.0.1:8080',
    window: '24',
    fetch: recorder.fetch,
  })
  try {
    const snapshot = await postMessage(host, { roomId: w.world.room, text: 'the batch failed' })

    assert.ok(
      recorder.calls.some((call) => call.path === '/completion'),
      'the model was asked — the silence is its answer, not a wiring that never called',
    )
    const messages = messagesIn(snapshot, w.world.room)
    assert.deepEqual(messages.map((one) => one.text), ['the batch failed'], 'nothing answered it')
  } finally {
    closeHost(host)
    await rm(w.dir, { recursive: true, force: true })
  }
})

test('a server serving another model is refused, and the window opens on the placeholder', async () => {
  const w = await oneBotWorld()
  const recorder = fakeServer({ candidates: ACTS, modelAlias: 'other', modelPath: null })
  const host = await openHost(w.storeFile, {
    server: 'http://127.0.0.1:8080',
    window: '24',
    fetch: recorder.fetch,
  })
  try {
    assert.equal(host.stage1.server, null, 'the refused server is not the one in use')
    assert.match(host.stage1.refusal, /serves 'other'/, "the reason names what the server serves")
    assert.match(host.stage1.refusal, /gate/, 'and what the roster claimed')

    const snapshot = await postMessage(host, { roomId: w.world.room, text: 'the deploy is red' })

    const messages = messagesIn(snapshot, w.world.room)
    assert.equal(messages.length, 2, 'the app still works: the placeholder answers')
    assert.equal(messages[1].text, STUB_REPLY)
    assert.match(snapshot.stage1.refusal, /serves 'other'/, 'and the window keeps saying why')
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

test('a store holding two bots is refused rather than bound to whichever came first', async () => {
  // `watchOverServer` binds one bot, because the model it checks is that bot's watch row
  // and the identity its agents are told is that bot's. `Kernel` takes a single `judge`, so
  // a second bot would be served by the same server without its own claim being checked —
  // the failure row 24 exists to stop, one bot over.
  const dir = await mkdtemp(join(tmpdir(), 'seek-ui-model-'))
  try {
    const storeFile = join(dir, 'seek.json')
    await new SeekStore(makeWorld().store.data, storeFile).save()

    const host = await openHost(storeFile, {
      server: 'http://127.0.0.1:8080',
      window: '24',
      fetch: fakeServer({ candidates: ACTS }).fetch,
    })
    try {
      assert.equal(host.stage1.server, null)
      assert.match(host.stage1.refusal, /holds 2 bots/)
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
  // (`docs/decisions.md` row 24). Binding both to one origin is the shape this test rules
  // out by measuring it — the work row's claim would be checked against `gate` and refused.
  const w = await oneBotWorld()
  const watch = fakeServer({ candidates: ACTS })
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
    assert.equal(snapshot.stage2.server, 'http://127.0.0.1:8081', 'a send keeps both strips on screen')
  } finally {
    closeHost(host)
    await rm(w.dir, { recursive: true, force: true })
  }
})

test('the work half refusing does not take the watch half with it', async () => {
  // The fixture's work row claims `big`; this server serves `other`, so stage 2 is refused
  // and stage 1 is not. One strip for both would let the working half hide the broken one,
  // and a bot that still answers — because `stubDecide` took over — is exactly the state a
  // reader must be able to tell apart from a model that answered.
  const w = await oneBotWorld()
  const watch = fakeServer({ candidates: ACTS })
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
    assert.equal(host.stage2.server, null, 'stage 2 is not')
    assert.match(host.stage2.refusal, /serves 'other'/, 'the reason names what the server serves')
    assert.match(host.stage2.refusal, /big/, 'and what the work row claimed')

    const snapshot = await postMessage(host, { roomId: w.world.room, text: 'the batch failed' })

    const messages = messagesIn(snapshot, w.world.room)
    assert.equal(messages.length, 2, 'the window still works: the placeholder answers')
    assert.equal(messages[1].text, STUB_REPLY, 'and that answer is visibly the kernel’s line')
    assert.match(snapshot.stage2.refusal, /serves 'other'/, 'while the strip keeps saying why')
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
    candidates: [
      { token: 'act', logprob: Math.log(0.55) },
      { token: 'ignore', logprob: Math.log(0.3) },
    ],
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
