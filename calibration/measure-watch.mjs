// Does the shipped judgement separate "this is for me" from "this is not"?
//
// `calibration/set4.json` is the labelled set written after every prompt selection, and
// `src/prompts/watch-v3.json` ships the cut that is applied to it. This file is the reading
// that cut rests on, taken **through the kernel's own code**: a store, a room, a message,
// `watchAs` from `src/watch.ts`, and `llamaWatchModel` from `src/llama.ts` talking to a real
// `llama-server` at its `/v1/systemone`. Nothing here re-implements the state, the question,
// the cut or the arithmetic — the driver wraps the kernel's model only to keep the number the
// kernel read and the exact text the endpoint was sent.
//
// Two readings, because two questions are being answered:
//
//   A. the four messages a room actually produces — one names one bot, one names another,
//      two name nobody — asked of all four bots in the room. That is the shape the defect
//      this replaced was about: every bot either acted on a message naming one of them, or
//      none did.
//   B. the twenty-four labelled cases in `set4.json`, asked of one bot.
//
//   [MODEL=<gguf>] [ALIAS=<name>] [LLAMA=<binary>] [PORT=54466] [OUT=<file>] \
//     node calibration/measure-watch.mjs
//
// The record it writes is `calibration/set4-d1.json`, and it carries the state each case was
// sent as, so the figure `watch-v3.json` advertises can be recomputed by anyone holding the
// file rather than taken on this script's word.
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const KERNEL = process.env.KERNEL || join(HERE, '..')
const LLAMA = process.env.LLAMA || '/tmp/llama-b11946/llama-server'
const MODEL = process.env.MODEL || '/tmp/models/d1-2B-Q8_0.gguf'
const ALIAS = process.env.ALIAS || 'd1-2B'
const PORT = Number(process.env.PORT || 54466)
const OUT = process.env.OUT || join(HERE, 'set4-d1.json')
const BASE = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const { llamaWatchModel } = await import(join(KERNEL, 'src', 'llama.ts'))
const { loadPromptArtifact } = await import(join(KERNEL, 'src', 'prompts.ts'))
const { declaredOptions, watchAs } = await import(join(KERNEL, 'src', 'watch.ts'))
const { deliver } = await import(join(KERNEL, 'src', 'delivery.ts'))
const { emptyData, newId, SeekStore } = await import(join(KERNEL, 'src', 'store.ts'))

const artifact = loadPromptArtifact()
const point = artifact.operatingPoint
const tokens = declaredOptions()
if (typeof point?.threshold !== 'number') {
  throw new Error(`${artifact.version} declares no operating point, so there is no cut to read against`)
}

/** The room both readings happen in: four bots, one person, one name. */
const NAMES = ['小荷', 'Echo', '小李', '小胖']
const ROOM = '支付组'
const AT = '2026-10-28T08:40:00.000Z'

function fourBots() {
  const store = new SeekStore(emptyData())
  const me = newId('ou')
  store.data.principals[me] = { id: me, kind: 'human', name: '邵安清' }
  const bots = []
  for (const name of NAMES) {
    const id = newId('ou')
    store.data.bots[id] = { id, name, position: '运维' }
    bots.push(id)
  }
  const room = newId('oc')
  store.data.rooms[room] = { id: room, name: ROOM, chat_mode: 'group', created_at: AT }
  for (const principal of [me, ...bots]) {
    const id = newId('mb')
    store.data.memberships[id] = {
      id,
      room_id: room,
      principal_id: principal,
      joined_at: AT,
      role: principal === me ? 'owner' : 'member',
    }
  }
  return { store, me, room, bots }
}

/**
 * One judgement, through the kernel, keeping what the endpoint was actually sent.
 *
 * A fresh world per reading, for the same reason `measure-gate.mjs` builds one: one message
 * per judgement, so no case rides on another's delta and the reading belongs to the text it
 * is recorded against.
 */
async function judge(botName, text, server) {
  const world = fourBots()
  const bot = world.bots[NAMES.indexOf(botName)]
  deliver(world.store, { roomId: world.room, senderId: world.me, text })
  const entries = await world.store.drain(bot)

  let state = null
  let reading = null
  const base = llamaWatchModel(server)
  const recording = {
    async read(input) {
      state = input.prompt.state
      reading = await base.read(input)
      return reading
    },
  }
  await watchAs(world.store, bot, recording, { window: 40 })(entries)

  const p = reading?.probabilities?.[tokens.act]
  return {
    bot: botName,
    text,
    state,
    p_act: typeof p === 'number' ? Number(p.toFixed(4)) : null,
    choice: reading?.probabilities?.[tokens.ignore] === undefined ? null : null,
    verdict: entries[0].verdict,
  }
}

const args = [
  '-m', MODEL,
  '--alias', ALIAS,
  '--host', '127.0.0.1', '--port', String(PORT),
  '--no-webui', '--parallel', '1',
  '-c', '8192', '-b', '8192', '-ub', '8192', '--n-gpu-layers', '99',
]
const server = spawn(LLAMA, args, { stdio: ['ignore', 'pipe', 'pipe'] })
const said = []
server.stdout.on('data', (d) => said.push(String(d)))
server.stderr.on('data', (d) => said.push(String(d)))

try {
  let up = false
  for (let i = 0; i < 600; i += 1) {
    try {
      const health = await (await fetch(`${BASE}/health`)).json()
      if (health?.status === 'ok') { up = true; break }
    } catch {}
    if (server.exitCode !== null) throw new Error('llama-server exited: ' + said.join('').slice(-1200))
    await sleep(200)
  }
  if (!up) throw new Error('llama-server never answered /health')
  const props = await (await fetch(`${BASE}/props`)).json()
  const endpoint = { baseUrl: BASE }

  // ---- A. the four bots, one room, four messages -------------------------------------
  const MESSAGES = [
    { text: '小荷，这个 bug 你来看一下', named: '小荷' },
    { text: 'Echo，帮我看下这个接口报错', named: 'Echo' },
    { text: '今天下午三点开会', named: null },
    { text: '大家讨论一下', named: null },
  ]
  const matrix = []
  let right = 0
  console.log('\n=== A. four bots × four messages (a bot should act only when it is the one named) ===')
  for (const message of MESSAGES) {
    const row = { text: message.text, named: message.named, readings: [] }
    const cells = []
    for (const botName of NAMES) {
      const one = await judge(botName, message.text, endpoint)
      const should = message.named === null ? false : botName === message.named
      const hit = (one.p_act !== null && one.p_act >= point.threshold) === should
      if (hit) right += 1
      row.readings.push({ bot: botName, p_act: one.p_act, verdict: one.verdict, should_act: should, hit })
      cells.push(`${botName}:${one.p_act?.toFixed(2)}${hit ? '' : ' ✗'}`)
    }
    matrix.push(row)
    console.log(`  ${JSON.stringify(message.text)} (${message.named ?? 'nobody named'}) — ${cells.join('  ')}`)
  }
  console.log(`  → ${right}/${MESSAGES.length * NAMES.length}`)

  // ---- B. set4, one bot --------------------------------------------------------------
  const set = JSON.parse(readFileSync(join(HERE, 'set4.json'), 'utf8'))
  const rows = []
  let correct = 0
  const acts = []
  const others = []
  const misses = []
  console.log(`\n=== B. ${set.cases.length} labelled cases, read by 小荷 at ${point.threshold} ===`)
  for (const one of set.cases) {
    const read = await judge('小荷', one.text, endpoint)
    const should = one.label === 'act'
    const hit = read.p_act !== null && (read.p_act >= point.threshold) === should
    if (hit) correct += 1
    else misses.push({ label: one.label, p_act: read.p_act, text: one.text })
    ;(should ? acts : others).push(read.p_act)
    rows.push({ label: one.label, text: one.text, p_act: read.p_act, verdict: read.verdict, state: read.state })
    console.log(`  ${one.label.padEnd(6)} p_act=${read.p_act?.toFixed(3)} ${hit ? '' : '✗'}  ${one.text.slice(0, 36)}`)
  }
  console.log(
    `\n  correct at ${point.threshold}: ${correct}/${set.cases.length}` +
      `   lowest act ${Math.min(...acts).toFixed(3)}` +
      `   highest of ignore/keep/snooze ${Math.max(...others).toFixed(3)}`,
  )
  if (misses.length > 0) console.log('  missed: ' + JSON.stringify(misses, null, 1))

  // ---- the record ----------------------------------------------------------------
  const record = {
    _what_this_is:
      `Every case in set4.json, and a four-by-four of the messages a room actually produces, ` +
      `read through the shipped judgement: watchAs() from src/watch.ts over llamaWatchModel() ` +
      `from src/llama.ts against /v1/systemone. One message per fresh world, so no case rides ` +
      `on another's delta. Each row keeps the exact state the endpoint was sent, so the figure ` +
      `${artifact.version} advertises can be recomputed from this file alone.`,
    _why_this_file_exists:
      `the cut ${artifact.version} ships is applied to a probability, and a probability is only ` +
      `meaningful together with the text that produced it. The previous records ` +
      `(calibration/measured.json, calibration/vision/server-transport.json) measured a ` +
      `different reading on a different model: one token sampled after a sentence ending ` +
      `"Answer act or ignore", summed over the spellings of the option. Nothing here sums ` +
      `anything — the endpoint answers with one probability per declared answer.`,
    model: ALIAS,
    file: MODEL,
    build: props?.build_info ?? null,
    artifact: artifact.version,
    transport: '/v1/systemone, one named question of type `choice`, two declared answers',
    question: artifact.question,
    options: tokens,
    threshold: point.threshold,
    case_set: 'calibration/set4.json',
    correct_at_cut: correct,
    cases: rows.length,
    lowest_act: Number(Math.min(...acts).toFixed(4)),
    highest_other: Number(Math.max(...others).toFixed(4)),
    missed: misses,
    readings: rows,
    four_bots: matrix,
    four_bots_correct: right,
    four_bots_total: MESSAGES.length * NAMES.length,
    what_was_not_measured: [
      'how the model behaves on pictures: it has no projector (`modalities.vision: false`), and a box carrying one is refused rather than read from its caption (src/watch.ts)',
      'any language but the two in this set: twelve of the twenty-four are Chinese and twelve English, which is what the set holds rather than a language study',
      'a second sampling run: a decision model produces a probability and no token, so there is nothing to sample. Two identical asks were measured at a 0.0000 difference',
    ],
  }
  writeFileSync(OUT, JSON.stringify(record, null, 2))
  console.log(`\n=== wrote ${OUT} ===`)
} finally {
  server.kill('SIGTERM')
  await sleep(1200)
  if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL')
  console.log(`=== llama-server stopped (exitCode=${server.exitCode}, signal=${server.signalCode}) ===`)
}
