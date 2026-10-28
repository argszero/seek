// Does the work model ever see these messages? One gate reading per case.
//
// `measure.mjs` answers "which work model calls `say`". This answers the question that
// decides what that table costs: the work model is stage 2, and a message reaches it
// only after stage 0's rules and stage 1's cut have had their say. So a model that
// speaks when it should not only costs anything on the cases that get that far.
//
// The cases are `cases.json`, the same nine the work table was measured on — not a
// second set written to flatter this one. Each is posted into a room by a human, drained
// by the bot, settled by the kernel's own `classify`, and, when the rules leave it to the
// model, read by the kernel's own `watchAs` over a real `llama-server`. Nothing here
// re-implements a rule: the gate is `gate.ts`, the reading is `llama.ts`, the comparison
// against the shipped 0.600 is `watch.ts`.
//
// **The judgement is one call to `/v1/systemone`**, the decision endpoint (`d1-2B`), and
// it answers with one calibrated probability per declared answer and generates no token.
// So nothing here binds a token id, strips a spelling or sums anything — the driver wraps
// the kernel's model only to keep the number the kernel read.
//
//   [MODEL=<gguf>] [ALIAS=<name>] [LLAMA=<binary>] [PORT=54467] [OUT=<file>] \
//     node calibration/work/measure-gate.mjs
//
// The bot is named Echo and the room carries a nightly batch, because the cases name it:
// two of the six that should speak begin `@Echo`, and a mention is what makes stage 0
// fast-pass a message instead of asking a model about it.
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const KERNEL = process.env.KERNEL || join(HERE, '..', '..')
const LLAMA = process.env.LLAMA || '/tmp/llama-b11946/llama-server'
const MODEL = process.env.MODEL || '/tmp/models/d1-2B-Q8_0.gguf'
const ALIAS = process.env.ALIAS || 'd1-2B'
const PORT = Number(process.env.PORT || 54467)
const OUT = process.env.OUT || join(HERE, 'gate-d1.json')
const BASE = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const { llamaWatchModel } = await import(join(KERNEL, 'src', 'llama.ts'))
const { loadPromptArtifact } = await import(join(KERNEL, 'src', 'prompts.ts'))
const { declaredOptions, watchAs } = await import(join(KERNEL, 'src', 'watch.ts'))
const { classify } = await import(join(KERNEL, 'src', 'gate.ts'))
const { deliver } = await import(join(KERNEL, 'src', 'delivery.ts'))
const { makeWorld } = await import(join(KERNEL, 'src', 'fixtures.ts'))

const set = JSON.parse(readFileSync(join(HERE, 'cases.json'), 'utf8'))
const artifact = loadPromptArtifact()
const tokens = declaredOptions()
const point = artifact.operatingPoint
if (typeof point?.threshold !== 'number') {
  throw new Error(`${artifact.version} declares no operating point, so there is no cut to read against`)
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
  let props = null
  for (let i = 0; i < 600; i += 1) {
    try {
      const health = await (await fetch(`${BASE}/health`)).json()
      if (health?.status === 'ok') {
        props = await (await fetch(`${BASE}/props`)).json()
        break
      }
    } catch {}
    if (server.exitCode !== null) throw new Error('llama-server exited: ' + said.join('').slice(-1200))
    await sleep(200)
  }
  if (props === null) throw new Error('llama-server never answered /health or /props')

  const endpoint = { baseUrl: BASE }
  const rows = []

  for (const one of set.cases) {
    // A fresh world per case: one message per judgement, so no case rides on another's
    // delta and the reading belongs to the text it is recorded against.
    const world = makeWorld()
    const bot = world.botA
    world.store.data.bots[bot].name = 'Echo'
    world.store.data.bots[bot].description = 'the one who watches the nightly batch'

    const mentions = one.text.includes('@Echo') ? [{ id: bot, name: 'Echo' }] : undefined
    deliver(world.store, {
      roomId: world.room,
      senderId: world.me,
      text: one.text,
      ...(mentions ? { mentions } : {}),
    })

    const entries = await world.store.drain(bot)
    const verdict = classify(world.store, bot, entries[0])

    const row = { label: one.label, text: one.text, mentions: mentions !== undefined, stage0: verdict }

    if (verdict === 'judge') {
      // The kernel's own reading, wrapped only to keep the number it read.
      let act
      const base = llamaWatchModel(endpoint)
      const recording = {
        async read(input) {
          const reading = await base.read(input)
          act = reading.probabilities?.[tokens.act]
          return reading
        },
      }
      await watchAs(world.store, bot, recording, { window: 10 })(entries)
      row.actProbability = typeof act === 'number' ? Number(act.toFixed(4)) : null
      row.stage1 = entries[0].verdict
      row.reachesWork = entries[0].verdict === 'act'
    } else {
      // Settled by the rules: `act` fast-passes to stage 2 without a model call, and
      // `ignore` is consumed with nothing spent.
      row.stage1 = null
      row.reachesWork = verdict === 'act'
    }

    rows.push(row)
    console.log(
      `  [want ${row.label}] stage0=${row.stage0} stage1=${row.stage1 ?? 'rules'}` +
        `${row.actProbability === undefined ? '' : ` act=${row.actProbability}`}` +
        ` ⇒ ${row.reachesWork ? 'REACHES the work model' : 'stops here'}  ${JSON.stringify(one.text)}`,
    )
  }

  const speak = rows.filter((r) => r.label === 'speak')
  const quiet = rows.filter((r) => r.label === 'quiet')
  const table = {
    cases: rows.length,
    readByStage1: rows.filter((r) => r.stage0 === 'judge').length,
    speakReachesWork: speak.filter((r) => r.reachesWork).length,
    quietReachesWork: quiet.filter((r) => r.reachesWork).length,
    quietStoppedByRules: quiet.filter((r) => r.stage0 !== 'judge').length,
    quietStoppedByStage1: quiet.filter((r) => r.stage0 === 'judge' && !r.reachesWork).length,
  }

  console.log(`\n=== ${ALIAS} behind the shipped gate (${point.threshold}) ===`)
  console.log(`  should-speak cases that reach the work model : ${table.speakReachesWork}/${speak.length}`)
  console.log(`  should-quiet cases that reach the work model : ${table.quietReachesWork}/${quiet.length}`)
  console.log(`  should-quiet settled by stage 0's rules      : ${table.quietStoppedByRules}/${quiet.length}`)
  console.log(`  should-quiet read by stage 1 and refused     : ${table.quietStoppedByStage1}/${quiet.length}`)

  const record = {
    _what_this_is:
      'The nine cases in cases.json, each posted alone into a room by a human and pushed through ' +
      "the shipped gate: stage 0's rules (gate.ts), then stage 1's cut (watch.ts at the shipped " +
      'threshold over the probability /v1/systemone answered with). One row per case, saying where ' +
      'the case stopped and what the model read if it was asked.',
    _why_this_file_exists:
      'The work table beside this file counts what a work model does with the nine cases, and that ' +
      'count is only a cost where the cases actually arrive. The work model is stage 2: a message ' +
      'reaches it when stage 0 fast-passes it or when stage 1 reads act, and is consumed with ' +
      "nothing spent otherwise. Without this reading, 'spoke when it should not 3/3' has no price " +
      "and 'delivered 6/6' has no ceiling.",
    rig: {
      server: `llama-server ${props?.build_info ?? 'unknown build'}, Darwin arm64`,
      flags: '-m <model.gguf> --alias <name> --host 127.0.0.1 --port <port> --no-webui --parallel 1 -c 8192 -b 8192 -ub 8192 -ngl 99, no projector',
      transport:
        'the kernel’s own, not a paraphrase: classify() from src/gate.ts decides each entry, ' +
        'watchAs() from src/watch.ts owns the cut, and llamaWatchModel() from src/llama.ts asks ' +
        '/v1/systemone for one choice question with two declared answers',
      not_re_implemented:
        'no threshold, no token binding and no probability arithmetic appears in the driver: it ' +
        'wraps the kernel’s model only to keep the number the kernel read',
      threshold: point.threshold,
      artifact: artifact.version,
      model: ALIAS,
      window: 10,
      judgements: 'one message per world, drained alone, so no case rides on another’s delta and each reading belongs to the text it is recorded against',
      sender:
        'a human, in a group room, to a bot named Echo described as the one who watches the nightly ' +
        'batch, because two cases name the bot and a mention is what makes stage 0 fast-pass them',
      determinism:
        'a decision model answers with a probability and generates no token, so there is nothing to ' +
        'sample. Two identical asks of the same state were measured at a 0.0000 difference',
    },
    cases: {
      source: 'calibration/work/cases.json',
      count: set.cases.length,
      note: 'the same nine the work table was measured on, read from that file rather than repeated here — a second copy of a case set is a second thing to drift',
    },
    table,
    rows,
    files: {
      'd1-2B-Q8_0.gguf': {
        bytes: 1846240576,
        sha256: '073313d92b53b0ac8193db6e906cb3c78a98183d244b15b7b8f5426115c6738c',
      },
    },
    what_was_not_measured: [
      'Batching. Each case was judged alone with window 10. The runtime judges a room’s delta — a summary plus several entries — and a different box is a different prompt, so a case that reads one number here may read otherwise beside two others. This is a controlled reading of the cases, not a replay of a live room.',
      'Any watch model but the shipped one. Stage 1 runs d1-2B, so these figures do not move with the work-model choice — they bound it. A different watch model is a different gate and needs its own reading.',
      `Any cut but ${point.threshold}. Moving it is the host’s word, not this file’s.`,
      'Why stage 1 refuses a should-speak case. Nothing here isolates a cause; the row says what was read, and the text is kept beside it so a reader can judge the reading rather than the verdict.',
      'Whether an accepted case is answered well. Reaching the work model is the whole claim; what the work model then does with it is the table in measured.json.',
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
