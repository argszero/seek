'use strict'

/**
 * What a first run needs before it can start the server it carries: the weight file.
 *
 * The mechanism is `model-weights.js`, and it deliberately decides nothing about *where* a
 * file comes from — "the canonical host and any mirror beside it is a choice about
 * distribution rather than about this mechanism". This file is that choice, made once, and
 * the wiring that a launch goes through: which repository, which URL shape, how far the
 * whole download has got, and what the window is told while it runs.
 *
 * **The repository is not invented here.** `LiquidAI/d1-2B-GGUF` is the checkpoint
 * `calibration/set4-d1.json` names as the one the `0.600` cut was calibrated against, and the
 * file name is the one that record carries. A different repository would be a different model,
 * which is a different probability distribution and therefore a different cut — so this is a
 * constant rather than a setting.
 *
 * **What is a setting is the host, and the order is a ruling rather than a preference.** The
 * host decided the mirror comes first and the canonical host second (`docs/host-rulings.md`,
 * "Distribution"), because the network this product is being built on reaches `hf-mirror.com`
 * and not `huggingface.co` — measured: the mirror answers `206` with `content-range: bytes
 * 0-99/1846240576` for the weight file, while the canonical
 * host times out after 40 s, which is a first run that spends 40 s learning nothing. A person
 * who wants one host exactly says so with `SEEK_WEIGHTS_BASE`, and then there is no second.
 *
 * **Two hosts resume across each other, and that is why the fallback costs nothing.** A `.part`
 * holds bytes rather than a host's promise: both hosts serve the same file, so a download
 * that stopped on the first continues from its own bytes on the second with one `Range`
 * request (`model-weights.js` decides that, and says why).
 *
 * This module exists rather than living in `main.js` for one reason: `main.js` requires
 * `electron` and cannot be run under `node --test`, and "how far has the download got" is
 * exactly the kind of arithmetic that is worth pinning down.
 *
 * **It is not called `first-run.js`, and that is not an oversight.** `first-run.test.mjs`
 * already exists in this repository and measures the other thing a first run does — a fresh
 * store landing in a room rather than on an empty window (`src/main.ts`'s seeding, PR #61).
 * Two different first runs, two names.
 */

const { fetchWeights, WEIGHT_FILES } = require('./model-weights.js')

/** The checkpoint the shipped cut was calibrated against (`calibration/set4-d1.json`). */
const WEIGHTS_REPO = 'LiquidAI/d1-2B-GGUF'

/** Where the files come from when nobody says otherwise, in the order they are tried. */
const WEIGHTS_BASES = ['https://hf-mirror.com', 'https://huggingface.co']

/** The first host tried, and the one a person sees named in a refusal. */
const WEIGHTS_BASE = WEIGHTS_BASES[0]

/**
 * Where one file is, given the host to ask.
 *
 * A trailing slash on the base is trimmed, because `//resolve/main` is a different path and
 * some hosts answer it with a redirect to a login page rather than a file.
 */
function urlForAt(base) {
  const root = String(base ?? '').trim().replace(/\/+$/, '')
  return (file) => `${root}/${WEIGHTS_REPO}/resolve/main/${file.name}`
}

/**
 * What a progress reading is: three facts, and no words.
 *
 * `received` and `total` count across every file the first run wants rather than across the
 * current one, because the person waiting is waiting for "can I use this app yet", not for a
 * file. `name` is the file being fetched, and it travels with them — today there is one file
 * (`d1-2B-Q8_0.gguf`, 1.72 GiB), and a list that grows again keeps the name beside the number
 * so a strip whose figure jumped could never be read as a restart, which is the one thing a
 * resumable download must never look like.
 *
 * **The sentence is not composed here, and that is the point of the shape.** `docs/design/
 * i18n.md` §1 forbids a user-visible string in code, and §4 puts a file size in the layer that
 * formats per locale and forbids the concatenation at the call site. A sentence built in this
 * process has picked a language and a decimal separator before any catalogue is consulted —
 * which is exactly what a window on a first run used to draw: `0.2 GB of 2.2 GB —
 * LFM2.5-VL-3B-Q4_0.gguf` under a heading the catalogue had already translated. So this module
 * hands the three facts over (`onProgress`) and the window asks its catalogue for the frame
 * around them (`ui/src/App.jsx`, and `size()` in `catalogue.mjs` for the numbers).
 */

/**
 * Make sure the two weight files are on disk, fetching whatever is missing or short.
 *
 * Returns `{ ok: true, bytes, files, fetched }` when both are whole on disk, and
 * `{ ok: false, refusal, bytes, files }` when they are not, with the refusal being a sentence
 * something can draw. Nothing throws: a first run with no network still has a window to open,
 * and the sentence is what that window says.
 *
 * `fetched` is false when both files were already there — a second launch must not pay 1.6 GB
 * again, and a launch that re-reads nothing should not claim it did.
 *
 * `onProgress` is called with the whole download's reading (`{name, received, total}`), not one
 * file's, so a caller drawing it needs no memory of which file came first.
 *
 * `host` on a success and `tried` on a failure say which hosts were used, because the log line
 * and the sentence are the only places that fact exists: a run that quietly fell back to the
 * second host would otherwise look exactly like one served by the first.
 */
async function ensureWeights(options = {}) {
  const {
    dir,
    // No default here on purpose: `undefined` and an empty string are different readings, and
    // a destructuring default would collapse them before this could tell them apart.
    base,
    files = WEIGHT_FILES,
    fetchImpl = globalThis.fetch,
    onProgress,
    signal,
  } = options
  if (!dir) throw new TypeError('ensureWeights needs a directory to fetch into')

  // `undefined` is "nobody said", which is what the list of defaults is for; a string that is
  // empty once trimmed is somebody setting the variable to nothing — a shell expanding an unset
  // one, a config line left blank — and that is the case this refuses rather than silently
  // substituting a host for the one the person thought they had configured. A string that is
  // not empty is that one host, and only it: a person who named a host meant that host. An
  // array is a caller that wants an order of its own, which is what a test of the fallback
  // needs — the alternative was a second setting meaning almost the same thing.
  const roots =
    base === undefined
      ? [...WEIGHTS_BASES]
      : Array.isArray(base)
        ? base.map((one) => String(one ?? '').trim())
        : [String(base ?? '').trim()]
  if (roots[0] === '') {
    // Not a network failure and not a missing file: the build or the environment named no
    // host, and saying "the server could not be reached" about that would send a person to
    // check their wifi over a configuration mistake.
    //
    // The reason travels as the facts rather than as a sentence: `docs/design/i18n.md` §1 puts
    // every word a person reads in the catalogue, and a sentence composed here is English in
    // every language the app can run in. The window writes this one out of `repo`.
    return { ok: false, why: { kind: 'no-host', repo: WEIGHTS_REPO }, files: [], bytes: 0 }
  }

  const total = files.reduce((sum, file) => sum + file.bytes, 0)
  // The whole download's reading, kept here because `model-weights.js` reports one file at a
  // time and has no business knowing how many files a caller asked for.
  let behind = 0
  let current = null
  const onOne = (one) => {
    if (one.name !== current) {
      if (current !== null) {
        behind += files.find((file) => file.name === current)?.bytes ?? 0
      }
      current = one.name
    }
    if (onProgress) {
      onProgress({ name: one.name, received: behind + one.received, total })
    }
  }

  // Each host in turn, and every failure is remembered rather than returned: the sentence a
  // person gets has to say which hosts were tried and what each one said, because "the weights
  // did not arrive" over two hosts that failed differently is a sentence they cannot act on.
  // A resume carries across the change of host — the bytes in `.part` are the file's, not the
  // host's — so the second attempt does not start over.
  const tried = []
  for (const root of roots) {
    const result = await fetchWeights({
      dir,
      files,
      urlFor: urlForAt(root),
      fetchImpl,
      onProgress: onOne,
      signal,
    })
    if (result.ok) {
      return {
        ok: true,
        files: result.files,
        bytes: result.bytes,
        fetched: result.files.some((file) => file.status === 'fetched'),
        host: root,
      }
    }
    tried.push({ root, refusal: result.refusal, files: result.files, bytes: result.bytes })
  }

  const last = tried[tried.length - 1]
  // The reasons as facts, because the words around them are the language's.
  //
  // One host is the ordinary case, and what it said is the whole answer: those are the host's
  // own words, written where the failure happened, and `docs/design/i18n.md` §2 forbids
  // rewriting somebody else's sentence — so they travel as data and the window draws them as
  // they came.
  //
  // Several hosts are a list a person has to be able to act on: which hosts were tried, and
  // what each one said. "The weights did not arrive" over two hosts that failed differently
  // does not say whether their network is down or this build is wrong.
  //
  // Neither the frame nor the joining is decided here. `"A, B and C"` is the language's
  // (§4), so the window composes from its own catalogue and joins with its own list formatter.
  //
  // **`words` never leaves this process.** What a host said, and what Node's `fetch` said, is a
  // diagnostic rather than something a person can act on, so the window is handed the names and
  // says the rest in its own language (`docs/host-rulings.md`, "The window does not speak to a
  // developer"); `describe()` below is where the sentences go, and `main.js` writes it to stderr.
  const why =
    tried.length === 1
      ? { kind: 'refused', host: hostName(tried[0].root), words: tried[0].refusal }
      : { kind: 'hosts', hosts: tried.map((one) => ({ host: hostName(one.root), words: one.refusal })) }
  return { ok: false, why, files: last.files, bytes: last.bytes, tried: tried.map((one) => one.root) }
}

/**
 * The same reasons as one English phrase, for the kernel's own reading and for the log.
 *
 * Not the sentence a person reads. `docs/design/i18n.md` §7 keeps log lines English, and the
 * kernel's `serverRefusal` is the kernel's own statement about a half it cannot use — the window
 * draws `why` itself, in the language it is running in, so nothing here may move into a
 * component and no catalogue entry may be spelled from here.
 */
function describe(why) {
  if (why.kind === 'no-host') return `no host is configured for the weights (${why.repo})`
  if (why.kind === 'refused') return why.words
  return why.hosts.map((one) => `${one.host} — ${one.words}`).join('; ')
}

/** A host as a person names it: no scheme, which is the part they did not choose. */
function hostName(root) {
  return String(root).replace(/^https?:\/\//, '').replace(/\/+$/, '')
}

module.exports = {
  WEIGHTS_BASE,
  WEIGHTS_BASES,
  WEIGHTS_REPO,
  describe,
  ensureWeights,
  urlForAt,
}
