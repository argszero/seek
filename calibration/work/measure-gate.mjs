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
//   [MODEL=<gguf>] [MMPROJ=<gguf>] [ALIAS=<name>] [PORT=8098] [OUT=<file>] \
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
const LLAMA = process.env.LLAMA || '/private/tmp/llamatest/build/bin/llama-server'
const MODEL = process.env.MODEL || '/private/tmp/llamatest/models/LFM2.5-VL-3B-Q4_0.gguf'
const MMPROJ = process.env.MMPROJ || '/private/tmp/llamatest/models/mmproj-LFM2.5-VL-3B-Q8_0.gguf'
const ALIAS = process.env.ALIAS || 'LFM2.5-VL-3B'
const PORT = Number(process.env.PORT || 8098)
const OUT = process.env.OUT || ''
const BASE = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const { bindOverServer, llamaWatchModel } = await import(join(KERNEL, 'src', 'llama.ts'))
const { loadPromptArtifact, skeletonOf } = await import(join(KERNEL, 'src', 'prompts.ts'))
const { declaredOptions, watchAs } = await import(join(KERNEL, 'src', 'watch.ts'))
const { classify } = await import(join(KERNEL, 'src', 'gate.ts'))
const { deliver } = await import(join(KERNEL, 'src', 'delivery.ts'))
const { makeWorld } = await import(join(KERNEL, 'src', 'fixtures.ts'))

const set = JSON.parse(readFileSync(join(HERE, 'cases.json'), 'utf8'))
const artifact = loadPromptArtifact()
const tokens = declaredOptions()
const point = artifact.operatingPoint

const args = [
  '-m', MODEL,
  '--alias', ALIAS,
  '--host', '127.0.0.1', '--port', String(PORT),
  '-c', '4096', '-np', '1', '-ngl', '99',
]
if (MMPROJ) args.push('--mmproj', MMPROJ)

const server = spawn(LLAMA, args, { stdio: ['ignore', 'pipe', 'pipe'] })
const said = []
server.stdout.on('data', (d) => said.push(String(d)))
server.stderr.on('data', (d) => said.push(String(d)))

try {
  let up = false
  for (let i = 0; i < 600; i += 1) {
    try {
      const props = await (await fetch(`${BASE}/props`)).json()
      if (props?.model_alias) { up = true; break }
    } catch {}
    if (server.exitCode !== null) throw new Error('llama-server exited: ' + said.join('').slice(-1200))
    await sleep(200)
  }
  if (!up) throw new Error('llama-server never answered /props')

  const endpoint = { baseUrl: BASE, artifact, nProbs: 64 }
  // The mask the kernel itself would measure: the ids `act` and `ignore` take at this
  // prompt's own end, read over the same transport `watchAs` will use.
  const mask = await bindOverServer(endpoint, skeletonOf(artifact), tokens)

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
      await watchAs(world.store, bot, recording, { window: 10, mask })(entries)
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
    const where = row.stage1 ?? 'rules'
    console.log(
      `  [want ${row.label}] stage0=${row.stage0} stage1=${where}` +
        `${row.actProbability === undefined ? '' : ` act=${row.actProbability}`}` +
        ` ⇒ ${row.reachesWork ? 'REACHES the work model' : 'stops here'}  ${JSON.stringify(one.text)}`,
    )
  }

  const speak = rows.filter((r) => r.label === 'speak')
  const quiet = rows.filter((r) => r.label === 'quiet')
  const summary = {
    model: ALIAS,
    file: MODEL,
    mmproj: MMPROJ || null,
    artifact: artifact.version,
    threshold: point?.threshold ?? null,
    cases: rows.length,
    speakReachesWork: speak.filter((r) => r.reachesWork).length,
    quietReachesWork: quiet.filter((r) => r.reachesWork).length,
    quietStoppedByRules: quiet.filter((r) => r.stage0 !== 'judge').length,
    quietStoppedByStage1: quiet.filter((r) => r.stage0 === 'judge' && r.reachesWork === false).length,
    readByStage1: rows.filter((r) => r.stage0 === 'judge').length,
    rows,
  }
  console.log('\n=== ' + ALIAS + ' behind the shipped gate (' + summary.threshold + ') ===')
  console.log(`  should-speak cases that reach the work model : ${summary.speakReachesWork}/${speak.length}`)
  console.log(`  should-quiet cases that reach the work model : ${summary.quietReachesWork}/${quiet.length}`)
  console.log(`  should-quiet settled by stage 0's rules      : ${summary.quietStoppedByRules}/${quiet.length}`)
  console.log(`  should-quiet read by stage 1 and refused     : ${summary.quietStoppedByStage1}/${quiet.length}`)
  if (OUT) writeFileSync(OUT, JSON.stringify(summary, null, 2))
} finally {
  server.kill('SIGTERM')
  await sleep(1200)
  if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL')
  console.log('=== llama-server stopped (exitCode=' + server.exitCode + ', signal=' + server.signalCode + ') ===')
}
