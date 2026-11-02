/**
 * The model server a Windows download carries, fetched from upstream rather than committed.
 *
 * **Why this is fetched and the macOS one is tracked.** `ui/resources/server/` holds macOS
 * binaries in this repository, and that is a choice with a cost this file declines to
 * double: they are 29 MB of `Mach-O` inside a git history. A second platform's 44 MB of
 * `PE` would be a second copy of a thing that upstream already publishes, per release,
 * for ever — and the reason to carry one at all is that *this* repository's own build
 * produced it. This one it did not. So what is pinned here is upstream's own archive: a
 * release tag, an asset name, a byte count and a sha256, which is the same account
 * `ui/resources/server/PROVENANCE.md` gives for the binaries that are tracked, written so
 * that a build either gets that exact archive or stops.
 *
 * **The set is measured, not copied.** The archive holds 52 files because it also holds
 * `llama-cli`, `llama-quantize`, `llama-bench` and a `*-impl.dll` per tool. What this
 * writes out is the closure `llama-server.exe` actually loads, found by reading its PE
 * import table and walking it (`objdump -p`, transitive), and that closure is not the same
 * shape as the macOS one:
 *
 * - `llama-server.exe` is a 9 KB launcher; the code is `llama-server-impl.dll`, exactly as
 *   on macOS where it is `libllama-server-impl.dylib`.
 * - The fourteen `ggml-cpu-*.dll` files are in **no** import table. `ggml` loads its CPU
 *   backends by scanning the directory beside itself for them and picking the best one this
 *   processor supports, which is why there are fourteen and why a set cut from the import
 *   table alone would start, load a model, and then report that it has no backend. They all
 *   ship, and dropping the slow-looking ones would silently turn a fast machine into a
 *   baseline one.
 *
 * **What is deliberately not shipped is a Microsoft runtime.** The closure names
 * `VCRUNTIME140.dll`, `VCRUNTIME140_1.dll` and `MSVCP140.dll`, and upstream's archive does
 * not carry them either: they come from the Visual C++ redistributable, which a great many
 * Windows machines already have. A machine that has never had one crashes at start-up
 * instead of refusing in words, and this file does not fix that — it records it. Redistributing
 * the runtime is a licensing decision about Microsoft's binaries, not a build step.
 *
 * **A missing server is said, not crashed.** If this directory is absent, the app's own
 * `server.js` already refuses in a sentence naming the path (`this build carries no model
 * server at …`), which is what a build made without this step does.
 *
 * Usage, from `ui/`: `npm run fetch:server-win`, which is `node ../packaging/fetch-server-win.mjs`.
 * `LLAMA_WIN_ARCHIVE` points it at an archive already on disk, so a machine that has one
 * does not download it twice.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Where the app's packaging expects the Windows server to sit (`ui/package.json`). */
const OUTPUT = join(REPO, 'ui', 'resources', 'server-win')

/** Where a downloaded archive is kept between runs, so one machine downloads it once. */
const CACHE = join(REPO, 'packaging', '.cache')

/**
 * The archive this build carries, and the three facts that make it that archive.
 *
 * `b11946` is the build the macOS binaries beside it are, too (`ui/resources/server/
 * PROVENANCE.md`): one release of llama.cpp for both platforms, so the two downloads are
 * running the same code. `bytes` and `sha256` are measured from the published asset, and a
 * mismatch stops the build rather than packing an archive nobody checked.
 */
const UPSTREAM = {
  project: 'ggml-org/llama.cpp',
  release: 'b11946',
  asset: 'llama-b11946-bin-win-cpu-x64.zip',
  bytes: 24376086,
  sha256: '8a702bb07c873b133c56eb3acd92a48d7c5c9ad339c6435eddc5185e46e1a043',
  url: 'https://github.com/ggml-org/llama.cpp/releases/download/b11946/llama-b11946-bin-win-cpu-x64.zip',
}

/**
 * The launcher and everything its import table reaches, in the archive's own spelling.
 *
 * Read out of the published file with `objdump -p llama-server.exe`, then over each library
 * it names, until nothing new turned up. Editing this list by hand is the one way to get a
 * server that starts and then cannot find a symbol — and the guard is `provision()` below
 * rather than a second list: a name here that the pinned archive does not hold stops the
 * build with the archive named, so the wrong list fails loudly instead of shipping.
 */
const IMPORTS = [
  'ggml-base.dll',
  'ggml.dll',
  'libomp.dll',
  'llama-common.dll',
  'llama-server-impl.dll',
  'llama.dll',
  'mtmd.dll',
]

/** The CPU backends, which are loaded by directory scan rather than by import. */
const CPU_BACKENDS = [
  'ggml-cpu-alderlake.dll',
  'ggml-cpu-cannonlake.dll',
  'ggml-cpu-cascadelake.dll',
  'ggml-cpu-cooperlake.dll',
  'ggml-cpu-haswell.dll',
  'ggml-cpu-icelake.dll',
  'ggml-cpu-ivybridge.dll',
  'ggml-cpu-piledriver.dll',
  'ggml-cpu-sandybridge.dll',
  'ggml-cpu-sapphirerapids.dll',
  'ggml-cpu-skylakex.dll',
  'ggml-cpu-sse42.dll',
  'ggml-cpu-x64.dll',
  'ggml-cpu-zen4.dll',
]

/** The executable itself, named the way Windows names executables. */
const LAUNCHER = 'llama-server.exe'

/**
 * Every file this writes out, and where each group comes from.
 *
 * A plan rather than a loop with the literals inline, because the packaging test pins it:
 * the same shape `pkgPlan()` and `notarizePlan()` have in the files beside this one.
 */
export function serverWinPlan({ output = OUTPUT, upstream = UPSTREAM } = {}) {
  return {
    output,
    upstream,
    /** Files that must come out of the archive, launcher first. */
    fromArchive: [LAUNCHER, ...IMPORTS, ...CPU_BACKENDS],
    /**
     * Licences written beside them. `LICENSE-LLVM-OpenMP` travels in the archive because
     * `libomp.dll` is LLVM's; llama.cpp's own MIT text is not in it, so it is copied out of
     * the directory already tracked in this repository rather than re-typed here.
     */
    licences: [
      { name: 'LICENSE-LLVM-OpenMP', from: 'archive' },
      { name: 'LICENSE-llama.cpp', from: join(REPO, 'ui', 'resources', 'server', 'LICENSE-llama.cpp') },
    ],
    provenance: join(output, 'PROVENANCE.md'),
    launcher: LAUNCHER,
  }
}

/**
 * A ZIP archive, read without a dependency.
 *
 * Node ships gzip, brotli and zlib but no ZIP container reader, and this runs on a Windows
 * runner where shelling out to `unzip` is not available. What is needed is small: find the
 * end-of-central-directory record at the tail, walk the central directory it points at, and
 * take each entry's bytes from its local header — method 8 deflated, method 0 stored, and
 * anything else refused rather than guessed. Verified against the real 24 MB archive by the
 * test beside this file, which reads all 52 entries out of it and compares two against bytes
 * that are already tracked in this repository.
 */
export function readZip(buf) {
  const EOCD = 0x06054b50
  let eocd = -1
  // The record sits at the tail, after a comment of unknown length (up to 65 535).
  for (let at = buf.length - 22; at >= Math.max(0, buf.length - 22 - 0xffff); at -= 1) {
    if (buf.readUInt32LE(at) === EOCD) {
      eocd = at
      break
    }
  }
  if (eocd === -1) throw new Error('this is not a zip archive: no end-of-central-directory record')

  const count = buf.readUInt16LE(eocd + 10)
  let at = buf.readUInt32LE(eocd + 16)
  const entries = new Map()

  for (let index = 0; index < count; index += 1) {
    if (buf.readUInt32LE(at) !== 0x02014b50) {
      throw new Error(`the central directory is malformed at entry ${index}`)
    }
    const method = buf.readUInt16LE(at + 10)
    const compressed = buf.readUInt32LE(at + 20)
    const nameLength = buf.readUInt16LE(at + 28)
    const extraLength = buf.readUInt16LE(at + 30)
    const commentLength = buf.readUInt16LE(at + 32)
    const localAt = buf.readUInt32LE(at + 42)
    const name = buf.toString('utf8', at + 46, at + 46 + nameLength)

    // The local header repeats the name and extra field, and its lengths are the ones that
    // say where its bytes begin — not the central directory's.
    const localNameLength = buf.readUInt16LE(localAt + 26)
    const localExtraLength = buf.readUInt16LE(localAt + 28)
    const start = localAt + 30 + localNameLength + localExtraLength
    const raw = buf.subarray(start, start + compressed)

    if (method === 0) entries.set(name, Buffer.from(raw))
    else if (method === 8) entries.set(name, inflateRawSync(raw))
    else throw new Error(`${name} is compressed with zip method ${method}, which this reader does not do`)

    at += 46 + nameLength + extraLength + commentLength
  }

  return entries
}

/** The account written beside the binaries, so the shipped directory explains itself. */
export function provenanceOf(plan) {
  const { upstream } = plan
  return `# The model server this Windows build carries

Fetched at build time and **not tracked**, unlike the macOS binaries one directory up: this
one is upstream's own artifact, so what is pinned is the artifact. \`packaging/fetch-server-win.mjs\`
either produces the file set below from that exact archive or stops the build.

| | |
|---|---|
| upstream | \`${upstream.project}\`, release **\`${upstream.release}\`** |
| archive | \`${upstream.asset}\`, ${upstream.bytes.toLocaleString('en-US')} bytes |
| sha256 | \`${upstream.sha256}\` |
| launcher | \`${plan.launcher}\` (a launcher; the code is \`llama-server-impl.dll\`) |
| libraries | ${plan.fromArchive.length - 1} files beside it: the seven its import table reaches, and the fourteen CPU backends |
| licence | MIT — \`LICENSE-llama.cpp\` is copied here from the tracked macOS directory, and \`LICENSE-LLVM-OpenMP\` travels with the archive because \`libomp.dll\` is LLVM's |

## Why these files and not the archive's 52

The archive also carries \`llama-cli\`, \`llama-quantize\`, \`llama-bench\` and a \`*-impl.dll\`
for every tool. What is here is the closure \`llama-server.exe\` loads, read out of its PE
import table and walked transitively, **plus** the fourteen \`ggml-cpu-*.dll\` files, which
appear in no import table at all: \`ggml\` finds its CPU backend by looking beside itself and
choosing the best one the processor supports. A set cut from the import table alone would
start and then report no backend.

## What it needs from the machine, and does not carry

\`VCRUNTIME140.dll\`, \`VCRUNTIME140_1.dll\` and \`MSVCP140.dll\` come from the Microsoft Visual
C++ redistributable. Upstream does not ship them and neither does this: a Windows machine
that has never had an MSVC-built application installed crashes at start-up rather than
refusing in words. **A green build on a GitHub runner does not clear this** — runners have the
runtime installed — so that is stated here rather than claimed as tested.
`
}

/** Download the pinned archive, or hand back the copy already on disk. */
export async function archiveOf(plan, { cache = CACHE, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const onDisk = env.LLAMA_WIN_ARCHIVE ? resolve(env.LLAMA_WIN_ARCHIVE) : join(cache, plan.upstream.asset)
  if (existsSync(onDisk)) {
    const bytes = readFileSync(onDisk)
    if (bytes.length === plan.upstream.bytes && sha256Of(bytes) === plan.upstream.sha256) {
      return { path: onDisk, bytes, downloaded: false }
    }
    // A cached copy that is not that archive is deleted rather than reused: a truncated
    // download left behind by an interrupted run must not become the build's input.
    throw new Error(
      `the archive at ${onDisk} is not ${plan.upstream.asset} (${bytes.length} bytes, sha256 ${sha256Of(bytes)}): ` +
        'delete it and run this again',
    )
  }

  const response = await fetchImpl(plan.upstream.url)
  if (!response.ok) throw new Error(`${plan.upstream.url} answered ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  mkdirSync(dirname(onDisk), { recursive: true })
  writeFileSync(onDisk, bytes)
  return { path: onDisk, bytes, downloaded: true }
}

function sha256Of(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** The whole job: verify the archive, write the set, write the account beside it. */
export async function provision(plan, options = {}) {
  const { log = () => {}, archive = null } = options
  const got = archive ?? (await archiveOf(plan, options))

  if (got.bytes.length !== plan.upstream.bytes) {
    throw new Error(
      `${plan.upstream.asset} is ${got.bytes.length} bytes and should be ${plan.upstream.bytes}: ` +
        'this is not the archive this build carries',
    )
  }
  const digest = sha256Of(got.bytes)
  if (digest !== plan.upstream.sha256) {
    throw new Error(`${plan.upstream.asset} has sha256 ${digest} and should have ${plan.upstream.sha256}`)
  }
  log(`archive: ${got.path} (${got.downloaded ? 'downloaded' : 'already on disk'}), sha256 checked`)

  const entries = readZip(got.bytes)
  mkdirSync(plan.output, { recursive: true })

  const written = []
  for (const name of plan.fromArchive) {
    const bytes = entries.get(name)
    if (bytes === undefined) throw new Error(`${plan.upstream.asset} does not hold ${name}`)
    writeFileSync(join(plan.output, name), bytes)
    written.push({ name, bytes: bytes.length })
  }
  for (const licence of plan.licences) {
    const bytes = licence.from === 'archive' ? entries.get(licence.name) : readFileSync(licence.from)
    if (bytes === undefined || bytes === null) throw new Error(`no ${licence.name} to ship`)
    writeFileSync(join(plan.output, licence.name), bytes)
  }

  writeFileSync(plan.provenance, provenanceOf(plan))

  const total = written.reduce((sum, file) => sum + file.bytes, 0)
  log(`${written.length} files, ${(total / 1024 / 1024).toFixed(1)} MB, written to ${plan.output}`)
  return { written, total, provenance: plan.provenance }
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  const plan = serverWinPlan()
  provision(plan, { log: (line) => console.log(line) }).catch((error) => {
    console.error(`the Windows model server was not provisioned: ${error.message}`)
    process.exitCode = 1
  })
}
