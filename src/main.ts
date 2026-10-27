/**
 * The first milestone, runnable: one room, one bot, and whether it speaks on
 * its own.
 *
 * `CONTRIBUTING.md` states the milestone — "a bot and its agent, the inbox, a
 * gate and one room, with no interface. What is being tested is whether 'it
 * says something on its own' holds up, not how it looks" — and `src/README.md`
 * carries it as a checklist line. Every part of it is written and tested
 * (`delivery`, `gate`, `inbox`, `turn`, `say`, `kernel`), so what was missing is
 * not a rule but a way to *watch* it: a `Kernel` was constructible only from a
 * test, so "the bot answered a message nobody addressed to it" could be read in
 * an assertion and never observed.
 *
 * This file is that observation, and it adds no rule of its own. It seeds one
 * group room out of the entities the data model already fixes, has a person say
 * something that names nobody, starts the kernel and prints the room's log.
 *
 * The room holds two people and a bot rather than one of each, and that is not
 * decoration: `direct` is a **headcount**, so a room of exactly two members is a
 * direct message and takes the gate's fast path without stage 1 being asked.
 * Three members is what makes an ordinary group room, and an ordinary group
 * room is the only place where "it answers something nobody addressed to it"
 * means anything.
 * Every decision is taken where it already lives: whether to spend anything is
 * `gate.ts`, whether an ambiguous entry is worth acting on is `inbox.ts`, what
 * to say is `turn.ts` and `say.ts`.
 *
 * **Three things it deliberately does not do.**
 *
 * - **Stage 2 is still a placeholder — stage 1 need not be.** The words a bot says
 *   arrive as the `decide` argument, exactly as `turn.ts` takes it, and the
 *   default says the placeholder line. Stage 1 — "is this worth acting on" — is
 *   the measured watch model as soon as the caller names a server it started
 *   (`--server <origin> --window <n>`): the model comes from a server the caller
 *   supplies, named by its origin, and nothing here starts, supervises or stops
 * that process. What stays true either way is the
 *   one thing the printed report must never do: let a placeholder read as a bot
 *   that thought. So the report says which of the two answered. A stub that says
 *   "act" without reading demonstrates the plumbing and is evidence about
 *   nothing; a real stage 1 is evidence about exactly one question — whether the
 *   room was worth acting on — and about none of the others.
 * - **The agents are the roster's, not this file's.** `seedOneRoom` builds the
 *   people, the bot and the room and stops there; `src/roster.ts` reads
 *   `agents.yml` beside the store and rebuilds the store's agents from it
 * (checklist lines 13 and 20). A run
 *   with no roster file is a bot with no agents, and it says so rather than
 *   falling back on rows written here.
 * - **No interface.** The checklist line says "no interface", so this writes to
 *   stdout and has no other surface. It is a harness for watching the kernel,
 *   not the beginning of the client.
 *
 * **What it prints is chrome all the same.** A person reads this report, so every
 * word of it is looked up by key from `src/i18n/<tag>.json` and none of it is
 * written below (checklist line 19, `docs/design/i18n.md` §1). That line was
 * open while this file was the product's only surface, and an earlier version of
 * this comment argued the line was therefore not due — which is the reading that
 * makes retrofitting certain: the first screen would have inherited a file full
 * of sentences instead of a catalogue next to it. Two things stay out of the
 * catalogue, and both are deliberate. **Content** — what the person says, what
 * the stub says back, the names the seed gives them — is data a participant
 * produced, and translating it is the trust violation `docs/design/i18n.md` §2
 * forbids. **Diagnostics** — the kernel's `throw`s — are §7's English, read in a
 * log rather than rendered.
 *
 * Run it with `npm start`, `npm start -- --lang zh-CN` to choose the language, or
 * `npm start -- <path>` to choose the store. The store is ordinary: the second
 * run appends to the room the first one made.
 *
 * `npm start -- --server http://127.0.0.1:8080 --window 24` asks the measured
 * watch model instead of the placeholder, and the two flags go together on
 * purpose: the server is the caller's to start, and how much one judgement may
 * read is the caller's number rather than one this harness may invent
 * (`box.ts`). What that does not buy is a picture: a box carrying one is still
 * refused rather than read from its caption, because
 * the bytes arrive through a loader this harness has no blob scheme for — and a
 * seed here writes none, so no run of this file exercises that path.
 */

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { CompactLines, Summarise } from './compact.ts';
import type { Timers } from './comparator.ts';
import { deliver } from './delivery.ts';
import {
  catalogueFor,
  DEFAULT_LOCALE,
  joinList,
  locales,
  loadCatalogue,
  translator,
  type Catalogue,
} from './i18n.ts';
import type { Judge } from './inbox.ts';
import { Kernel, type KernelFailure } from './kernel.ts';
import type { Fetcher, LlamaServer } from './llama.ts';
import { loadPromptArtifact } from './prompts.ts';
import { applyRoster, readRosterFor, rosterPath, type AgentRow } from './roster.ts';
import { addMember, createRoom } from './rooms.ts';
import { newId, SeekStore } from './store.ts';
import type { Decide } from './turn.ts';
import type { Id } from './types.ts';
import { watchOverServer } from './watch-server.ts';

/** Where the seed writes its `created_at`, so a seeded world is reproducible. */
const SEED_AT = '2026-10-24T00:00:00.000Z';

/**
 * What the person says: a remark to the room that names nobody.
 *
 * Content, not chrome — a participant's words are data, and the catalogue beside
 * this file never touches them (`docs/design/i18n.md` §2). The line below is what
 * a language switch must leave byte-identical, and the suite asserts exactly that.
 */
export const SAID =
  'the release notes for the last build still say "not started" — someone should look at that';

/**
 * What the bot answers, as a placeholder.
 *
 * It is deliberately about the placeholder and not about the message: a stub
 * cannot have read the room, and a line that pretended to would be the one lie
 * this file could tell. Content for the same reason as `SAID`: it is what a
 * participant would say, so it is stored as the words it is, not as a key.
 */
export const STUB_REPLY =
  'I would answer that once there is a model behind me — for now this line is a stub, and the plumbing is what works.';

/**
 * Stage 1, standing in for the watch model: every ambiguous entry is worth
 * acting on.
 *
 * The real one asks a binary question per entry and answers from two token
 * probabilities (`watch.ts`). This one answers without reading, which is the
 * honest description of a stub and the reason its verdict says nothing about
 * whether the design holds up.
 */
export const stubJudge: Judge = (entries) => entries;

/** Stage 2, standing in for the work model: it answers, without reading. */
export const stubDecide: Decide = (context) => {
  // A reminder's turn has no room, and `say` addresses a room by name — so a
  // turn with nothing to address says nothing.
  if (!context.roomId) return;
  context.say(context.roomId, STUB_REPLY);
};

/** The person, the bot and the room — everything a run needs that is not an agent. */
export interface SeedWorld {
  /** The person who speaks. */
  me: Id;
  bot: Id;
  room: Id;
}

/**
 * The one room the milestone is about, and who is in it.
 *
 * A `SeedWorld` plus the two roles the run needs. The roles are looked up on the
 * bot's rows rather than assumed to be its only rows: a bot may carry a third
 * agent (checklist line 20), and this shape is what a run reads, not a claim
 * about how many there are.
 */
export interface MilestoneScene extends SeedWorld {
  /** The bot's two halves: the one that reads the room, and the one that writes. */
  watch: Id;
  work: Id;
}

/** One line of a room's log, as a person would read it. */
export interface TranscriptLine {
  senderId: Id;
  sender: string;
  text: string;
  /** Whether a bot said it — the milestone's whole question, per line. */
  byBot: boolean;
}

/** What one run of the milestone produced. */
export interface MilestoneRun {
  scene: MilestoneScene;
  /** The room's log when the run settled, oldest first. */
  transcript: TranscriptLine[];
  /**
   * Whether the bot put a message in the room.
   *
   * This is the milestone's question answered from the record rather than from
   * a return value: a turn that opened and said nothing is not "speaking".
   */
  spoke: boolean;
  /** Turns that threw. Empty is the expected reading, and never the assumption. */
  failures: KernelFailure[];
  /**
   * The origin of the server stage 1 read the room through, when it read one.
   *
   * Absent means both halves of the run were placeholders, and that difference is
   * exactly what the report has to be able to state: a reader who cannot tell a
   * measured verdict from a stub is reading a placeholder as a bot that thought.
   */
  stage1Server?: string;
}

export interface MilestoneOptions {
  /** An injectable clock, so a run can be reproducible. */
  now?: () => string;
  /** Injectable timers: a run arms nothing, and a test must not wait on one. */
  timers?: Timers;
  decide?: Decide;
  judge?: Judge;
  /**
   * A stage-1 model server the caller has already started, named by its origin.
   *
   * The kernel starts nothing and supervises nothing,
   * so reaching a real judgement is the caller's act: this is the object
   * `watch-server.ts` binds stage 1 over, and `window` beside it is the budget its
   * box is filled against. An explicit `judge` wins over this one, because a
   * caller that built its own stage 1 has said so more directly than a command
   * line did.
   */
  watchServer?: LlamaServer;
  /**
   * How much one judgement may read, in the units `weigh` returns (`box.ts`).
   *
   * Required with `watchServer` and refused without it: the number is the
   * caller's, and a harness that picked one for the caller would be writing down
   * a budget no measurement stands behind.
   */
  window?: number;
  /** What a server-named run calls instead of `globalThis.fetch`. A test's recorder. */
  fetch?: Fetcher;
  /**
   * The room summary's writer, and the line that makes one due.
   *
   * Both are the caller's (`compact.ts`) and both are absent by default, so a
   * run compacts nothing. They exist here because compaction is the one thing a
   * run starts that a turn does not finish — see the wait in
   * `runFirstMilestone`.
   */
  summarise?: Summarise;
  compactLines?: CompactLines;
  /** Override what the person says. */
  said?: string;
  /**
   * The roster to apply, for a store that has no file to read one from.
   *
   * An in-memory store has no directory, so it has no `agents.yml` beside it;
   * this is how a caller hands rows over instead. On disk the file wins, because
   * that is where the roster lives.
   */
  roster?: AgentRow[];
  /** Where the printed run goes. stdout by default; a test passes a collector. */
  out?: (text: string) => void;
}

/**
 * Seed one room: a person, a bot, and somewhere to talk to it.
 *
 * Everything written here is an entity `data-model.md` already fixes — a
 * `Principal` for the person, a `Bot`, and a `Membership` per principal — so this
 * seeds a world rather than stating a rule. **The bot's agents are not here.**
 * They are the roster's (`src/roster.ts`), and a seed that also wrote them would
 * be a second place agents come from — disagreeing with `agents.yml` the first
 * time someone edited the file. The bot is created first and the roster applied
 * after it, because a row names the bot it serves.
 *
 * **Two members, and nobody else.** `direct` is a headcount and not a type, so
 * this room is a direct message — which is what a first run should be: a person
 * and the one bot they were given. It also settles the gate (row 2, `gate.ts`):
 * everything said here addresses the bot, so it answers without stage 1 having to
 * be asked. A seeded third member would make it a group, and the only reason one
 * ever existed here was the milestone's need for an unaddressed line — which is
 * the milestone's business, and it makes its own (`seedMilestoneWorld` below).
 * The host's ruling: a first run puts no stranger in anybody's organization.
 */
export function seedOneRoom(store: SeekStore): SeedWorld {
  const me = newId('ou');
  store.data.principals[me] = { id: me, kind: 'human', name: 'me' };

  const bot = newId('ou');
  store.data.bots[bot] = {
    id: bot,
    name: 'Echo',
    description: 'the bot this milestone is about',
    // The card a bot carries (`src/types.ts`, `Bot`), filled for the seeded one so the window
    // has something to draw before anybody has added a bot of their own. The host stated these
    // three on 2026-10-26T21:22 — 男 / 研发 / 实事求是、老实听话 — and they are stored as
    // written: this is content, not chrome, so no catalogue translates it (`docs/design/i18n.md`
    // §2 keeps what a participant produced out of the catalogue, and a seeded bot is written by
    // the world rather than by the app's interface).
    gender: '男',
    position: '研发',
    personality: '实事求是、老实听话',
  };

  // The room and its members in one write, through the kernel's own
  // `createRoom()`: the seed is a caller like any other, so there is one place
  // that knows how a membership is shaped rather than a fourth one.
  const { room } = createRoom(store, {
    name: 'the first room',
    chatMode: 'group',
    members: [{ principalId: me, role: 'owner' }, { principalId: bot }],
    now: SEED_AT,
  });

  return { me, bot, room: room.id };
}

/**
 * The world the milestone runs in: the first run's room, plus somebody who says nothing.
 *
 * **The extra member is the harness's requirement, not the product's.** The seeded room is a
 * direct message, and a direct message takes the gate's fast path (row 2) — stage 1 is never
 * consulted, and stage 1 is the only row this milestone is about: a group talking near a bot
 * without naming it. One more member makes the room an ordinary group, which is the only kind
 * whose chatter reaches that ambiguous remainder.
 *
 * It is added here rather than seeded there because a person is not something a first launch
 * should put into somebody's organization. The name is the harness's own and appears nowhere
 * the product draws.
 */
function seedMilestoneWorld(store: SeekStore): SeedWorld {
  const world = seedOneRoom(store);
  const other = newId('ou');
  store.data.principals[other] = { id: other, kind: 'human', name: 'the second person' };
  addMember(store, { roomId: world.room, principalId: other, now: SEED_AT });
  return world;
}

/**
 * The world a store already holds, when it holds one.
 *
 * Read back rather than remembered, so a second run continues the conversation
 * the first one started instead of seeding a second bot: the store is the
 * product's own thesis — the data stays local and outlives the process — and a
 * harness that grew a room per run would contradict it.
 *
 * The first room, the first bot in it, and the person who owns it. **The agents are not
 * part of this**: they are read from the roster, and a world that is complete
 * without them is what lets a roster be applied after the bot exists.
 */
export function worldOf(store: SeekStore): SeedWorld | undefined {
  const room = Object.values(store.data.rooms)[0];
  if (!room) return undefined;

  const membership = Object.values(store.data.memberships).find(
    (row) => row.room_id === room.id && store.data.bots[row.principal_id],
  );
  if (!membership) return undefined;
  const bot = membership.principal_id;

  // The owner, not merely the first person: a group room may hold more than one,
  // and "whichever came first" would make the scene depend on insertion order.
  const human = Object.values(store.data.memberships).find(
    (row) =>
      row.room_id === room.id &&
      row.role === 'owner' &&
      store.data.principals[row.principal_id],
  );
  if (!human) return undefined;

  return {
    me: human.principal_id,
    bot,
    room: room.id,
  };
}

/**
 * The scene a store holds: the world, plus the two roles a run needs.
 *
 * A bot with no `work` agent is not a scene — something would have to guess who
 * answers. A bot with a third row is: the roles are looked up by name and the
 * others are left alone, because the roster is a roster of agents and nothing
 * here may assume it holds exactly two (checklist line 20).
 */
export function sceneOf(store: SeekStore): MilestoneScene | undefined {
  const world = worldOf(store);
  if (!world) return undefined;

  const agents = store.agentsOf(world.bot);
  const watch = agents.find((agent) => agent.role === 'watch');
  const work = agents.find((agent) => agent.role === 'work');
  if (!watch || !work) return undefined;

  return { ...world, watch: watch.id, work: work.id };
}

/** A room's log, oldest first, with the sender's name resolved. */
export function transcriptOf(store: SeekStore, roomId: Id): TranscriptLine[] {
  return store.messagesOf(roomId).map((message) => {
    const sender = store.principal(message.sender_id);
    return {
      senderId: message.sender_id,
      sender: sender?.name ?? message.sender_id,
      text: message.text,
      byBot: Boolean(store.data.bots[message.sender_id]),
    };
  });
}

/**
 * Who answers stage 1 for this run: the placeholder, the caller's own judge, or
 * the measured watch model over the server the caller named.
 *
 * The order gives the caller's own word the last say: an injected `judge` is a
 * caller that built stage 1 itself, and a command line does not overrule it.
 *
 * What is refused here rather than inside `watchOverServer` is the one fact this
 * file cannot look up — the box's budget. `box.ts` makes `window` the caller's
 * number, so a server named without one is a request to invent it, and an invented
 * budget is how a judgement reads part of a room and reports as though it had read
 * the whole of it. Nothing else about the server is checked here: whether it can
 * be read this way at all, and where the option ids sit, are `watch-server.ts`'s
 * four steps and belong there rather than in a second copy.
 */
async function stageOne(
  store: SeekStore,
  botId: Id,
  options: MilestoneOptions,
): Promise<{ judge: Judge; server?: string }> {
  if (options.judge !== undefined) return { judge: options.judge };
  if (options.watchServer === undefined) return { judge: stubJudge };

  const window = options.window;
  if (window === undefined) {
    throw new Error(
      'a model server was named with no `window`: how much one judgement may read ' +
        "is the caller's number (`box.ts`), and this harness will not choose one for it",
    );
  }

  return {
    judge: await watchOverServer(store, botId, options.watchServer, { window }),
    server: options.watchServer.baseUrl,
  };
}

/**
 * Run the milestone once: a person speaks, the kernel wakes the bot, and the
 * room's log is what happened.
 *
 * The message names nobody on purpose. An @-mention would take the gate's
 * fast path (`gate.ts` row 2) and prove nothing about the interesting half —
 * the ambiguous remainder is the only row that costs anything, and "it says
 * something on its own" is a claim about that row.
 */
export async function runFirstMilestone(
  store: SeekStore,
  options: MilestoneOptions = {},
): Promise<MilestoneRun> {
  // The bot has to exist before a row can name it, so the world is seeded first
  // and only when there is none; the roster then says what the bot's agents are.
  if (!worldOf(store)) seedMilestoneWorld(store);
  const rows = options.roster ?? (await readRosterFor(store));
  if (rows !== undefined) applyRoster(store, rows);

  const scene = sceneOf(store);
  if (!scene) {
    const where = store.path ? rosterPath(store.path) : 'no path, so no file beside it';
    throw new Error(
      `this bot has no watch and work agent, so nothing can run — the roster read from ${where} did not supply both`,
    );
  }

  // Stage 1 is settled before the message is delivered, because building it is the
  // one step here that can refuse — the option ids are measured over HTTP, and a
  // mask taken from the wrong question fails silently rather than loudly
  // (`watch-server.ts`). A run that refused after delivering would leave a message
  // in the store that nothing had judged.
  const stage1 = await stageOne(store, scene.bot, options);

  deliver(store, {
    roomId: scene.room,
    senderId: scene.me,
    text: options.said ?? SAID,
    now: options.now?.(),
  });
  await store.save();

  const kernel = new Kernel(store, {
    decide: options.decide ?? stubDecide,
    judge: stage1.judge,
    summarise: options.summarise,
    compactLines: options.compactLines,
    now: options.now,
    timers: options.timers,
  });

  await kernel.start();
  // This awaits the turn the tick opened. It does not await the compaction the
  // tick started alongside it — that one is a background action by design (§3) —
  // so the run is not over yet.
  await kernel.tick(scene.bot);
  // `whenIdle()` is the one answer to "what is this process doing", and a
  // harness that printed a log while a summary was still being written would be
  // describing a store that is still moving.
  await kernel.whenIdle();
  kernel.stop();

  const transcript = transcriptOf(store, scene.room);
  return {
    scene,
    transcript,
    spoke: transcript.some((line) => line.byBot),
    failures: kernel.failures,
    // Left out rather than set to `undefined`, so a placeholder run's shape stays
    // exactly what it was: a key that is present and empty is a second way to say
    // "no model", and one of them would drift.
    ...(stage1.server === undefined ? {} : { stage1Server: stage1.server }),
  };
}

/**
 * What a person watching the run reads.
 *
 * It names the store, the room, the log, and — in as many words — which half
 * answered: whether the decision to act came from the measured model at a server
 * the caller named, or from the placeholder. A run printed without that sentence
 * would be this file's only real hazard.
 *
 * **Every word of the chrome comes from a catalogue**, which is what makes the
 * report translatable and, before that, reviewable: the sentence a user reads can
 * be changed without touching this function and this function can be changed
 * without changing what a user reads. `catalogue` defaults to the shipped base
 * language and takes any loaded catalogue, so a test can render this report in a
 * language that exists only in a temporary directory.
 *
 * The one thing not looked up is the blank line, which carries no text to
 * translate, and the transcript's own lines, whose sender and text are content
 * and are passed through as they were written.
 */
export function format(
  run: MilestoneRun,
  path: string,
  catalogue: Catalogue = loadCatalogue(),
): string {
  const t = translator(catalogue);
  const lines = [
    t('report.title'),
    t('report.store', { path }),
    '',
    t('report.room', { room: run.scene.room }),
    ...run.transcript.map((line) => t('report.line', { sender: line.sender, text: line.text })),
    '',
    run.spoke
      ? t('report.spoke', { count: run.transcript.filter((line) => line.byBot).length })
      : t('report.silent'),
    t('report.turns', { count: run.failures.length }),
    '',
    run.stage1Server === undefined
      ? t('report.stub')
      : t('report.stage1', { origin: run.stage1Server }),
  ];
  return `${lines.join('\n')}\n`;
}

/** Where the store lives when no path is given. */
export function defaultStorePath(): string {
  return join(process.cwd(), 'seek-data', 'seek.json');
}

/** What a command line asked for, before anything asks whether it can be honoured. */
export interface ParsedArgv {
  /** The language `--lang` named, or the default. Unvalidated: it may not exist. */
  locale: string;
  /** The origin `--server` named, or nothing. Unvalidated: it may not be a URL. */
  server?: string;
  /** The budget `--window` named, as written. Unvalidated: it may not be a number. */
  window?: string;
  /** Flags this harness does not know, in the order they appeared. */
  unknown: string[];
  /** Flags given more than once, each named once, in the order its second copy came. */
  repeated: string[];
  /** Flags left without the value they need — `--lang` with nothing usable after it. */
  missingValue: string[];
  /** Positional arguments, which is where a store path goes. */
  paths: string[];
}

/** The flags this harness reads a value for. A flag outside this list is unknown. */
const VALUED_FLAGS = ['--lang', '--server', '--window'] as const;

/**
 * Read the command line without deciding anything about it.
 *
 * Separated from `main` so that "what was asked for" is a value a test can read,
 * and so that every refusal below is written after the language is known — a
 * message about a bad flag in a language nobody asked for would be its own small
 * version of the bug this file is fixing.
 */
export function parseArgv(argv: string[]): ParsedArgv {
  const parsed: ParsedArgv = {
    locale: DEFAULT_LOCALE,
    unknown: [],
    repeated: [],
    missingValue: [],
    paths: [],
  };
  /** What each flag was given, in the order it was given, so a second copy shows. */
  const given: Record<string, string[]> = { '--lang': [], '--server': [], '--window': [] };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    // `--flag=value` and `--flag value` are one request written two ways; only the
    // first keeps the value out of the positional list.
    const equals = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = equals > 0 ? arg.slice(0, equals) : arg;

    if (!(VALUED_FLAGS as readonly string[]).includes(name)) {
      // A flag nobody ships and a store path are different mistakes, and the
      // leading dash is the only thing that tells them apart.
      if (name.startsWith('-')) parsed.unknown.push(arg);
      else parsed.paths.push(arg);
      continue;
    }

    let value = equals > 0 ? arg.slice(equals + 1) : undefined;
    if (value === undefined) {
      const next = argv[index + 1];
      // A following flag is not this flag's value: `--lang --nope` asked for a
      // language and wrote nothing, which is a different mistake from a typo.
      if (next !== undefined && !next.startsWith('-')) {
        index += 1;
        value = next;
      }
    }
    if (value === undefined || value.length === 0) {
      parsed.missingValue.push(name);
      continue;
    }

    const already = given[name].length;
    given[name].push(value);
    // Recorded when the second copy arrives, and once: a flag given three times is
    // still one repeated flag, and the first copy is the one that was kept.
    if (already === 1) parsed.repeated.push(name);
  }

  const [lang] = given['--lang'];
  const [server] = given['--server'];
  const [window] = given['--window'];
  if (lang !== undefined) parsed.locale = lang;
  if (server !== undefined) parsed.server = server;
  if (window !== undefined) parsed.window = window;

  return parsed;
}

/**
 * Whether a string is the origin of a model server this harness will call.
 *
 * Two facts, and both are wanted: the scheme is one a request can reach, and the
 * rest parses as a URL at all. `127.0.0.1:8080` looks like an origin to a person
 * and reads as a scheme to a parser, so it is refused here rather than failing
 * inside a request that is already on its way.
 */
function isOrigin(value: string): boolean {
  if (!/^https?:\/\//.test(value)) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * The command line: `npm start`, optionally `--lang <tag>`, a store path, and the
 * `--server` / `--window` pair that asks the measured watch model instead of the
 * placeholder.
 *
 * The exit status is the milestone's answer, so a run that stops speaking fails
 * loudly instead of printing a page of success around one empty line.
 *
 * The catalogue is chosen before anything is refused, because a refusal is itself
 * a sentence a person reads. A language this tree does not ship has no catalogue
 * to carry its own refusal, so `catalogueFor` hands back the base one: the answer
 * to "there is no catalogue for de-DE" is written in English, and that is the one
 * case where the fallback is allowed to print.
 */
export async function main(
  argv: string[],
  options: MilestoneOptions = {},
): Promise<number> {
  const parsed = parseArgv(argv);
  const catalogue = catalogueFor(parsed.locale);
  const t = translator(catalogue);

  if (!locales().includes(parsed.locale)) {
    throw new Error(
      t('cli.unknown-locale', {
        locale: parsed.locale,
        languages: joinList(DEFAULT_LOCALE, locales()),
      }),
    );
  }
  // Unknown flags first: `--lang --nope` is both a language with no value and a
  // flag nobody ships, and the flag nobody ships is the one worth naming.
  if (parsed.unknown.length > 0) {
    throw new Error(t('cli.unknown-flag', { flag: parsed.unknown[0] }));
  }
  if (parsed.missingValue.length > 0) {
    throw new Error(t('cli.flag-needs-value', { flag: parsed.missingValue[0] }));
  }
  if (parsed.repeated.length > 0) {
    throw new Error(t('cli.repeated-flag', { flag: parsed.repeated[0] }));
  }
  // The server and the box's budget arrive together or not at all. The first is
  // whose process reads the room — the caller's —
  // and the second is the caller's number too (`box.ts`), so either one alone is a
  // request to guess the missing half of a judgement.
  if ((parsed.server === undefined) !== (parsed.window === undefined)) {
    throw new Error(
      t('cli.server-window-pair', {
        given: parsed.server === undefined ? '--window' : '--server',
      }),
    );
  }
  if (parsed.server !== undefined && !isOrigin(parsed.server)) {
    throw new Error(t('cli.bad-server', { origin: parsed.server }));
  }
  if (parsed.window !== undefined && !/^[1-9][0-9]*$/.test(parsed.window)) {
    throw new Error(t('cli.bad-window', { window: parsed.window }));
  }
  if (parsed.paths.length > 1) {
    throw new Error(t('cli.two-paths', { first: parsed.paths[0], second: parsed.paths[1] }));
  }

  const path = parsed.paths[0] ?? defaultStorePath();
  const store = await SeekStore.load(path);
  // The artifact is loaded here because the transport cannot be built without it:
  // which of an assembly's parts travels as a system message is the artifact's
  // statement, and a server object that guessed it would send the text in a shape
  // nobody measured. `watch-server.ts` then refuses if the two disagree.
  const watchServer =
    parsed.server === undefined || parsed.window === undefined
      ? undefined
      : {
          baseUrl: parsed.server,
          artifact: loadPromptArtifact(),
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        };
  const run = await runFirstMilestone(store, {
    ...options,
    ...(watchServer === undefined
      ? {}
      : { watchServer, window: Number(parsed.window) }),
  });
  const out = options.out ?? ((text: string) => process.stdout.write(text));
  out(format(run, path, catalogue));
  return run.spoke && run.failures.length === 0 ? 0 : 1;
}

// Only when run as a program: importing this file from a test must not start a
// kernel, and must not write to stdout.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
