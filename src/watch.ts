/**
 * Stage 1: the rules, and the question they put to a model.
 *
 * **What this is, and what it is not.** `docs/host-rulings.md` (2026-10-28T11:36) settled
 * that the judgement is not an agent: it is one step of the loop, a question asked only
 * when a rule could not settle it, with three answers — call the work agent, call it to
 * compress, or do nothing. This file is that step. It builds the box the question is
 * about (`box.ts`), hands it to a model, and writes one verdict per entry judged.
 *
 * **The question has two answers, and they are the model's to pick from.** A judgement used
 * to be a sentence ending in "Answer act or ignore" with one token sampled after it, and the
 * reading was a search through the distribution for a spelling of `act`. That measured the
 * model's willingness to *start* with a word rather than its answer: `Act`, `Action` and
 * `act` arrived as three ids, `我` and `I` took a third of the mass, and a bot in a room of
 * four could not tell whether it was the one being addressed. What replaced it is a decision
 * model (`/v1/systemone`, `llama.ts`) handed a `state` and a question whose answers are
 * declared, answering with a calibrated probability per answer. Nothing is generated, so
 * there is no token to read and no spelling to match.
 *
 * **The state is assembled here and the question is the artifact's.** The text a judgement
 * reads is built from the versioned artifact (`src/prompts/watch-v3.json`) and the box: the
 * model is not asked where the summary, the room and the messages go, because an order that
 * lives in the model is an order no version pins and no measurement covers.
 *
 * **Who is being asked is in the state, and who else is in the room is too.** A judgement is
 * one bot's; the state names it, what it does here, and the other bots in the room. That last
 * line is load-bearing rather than decorative: without it, four bots read the same
 * `小荷，这个 bug 你来看一下` as addressed to each of them (act 0.64–0.73 for all four);
 * with it, the named bot reads 0.89 and the others read 0.21–0.36, and a room that names
 * nobody reads under 0.57 for everyone.
 *
 * **No model is built, bundled or chosen here.** `WatchModel` is the seam; `llama.ts` is the
 * one implementation that speaks to a server, and the model behind it is `src/README.md`
 * line 25's. This file decides the question, the cut and the verdict, and nothing about
 * where the answer comes from.
 *
 * **The verdict is the only thing it writes.** A judgement sets `entry.verdict` and, when
 * the model gave one, `entry.reason` — on the entries it judged and nowhere else, so the
 * record has one place a verdict lives rather than two free to disagree. It appends no
 * message and opens no turn: §4 keeps those for the half that can write.
 */

import {
  assemblePrompt,
  loadPromptArtifact,
  questionOf,
  systemOf,
  type PromptArtifact,
  type PromptLine,
  type PromptQuestion,
} from './prompts.ts';
import { buildBox, type BoxOptions } from './box.ts';
import type { SeekStore } from './store.ts';
import type { Id, Message, Observation, Verdict } from './types.ts';

/**
 * What a judgement is asked, in the two pieces the endpoint takes.
 *
 * `state` is the text the model reads — the bot, its job, the room, the other bots in it,
 * the memory, then the entries, oldest first — and `question` is the single question with
 * its two answers. Both are assembled by this runtime from the versioned artifact, never
 * laid out by the model.
 */
export interface WatchPrompt {
  /** The artifact's identity. The operating point names this string. */
  version: string;
  /** Everything the model is told before it is asked anything. */
  state: string;
  /** The question, and what each of the two answers means. */
  question: PromptQuestion;
}

/**
 * The cut a probability has to reach before the bot acts.
 *
 * It comes from a labelled set (checklist line 26) and has no default: a runtime
 * that could fall back to 0.5 would produce a plausible verdict from nothing.
 */
export interface OperatingPoint {
  /** Probability of the `act` token at or above which the bot acts. In (0, 1). */
  threshold: number;
  /** The prompt version this cut was measured against. */
  promptVersion: string;
  /** What it was measured on, so a reviewable number has a source. */
  measuredOn?: string;
}

/**
 * The two declared options of the binary question.
 *
 * §4 names the verdicts themselves as the options — *"`act` and `ignore` are the
 * whole of what it produces"* — so those two words are the default, and they are also
 * the keys of the artifact's `question.criteria` and of the probabilities the endpoint
 * answers with. Nothing else in the tree has to know a token id: the model is handed
 * the two names and picks one.
 */
export interface OptionTokens {
  act: string;
  ignore: string;
}

/**
 * One judgement's input: the question, and the options it may be answered with.
 *
 * **The box is not here.** It was, while the reading was a distribution over the text's
 * own end and a transport had to know where that end was and whether a picture sat in it.
 * A decision model is handed the assembled state as a whole, so what crosses this seam is
 * the text rather than the pieces it was built from.
 */
export interface WatchInput {
  /** The state and the question, already assembled. */
  prompt: WatchPrompt;
  /** The declared options the answer is read from. */
  options: OptionTokens;
}

export interface WatchReading {
  /** Probability per declared option token, each a finite number in [0, 1]. */
  probabilities: Record<string, number>;
  /** What the judgement said, when it said anything. Absent is absent. */
  reason?: string;
}

export interface WatchModel {
  read(input: WatchInput): Promise<WatchReading> | WatchReading;
}

export interface WatchOptions {
  /** How much the judgement can read, in `weigh` units. The caller's number. */
  window: number;
  /**
   * The versioned prompt artifact.
   *
   * **Absent means the shipped one** (`src/prompts/watch-v3.json`), which is what
   * "the prompt is a versioned file" has to mean for a default to exist at all.
   * A file, a version and a cut are one contract, so passing one here moves the
   * others with it — an artifact that declares no operating point needs a
   * threshold supplied, or there is none to apply.
   */
  prompt?: PromptArtifact;
  /**
   * The calibrated cut, and the prompt version it belongs to.
   *
   * **Absent means the artifact's own declaration**: `watch-v3` ships 0.600, measured
   * on the shape that artifact states. That is a default with a source rather than a
   * convenience — 0.5 is the value that looks reasonable and is measurably wrong (it
   * reads 20/24 where 0.600 reads 23/24), and a number this file carried itself would
   * be a second copy free to disagree with the artifact it belongs to.
   */
  operatingPoint?: OperatingPoint;
  /** Overrides for the declared option tokens. Defaults to `act` / `ignore`. */
  optionTokens?: Partial<OptionTokens>;
  /** What one observation costs against `window`. Passed through to the box. */
  weigh?: (entry: Observation) => number;
}

/** What one call did, for a caller or a test that wants to see it. */
export interface WatchOutcome {
  /** The rooms a question was put about, in the order they were asked. */
  rooms: Id[];
  /** Entries that act and go on to stage 2. */
  acting: Id[];
  /** Entries judged and settled as `ignore`. */
  ignored: number;
  /**
   * Answers that could not be read, counted apart from `ignored`.
   *
   * An unanswerable reading counts as no act (§4), which means it leaves the same
   * verdict a confident "not about me" would — so the distinction is kept here,
   * where a caller can see the model has stopped answering, rather than by
   * inventing a fifth verdict the design does not have.
   */
  unparsed: number;
  /**
   * Pictures the judgement was handed and could not read.
   *
   * The shipped model is text (`d1-2B`, `modalities.vision: false`) and the endpoint takes
   * a `state` string, so a picture's bytes have nowhere to go. This is counted rather than
   * dropped so that the fact is on the record — an earlier version refused the whole room
   * instead, which is the trade this field replaced (see the fill in `watchAs`).
   */
  unreadPictures: number;
  /**
   * Entries with no room, which a per-room judgement cannot ask about.
   *
   * A reminder has no room and is settled by stage 0 (a due reminder acts), so
   * one arriving here means a rule changed. It is left untouched and counted,
   * rather than judged against a room it is not in or dropped in silence.
   */
  roomless: Id[];
}

/** Stage 1 bound to one bot: a `Judge` that also reports what it did last. */
export interface Watch {
  (entries: Observation[]): Promise<Observation[]>;
  /** The most recent call's account of itself. */
  last?: WatchOutcome;
}

/**
 * Bind stage 1 to one bot and one store.
 *
 * The returned function is the loop's `Judge` (`inbox.ts`): it takes the entries
 * stage 0 could not settle and returns the ones that act. Everything it needs
 * that is a number — the window, the cut, the prompt — arrives as an argument,
 * because none of those are the runtime's to know.
 *
 * It refuses at construction, not on the first tick: a runtime wired to an
 * operating point measured against a different question would otherwise run
 * happily, spending verdicts on a threshold that means nothing.
 *
 * **What it remembers is nothing.** A judgement is one call over a whole box, so
 * there is no resident context to keep warm and no front to invalidate: an earlier
 * version of this file tracked what a model had already read so its KV cache could be
 * reused, which is an economy a per-call decision model does not have.
 */
export function watchAs(
  store: SeekStore,
  botId: Id,
  model: WatchModel,
  options: WatchOptions,
): Watch {
  const tokens = declaredOptions(options.optionTokens);
  // The artifact and the cut are one contract, so both are settled once, here: a
  // runtime whose prompt could change mid-life would be a runtime whose question and
  // threshold belonged to something it is no longer asking.
  const artifact = options.prompt ?? loadPromptArtifact();
  const point = resolveOperatingPoint(artifact, options.operatingPoint);
  // **Who is being asked.** One `watchAs` is one bot, and the state names that bot rather
  // than describing some other one: without this every bot in an organization was handed
  // the same text and answered the same way, so a room of four either woke all four or
  // none. The name is the one a person gave the bot, and a bot with none is asked under
  // its id, which is what every other reading in the store calls it (`snapshot.js`).
  const who = store.principal(botId);
  const given = who !== undefined && 'name' in who ? who.name : undefined;
  const botName = typeof given === 'string' && given !== '' ? given : botId;
  const declared = who !== undefined && 'position' in who ? who.position : undefined;
  const position = typeof declared === 'string' && declared !== '' ? declared : undefined;
  const question = questionOf(artifact, tokens);

  const watch = (async (entries: Observation[]): Promise<Observation[]> => {
    const outcome: WatchOutcome = {
      rooms: [],
      acting: [],
      ignored: 0,
      unparsed: 0,
      unreadPictures: 0,
      roomless: [],
    };

    // A judgement is about a room, so the batch is split by the room it belongs
    // to; one tick can hold several. An entry with no room has no box to be
    // judged against and is left alone (see `WatchOutcome.roomless`).
    const byRoom = new Map<Id, Observation[]>();
    for (const entry of entries) {
      if (!entry.room_id) {
        outcome.roomless.push(entry.id);
        continue;
      }
      const group = byRoom.get(entry.room_id);
      if (group) group.push(entry);
      else byRoom.set(entry.room_id, [entry]);
    }

    // **One box, built once, because the box is the bot's.** Building it inside the
    // loop below would build one per room this tick touched, and each of those would
    // be a box the bot does not have — the shape `box.ts`, `agent-lifecycle.md` §3 and
    // `docs/host-rulings.md` ("The box is the bot's and not a room's") all refuse. What
    // changes per room is the question, never what the bot has read.
    //
    // It is built from the record, so it already holds this batch: the drain marked
    // these entries rather than removing them, and a box that had to be handed them
    // back would be reading the room after the reason to look was taken away.
    const boxOptions: BoxOptions = { window: options.window };
    if (options.weigh) boxOptions.weigh = options.weigh;
    const box = buildBox(store, botId, boxOptions);

    // Every message the box's lines point at, whichever room it is in: one box holds
    // several rooms now, so the bodies are read once per room the box's delta names.
    if (box.media.length > 0) outcome.unreadPictures += box.media.length;
    const messages = new Map<Id, Message>();
    for (const boxRoom of box.rooms) {
      for (const message of store.messagesOf(boxRoom)) messages.set(message.id, message);
    }

    const acted = new Set<Id>();
    let wrote = false;

    for (const [roomId, group] of byRoom) {

      // **A picture this seam cannot read is counted, and the room is still judged.** The
      // model this app ships is text (`d1-2B`: `modalities.vision: false`) and
      // `/v1/systemone` takes a `state` string, so a picture's bytes have nowhere to go —
      // that much has not changed. What changed is what is done about it.
      //
      // This used to throw, and the cost was not one judgement. The box was built per room
      // then, so a picture anywhere in the window stopped this bot judging **that room** for
      // as long as the picture stayed inside it — every later text message included — and the
      // window said nothing at all, because a background wake's failure goes to the log and
      // nowhere else. Measured on a room holding one picture: the picture was refused, and
      // so was the plain text message posted after it. A room that goes silently mute for a
      // reason nobody is told is the failure this whole slice exists to stop, and it is
      // worse than the thing the refusal was protecting against.
      //
      // What that refusal was protecting is answered rather than dropped. The state the
      // model reads never held the picture, so nothing in it says one was there, and the
      // verdict is one of two words — the judgement cannot claim to have seen an image it
      // was never given. The gap that remains is that it cannot know a picture arrived at
      // all, and it is stated here rather than hidden: that is the price of a text model,
      // not of this file. Reopening the picture route needs a model with a projector
      // (`llama.ts`, `modalities.vision`), not a longer prompt.

      // What this judgement is asked. The record keeps a message's body on the message and
      // an observation only names it, so the bodies are read once for the whole box — read,
      // never copied onto the entry: a verdict is the only thing stage 1 writes. Entries
      // are rendered **oldest first**, so the newest arrival is the last thing read.
      // The room's name, when it has one: `rooms.ts` treats an empty name as no name,
      // and the artifact skips its room part rather than printing a blank after a colon.
      const declaredRoom = store.room(roomId)?.name;
      const roomName =
        typeof declaredRoom === 'string' && declaredRoom !== '' ? declaredRoom : undefined;
      // The other bots in the room, by name. This is the line that makes "is this for me"
      // answerable (`watch-v3.json`): the artifact skips it when the bot is alone, and a
      // bot not in the room at all gets the same absence rather than an empty list.
      const otherNames = store
        .botsIn(roomId)
        .filter((bot) => bot.id !== botId)
        .map((bot) => (bot.name === '' ? bot.id : bot.name));
      const others = otherNames.length > 0 ? otherNames.join(', ') : undefined;

      // **Four facts the box computes and this artifact does not render**, said here rather
      // than left to be discovered: `read` / `total` / `unread`, `lastVerdict` with its
      // staleness, `whoSpoke`, and the media list. `box.ts` keeps them because they are
      // facts about the record; `watch-v3` renders none of them, because the shape that was
      // measured is *who is being asked* plus *the messages* — the four-bot matrix and set4
      // were both taken on exactly that, and adding a line is adding text no measurement
      // covers. The cost is stated rather than hidden: a judgement that could not fit the
      // whole delta no longer says so, and an earlier verdict is not visible to it.
      const ask: WatchPrompt = {        version: artifact.version,
        state: assemblePrompt(artifact, {
          bot: botName,
          ...(position === undefined ? {} : { position }),
          ...(others === undefined ? {} : { others }),
          ...(box.summary === undefined ? {} : { summary: box.summary }),
          ...(roomName === undefined ? {} : { room: roomName }),
          lines: [...box.delta]
            .reverse()
            .map((entry) => lineOf(entry, messages, store, botName)),
        }),
        question,
      };

      const reading = await model.read({ prompt: ask, options: tokens });
      const probability = probabilityOf(reading, tokens);

      if (probability === undefined) outcome.unparsed += 1;
      // No answer that could be read is no act (§4). The cut is inclusive: a
      // probability exactly at the operating point acts.
      const acts = probability !== undefined && probability >= point.threshold;
      const verdict: Verdict = acts ? 'act' : 'ignore';
      const reason = reasonOf(reading);

      outcome.rooms.push(roomId);
      for (const entry of group) {
        entry.verdict = verdict;
        // Written when one came back, absent when none did: an entry that kept a
        // reason it never got would make the record claim the judgement said
        // something it did not.
        if (reason !== undefined) entry.reason = reason;
        wrote = true;
      }
      if (acts) {
        for (const entry of group) acted.add(entry.id);
      } else {
        outcome.ignored += group.length;
      }
    }

    if (wrote) await store.save();

    // Arrival order, not room order: the turn is opened with these.
    const acting = entries.filter((entry) => acted.has(entry.id));
    outcome.acting = acting.map((entry) => entry.id);
    watch.last = outcome;
    return acting;
  }) as Watch;

  return watch;
}

/**
 * The two declared option tokens, checked for the shapes line 79 requires.
 *
 * Exported because the question's two criteria are keyed by these tokens
 * (`questionOf` in `prompts.ts`), so the file and the runtime have to agree on them
 * through one function rather than two copies of the rules.
 */
export function declaredOptions(override?: Partial<OptionTokens>): OptionTokens {
  const tokens: OptionTokens = { act: 'act', ignore: 'ignore', ...override };
  for (const token of [tokens.act, tokens.ignore]) {
    if (typeof token !== 'string' || token.trim().length === 0) {
      throw new Error(`an option token must be a non-empty string, got ${JSON.stringify(token)}`);
    }
  }
  if (tokens.act === tokens.ignore) {
    throw new Error(
      `the two options must be different tokens, both are ${JSON.stringify(tokens.act)}`,
    );
  }
  return tokens;
}

/**
 * The operating point in force, checked against the question it claims to belong to.
 *
 * A cut outside (0, 1) is not a cut: at 0 every answer acts and at 1 none does,
 * and neither is a decision. A version mismatch is the one the design warns
 * about — a well-meant prompt edit that silently moves the threshold — so it is
 * refused here instead of being discovered from the verdicts later.
 *
 * **Absent means the artifact's own declaration**, which is the only shape "the
 * shipped default is 0.600" can take without a second copy of the number in code.
 * An artifact that declares none and a caller that supplies none is a runtime with
 * no cut at all, and that is refused rather than guessed: 0.5 always fits, which is
 * exactly why it cannot be the fallback.
 */
function resolveOperatingPoint(
  artifact: PromptArtifact,
  supplied: OperatingPoint | undefined,
): OperatingPoint {
  const declared = artifact.operatingPoint;
  if (supplied === undefined && declared === undefined) {
    throw new Error(
      `prompt ${JSON.stringify(artifact.version)} declares no operating point and none was ` +
        'supplied, so there is no cut to apply — the cut comes from a labelled set ' +
        '(src/README.md line 26), never from a guess',
    );
  }
  const point: OperatingPoint =
    supplied ??
    ({
      threshold: declared?.threshold,
      promptVersion: artifact.version,
      ...(declared?.measuredOn === undefined ? {} : { measuredOn: declared.measuredOn }),
    } as OperatingPoint);

  const threshold = point.threshold;
  if (typeof threshold !== 'number' || !Number.isFinite(threshold)) {
    throw new Error(`the operating point needs a numeric threshold, got ${String(threshold)}`);
  }
  if (threshold <= 0 || threshold >= 1) {
    throw new Error(
      `the operating point must lie strictly between 0 and 1, got ${threshold} — ` +
        'the cut comes from a labelled set (src/README.md line 26), never from an edge',
    );
  }
  const measured = point.promptVersion;
  if (measured !== artifact.version) {
    throw new Error(
      `the operating point was calibrated against prompt ${JSON.stringify(measured)}, ` +
        `but the prompt handed in is ${JSON.stringify(artifact.version)} — ` +
        'a cut measured on another question is not a cut for this one',
    );
  }
  return point;
}

/**
 * The line one box entry contributes to the assembled text: what was said, by whom,
 * and when.
 *
 * A message's body lives on the message, and an observation only names it —
 * `Observation.text` is the reminder's own words and nothing else — so a judgement
 * that reads one assembled string has to be given the body here. **The sender is the
 * record's**, resolved off `Message.sender_id`, and never a guess from the words: the
 * defect this closed was a bot reading `小荷，这个 bug 你来看一下` with nothing on the
 * line saying who spoke, so every bot in the room had to decide from the sentence
 * alone whether it was the one being addressed, and all four decided it was not.
 *
 * A reminder's sender is the bot itself: `agent-lifecycle.md` §12 has a reminder
 * written by the bot for its own future, so the name on it is the bot's. A reminder
 * never reaches this point (it has no room, so no box), but the fallback keeps that
 * a property of the loop rather than of this helper.
 */
function lineOf(
  entry: Observation,
  messages: Map<Id, Message>,
  store: SeekStore,
  botName: string,
): PromptLine {
  // **Which room the line came from, because one box now holds several.** The design
  // asks for exactly this — an observation carries *"its room, who spoke, when and what
  // was said, which is what lets one box hold several rooms without confusing them"*
  // (`agent-lifecycle.md` §3) — and a reminder, which is in no room, says nothing rather
  // than naming one it is not in.
  const room = roomLabelOf(store, entry.room_id);
  if (entry.text !== undefined) {
    return { text: entry.text, sender: botName, at: entry.delivered_at };
  }
  const message = entry.message_id === undefined ? undefined : messages.get(entry.message_id);
  if (message === undefined) {
    // A body the room no longer holds: the erased message, or one the record named
    // and never had. The line keeps its time and says whose it was as far as the
    // record can, which is the same refusal to invent that `reason` gets.
    return { text: '', sender: botName, at: entry.delivered_at };
  }
  const line: PromptLine = {
    text: message.text,
    sender: nameOf(store, message.sender_id),
    at: entry.delivered_at,
  };
  // Set only when there is a room to name: `fill` leaves an unknown placeholder whole, so
  // an absent fact has to reach the artifact as `''` rather than as `{room}`.
  if (room !== undefined) line.room = room;
  return line;
}

/** The room's name, or its id when nobody named it; absent for a reminder. */
function roomLabelOf(store: SeekStore, roomId: Id | undefined): string | undefined {
  if (roomId === undefined) return undefined;
  const declared = store.room(roomId)?.name;
  return typeof declared === 'string' && declared !== '' ? declared : roomId;
}

/** A principal's name, or its id when the name is missing or empty. */
function nameOf(store: SeekStore, id: Id): string {
  const who = store.principal(id);
  if (who === undefined) return id;
  const given = 'name' in who ? who.name : undefined;
  return typeof given === 'string' && given !== '' ? given : id;
}

/**
 * The probability of the `act` token, or `undefined` when the answer cannot be
 * read.
 *
 * Unreadable is: no reading, no probabilities, either declared option missing, or
 * a number that is not a finite probability in [0, 1]. All of them are "no act",
 * because §4 says unparseable counts as no act — and a model whose answer cannot
 * be read must never look like a model that answered.
 */
function probabilityOf(reading: WatchReading | undefined, tokens: OptionTokens): number | undefined {
  const probabilities = reading?.probabilities;
  if (!probabilities || typeof probabilities !== 'object') return undefined;
  const act = read(probabilities, tokens.act);
  const ignore = read(probabilities, tokens.ignore);
  if (act === undefined || ignore === undefined) return undefined;
  return act;
}

function read(probabilities: Record<string, unknown>, token: string): number | undefined {
  const value = probabilities[token];
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (value < 0 || value > 1) return undefined;
  return value;
}

/** The judgement's own sentence, when it gave one that is a sentence. */
function reasonOf(reading: WatchReading | undefined): string | undefined {
  const reason = reading?.reason;
  return typeof reason === 'string' ? reason : undefined;
}
