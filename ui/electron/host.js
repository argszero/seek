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
 * `work-server.ts`). With no server named, both are the kernel's own placeholders —
 * `stubJudge` acting on everything and `stubDecide` saying one fixed line
 * (`src/main.ts`, `STUB_REPLY`) — taken from the kernel so that "no model is wired"
 * stays one fact in one place.
 *
 * **Two servers, not one, because a server serves one model.** `SEEK_SERVER` names the
 * watch half's server and `SEEK_WORK_SERVER` the work half's, and the reason is
 * `docs/decisions.md` row 24: a roster row's `model` is a claim about the server it is
 * served by, checked by role. One origin reports one `model_alias`, so a store whose
 * two rows name two models cannot be served by one server — and row 24 already says the
 * work row's model "belongs to the other server". Springing stage 2 from `SEEK_SERVER`
 * would have forced every roster onto one model, which is a decision about which model
 * reads the cut, and that is the host's (`docs/decisions.md` rows 20 and 24).
 */

const { writeFile } = require('node:fs/promises')

const { meOf, snapshotOf } = require('./snapshot.js')

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
 * `docs/decisions.md` default 14 rejects the reading that `agents.yml` is a one-time seed:
 * the file **is** the roster, read on every open, and the store's `agents` shard is rebuilt
 * from it. Putting the agents into the store on first run and leaving no file would be
 * exactly the design that row rejects — configuration turned into state, with nothing left
 * for a person to edit afterwards. So the first run writes the file, and the ordinary open
 * path reads it back like any other roster.
 *
 * The shape is `default 15`'s subset, and it is not trusted: the text is parsed by the
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
# opens the store beside it (\`docs/decisions.md\`, defaults 14 and 15). A row's id is derived
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
    # could not answer at all.
    tools: [say]
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
 * The world a first run lands in: one room, two people and a bot (`seedOneRoom`), and the
 * roster beside it, so the bot has an agent that can speak.
 *
 * Both pieces already exist in the kernel and are composed here rather than re-stated:
 * `seedOneRoom` writes the people, the bot, the room and the memberships, and the roster is
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
 * Who decides whether the bot acts: the kernel's placeholder, or the measured watch model
 * over a server the person named.
 *
 * **This is stage 1, and only stage 1.** The kernel has two halves: the cheap judgement
 * that says whether a message is worth acting on (`judge`, below) and the turn that then
 * says something (`decide`, still `stubDecide`). Reading a real model for the first half
 * makes the bot speak when it judges it should rather than on every message; it does not
 * change a word of what it says, which is `STUB_REPLY` until a turn has a model. Naming
 * both in one breath is the confusion this comment exists to prevent.
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
 * Returns the kernel's `Judge` and, when a server was named, its origin — so the window
 * can say which of the two it is looking at. A reader who cannot tell a measured verdict
 * from a placeholder is reading a stub as a bot that thought (`src/main.ts`,
 * `MilestoneRun.stage1Server`).
 */
async function stageOneFor(mods, store, options) {
  const server = typeof options?.server === 'string' && options.server !== '' ? options.server : undefined;
  const rawWindow = typeof options?.window === 'string' && options.window !== '' ? options.window : undefined;

  if ((server === undefined) !== (rawWindow === undefined)) {
    throw new Error(
      server === undefined
        ? 'SEEK_WINDOW gives a budget with no SEEK_SERVER: which model server to ask is ' +
            "yours to name (`docs/decisions.md` row 20), so a budget on its own says " +
            'nothing to ask it of'
        : 'SEEK_SERVER names a model server with no SEEK_WINDOW: how much one judgement ' +
            'may read is your number (`box.ts`), and this app will not choose one for you',
    );
  }

  if (server === undefined) return { judge: mods.main.stubJudge };

  if (!/^[1-9][0-9]*$/.test(rawWindow)) {
    throw new Error(
      `SEEK_WINDOW is '${rawWindow}', which is not a positive whole number: it is how much ` +
        'one judgement may read, and a budget that is not a number is not the one you meant',
    );
  }

  const judge = await mods.watchServer.watchOverServer(
    store,
    onlyBotId(store),
    {
      baseUrl: server,
      artifact: mods.prompts.loadPromptArtifact(),
      ...(options?.fetch === undefined ? {} : { fetch: options.fetch }),
    },
    { window: Number(rawWindow) },
  );

  return { judge, server };
}

/**
 * Who writes what the bot says: the kernel's placeholder, or the work model over the
 * server `SEEK_WORK_SERVER` names.
 *
 * **This is stage 2, and it is a separate server from stage 1's.** Row 24 checks a
 * roster row's `model` claim against the server that serves that row, and one origin
 * reports one `model_alias` — so a store whose watch row names one model and whose work
 * row names another needs two servers, which is what row 24 already calls "the other
 * server". A single `SEEK_SERVER` serving both would silently collapse that into "one
 * model does everything", which is a choice about which model reads the cut.
 *
 * **No budget is asked of this half, and that is not an omission.** `SEEK_WINDOW` is how
 * much one *judgement* may read, and it lives with `SEEK_SERVER` because a judgement is
 * what stage 1 asks for (`box.ts`). A turn's prompt is assembled from the artifact and
 * the store, and `work-server.ts` re-checks it against the server's own `n_ctx` per
 * turn — it never asks the caller for a budget, so inventing a second one here would be
 * a number no measurement stands behind and nothing reads.
 *
 * What it costs to be wrong is one refusal at start-up, the same shape stage 1 has: an
 * artifact offering a tool this runtime cannot execute, a server that cannot hold the
 * smallest turn, or a work row claiming another model. All three fail here rather than
 * mid-turn, and `openHost` turns each into a fact the window shows.
 */
async function stageTwoFor(mods, store, options) {
  const server =
    typeof options?.workServer === 'string' && options.workServer !== '' ? options.workServer : undefined;

  if (server === undefined) return { decide: mods.main.stubDecide };

  const decide = await mods.workServer.workOverServer(
    store,
    onlyBotId(store),
    {
      baseUrl: server,
      // Stage 2 reads this for nothing — `work-server.ts` takes the words from its own
      // artifact (`src/prompts/work-v1.json`) and uses the server only for `/props`,
      // rendering and the chat call. It is here because `LlamaServer` requires it, and
      // passing a made-up one would be a second artifact nobody measured.
      artifact: mods.prompts.loadPromptArtifact(),
      ...(options?.workFetch === undefined ? {} : { fetch: options.workFetch }),
    },
    { prompt: mods.prompts.loadWorkArtifact() },
  );

  return { decide, server };
}

/**
 * The one bot stage 1 is bound to.
 *
 * `watchOverServer` binds **one** bot, because two of the facts it checks are that bot's:
 * the `model` its watch row declares (`docs/decisions.md` row 24) and the identity its
 * agents are told. `Kernel` takes a single `judge` for every bot it drains, so this build
 * can bind exactly one. A store holding more than one is therefore refused rather than
 * bound to whichever key came first — that would check one bot's claim and then let every
 * other bot be served by whatever is in front of the port, which is the failure row 24
 * exists to stop. The store a first run makes holds one bot, which is why this build is
 * exact there.
 */
function onlyBotId(store) {
  const ids = Object.keys(store.data.bots);
  if (ids.length === 1) return ids[0];
  throw new Error(
    ids.length === 0
      ? 'this store holds no bot, so there is nothing to bind a model server to'
      : `this store holds ${ids.length} bots, and stage 1 is bound per bot: this build binds ` +
          'one, so a server is refused rather than read for one bot and applied to all of them',
  );
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
 * and `options.workServer` is what `SEEK_WORK_SERVER` carried. Left out, the half each
 * one belongs to is the kernel's placeholder, as the published build has been until now.
 * `options.fetch` and `options.workFetch` are a test's recorders, handed to the two
 * transports.
 */
async function openHost(storeFile, options = {}) {
  const mods = await kernelModules()

  const store = await mods.store.SeekStore.load(storeFile)

  // Agents are rebuilt from the roster beside the store every time the kernel opens it
  // (`docs/decisions.md`, defaults 14 and 15). `undefined` means no file was found, and
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
  let stage1 = { judge: mods.main.stubJudge, server: null, refusal: null }
  try {
    const bound = await stageOneFor(mods, store, options)
    stage1 = { judge: bound.judge, server: bound.server ?? null, refusal: null }
  } catch (error) {
    stage1 = {
      judge: mods.main.stubJudge,
      server: null,
      refusal: error instanceof Error ? error.message : String(error),
    }
  }

  // Stage 2 is bound the same way and refused in the same shape, because it is a second
  // server with its own roster row to check: one half refusing must not take the other
  // with it. A store whose watch row is served and whose work row is not is a real state,
  // and the window says exactly that rather than closing or pretending both are fine.
  let stage2 = { decide: mods.main.stubDecide, server: null, refusal: null }
  try {
    const bound = await stageTwoFor(mods, store, options)
    stage2 = { decide: bound.decide, server: bound.server ?? null, refusal: null }
  } catch (error) {
    stage2 = {
      decide: mods.main.stubDecide,
      server: null,
      refusal: error instanceof Error ? error.message : String(error),
    }
  }

  const kernel = new mods.kernel.Kernel(store, {
    decide: stage2.decide,
    judge: stage1.judge,
  })
  // Nothing is woken by starting: this arms the one comparator for rows that came due
  // (`§12 (c)`), and a delivery is what wakes a bot.
  await kernel.start()

  return { store, kernel, storeFile, stage1, stage2 }
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
 * Who a message addresses, in the kernel's own pair.
 *
 * A copy of the `{id, name}` pairs the caller passed, and nothing else — `deliver()` stores
 * this array on the message exactly as given (`src/delivery.ts`), and the pair is Feishu's
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
 *    wake path, which consults stage 0 first and opens a turn only for what survives
 *    it. A turn that threw comes back out of `tick()` and therefore out of here: the
 *    kernel hands a wake's failure to the caller that started that wake, and
 *    `kernel.failures` is where the *comparator's* own background wakes are recorded
 *    (`src/kernel.ts`). The message the person typed is already on disk by then, which
 *    is why the interface shows the refusal it gets rather than claiming nothing
 *    happened.
 *
 * What it returns is the snapshot to draw, taken after `whenIdle()` — so the bot's
 * answer is in it, not in the next one.
 */
async function postMessage(host, input) {
  const text = typeof input?.text === 'string' ? input.text : ''
  // A picture is a message whose words may be nothing: the caption is optional, and
  // `deliver()` accepts an `image` with an empty text as long as `media` names the blob
  // (`docs/decisions.md` row 17). A text message with no words is still not a message.
  const isPicture = input?.kind === 'image'
  if (text.trim() === '' && !isPicture) {
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
    // about (`docs/decisions.md` row 17).
    kind: isPicture ? 'image' : 'text',
    media: mediaOf(input?.media),
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
  })
  await host.store.save()

  const recipients = new Set(sent.observations.map((entry) => entry.bot_id))
  for (const botId of recipients) await host.kernel.tick(botId)
  // A wake is not awaited by `tick`'s own compaction, and "the interface is done
  // writing" has exactly one answer in the kernel.
  await host.kernel.whenIdle()

  // The same facts the window's first snapshot carried, for both halves: a send replaces
  // the whole snapshot in the renderer, so leaving either out here would make its strip
  // disappear the moment the person said anything.
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

module.exports = { addMember, closeHost, createRoom, openHost, postMessage }
