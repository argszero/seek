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
 * - **No model.** The two answers a model would give arrive as the `decide` and
 *   `judge` arguments, exactly as `turn.ts` and `inbox.ts` take them, and the
 *   defaults are stubs. The printed output says so: a bot whose words came from
 *   a placeholder must never read as a bot that thought. A stub that says "act"
 *   without reading demonstrates the plumbing, and is no evidence about the
 *   design question — that needs a model, and the model is the slice after this
 *   one.
 * - **No roster.** `agents.yml` has neither a settled shape nor a parser, so the
 *   bot's two agents are seeded from the entity types instead. `seedOneRoom` is
 *   the function that goes away when the roster is ruled; nothing here invents a
 *   YAML key.
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
 */

import { dirname, join } from 'node:path';
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
import { newId, SeekStore } from './store.ts';
import type { Decide } from './turn.ts';
import type { Id } from './types.ts';

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

/** The one room the milestone is about, and who is in it. */
export interface MilestoneScene {
  /** The person who speaks. */
  me: Id;
  /**
   * A second person, who says nothing.
   *
   * Not decoration: `direct` is a headcount and not a type, so a room of exactly
   * two members is a direct message — and a direct message takes the gate's fast
   * path without stage 1 ever being consulted. A third member is what makes this
   * an ordinary group room, which is the only kind whose chatter reaches the
   * ambiguous remainder the milestone is about.
   */
  other: Id;
  bot: Id;
  /** The bot's two halves: the one that reads the room, and the one that writes. */
  watch: Id;
  work: Id;
  room: Id;
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
}

export interface MilestoneOptions {
  /** An injectable clock, so a run can be reproducible. */
  now?: () => string;
  /** Injectable timers: a run arms nothing, and a test must not wait on one. */
  timers?: Timers;
  decide?: Decide;
  judge?: Judge;
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
  /** Where the printed run goes. stdout by default; a test passes a collector. */
  out?: (text: string) => void;
}

/**
 * Seed one room: a person, one bot, its two agents, and a group to talk in.
 *
 * Everything written here is an entity `data-model.md` already fixes — a
 * `Principal`, a `Bot`, two `Agent` rows and a `Membership` per principal — so
 * this seeds a world rather than stating a rule. **The roster replaces it.**
 * `agents.yml` is where a bot's agents are meant to come from, and it has no
 * settled format and no parser (`src/README.md` lines 13 and 20 are open on
 * exactly that), so the two rows are written here instead of invented there.
 */
export function seedOneRoom(store: SeekStore): MilestoneScene {
  const me = newId('ou');
  store.data.principals[me] = { id: me, kind: 'human', name: 'me' };
  const other = newId('ou');
  store.data.principals[other] = { id: other, kind: 'human', name: 'someone else' };

  const bot = newId('ou');
  store.data.bots[bot] = {
    id: bot,
    name: 'Echo',
    description: 'the bot this milestone is about',
  };

  // A home per agent, beside the store: nothing reads it yet, and a row with no
  // home would be a row no session could open in later.
  const home = join(dirname(store.path ?? '.'), 'agents', bot);
  const watch = newId('ag');
  store.data.agents[watch] = {
    id: watch,
    bot_id: bot,
    role: 'watch',
    home: join(home, 'watch'),
    // `unset` on both: choosing a model is a measurement (`src/README.md` line
    // 26), and naming one here would be a decision this file has no standing to
    // take.
    model: 'unset',
    prompt: 'unset',
    // The half that cannot write: it produces no text and calls no tool.
    tools: [],
  };
  const work = newId('ag');
  store.data.agents[work] = {
    id: work,
    bot_id: bot,
    role: 'work',
    home: join(home, 'work'),
    model: 'unset',
    prompt: 'unset',
    // `say` is the only way into a room (checklist line 14), so a work agent
    // without it could not answer at all.
    tools: ['say'],
  };

  const room = newId('oc');
  store.data.rooms[room] = {
    id: room,
    name: 'the first room',
    chat_mode: 'group',
    created_at: SEED_AT,
  };
  for (const [principal, role] of [
    [me, 'owner'],
    [other, 'member'],
    [bot, 'member'],
  ] as const) {
    const membership = newId('mb');
    store.data.memberships[membership] = {
      id: membership,
      room_id: room,
      principal_id: principal,
      joined_at: SEED_AT,
      role,
    };
  }

  return { me, other, bot, watch, work, room };
}

/**
 * The scene a store already holds, when it has one.
 *
 * Read back rather than remembered, so a second run continues the conversation
 * the first one started instead of seeding a second bot: the store is the
 * product's own thesis — the data stays local and outlives the process — and a
 * harness that grew a room per run would contradict it.
 *
 * The first room, the first bot in it, and its agents by role. Anything else is
 * a shape this milestones does not claim to read.
 */
export function sceneOf(store: SeekStore): MilestoneScene | undefined {
  const room = Object.values(store.data.rooms)[0];
  if (!room) return undefined;

  const membership = Object.values(store.data.memberships).find(
    (row) => row.room_id === room.id && store.data.bots[row.principal_id],
  );
  if (!membership) return undefined;
  const bot = membership.principal_id;

  // The owner, not merely the first person: a group room holds more than one,
  // and "whichever came first" would make the scene depend on insertion order.
  const human = Object.values(store.data.memberships).find(
    (row) =>
      row.room_id === room.id &&
      row.role === 'owner' &&
      store.data.principals[row.principal_id],
  );
  const agents = store.agentsOf(bot);
  const watch = agents.find((agent) => agent.role === 'watch');
  const work = agents.find((agent) => agent.role === 'work');
  if (!human || !watch || !work) return undefined;

  const others = Object.values(store.data.memberships).find(
    (row) =>
      row.room_id === room.id &&
      row.principal_id !== human.principal_id &&
      store.data.principals[row.principal_id],
  );

  return {
    me: human.principal_id,
    other: others?.principal_id ?? human.principal_id,
    bot,
    watch: watch.id,
    work: work.id,
    room: room.id,
  };
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
  const scene = sceneOf(store) ?? seedOneRoom(store);

  deliver(store, {
    roomId: scene.room,
    senderId: scene.me,
    text: options.said ?? SAID,
    now: options.now?.(),
  });
  await store.save();

  const kernel = new Kernel(store, {
    decide: options.decide ?? stubDecide,
    judge: options.judge ?? stubJudge,
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
  };
}

/**
 * What a person watching the run reads.
 *
 * It names the store, the room, the log, and — in as many words — that the
 * words above came from a stub. A placeholder printed without that sentence
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
    t('report.stub'),
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
  /** Flags this harness does not know, in the order they appeared. */
  unknown: string[];
  /** Whether `--lang` was given more than once. */
  repeatedLocale: boolean;
  /** Flags left without the value they need — `--lang` with nothing usable after it. */
  missingValue: string[];
  /** Positional arguments, which is where a store path goes. */
  paths: string[];
}

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
    repeatedLocale: false,
    missingValue: [],
    paths: [],
  };
  let sawLocale = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    let value: string | undefined;
    let isLocale = false;

    if (arg === '--lang') {
      const next = argv[index + 1];
      // A following flag is not this flag's value: `--lang --nope` asked for a
      // language and wrote nothing, which is a different mistake from a typo.
      if (next !== undefined && !next.startsWith('-')) {
        index += 1;
        value = next;
        isLocale = true;
      }
    } else if (arg.startsWith('--lang=')) {
      value = arg.slice('--lang='.length);
      isLocale = true;
    } else if (arg.startsWith('-')) {
      parsed.unknown.push(arg);
      continue;
    } else {
      parsed.paths.push(arg);
      continue;
    }

    if (!isLocale) {
      parsed.missingValue.push('--lang');
      continue;
    }
    if (value === undefined || value.length === 0) {
      parsed.missingValue.push('--lang');
      continue;
    }
    if (sawLocale) {
      parsed.repeatedLocale = true;
      continue;
    }
    sawLocale = true;
    parsed.locale = value;
  }

  return parsed;
}

/**
 * The command line: `npm start`, optionally `--lang <tag>` and a store path.
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
  if (parsed.repeatedLocale) throw new Error(t('cli.repeated-flag', { flag: '--lang' }));
  if (parsed.paths.length > 1) {
    throw new Error(t('cli.two-paths', { first: parsed.paths[0], second: parsed.paths[1] }));
  }

  const path = parsed.paths[0] ?? defaultStorePath();
  const store = await SeekStore.load(path);
  const run = await runFirstMilestone(store, options);
  const out = options.out ?? ((text: string) => process.stdout.write(text));
  out(format(run, path, catalogue));
  return run.spoke && run.failures.length === 0 ? 0 : 1;
}

// Only when run as a program: importing this file from a test must not start a
// kernel, and must not write to stdout.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
