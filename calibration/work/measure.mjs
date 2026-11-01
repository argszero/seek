// Which work model actually says something? One rig, one labelled set, N models.
//
// The kernel assembles the work prompt from the shipped artifact and asks with
// tool_choice:'auto' (llama.ts:785). On the released v0.1.3 + LFM2.5-VL-3B that produced
// prose and no call — see issue #89. This runs the SAME assembly and the SAME nine cases
// against a parameterised llama-server, so the only thing that changes between rows of the
// table is the model.
//
//   MODEL=<path.gguf> [MMPROJ=<path.gguf>] [ALIAS=<name>] [PORT=8099] [REPS=3] \
//   [LLAMA=<path to llama-server>] [KERNEL=<kernel checkout>] \
//     node calibration/work/measure.mjs
//
// The prompt is imported from the checkout this file sits in, so a row is measured with the
// same `src/prompts.ts` a reader is looking at; KERNEL points somewhere else if needed.
// LLAMA defaults to the build these rows were taken on — set it to your own llama-server.
// JINJA=1 adds --jinja explicitly; this build enables the Jinja engine by default, so the
// GGUF's own chat template renders the tool list either way. Without that rendering the
// tools may never reach the model, and a row measured that way says nothing about the model.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { writeFileSync } from 'node:fs'

const HERE = dirname(fileURLToPath(import.meta.url))
const KERNEL = process.env.KERNEL || join(HERE, '..', '..')
const LLAMA = process.env.LLAMA || '/private/tmp/llamatest/build/bin/llama-server'
const MODEL = process.env.MODEL
const MMPROJ = process.env.MMPROJ || ''
const ALIAS = process.env.ALIAS || 'candidate'
const JINJA = process.env.JINJA === '1'
const PORT = Number(process.env.PORT || 8099)
const OUT = process.env.OUT || ''
const REPS = Math.max(1, Number(process.env.REPS || 1))
const BASE = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (!MODEL) throw new Error('MODEL is required')

const { assembleWorkPrompt, loadWorkArtifact } = await import(join(KERNEL, 'src', 'prompts.ts'))
const shipped = loadWorkArtifact()

const ROOM = 'oc_0000000000000000'
const values = (entry) => ({
  bot: 'Echo',
  description: 'the one who watches the nightly batch',
  room: ROOM,
  roster: 'watch (no tools), work (say,read)',
  // Filled, not left out: `work-v10`'s archive part is rendered on every turn, and a row
  // measured with `{archive}` in it would be a reading of a prompt no bot is ever given.
  archive: '/tmp/seek/agents/work/archive (days: 2026-10-30)',
  entries: [{ sender: '邵安清', text: entry }],
})

// Six that want an answer, three that do not. The three are the guard: a model that buys
// delivery by firing on a message nobody needed answered has made the bot worse.
const CASES = [
  { want: 'speak', text: 'the nightly batch failed again — can you look at it?' },
  { want: 'speak', text: '@Echo what is the retry queue doing right now?' },
  { want: 'speak', text: 'did you finish the reconciliation you mentioned yesterday?' },
  { want: 'speak', text: '今天的对账跑完了吗？' },
  { want: 'speak', text: '@Echo 那条重试队列现在什么情况？' },
  { want: 'speak', text: '批处理又挂了，你能看一眼吗？' },
  { want: 'quiet', text: 'ok' },
  { want: 'quiet', text: 'thanks!' },
  { want: 'quiet', text: '好的收到' },
]

function readAnswer(payload) {
  const message = payload?.choices?.[0]?.message ?? {}
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : []
  const content = typeof message.content === 'string' ? message.content : ''
  const say = calls.find((c) => c?.function?.name === 'say')
  let text = ''
  if (say) {
    try {
      const args = JSON.parse(say.function.arguments)
      text = typeof args?.text === 'string' ? args.text : ''
      if (args?.room !== ROOM) text = ''
    } catch {
      text = ''
    }
  }
  return {
    calls: calls.length,
    said: say ? text.trim() !== '' : false,
    reply: (text || content).replace(/\s+/g, ' ').slice(0, 70),
    prose: calls.length === 0 && content.trim() !== '',
    silent: calls.length === 0 && content.trim() === '',
    finish: payload?.choices?.[0]?.finish_reason,
  }
}

async function ask(entry) {
  const assembled = assembleWorkPrompt(shipped, values(entry))
  const started = Date.now()
  const response = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: assembled.system },
        { role: 'user', content: assembled.rest },
      ],
      tools: shipped.tools.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      })),
      tool_choice: 'auto',
      temperature: 0,
    }),
  })
  const payload = await response.json()
  return { ...readAnswer(payload), ms: Date.now() - started }
}

const args = [
  '-m', MODEL,
  '--alias', ALIAS,
  '--host', '127.0.0.1', '--port', String(PORT),
  '-c', '4096', '-np', '1', '-ngl', '99',
]
if (MMPROJ) args.push('--mmproj', MMPROJ)
if (JINJA) args.push('--jinja')

const server = spawn(LLAMA, args, { stdio: ['ignore', 'pipe', 'pipe'] })
const serverOut = []
server.stdout.on('data', (d) => serverOut.push(String(d)))
server.stderr.on('data', (d) => serverOut.push(String(d)))

try {
  let up = false
  for (let i = 0; i < 600; i += 1) {
    try {
      const props = await (await fetch(`${BASE}/props`)).json()
      if (props?.model_alias) { up = true; break }
    } catch {}
    if (server.exitCode !== null) throw new Error('llama-server exited: ' + serverOut.join('').slice(-1200))
    await sleep(200)
  }
  if (!up) throw new Error('llama-server never answered /props')

  const rows = []
  for (const item of CASES) {
    const reps = []
    for (let i = 0; i < REPS; i += 1) reps.push(await ask(item.text))
    const got = reps[0]
    const outcomes = reps.map((r) => (r.said ? 'said' : r.silent ? 'silent' : 'prose'))
    const stable = outcomes.every((o) => o === outcomes[0])
    rows.push({ want: item.want, text: item.text, reps: reps.length, outcomes, stable, ...got })
    console.log(`  ${got.said ? 'SAID  ' : got.silent ? 'SILENT' : 'PROSE '} [want ${item.want}] ${item.text} -> ${JSON.stringify(got.reply)} (${got.finish}, ${got.ms}ms) reps=${outcomes.join('/')}`)
  }
  const speak = rows.filter((r) => r.want === 'speak')
  const quiet = rows.filter((r) => r.want === 'quiet')
  const summary = {
    model: ALIAS,
    file: MODEL,
    mmproj: MMPROJ || null,
    jinja: JINJA,
    delivered: speak.filter((r) => r.said).length,
    proseOnly: speak.filter((r) => r.prose).length,
    silentWhenShouldSpeak: speak.filter((r) => r.silent).length,
    stayedQuiet: quiet.filter((r) => r.silent).length,
    proseWhenShouldBeQuiet: quiet.filter((r) => r.prose).length,
    spokeWhenShouldNot: quiet.filter((r) => r.said).length,
    reps: REPS,
    unstableCases: rows.filter((r) => !r.stable).length,
    medianMs: rows.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(rows.length / 2)],
    rows,
  }
  console.log('\n=== ' + ALIAS + ' (jinja=' + JINJA + ') ===')
  console.log(`  spoke when it should       : ${summary.delivered}/6`)
  console.log(`  wrote prose instead        : ${summary.proseOnly}/6`)
  console.log(`  silent when it should speak: ${summary.silentWhenShouldSpeak}/6`)
  console.log(`  stayed quiet when it should: ${summary.stayedQuiet}/3`)
  console.log(`  spoke when it should NOT   : ${summary.spokeWhenShouldNot}/3`)
  console.log(`  prose when it should be quiet: ${summary.proseWhenShouldBeQuiet}/3`)
  console.log(`  unstable cases (outcome changed across reps): ${summary.unstableCases}/${rows.length} of ${REPS} reps`)
  console.log(`  median ms                  : ${summary.medianMs}`)
  if (OUT) writeFileSync(OUT, JSON.stringify(summary, null, 2))
} finally {
  server.kill('SIGTERM')
  await sleep(1200)
  if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL')
  console.log('=== llama-server stopped (exitCode=' + server.exitCode + ', signal=' + server.signalCode + ') ===')
}
