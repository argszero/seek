'use strict'

/**
 * The interface's host: one store, one kernel, and the writes the composer makes.
 *
 * It is separate from `main.js` so that the whole of what the interface does to the
 * kernel is ordinary code that `node --test` can run without Electron. `main.js` adds
 * windows and IPC; every rule that touches the store is here.
 *
 * **Two writes, one path.** Saying something in a room and answering it in a thread are
 * the same call: `postMessage` with a `rootId` is a reply, without one it is a message.
 * The difference between a message and a reply is the kernel's, stated once in
 * `src/delivery.ts` — this file only carries the caller's choice of parent along.
 *
 * **Nothing in this file invents behaviour.** The pieces are composed exactly as the
 * kernel's own milestone composes them (`src/main.ts`, `runFirstMilestone`): open the
 * store, rebuild its agents from the roster beside it, then build one `Kernel` over
 * it. The one thing the interface adds is a person's write, and that is the kernel's
 * `deliver()` — not a second way into the store.
 *
 * **The bot's answer is a model's when a work server is named.** The kernel has two
 * halves, and each is bound separately: stage 1 decides *whether* the bot acts
 * (`judge`, `watch-server.ts`) and stage 2 writes *what* it says (`decide`,
 * `work-server.ts`). With no server named, neither half is bound and **the bot says
 * nothing** — an empty room is the honest state of an install with no model, and a line
 * standing in for one would be the one sentence this interface must never write
 * (`docs/host-rulings.md`, "A bot whose model is not ready says nothing, and the window
 * says why"). The kernel's placeholders (`stubJudge`, `stubDecide`, `src/main.ts`) stay
 * where they belong: in the kernel's own command line, whose report says its words are a
 * stub.
 *
 * **Every bot in the store is bound, and a bot that could not be is silent alone.** The
 * facts each binding checks — the `model` a roster row claims, the box a judgement reads —
 * belong to one bot, so a store of several bots spends one binding per bot. A bot whose
 * binding refused is left out of the two dispatchers below rather than taking the others
 * with it, and its name is what the window says is quiet.
 *
 * **Two servers, not one, because a server serves one model.** `SEEK_SERVER` names the
 * watch half's server and `SEEK_WORK_SERVER` the work half's, and the reason is
 * a roster row's `model` is a claim about the server it is
 * served by, checked by role. One origin reports one `model_alias`, so a store whose
 * two rows name two models cannot be served by one server — and the design already says the
 * work row's model "belongs to the other server". Springing stage 2 from `SEEK_SERVER`
 * would have forced every roster onto one model, which is a decision about which model
 * reads the cut, and that is the host's.
 */

const { readFile, writeFile } = require('node:fs/promises')

const { meOf, snapshotOf } = require('./snapshot.js')
const { PICTURE_GONE, readBytes } = require('./media.js')

/** The kernel's modules, imported once. Electron's Node strips TypeScript itself. */
let modules = null

async function kernelModules() {
  if (modules) return modules
  modules = {
    store: await import('../../src/store.ts'),
    delivery: await import('../../src/delivery.ts'),
    // The other write the interface makes: a room that does not exist yet. It is the
    // kernel's own `createRoom()`/`addMember()` (`src/rooms.ts`), added for exactly this
    // slice — the interface may make a room, and it may not make one any other way.
    rooms: await import('../../src/rooms.ts'),
    kernel: await import('../../src/kernel.ts'),
    // The fourth write the interface makes: a bot. `src/bots.ts` writes the bot and
    // nothing else — the agents a bot works through are the roster's, and this file
    // adds those rows to the file rather than to the store.
    bots: await import('../../src/bots.ts'),
    // Taking things back: a message, a thread, a room (`src/erase.ts`). A bot already had
    // its verb in `bots` above, and it is the same shape — a stamp, and the rows that point
    // at what is left stay readable.
    erase: await import('../../src/erase.ts'),
    main: await import('../../src/main.ts'),
    roster: await import('../../src/roster.ts'),
    // Stage 1 over a server, and the artifact it is bound to. Both are the kernel's,
    // and `watch-server.ts` is the seam the kernel's own command line goes through.
    watchServer: await import('../../src/watch-server.ts'),
    // Stage 2's seam, one server over: `work-server.ts` is the half that writes the
    // reply, and it checks the roster's **work** row against the server it is given.
    workServer: await import('../../src/work-server.ts'),
    prompts: await import('../../src/prompts.ts'),
  }
  return modules
}

/**
 * The roster a first run writes, and why it is a file rather than rows in memory.
 *
 * The design rejects the reading that `agents.yml` is a one-time seed:
 * the file **is** the roster, read on every open, and the store's `agents` shard is rebuilt
 * from it. Putting the agents into the store on first run and leaving no file would be
 * exactly the design that row rejects — configuration turned into state, with nothing left
 * for a person to edit afterwards. So the first run writes the file, and the ordinary open
 * path reads it back like any other roster.
 *
 * The shape is the roster format's subset, and it is not trusted: the text is parsed by the
 * kernel's own `parseRoster` on the open that follows, so a typo here fails the first
 * launch instead of quietly landing a bot with no agents.
 *
 * `model` and `prompt` are absent, which means `unset` — choosing a model is a measurement
 * (`src/README.md` line 26) and this file has no standing to pick one.
 */
const FIRST_RUN_ROSTER = `# agents.yml — the roster of agents (\`host-rulings.md\`, "Bot and agent as two objects").
#
# What is registered here is agents, not bots. Each bot is the grouping, its rows are its
# workers, and nothing caps a bot at two: a bot that later needs a third role gets a third
# row and the two that were there first need no migration.
#
# This file is the roster, and the store's agents are rebuilt from it every time the kernel
# opens the store beside it. A row's id is derived
# from its bot and its role, so a row keeps the sessions and memories it had before.
#
# A first run writes this file because a fresh install has no other way to have an agent at
# all. Editing it is how a bot is given a different set of workers; deleting it is not, since
# a store with no roster file beside it keeps the agents it already has — a missing file says
# nothing about the store, while a file that is there and holds no rows says the bot has no
# agents.
#
# Two spaces for \`- \`, four for a field, whole-line comments only, lists in one line.
# Anything outside that subset is an error naming the line.
agents:
  - bot: Echo
    role: watch
    # The half that cannot write: a decision model produces no text and calls no tool.
    # \`[]\` is a real answer here, not a placeholder.
    tools: []
  - bot: Echo
    role: work
    # \`say\` is the only way into a room (checklist line 14), so a work agent without it
    # could not answer at all; \`read\` is how it goes back to what a note folded away
    # (\`archive.ts\`, and \`docs/host-rulings.md\` "The observation box"). \`glob\` and \`grep\` answer
    # what that archive holds rather than one day of it, and \`write\` and \`edit\` are how it
    # keeps something of its own: the same directory, and the one part of the tool set that
    # changes what is on the disk. A row that allows less than the shipped prompt offers is
    # refused when the prompt is bound to a server, so these six words and the shipped
    # turn artifact (work-v11.json) are one decision written twice.
    tools: [say, read, glob, grep, write, edit]
`

/**
 * Whether this store holds nothing at all.
 *
 * Read over the three shards a world is made of rather than over `rooms` alone: a store
 * whose rooms are gone but whose people and bots are still there is damaged, not new, and
 * seeding a second world on top of it would bury the damage under a fresh room.
 */
function holdsNothing(store) {
  return [store.data.rooms, store.data.principals, store.data.bots].every(
    (shard) => Object.keys(shard).length === 0,
  )
}

/**
 * The world a first run lands in: one room, one person and one bot (`seedOneRoom`), and the
 * roster beside it, so the bot has an agent that can speak.
 *
 * Both pieces already exist in the kernel and are composed here rather than re-stated:
 * `seedOneRoom` writes the person, the bot, the room and the memberships, and the roster is
 * the same two rows the shipped `seek-data/agents.yml` holds. `src/` is untouched, exactly
 * as in the three slices before this one.
 *
 * Two refusals, each one a state that is not a first run:
 *
 * - **Anything in the store.** Opening an existing world must not add a room to it.
 * - **A roster already beside it.** Rows name the bots they serve, so writing our own would
 *   either overwrite a person's file or produce agents for a bot that is not there. A store
 *   that is empty with a roster beside it is a hand-made state, and the ordinary path's
 *   refusal (`no bot is 'X' in this store`) is the honest answer to it.
 *
 * `store.path` is not checked: `SeekStore.load` takes the path this function is called with,
 * so a store opened here always has one, and a branch for the other case would be a state no
 * caller can reach.
 *
 * Returns the seeded scene, or `null` when nothing was seeded.
 */
async function seedFirstRun(mods, store, rows) {
  if (rows !== undefined || !holdsNothing(store)) return null

  const scene = mods.main.seedOneRoom(store)
  // The world is on disk before the roster is: a roster written for a bot that never
  // landed would name nobody on the next open.
  await store.save()
  try {
    await writeFile(mods.roster.rosterPath(store.path), FIRST_RUN_ROSTER, {
      encoding: 'utf8',
      // Never over a file that appeared meanwhile: if one did, it wins and the read below
      // picks it up.
      flag: 'wx',
    })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
  return scene
}

/**
 * Who decides whether a bot acts: the measured watch model over a server named for this
 * half, one binding per bot.
 *
 * **This is stage 1, and only stage 1.** The kernel has two halves: the cheap judgement
 * that says whether a message is worth acting on (`judge`, below) and the turn that then
 * says something (`decide`). Reading a real model for the first half makes a bot act when
 * it judges it should rather than on every message; it does not change a word of what it
 * says. Naming both in one breath is the confusion this comment exists to prevent.
 *
 * **With nothing named there is no judgement at all, and that is not a placeholder.** A
 * bot acts on what the rules settle (a direct room, a mention, a reminder) and on nothing
 * else, so a group room with no model behind it stays quiet rather than answering
 * everything — and the name of each bot left without this half is returned as `quiet`,
 * which is what the window puts into a sentence a person can act on.
 *
 * **Nothing here is invented.** `watch-server.ts` is the seam the kernel's own command
 * line goes through, and it is called with the same two facts it is given there: the
 * server's origin, and the artifact the assembled text belongs to. The artifact is not a
 * choice this file makes — `loadPromptArtifact()` reads the shipped one, and
 * `watchOverServer` refuses outright if the server was bound to an artifact that asks a
 * different question, so a wrong one fails at construction instead of drifting.
 *
 * **The two facts arrive together or not at all**, the way `--server`/`--window` pair up in
 * `src/main.ts`, and for the same reason: `window` is how much one judgement may read, the
 * number is the caller's (`box.ts`), and an app that chose one for the person would be
 * writing down a budget no measurement stands behind. The knobs are named in the refusal
 * because refusing is only useful to whoever turned one.
 *
 * Returns the kernel's `Judge` (or nothing, when no bot could be bound), the origin the
 * half was pointed at, the reason each refused bot refused — for the log, never the screen
 * — and the names of the bots left quiet.
 */
async function stageOneFor(mods, store, standing, options) {
  // A server the app meant to supply and could not — a build with no binary, a first run with
  // no weights, a child that died on start-up — arrives here as a sentence rather than as an
  // origin. It is refused before anything is bound, because there is nothing to bind to, and
  // the sentence reaches the log where whoever configured this install is looking
  // (`main.js`). Without this the half would look unnamed rather than broken, and a server
  // that was supposed to be there would be reported as one nobody asked for.
  if (typeof options?.serverRefusal === 'string' && options.serverRefusal !== '') {
    throw new Error(options.serverRefusal);
  }

  // **A test's own judgement, the way `options.fetch` is a test's own transport.** What a
  // test of a room, a membership or a delete measures is what this layer does with a
  // verdict; how a model reaches one is `model-wiring.test.mjs`'s subject and needs a
  // server's worth of fakes. An injected half wins over a named server for the same reason
  // it does in `src/main.ts`: a caller that bound its own stage 1 has already decided.
  if (typeof options?.judge === 'function') {
    return { judge: options.judge, server: null, refusal: null, quiet: [] };
  }

  const server = typeof options?.server === 'string' && options.server !== '' ? options.server : undefined;
  const rawWindow = typeof options?.window === 'string' && options.window !== '' ? options.window : undefined;

  if ((server === undefined) !== (rawWindow === undefined)) {
    throw new Error(
      server === undefined
        ? 'SEEK_WINDOW gives a budget with no SEEK_SERVER: which model server to ask is ' +
            "yours to name, so a budget on its own says " +
            'nothing to ask it of'
        : 'SEEK_SERVER names a model server with no SEEK_WINDOW: how much one judgement ' +
            'may read is your number (`box.ts`), and this app will not choose one for you',
    );
  }

  // Nothing named: no bot can be judged, so no bot acts on its own — a direct room's
  // message and a mention are still settled by the rules (`gate.ts` row 2), and what they
  // wake says nothing (§2, and stage 2 is what would speak). `quiet` is every bot, because
  // this half is missing for every bot.
  if (server === undefined) {
    return { judge: undefined, server: null, refusal: null, quiet: standing.map(nameOf) };
  }

  if (!/^[1-9][0-9]*$/.test(rawWindow)) {
    throw new Error(
      `SEEK_WINDOW is '${rawWindow}', which is not a positive whole number: it is how much ` +
        'one judgement may read, and a budget that is not a number is not the one you meant',
    );
  }

  // One binding per bot, and one bot's refusal is that bot's. `watchOverServer` binds the
  // bot whose roster row it checks and whose box a judgement reads, so a store holding
  // several cannot be served by one call — and refusing the store, which is what this
  // layer used to do, took every bot down over one row.
  const bound = new Map();
  const quiet = [];
  const refusals = [];
  for (const bot of standing) {
    try {
      bound.set(
        bot.id,
        await mods.watchServer.watchOverServer(
          store,
          bot.id,
          {
            baseUrl: server,
            ...(apiKeyOf(options) === undefined ? {} : { apiKey: apiKeyOf(options) }),
            artifact: mods.prompts.loadPromptArtifact(),
            ...(options?.fetch === undefined ? {} : { fetch: options.fetch }),
          },
          { window: Number(rawWindow) },
        ),
      );
    } catch (error) {
      // Named, because a sentence about a roster row is only actionable to whoever knows
      // which bot's row it is — and this sentence goes to the log, not the screen.
      quiet.push(nameOf(bot));
      refusals.push(`${nameOf(bot)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    judge: judgeOver(bound),
    server,
    // Every refusal, one per line: the log is where a diagnosis goes, and three bots that
    // refused for three reasons are three lines rather than one.
    refusal: refusals.length === 0 ? null : refusals.join('\n'),
    quiet,
  };
}

/**
 * A bot's name as a person reads it, for the two places a bot is named: the log's sentence
 * about a refused half, and the window's about a bot left quiet.
 *
 * A bot with no name is drawn by its id everywhere else in the store (`snapshotOf`), and
 * here too — there is nothing else to call it.
 */
function nameOf(bot) {
  return typeof bot.name === 'string' && bot.name !== '' ? bot.name : bot.id;
}

/**
 * Every bot that got a judgement, and silence for the ones that did not.
 *
 * **The silence is a decision, not a fallback.** A bot whose watch half could not be bound
 * acts on nothing, which is exactly what a bot whose model answered "not about me" does —
 * so one row claiming a model the server does not serve leaves the other bots talking,
 * instead of the whole store falling back to something that acts on everything.
 */
function judgeOver(bound) {
  return (botId, entries) => {
    const own = bound.get(botId);
    return own === undefined ? [] : own(entries);
  };
}

/** The same table for the half that writes: a bot with no turn to run adds no line. */
function decideOver(bound) {
  return (context) => {
    const own = bound.get(context.botId);
    if (own === undefined) return undefined;
    return own(context);
  };
}

/**
 * The same table for the note a room is compacted into, and one difference that matters:
 * a bot with no writer refuses rather than answering with nothing.
 *
 * A turn that says nothing is a legal turn — woken, silent, on the ledger. A note that
 * says nothing is not: it would consume the observations it was written from and leave the
 * bot knowing less than before, which is why `digestOver` throws on an empty answer. The
 * throw reaches `Compactor`, which records the failure, backs off until the delta grows
 * and writes nothing — and no note is better than an empty one.
 */
function summariseOver(writers) {
  return (input) => {
    const own = writers.get(input.botId);
    if (own === undefined) {
      throw new Error(`no note writer is bound for ${input.botId}`);
    }
    return own(input);
  };
}

/**
 * Why a model name with no server beside it is refused.
 *
 * One sentence in one place, because it is one rule: a model name is a fact about the
 * server that serves it. It is thrown here, where the half is bound, and read from here by
 * `main.js`, which has to decide whether to start the app's own server before this layer
 * runs at all — the server that app starts serves the model it carries, so a name given
 * with no origin of your own is refused there too, and in these words.
 */
const WORK_MODEL_WITHOUT_SERVER =
  'SEEK_WORK_MODEL names a model with no SEEK_WORK_SERVER: which model writes the words ' +
  'is a fact about the server that serves it, and a name on its own says nothing to ask it of';

/**
 * How many new observations a room may pile up before its box is compacted.
 *
 * The host settled it in these words on 2026-10-28 — 「超过20条新消息，就压缩」 — and it is a
 * count and not an age, because what has to be bounded is how much a later judgement is
 * asked to read. `Compactor.crosses` fires at `>=`, so the twentieth pending observation
 * is the one that starts a note, which is what "more than twenty" means when the twentieth
 * has already arrived.
 *
 * It bounds the judgement's input and nothing else: the work agent still opens its whole box
 * (`turn.ts` hands it the entries it was woken for, and §"The work agent is handed the whole
 * box" is a separate ruling). What the number changes is that the box stops growing forever —
 * before it, a room with a history woke every bot in it, because every judgement read the
 * whole conversation and found itself addressed by something in it.
 */
const NOTE_AFTER = 20;

/**
 * A picture's bytes, for the half that answers to read.
 *
 * `LlamaServer.loadMedia` is the kernel asking *what are these bytes I was handed a key
 * to*, and this is the only layer that can answer: the key is a bare file name inside the
 * `media/` directory beside the store (`media.js` says why it is a name and not a path).
 *
 * **A picture whose bytes are not there is answered `null`, not thrown.** A store copied
 * without its `media/` directory, or a file removed by hand, is a room in a state — and a
 * throw would be every turn that opens that box failing on the same missing file, which is
 * a room that never answers again over one picture. `null` says *this picture does not
 * ride*, which the transport states in words rather than silently dropping.
 *
 * Anything else — a key that is not a plain name, a directory where a file should be — is
 * thrown: those are not a picture that has gone, they are a store that is wrong.
 */
function pictureLoader(storeFile) {
  return async (picture) => {
    try {
      return readBytes(storeFile, picture.key)
    } catch (error) {
      if (error && error.reason === PICTURE_GONE) return null
      throw error
    }
  }
}

/**
 * Who writes what the bot says: the kernel's placeholder, or the work model over the
 * server `SEEK_WORK_SERVER` names.
 *
 * **This is stage 2, and it is a separate server from stage 1's.** Row 24 checks a
 * roster row's `model` claim against the server that serves that row, and one origin
 * reports one `model_alias` — so a store whose watch row names one model and whose work
 * row names another needs two servers, which is what the design already calls "the other
 * server". A single `SEEK_SERVER` serving both would silently collapse that into "one
 * model does everything", which is a choice about which model reads the cut.
 *
 * **No budget is asked of this half, and that is not an omission.** `SEEK_WINDOW` is how
 * much one *judgement* may read, and it lives with `SEEK_SERVER` because a judgement is
 * what stage 1 asks for (`box.ts`). A turn's prompt is assembled from the artifact and
 * the store, and `work-server.ts` re-checks it against the server's own `n_ctx` per
 * turn — it never asks the caller for a budget, so inventing a second one here would be
 * a number no measurement stands behind and nothing reads. A hosted endpoint is asked
 * nothing there at all, and that is stated where the check is skipped: the only tokeniser
 * that counts that prompt is the endpoint's own, which it does not offer, so an estimate
 * would be this app refusing a turn over a number it made up.
 *
 * **Two kinds of endpoint, and `options.workModel` is what tells them apart.** Without it
 * this half is a `llama-server` and every sentence above holds unchanged. With it, the
 * server is an OpenAI-compatible endpoint: `/props`, `/apply-template` and `/tokenize` do
 * not exist there, so what replaces them is the endpoint's own `GET /v1/models` — asked
 * once, before any turn, so a name it does not serve is one sentence at start-up rather
 * than a turn that fails all afternoon. That list is also why the name cannot be
 * discovered: it holds far more names than a person's config mentions, and picking one
 * would be a guess at which they meant.
 *
 * What it costs to be wrong is one refusal at start-up, the same shape stage 1 has: an
 * artifact offering a tool this runtime cannot execute, a server that cannot hold the
 * smallest turn, a work row claiming another model, or a model named with no server to
 * serve it. All four fail here rather than mid-turn, and `openHost` turns each into a
 * fact the window shows.
 */
async function stageTwoFor(mods, store, standing, options) {
  // The same fact as stage 1's, on the half that writes the words. Each half is refused on its
  // own so that one answer does not decide the other (`openHost`'s comment says why).
  if (typeof options?.workServerRefusal === 'string' && options.workServerRefusal !== '') {
    throw new Error(options.workServerRefusal);
  }

  // The same seam as stage 1's, on the half that writes: a test that gives this layer a
  // turn has said what the bot's model would have said, and standing up a server to say it
  // is a fake measuring the fake.
  if (typeof options?.decide === 'function') {
    return {
      decide: options.decide,
      summarise: options.summarise,
      server: null,
      refusal: null,
      quiet: [],
    };
  }

  const server =
    typeof options?.workServer === 'string' && options.workServer !== '' ? options.workServer : undefined;
  const model =
    typeof options?.workModel === 'string' && options.workModel !== '' ? options.workModel : undefined;

  // Paired, the way `SEEK_SERVER` and `SEEK_WINDOW` are, and refused for the same reason: a
  // model name is a fact about a server that serves it. On its own it names nothing to ask,
  // and the app's own server already knows which model it carries.
  if (server === undefined && model !== undefined) {
    throw new Error(WORK_MODEL_WITHOUT_SERVER);
  }

  // Nothing named, so no bot has words: every turn this store wakes runs and says nothing.
  // The turn is still on the ledger, which is what "woken and silent" reads as.
  if (server === undefined) {
    return {
      decide: undefined,
      summarise: undefined,
      server: null,
      refusal: null,
      quiet: standing.map(nameOf),
    };
  }

  // One binding per bot, for the reason stage 1 has one: the row whose `model` claim is
  // checked against this server belongs to one bot, and a turn is filled from that bot's
  // own name and card (`work-server.ts`, `valuesOf`).
  const bound = new Map();
  const writers = new Map();
  const quiet = [];
  const refusals = [];
  for (const bot of standing) {
    try {
      const endpoint = {
        baseUrl: server,
        ...(model === undefined ? {} : { model }),
        ...(workApiKeyOf(options) === undefined ? {} : { apiKey: workApiKeyOf(options) }),
        // Stage 2 reads this for nothing — `work-server.ts` takes the words from its own
        // artifact (`src/prompts/work-v1.json`) and uses the server for what it reports
        // (`/props`, or `/v1/models` on a hosted one — never both) and the chat call. It is
        // here because `LlamaServer` requires it, and passing a made-up one would be a second
        // artifact nobody measured.
        artifact: mods.prompts.loadPromptArtifact(),
        ...(options?.workFetch === undefined ? {} : { fetch: options.workFetch }),
        // **The pictures the turn is about, as bytes.** `box.ts` hands a turn a key and a
        // mime and never the bytes — how a client names a file is its business — so the
        // loader has to come from the one layer that knows where this store keeps its
        // `media/`. Absent here, a turn whose box held a picture would refuse rather than
        // answer from the words alone, which is the right refusal and the wrong app.
        loadMedia: pictureLoader(store.path),
      };
      bound.set(
        bot.id,
        await mods.workServer.workOverServer(
          store,
          bot.id,
          endpoint,
          { prompt: mods.prompts.loadWorkArtifact() },
        ),
      );
      // The other thing this half writes: the note a room's box is compacted into. It is
      // bound beside the turn rather than after it, on the same server and the same bot,
      // because `docs/host-rulings.md` gives the writing to the half that works — and a
      // note written by a model this bot does not speak through would be another agent's
      // summary of a conversation it was not in.
      writers.set(
        bot.id,
        mods.workServer.digestOver(store, bot.id, endpoint, {
          prompt: mods.prompts.loadCompactArtifact(),
        }),
      );
    } catch (error) {
      quiet.push(nameOf(bot));
      refusals.push(`${nameOf(bot)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    decide: decideOver(bound),
    summarise: summariseOver(writers),
    server,
    refusal: refusals.length === 0 ? null : refusals.join('\n'),
    quiet,
  };
}

/**
 * Open the kernel the interface runs on.
 *
 * A store that is not there yet is a fresh install, and a fresh install lands in a room
 * rather than on an empty window: see `seedFirstRun`. Everything after that point is the one
 * path — the roster is read, the bot's agents are rebuilt from it, and the kernel is built
 * over the store — so a first run takes no special route through the interface.
 *
 * `options.server` and `options.window` are what `SEEK_SERVER` and `SEEK_WINDOW` carried,
 * and `options.workServer` is what `SEEK_WORK_SERVER` carried, `options.workModel` what
 * `SEEK_WORK_MODEL` carried — the model the words half is talking to, which is absent for a
 * `llama-server` (it reports its own) and required to reach a hosted endpoint that only
 * answers which names it serves. Left out, the half each
 * one belongs to is the kernel's placeholder, as the published build has been until now.
 * `options.fetch` and `options.workFetch` are a test's recorders, handed to the two
 * transports. `options.apiKey` is what `SEEK_API_KEY` carried: the credential the named
 * servers ask for. It belongs to an origin rather than to a half, so both transports are
 * given the same one — and blank means no header at all rather than an empty `Bearer`.
 *
 * `options.workApiKey` overrides it for the words half alone, and it exists because the two
 * origins can now want two different keys. A credential in the environment is one the person
 * gave these servers, so it keeps reaching both; a key read out of another program's config
 * names *that* endpoint, and sending it to a server the app started on this machine — where it
 * is a secret addressed to nobody — would be a credential leaving the one origin it belongs to.
 * Absent, this half falls back to `options.apiKey`, which is the behaviour it had before.
 */

/**
 * The credential both halves send, when there is one.
 *
 * One function rather than two reads, because it is one rule: empty and whitespace-only
 * are not credentials (`llama.ts`'s `headersOf` sends no header for them), so a variable
 * set to nothing behaves exactly like one that was never set.
 */
function apiKeyOf(options) {
  const key = options?.apiKey
  return typeof key === 'string' && key.trim() !== '' ? key : undefined
}

/**
 * The credential the words half sends: its own when it was given one, the shared one otherwise.
 *
 * One rule, stated once — blank and whitespace-only mean "not given" exactly as they do above,
 * so a caller that passes an empty string gets the shared key rather than a request with an
 * empty `Bearer`.
 */
function workApiKeyOf(options) {
  const own = options?.workApiKey
  return typeof own === 'string' && own.trim() !== '' ? own : apiKeyOf(options)
}

async function openHost(storeFile, options = {}) {
  const mods = await kernelModules()

  const store = await mods.store.SeekStore.load(storeFile)
  // A store written while a deleted bot was spelled `removed_at` carries that name, and the
  // store keeps unknown keys on purpose (`src/store.ts`): without this the bot would come back
  // as somebody the organization still has — offered for rooms, and its messages unsigned.
  // Adopted in memory here, saved with the next write (`src/bots.ts`).
  mods.bots.adoptBotDeletions(store)

  // Agents are rebuilt from the roster beside the store every time the kernel opens it
  // `undefined` means no file was found, and
  // then the store keeps the agents it already carries — that is not an empty roster.
  let rows = await mods.roster.readRosterFor(store)
  // A first run writes both halves, and the roster it wrote is then read back through this
  // same call: the file it just created is parsed by the kernel's own reader, not trusted.
  if (await seedFirstRun(mods, store, rows)) rows = await mods.roster.readRosterFor(store)
  if (rows !== undefined) mods.roster.applyRoster(store, rows)

  // Stage 1 is settled before the kernel exists: binding it over a server measures the
  // option ids, and a kernel started over a mask taken from another question would run
  // happily and never act. Everything it can refuse, it refuses here rather than on the
  // first message.
  //
  // **A refusal does not close the window.** The store is local and every message in it is
  // still there, so an app that would not open because a model server was down or misnamed
  // would be punishing the person for the server's state. It falls back to the placeholder
  // and says *which server it did not use, and why* — that sentence is what a silent
  // fallback would lose, and it is why the reason is a returned fact rather than a caught
  // error nobody reads. `main.js` logs it too, so a refusal is visible where the app was
  // started from as well as in the window.
  // **Which bots this store has, standing.** A deleted bot keeps its row — its messages
  // name it — so a reader that walked the table bound a half for somebody the organization
  // no longer has, and counted the graveyard into the bargain (`src/bots.ts`,
  // `standingBots`).
  const standing = mods.bots.standingBots(store)

  let stage1 = { judge: undefined, server: null, refusal: null, quiet: standing.map(nameOf) }
  try {
    stage1 = await stageOneFor(mods, store, standing, options)
  } catch (error) {
    // One binding for the whole half — a server named without a budget, a build with no
    // binary — so every bot is left without it, and the reason is the half's, not a bot's.
    stage1 = {
      judge: undefined,
      server: null,
      refusal: error instanceof Error ? error.message : String(error),
      quiet: standing.map(nameOf),
    }
  }

  // Stage 2 is bound the same way and refused in the same shape, because it is a second
  // server with its own roster row to check: one half refusing must not take the other
  // with it. A store whose watch row is served and whose work row is not is a real state,
  // and the window says exactly that rather than closing or pretending both are fine.
  let stage2 = { decide: undefined, server: null, refusal: null, quiet: standing.map(nameOf) }
  try {
    stage2 = await stageTwoFor(mods, store, standing, options)
  } catch (error) {
    stage2 = {
      decide: undefined,
      server: null,
      refusal: error instanceof Error ? error.message : String(error),
      quiet: standing.map(nameOf),
    }
  }

  // A half nobody bound is left out rather than passed as nothing: the kernel's own default
  // is the honest one for a missing half — a judgement that acts on nothing and a turn that
  // says nothing — and both are what a bot with no model does.
  //
  // **The note is the one line a room gets.** The host settled it in these words on
  // 2026-10-28 — 「超过20条新消息，就压缩」 — and it is a count rather than an age, because
  // what the box has to bound is how much a later judgement can be asked to read. Without a
  // writer the line is inert: `Compactor.due()` answers false before it counts anything,
  // so a bot with no model still fills its box and still reads it.
  const kernel = new mods.kernel.Kernel(store, {
    ...(stage2.decide === undefined ? {} : { decide: stage2.decide }),
    ...(stage1.judge === undefined ? {} : { judge: stage1.judge }),
    ...(stage2.summarise === undefined ? {} : { summarise: stage2.summarise }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
    // How long a bot takes to look at what just arrived. The window's caller decides it
    // (`main.js` says what a person's tempo is), and a caller that says nothing gets no
    // wait at all — which is what every test of this layer wants, since what it measures
    // is a room and never a clock.
    ...(options.wakeDelay === undefined ? {} : { wakeDelay: options.wakeDelay }),
    ...(options.timers === undefined ? {} : { timers: options.timers }),
    compactLines: { maxObservations: NOTE_AFTER },
  })
  // Nothing is woken by starting: this arms the one comparator for rows that came due
  // (`§12 (c)`), and a delivery is what wakes a bot.
  await kernel.start()

  // **The two ways a bot answers without being asked twice.** A send starts its wakes and
  // returns (`postMessage`); `onChanged` is what says they have settled, so the window can
  // draw an answer that arrived after the person's own line was already on screen. `onError`
  // is the same hook for the wakes that threw — the kernel's comparator and a person's send
  // both report there, so the main process has one place to log them.
  return {
    store,
    kernel,
    storeFile,
    stage1,
    stage2,
    onChanged: options.onChanged,
    onError: options.onError,
  }
}

/**
 * Everything the window may see, read off an open host.
 *
 * The same read `seek:snapshot` and `seek:changed` carry, exported because a caller with no
 * window still has to ask what a room holds *now* — which after `postMessage` is a different
 * answer from the snapshot it returned, because a bot answers on its own time.
 */
function hostSnapshot(host) {
  return snapshotOf(host.store, host.storeFile, host.stage1, host.stage2)
}

/**
 * Open the kernel, or answer with the kernel's own sentence about why it would not.
 *
 * **A store this version refuses must not leave the person with no window.** `openHost`
 * throws for a store it cannot read — an older build's file, a hand-edited one — and that
 * sentence is the only thing that says what to do next. A caller that awaited `openHost`
 * *before* creating a window therefore turned the sentence into an app that looks dead: no
 * window, no dialog, and, started from Finder, no terminal to print to. This function is
 * where that answer stops being an exception, so the window can draw it in the same shape
 * stage 1 and stage 2 already refuse in.
 *
 * It decides nothing itself: what a store must hold is `SeekStore.load`'s question, and the
 * refusal is passed through word for word. Every other caller keeps `openHost`, which still
 * throws — the refusal is a fact this one caller needs as a value, not a rule about opening.
 */
async function openHostOrRefuse(storeFile, options = {}) {
  try {
    return { host: await openHost(storeFile, options), refusal: null }
  } catch (error) {
    return { host: null, refusal: error instanceof Error ? error.message : String(error) }
  }
}

/** Stop the comparator. The table is left as it is, so nothing is lost by quitting. */
function closeHost(host) {
  host.kernel.stop()
}

/**
 * The picture reference a caller passed, in the two fields the kernel reads.
 *
 * A copy of the two strings and nothing else — no lookup, no check, no default. Whether
 * they are acceptable is `mediaFor`'s question (`src/delivery.ts`), and it answers with a
 * sentence that names the failure; a check here would be a second opinion that could pass
 * what the kernel then refuses, or refuse with wording no document carries.
 *
 * `undefined` for anything that is not a pair of strings, so an `image` posted without a
 * picture reaches `mediaFor`'s own "an image message with no image" rather than a
 * TypeError from this file.
 */
function mediaOf(media) {
  if (!media || typeof media !== 'object') return undefined
  const { key, mime } = media
  if (typeof key !== 'string' || typeof mime !== 'string') return undefined
  return { key, mime }
}

/**
 * The attachment reference a caller passed, in the four fields the kernel reads.
 *
 * The same shape of copy as `mediaOf`, and for the same reason: no lookup, no check, no
 * default. `fileFor` (`src/delivery.ts`) is where "a file message with no file" and "an
 * attachment on a `text` message" are decided, and it says both in sentences the composer
 * draws — a check here would be a second opinion that can disagree with the kernel's.
 *
 * `undefined` for anything that is not four usable facts, so a `file` posted without one
 * reaches `fileFor`'s own refusal rather than a TypeError from this file.
 */
function fileOf(file) {
  if (!file || typeof file !== 'object') return undefined
  const { key, name, size, mime } = file
  if (typeof key !== 'string' || typeof name !== 'string') return undefined
  if (typeof mime !== 'string' || typeof size !== 'number') return undefined
  return { key, name, size, mime }
}

/**
 * Who a message addresses, in the kernel's own pair.
 *
 * A copy of the `{id, name}` pairs the caller passed, and nothing else — `deliver()` stores
 * this array on the message exactly as given (`src/delivery.ts`), and the pair is the
 * own field for "who was named". **Which ids are people in this room is not a question this
 * file answers**: `deriveHints()` finds a bot's own id in the array to decide `mentionsMe`,
 * and a mention naming somebody the room does not hold wakes nobody — which is a fact about
 * what was typed rather than a refusal some document wrote a sentence for. Inventing one
 * here would be the window refusing what the kernel accepts, which every other write in
 * this file avoids.
 *
 * `undefined` for anything that is not a list, so a message with no mention reaches
 * `deliver()` as the empty array its own type gives it; and a pair with no two strings in
 * it is dropped rather than stored as a mention nobody can draw.
 */
function mentionsOf(mentions) {
  if (!Array.isArray(mentions)) return undefined
  const pairs = mentions
    .filter((one) => one && typeof one.id === 'string' && typeof one.name === 'string')
    .map((one) => ({ id: one.id, name: one.name }))
  return pairs.length === 0 ? undefined : pairs
}

/**
 * Say something in a room, and let the kernel answer.
 *
 * `input.rootId` is what makes it a reply: named, the message answers that one and
 * joins its thread; left out, it is a message that answers nothing and roots its own
 * chain.
 *
 * The three steps are the kernel's, in the order the kernel states them:
 *
 * 1. **`deliver()`**, which is synchronous by design — the message and one entry per
 *    recipient bot are appended in one uninterrupted step, so a delivery can never
 *    interleave with the pop half of a drain.
 * 2. **One save by the caller**, because `deliver()` writes to the store and does not
 *    persist it. This is that save, and it happens before anything is woken: a bot's
 *    answer that reached the disk while the message it answers did not would be a
 *    room whose order is wrong after a restart.
 * 3. **One wake per bot that received an entry**, through `Kernel.tick()` — the single
 *    wake path, which consults stage 0 first and opens a turn only for what survives it.
 *
 * **The wake is started here and awaited by nobody.** A message is sent when it is written,
 * and step 2 is the writing; the room answering afterwards is the room's business, on its own
 * time. Until 2026-10-29 this call awaited the whole turn, so the composer sat disabled for
 * as long as a model took to talk and the person's own line did not appear until the bot had
 * finished — a chat window that stops accepting words while somebody else types, which is not
 * how any room behaves and which reads on screen as the app hanging.
 *
 * So the snapshot it returns is the room *now*: the person's message, and whatever was
 * already there. A bot's answer is not in it, because at that instant the bot has not been
 * asked yet. `host.onChanged` is called once the wakes have settled, and `main.js` answers
 * that by sending a fresh snapshot to the window — the same `seek:changed` every other write
 * broadcasts, so an answer arrives the way it does in any room.
 *
 * **A wake nobody awaited still cannot fail silently.** The kernel hands a wake's failure to
 * the caller that started that wake, so the caller is here: it goes on `kernel.failures`
 * beside the comparator's own background wakes (`src/kernel.ts`) and is named to
 * `host.onError`, which the main process logs. The room stays quiet, the message stays on
 * disk, and nothing is taken back — there is nothing to take back.
 */
/**
 * A forward's address, as `{roomId, messageId}` — or a refusal.
 *
 * The window always sends the pair, because the message being forwarded was drawn in a room
 * and that room is normally not the one it is being sent to. A bare id is the kernel's
 * one-room form and passes through unchanged. **A half address is refused rather than
 * dropped**: reading it as "no forward" would send an ordinary empty message, and a person
 * who pressed *forward* would get a silently blank line instead of the sentence saying what
 * went wrong.
 */
function forwardAddressOf(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value === '' ? undefined : value
  const roomId = typeof value.roomId === 'string' ? value.roomId : ''
  const messageId = typeof value.messageId === 'string' ? value.messageId : ''
  if (roomId === '' || messageId === '') {
    throw new Error(
      'a forwarded message names both the room it is in and the message itself, ' +
        'so nothing was sent'
    )
  }
  return { roomId, messageId }
}

async function postMessage(host, input) {
  const text = typeof input?.text === 'string' ? input.text : ''
  // A picture is a message whose words may be nothing: the caption is optional, and
  // `deliver()` accepts an `image` with an empty text as long as `media` names the blob
  // A text message with no words is still not a message.
  const isPicture = input?.kind === 'image'
  // An attachment is the third case of a message whose words may be nothing: a person
  // attaches a file and sends it, and a caption is optional exactly as it is for a picture.
  const isFile = input?.kind === 'file'
  // **A forward has no words of its own**, and that is the whole of what it is: its text,
  // kind and picture are copied off the stored original inside `deliver()`. So it is the
  // second case where an empty box is not an empty message — and the one where passing
  // anything beside `forwardOf` is refused by the kernel as a second copy of a fact.
  const forwarding = forwardAddressOf(input?.forwardOf)
  if (text.trim() === '' && !isPicture && !isFile && !forwarding) {
    throw new Error('an empty message is not a message, so nothing was sent')
  }

  const roomId = input?.roomId
  const senderId = meOf(host.store)
  if (!senderId) {
    throw new Error('this store holds nobody to speak as, so nothing was sent')
  }

  const mods = await kernelModules()
  const sent = mods.delivery.deliver(host.store, {
    roomId,
    senderId,
    text,
    // The kind and the picture's reference are the caller's, and neither is invented
    // here: `mediaFor` in `src/delivery.ts` refuses an `image` with no key, a picture on
    // a kind that disowns it, and a mime that is not `image/*`. Its sentences are what
    // the composer shows, so this file adds no refusal of its own about pictures.
    // **The kind is translated; the picture is passed through even when it looks wrong.**
    // `mediaOf` copies the caller's two strings and decides nothing, so a caller that sent
    // `media` on a text message reaches `mediaFor` and gets the kernel's own refusal —
    // "media on a `text` message: only 'image' carries a picture". Dropping it here instead
    // would be this file quietly discarding the bytes a caller asked to send, and an app
    // whose picture vanished with no sentence is the silent failure this whole slice is
    // about it.
    // A forward's kind and picture are the original's, read out of the store by the kernel —
    // so passing anything here would be the "carrying content of its own" refusal, and would
    // be this file inventing a second copy of a fact the store already holds.
    kind: forwarding ? undefined : isPicture ? 'image' : isFile ? 'file' : 'text',
    media: forwarding ? undefined : mediaOf(input?.media),
    // The attachment, copied and not judged — `fileFor` in `src/delivery.ts` owns both
    // halves of the invariant, and its sentences are the ones the composer shows.
    file: forwarding ? undefined : fileOf(input?.file),
    // Who the message addresses. The kernel stores the pairs and derives its own answer from
    // them per receiving bot (`mentionsMe`), so a message that names a bot is the one case
    // stage 0 settles without asking the watch model — and until this line existed the window
    // could not produce one (see `snapshot.js` for the other half, the drawing).
    mentions: mentionsOf(input?.mentions),
    // A reply names the message it answers and the kernel derives the rest of the
    // thread from it: `root_id`, the chain that message belongs to, and one hop more
    // depth (`src/delivery.ts`). Nothing here decides what a thread is. A `rootId`
    // that is not a message in this room is refused by `deliver()` itself, and that
    // refusal reaches the composer as the sentence the kernel wrote.
    rootId: typeof input?.rootId === 'string' && input.rootId !== '' ? input.rootId : undefined,
    // What this message quotes or forwards. Both are addresses the caller names and neither
    // is content: `deliver()` reads the named message out of the store and keeps the snapshot
    // of it, because a caller's copy of somebody's words is a claim about what they said.
    // A quotation is always a message in this room — a reply answers where it is — while a
    // forward names the room the original is in, because forwarding sends it somewhere else
    // (`forwardOf` in `src/delivery.ts`).
    quoteOf: typeof input?.quoteOf === 'string' && input.quoteOf !== '' ? input.quoteOf : undefined,
    forwardOf: forwarding,
  })
  await host.store.save()

  // The message is on disk, and that is the whole of "it was sent". The bots it was delivered
  // to are asked now and answered for later — one wake each, all of them started at once,
  // because the room's bots were all told at the same instant. What each of them does with
  // that instant is the tempo's business: `kernel.wake()` waits before it reads, and two bots
  // that were told together do not answer together.
  const recipients = new Set(sent.observations.map((entry) => entry.bot_id))
  const answers = [...recipients].map((botId) =>
    host.kernel.wake(botId).catch((error) => {
      // A turn that threw is recorded where the kernel records the wakes it started itself,
      // and the room goes quiet: the message it would have answered is already written.
      host.kernel.failures.push({ botId, error })
      host.onError?.(error, botId)
    }),
  )
  // **Not `whenIdle()`.** A tick also starts its own compaction, and waiting for that would
  // put a summary's request between a bot's answer and the window that draws it. What the
  // window is told about here is the answers, and nothing else.
  if (answers.length > 0) {
    void Promise.all(answers).then(() => {
      // A window that closed while a bot was answering is not a failure of the room, so this
      // is caught rather than left as a rejection on a promise nobody holds.
      try {
        host.onChanged?.()
      } catch (error) {
        host.onError?.(error, undefined)
      }
    })
  }

  // The same facts the window's first snapshot carried, for both halves: a send replaces
  // the whole snapshot in the renderer, so leaving either out here would make its strip
  // disappear the moment the person said anything.
  return snapshotOf(host.store, host.storeFile, host.stage1, host.stage2)
}

/**
 * One person's reaction on one message, and the snapshot that now shows it.
 *
 * **This is the kernel's one write for it.** `toggleReaction()` in `src/delivery.ts` adds the
 * person to `operators[]` or takes them out again — the same call both ways, because a second
 * press *is* the undo — and refuses an empty emoji, a principal this store has never heard of,
 * and a reactor who is not in the room. Its sentences are what the window shows, in the same
 * envelope as `seek:post`, and none of them is re-checked here.
 *
 * **A reaction wakes nobody.** It writes no observation, so unlike `postMessage` there is no
 * `tick()` and no `whenIdle()`: a message that already had its turn does not get a second one
 * because somebody nodded at it. The store is saved, because a reaction lives in the store.
 *
 * The snapshot is returned whole rather than the message: the window replaces what it draws
 * from one snapshot (`seek:changed` carries the same thing), so a field-level answer here
 * would be a second shape for the same fact.
 */
async function reactToMessage(host, input) {
  const principalId = meOf(host.store)
  if (!principalId) {
    throw new Error('this store holds nobody to react as, so nothing was recorded')
  }
  const mods = await kernelModules()
  mods.delivery.toggleReaction(host.store, {
    roomId: typeof input?.roomId === 'string' ? input.roomId : '',
    messageId: typeof input?.messageId === 'string' ? input.messageId : '',
    principalId,
    emojiType: typeof input?.emojiType === 'string' ? input.emojiType : '',
  })
  await host.store.save()
  return snapshotOf(host.store, host.storeFile, host.stage1, host.stage2)
}

/**
 * Make a room, with the people in it, and hand back the snapshot that has it.
 *
 * **This is the kernel's write, not a second one.** `createRoom()` in `src/rooms.ts` appends
 * the room and every membership in one uninterrupted step, and it refuses — before writing
 * anything — a member naming no principal in this store, one principal named twice, and an
 * empty room. All three of those refusals are sentences, and they are what the window shows;
 * this file re-checks none of them, because a second opinion here could pass what the kernel
 * then refuses, or refuse with wording no document carries.
 *
 * **Three things this file decides, and each is a fact about the interface rather than a rule
 * about rooms.**
 *
 * - **The name is trimmed, and an empty one is no name at all.** `Room.name` is optional in
 *   the kernel and `snapshotOf` already draws a nameless room by its id, so a person who
 *   typed spaces asked for the room they get rather than for one called `'   '`. Nothing is
 *   refused here: an unnamed room is a state the data model has, so this is a formatting
 *   choice, not a validation.
 * - **`chat_mode` is not asked for, so the kernel's default stands.** The field is stored and
 *   never branched on (`src/README.md`, last checklist row), and `direct` is a headcount that
 *   `deriveHints` takes from the member list — so a picker offering `group`/`topic`/`p2p` would
 *   be inviting the one thing that row calls the bug: a mode growing behaviour the other modes
 *   do not have. Two people in a room is a direct message whatever the field says, which is
 *   why this build never infers `p2p` from a headcount either.
 * - **The person the window speaks as is the owner, and everyone else is a member.** No
 *   permission model in the kernel branches on `MembershipRole`, so this changes no behaviour;
 *   it keeps a room made here shaped like the room a first run seeds, where the person is
 *   `owner` and the bot is `member`. When that person is not among the chosen members there is
 *   no owner at all — a state the kernel allows, and one the composer will report honestly:
 *   `deliver()` refuses a sender who is not a member, in its own sentence.
 */
async function createRoom(host, input) {
  const rawName = typeof input?.name === 'string' ? input.name.trim() : ''
  const chosen = Array.isArray(input?.members) ? input.members : []
  // Only strings can name a principal. Anything else reaches the kernel as no member at all,
  // and an empty list is then refused by the kernel's own "a room with no members" sentence
  // rather than by a TypeError written here.
  const ids = chosen.filter((id) => typeof id === 'string' && id !== '')
  const me = meOf(host.store)

  const mods = await kernelModules()
  const created = mods.rooms.createRoom(host.store, {
    ...(rawName === '' ? {} : { name: rawName }),
    members: ids.map((id) => (id === me ? { principalId: id, role: 'owner' } : { principalId: id })),
  })
  // Once, and before the snapshot: the room is on disk before the window draws it, exactly as
  // a message is. A room drawn but not saved would vanish on the next open while the person
  // believed they had made it.
  await host.store.save()

  return {
    roomId: created.room.id,
    snapshot: snapshotOf(host.store, host.storeFile, host.stage1, host.stage2),
  }
}

/**
 * Put one more person into a room that already exists.
 *
 * **This is the kernel's write, not a second one.** `addMember()` in `src/rooms.ts` refuses a
 * room this store does not hold, a principal it has never heard of, and one who is already in
 * the room — three sentences, and they are what the window shows. Nothing is re-checked here,
 * for the reason `createRoom` above gives: a second opinion could pass what the kernel then
 * refuses, or refuse in wording no document carries.
 *
 * **Two things this file decides, and both are facts about the interface.**
 *
 * - **No role is asked for, so the kernel's default stands.** `MembershipRole` branches on
 *   nothing in the kernel, and `createRoom`'s docstring makes the same point about
 *   `chat_mode`: a picker offering `owner`/`member` would be asking a question with no
 *   consequence. In particular, adding the person the window speaks as does **not** make them
 *   the owner — `createRoom` gives that role because it is *making* a room and keeps it shaped
 *   like the one a first run seeds, while joining somebody else's room is not making it.
 * - **The two ids reach the kernel as they were given.** A non-string names no room and no
 *   principal, so the kernel's own `unknown room: …` / `unknown principal: …` answers — a
 *   better report than a `TypeError` raised here, and the same choice `createRoom` makes about
 *   the member list.
 */
async function addMember(host, input) {
  const mods = await kernelModules()
  mods.rooms.addMember(host.store, {
    roomId: input?.roomId,
    principalId: input?.principalId,
  })
  // Once, and before the snapshot — the same rule a room and a message follow. A member drawn
  // but not saved is a room that silently loses somebody on the next open, which is the one
  // outcome the person cannot see and cannot repair.
  await host.store.save()

  return snapshotOf(host.store, host.storeFile, host.stage1, host.stage2)
}

/**
 * The two rows a new bot needs, written so that a later read finds the bot they name.
 *
 * **Named by id, never by name.** A roster row may say a bot's name, but only "when that is
 * unambiguous" (`src/roster.ts`) — and two bots called 周敏 is a state this app allows on
 * purpose, so a row that said the name would make the whole roster refuse on the next open.
 * The id is the one thing about a bot that is unique.
 *
 * **The two rows are the shipped ones**, `watch` and `work`, in the same order and with the
 * same tools a first run writes (`FIRST_RUN_ROSTER`): the half that decides cannot write and
 * calls nothing, and the half that answers has `say` — the only way into a room — `read`,
 * which is how it goes back to what a note folded away, and `glob` and `grep`, which find a
 * file or a word in what it filed. A bot with one row is a bot that either never decides or
 * can never speak.
 */
function rowsForNewBot(botId) {
  return (
    `  - bot: ${botId}\n` +
    '    role: watch\n' +
    '    tools: []\n' +
    `  - bot: ${botId}\n` +
    '    role: work\n' +
    '    tools: [say, read, glob, grep, write, edit]\n'
  )
}

/**
 * Make a bot: its card, and the two agents that let it speak.
 *
 * **The bot is the kernel's write, not a second one.** `createBot()` in `src/bots.ts` writes
 * the bot and refuses the one thing that cannot be stored — a bot with no name — in a
 * sentence. Nothing here re-checks the name, for the reason `createRoom` gives: a second
 * opinion could pass what the kernel then refuses, or refuse in wording no document carries.
 *
 * **The agents are a file.** The design says the roster *is* `agents.yml`, read on every open,
 * so a bot created at runtime has to be given rows there or it is a bot that can never be
 * woken: the store's `agents` shard is rebuilt from that file, and a row nobody wrote is a
 * worker nobody has. Three details, each one a decision this file makes:
 *
 * - **Appended, never rewritten.** The file may hold rows a person wrote by hand, with their
 *   comments; replacing it whole would be this function editing somebody's work.
 * - **Re-read and re-applied rather than spliced into memory**, so the file's own parse is
 *   what validates the text we just added — a mistake in the lines above fails here, where it
 *   can be reported, instead of on the next launch.
 * - **No file, no rows.** A store with no roster beside it keeps the agents it already has
 *   (a missing file says nothing about the store), so writing a fresh file here would rebuild
 *   the shard from nothing and take every existing agent's job away. The bot is created and is
 *   simply mute, and `roster: 'none'` is how the window can say so instead of pretending.
 *
 * Returns the snapshot, the new bot's id, and whether it was given agents.
 */
async function addBot(host, input) {
  const mods = await kernelModules()
  const { bot } = mods.bots.createBot(host.store, {
    name: input?.name,
    gender: input?.gender,
    position: input?.position,
    personality: input?.personality,
  })

  const rosterPath = mods.roster.rosterPath(host.store.path)
  let roster = 'none'
  let text = null
  try {
    text = await readFile(rosterPath, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (typeof text === 'string') {
    // The newline guard: a file that does not end with one would otherwise glue the first
    // appended row onto its last line — a roster that parses wrong is worse than one that
    // refuses.
    const grown = `${text}${text.endsWith('\n') ? '' : '\n'}${rowsForNewBot(bot.id)}`
    // Parsed before it is written: the text is ours, but what a row means is the kernel's
    // (`parseRoster`), and a name this file got wrong should not wait for the next launch to
    // be discovered.
    const rows = mods.roster.parseRoster(grown, rosterPath)
    await writeFile(rosterPath, grown, 'utf8')
    mods.roster.applyRoster(host.store, rows)
    roster = 'appended'
  }

  // Once, and before the snapshot: the bot and its agents are on disk before the window draws
  // them, the same rule a room and a message follow.
  await host.store.save()

  return {
    botId: bot.id,
    roster,
    snapshot: snapshotOf(host.store, host.storeFile, host.stage1, host.stage2),
  }
}

module.exports = {
  WORK_MODEL_WITHOUT_SERVER,
  addBot,
  addMember,
  closeHost,
  createRoom,
  deleteMessage,
  deleteRoom,
  deleteThread,
  hostSnapshot,
  openHost,
  openHostOrRefuse,
  pictureLoader,
  postMessage,
  reactToMessage,
  deleteBot,
  removeMember,
  updateRoom,
}

/**
 * Change what a room says about itself — its name, its description, its announcement,
 * its tag.
 *
 * **This is the interface's first edit.** `addMember` adds and `createRoom` makes; nothing
 * before this call changed something already written. What it may change is the kernel's
 * answer, not this file's: `updateRoom()` (`src/rooms.ts`) refuses a room this store does not
 * hold and a name that is nothing but spaces, and applies the four texts in one step — half
 * of a refused edit is worse than none of it.
 *
 * **A field the window did not send is a field nobody touched**, so each of the four is passed
 * only when it arrives as a string. That is what lets the form send what the person edited
 * without clearing the three texts they did not open.
 */
async function updateRoom(host, input) {
  const patch = {}
  for (const field of ['name', 'description', 'announcement', 'tag']) {
    if (typeof input?.[field] === 'string') patch[field] = input[field]
  }

  const mods = await kernelModules()
  mods.rooms.updateRoom(host.store, { roomId: input?.roomId, ...patch })
  // Once, and before the snapshot — the rule a room, a message and a member all follow. An
  // edit drawn but not saved is a room that reverts on the next open, which reads as the app
  // forgetting what it was told.
  await host.store.save()

  return snapshotOf(host.store, host.storeFile, host.stage1, host.stage2)
}

/**
 * Take one principal out of a room — the window's 退出, and the same call from the other side.
 *
 * `removeMember()` in `src/rooms.ts` decides who may go and refuses the last member in its own
 * sentence; nothing is re-checked here, for the reason `createRoom` gives. What the window does
 * with the answer — leaving the room, closing the people panel — is the window's, because it is
 * about what is on screen and not about the store.
 */
async function removeMember(host, input) {
  const mods = await kernelModules()
  mods.rooms.removeMember(host.store, {
    roomId: input?.roomId,
    principalId: input?.principalId,
  })
  await host.store.save()

  return snapshotOf(host.store, host.storeFile, host.stage1, host.stage2)
}

/**
 * Take one message back: its words go, its row stays, its deliveries stop.
 *
 * **Three calls rather than one with a flag**, for the reason the writes above are separate
 * calls: they answer three different questions. `deleteThread` is not a loop of this one — the
 * kernel stamps a whole run at one instant, so a caller that looped could stop halfway and
 * leave replies answering a root whose words are gone. `deleteRoom` is not a thread either: it
 * takes the memberships with it, and that is what makes the room leave every list.
 *
 * **What the store cannot say afterwards rides back.** A picture and an attachment are files in
 * `media/` beside the store, and the kernel keeps references rather than bytes — so each erased
 * message hands its two references back, and the main process removes them (`main.js` is the
 * only place that knows where `media/` is; this file has never written a file).
 */
async function deleteMessage(host, input) {
  const mods = await kernelModules()
  const gone = mods.erase.deleteMessage(host.store, { messageId: input?.messageId })
  await host.store.save()

  return {
    messageId: gone.message.id,
    roomId: gone.message.room_id,
    media: gone.media ? { key: gone.media.key } : null,
    file: gone.file ? { key: gone.file.key } : null,
    snapshot: snapshotOf(host.store, host.storeFile, host.stage1, host.stage2),
  }
}

/** Take a whole thread back — the root and every reply it holds, at one instant. */
async function deleteThread(host, input) {
  const mods = await kernelModules()
  const gone = mods.erase.deleteThread(host.store, { rootId: input?.rootId })
  await host.store.save()

  return {
    rootId: input?.rootId,
    roomId: gone.roomId,
    messageIds: gone.erased.map((one) => one.message.id),
    blobs: gone.erased
      .flatMap((one) => [one.media && { key: one.media.key }, one.file && { key: one.file.key }])
      .filter(Boolean),
    snapshot: snapshotOf(host.store, host.storeFile, host.stage1, host.stage2),
  }
}

/** Delete a room: its messages, its memberships, and the room itself. */
async function deleteRoom(host, input) {
  const mods = await kernelModules()
  const gone = mods.erase.deleteRoom(host.store, { roomId: input?.roomId })
  await host.store.save()

  return {
    roomId: gone.room.id,
    messageIds: gone.erased.map((one) => one.message.id),
    blobs: gone.erased
      .flatMap((one) => [one.media && { key: one.media.key }, one.file && { key: one.file.key }])
      .filter(Boolean),
    snapshot: snapshotOf(host.store, host.storeFile, host.stage1, host.stage2),
  }
}

/**
 * Delete a bot from the organization.
 *
 * **One store write and no file write.** `deleteBot()` (`src/bots.ts`) stamps the bot and deletes
 * its memberships; the roster beside the store is a person's file and this bridge has never
 * written it — the bot's agent rows simply stop waking anything, because an agent with no
 * membership in a room is delivered nothing.
 */
async function deleteBot(host, input) {
  const mods = await kernelModules()
  const gone = mods.bots.deleteBot(host.store, { botId: input?.botId })
  await host.store.save()

  return {
    botId: gone.bot.id,
    // The rooms it was in, so the window can say what changed rather than leaving a person to
    // notice it in a list.
    rooms: gone.rooms,
    snapshot: snapshotOf(host.store, host.storeFile, host.stage1, host.stage2),
  }
}
