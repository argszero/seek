/**
 * Stage 1: the watch side, as a runtime.
 *
 * `agent-lifecycle.md` §4 splits the tick in two. Stage 0 settles what the rules
 * settle for free (`gate.ts`); stage 1 asks the watch agent about the rest; stage
 * 2 runs the work agent, and only if the answer was `act`. This file is stage 1:
 * it builds the room's box, puts **one binary question** to a model, reads the
 * answer as a probability, compares it against the operating point it was given,
 * and writes the verdict — and the reason, when one came back — onto the entries
 * it judged.
 *
 * **No model is built, bundled or chosen here.** `WatchModel` is the seam and
 * `llama.ts` is the implementation over a local server; which model *ships* is
 * `src/README.md` line 25, answered by measurement, and nothing in this file reads
 * that answer. So this file stays the rules, and stays testable without a model.
 *
 * Five things the runtime is not allowed to decide for itself, each with the
 * document that keeps it out of here:
 *
 * - **The window** (§3, checklist line 23). The model's window is a measured
 *   number, so it arrives from the caller as a budget, together with what one
 *   entry costs against it.
 * - **The operating point** (checklist line 26): *"the operating point comes from
 *   a labelled set, never 0.5"*. A small model's usable cut sits between 0.6 and
 *   0.98, far from even, so a default in here would be a wrong answer wearing the
 *   shape of a considered one. `threshold` has no default and cannot be omitted.
 * - **The question, and the order it is asked in** (checklist line 27,
 *   `decisions.md` "the question put to the watch model is part of the contract").
 *   Rewording alone moved one model's discrimination from 0.09 to 0.77 and
 *   inverted it between Chinese and English, so the prompt is a versioned artifact
 *   read from a file (`prompts.ts`, `src/prompts/watch-v1.json`) — never a string
 *   composed at this call site — and **this file assembles it**, so where each part
 *   of the box sits is the artifact's decision rather than the model's. The
 *   operating point names the version it was measured against, because a cut
 *   measured on another question is not a cut for this one.
 * - **The option tokens** (§4 "one binary question", line 79). The model answers
 *   from the probabilities of two declared tokens, `act` and `ignore`; `keep` and
 *   `snooze` are the loop's to write and are never asked for, because a model that
 *   answers by reading token probabilities cannot emit an option it was not given.
 * - **Where in the vocabulary the answer is read** (§4 line 79, second sentence).
 *   An option is only answerable if it survives as **one** token past the prompt,
 *   and the id to mask is the one it takes *there* — not the id of the bare word.
 *   Both are measured off `prompt.text + option` with the model's own tokeniser
 *   (`bindOptions`), because masking the wrong form makes an option permanently
 *   unreachable and reads as a confident wrong answer; nothing here may assume the
 *   two ids are the same, and nothing here may pick a tokeniser, which is the
 *   model's.
 * - **Where the verdict lives** (`decisions.md` default 6): on the entry it judged,
 *   and nowhere else. Nothing here keeps a copy.
 *
 * **The resident context is this file's, and the tokens are still the model's.** §4
 * keeps the box's tokens warm per (bot, room): re-reading a full box at a 3B costs
 * about a millisecond a token, so a judgement pays only for what arrived since the
 * last one. What is kept here is the memory of what was handed over — the head's
 * identity, and the entries that head has read (`ResidentContext`) — and it is
 * handed over as fields, never as text (`WatchInput.resident`). **The box itself is
 * still rebuilt in full on every tick**, and stays a pure read of the record: what
 * is saved is what the *model* re-encodes, and only the model's own context can make
 * that true. A runtime that kept its own copy of an encoding would be keeping a
 * second version of a fact the model already holds, free to disagree with it.
 *
 * **What is written, and when.** `act` and `ignore` both go on the record. The box
 * reads the newest verdict back out of the entries (§3's last-verdict part: *"when
 * it was taken, what it was, and the reason if one came back"*), and a decision
 * that only the no-act branch recorded could never say how long ago it forwarded
 * something — which is the one piece of feedback the watch side gets.
 *
 * **A reason is the judgement's own sentence.** It is written when the model
 * returned one and is never invented, because a fabricated reason is worse than
 * none: it reads exactly like evidence. Nothing here puts it in front of the work
 * agent either — that boundary is `turn.ts`'s (`HandedEntry`), which strips both
 * fields on the way across.
 */

import { buildBox, type BoxOptions, type RoomBox } from './box.ts';
import type { Judge } from './inbox.ts';
import { assemblePrompt, loadPromptArtifact, skeletonOf, type PromptArtifact } from './prompts.ts';
import type { SeekStore } from './store.ts';
import type { Id, Observation, Verdict } from './types.ts';

/**
 * The text a judgement continues from, as one string.
 *
 * `version` is part of the value because the operating point is calibrated
 * *against* a prompt: `decisions.md` §"the question put to the watch model" makes
 * the two one contract. `text` is what was actually encoded — handed to the model
 * exactly as it stands, and **assembled by this runtime** from the versioned
 * artifact (`prompts.ts`) and the box, never left for the model to lay out. A
 * `WatchPrompt` is also what a mask is measured against: `bindOptions` reads its
 * option ids off the end of this text, so the end is the part of it that matters.
 */
export interface WatchPrompt {
  /** The artifact's identity. The operating point names this string. */
  version: string;
  /** The question and its framing, verbatim. */
  text: string;
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
 * The two declared option tokens of the binary question.
 *
 * §4 names the verdicts themselves as the options — *"`act` and `ignore` are the
 * whole of what it produces"* — so those two words are the default. A binding
 * with a different tokeniser may declare others; what it may not do is declare
 * one that splits into several tokens (line 79).
 */
export interface OptionTokens {
  act: string;
  ignore: string;
}

/**
 * What a tokeniser makes of a piece of text.
 *
 * One method, and one is all the mask needs: the ids a string becomes. It is a
 * seam rather than an import because the tokeniser belongs to the model, and which
 * model ships is `src/README.md` line 25 — a measurement, so this file may as
 * little choose a vocabulary as a window. The stub in the tests is the only
 * implementation in the tree, exactly as `WatchModel`'s is.
 */
export interface Tokeniser {
  /** The ids `text` becomes, in order. */
  encode(text: string): number[];
}

/** One declared option, bound to the id it takes where the answer is read. */
export interface BoundOption {
  /** The option as it was declared. */
  token: string;
  /**
   * The id this option occupies at the prompt's own end.
   *
   * **Not necessarily the id of the bare word.** A tokeniser that reads `act` after
   * a space gives it a different id than `act` on its own, and the mask is aimed at
   * the position the answer is actually read from (§4 line 79).
   */
  id: number;
}

/** The two options, each bound to the id it takes at the prompt's own end. */
export interface OptionBinding {
  act: BoundOption;
  ignore: BoundOption;
}

/**
 * What this judgement has already read, for one (bot, room).
 *
 * `agent-lifecycle.md` §4, last line: *"The box's tokens are kept warm … Each (bot,
 * room) therefore keeps a resident context and pays only for what arrived since its
 * last judgement."* This is that memory: two facts and no tokens, because the tokens
 * are the model's.
 *
 * **What the head is.** The front of the box, in the order a judgement reads it: the
 * prompt, the room's summary, then the entries named here — **oldest first**, so an
 * arrival can only ever be appended to it. Everything else the box carries (the
 * counts, the last verdict, who spoke, the caller's question set) is per-tick by
 * nature and is never resident: it is the tail this judgement is asked about.
 *
 * **What is not promised.** Whether a cache still holds that head is the model's to
 * know. A key that matches means this runtime has not invalidated the head, not that
 * a model must resume over it — a model that dropped its own context is free to
 * re-read, and one that resumes over a head it was never given is the failure this
 * field exists to make impossible.
 */
export interface ResidentContext {
  /**
   * The head's identity.
   *
   * Every ingredient of the front is in it (see `headKey`), so a change in any of
   * them is a different head rather than the same head quietly re-fingered.
   */
  key: string;
  /**
   * The entries of **this** box the model has already read, in the box's own order.
   *
   * In the box's order and not the head's, because it is a statement about this
   * box — *which of these lines are not new* — and the head's own order is the
   * reverse of it.
   */
  entries: Id[];
}

/** One question put to the model. Fields, never prose. */
export interface WatchInput {
  /**
   * The text this judgement continues from, already assembled.
   *
   * Assembled by the runtime from the artifact and this box: the model is not
   * asked where the summary, the messages and the question go, because an order
   * that lives in the model is an order no version pins and no measurement covers.
   */
  prompt: WatchPrompt;
  /**
   * The room's box (§3): standing summary, delta, last verdict, unread count —
   * and the pictures in the delta, named there, because a model that is handed
   * the entries and not their images is judging from text alone.
   */
  state: RoomBox;
  /**
   * How much of this box the model has already read under the same head.
   *
   * **Absent means cold**: a room's first judgement, or a head that changed — a
   * compaction that rewrote the summary, or a runtime wired to a different prompt or
   * option binding. Then the whole box is new, and a model that resumed anyway would
   * be answering over a front it was never given.
   */
  resident?: ResidentContext;
  /** The declared options the answer is read from. */
  options: OptionTokens;
  /**
   * The ids the mask has to allow, measured at the prompt's own end.
   *
   * Handed over rather than left to the model to work out: a binding re-derived per
   * call site is a binding free to disagree with the prompt it belongs to, and its
   * failure mode is an option nobody can reach.
   */
  mask: OptionBinding;
}

/**
 * A decision model's answer for one question.
 *
 * Both declared options have to come back as probabilities: an option missing
 * from the reading is the failure line 79 describes — a token masked at the wrong
 * id is permanently unreachable, and its absence is the only symptom there is.
 * Reading `act` alone would turn that defect into a confident decision.
 */
export interface WatchReading {
  /** Probability per declared option token, each a finite number in [0, 1]. */
  probabilities: Record<string, number>;
  /** What the judgement said, when it said anything. Absent is absent. */
  reason?: string;
}

/**
 * The injected model: one forward pass, no generated text, no tools.
 *
 * The real one reads token probabilities at the prompt's end; the stub in the
 * tests returns a `WatchReading` and remembers its input. Nothing else in the
 * kernel knows the difference.
 */
export interface WatchModel {
  read(input: WatchInput): Promise<WatchReading> | WatchReading;
}

export interface WatchOptions {
  /** How much the judgement can read, in `weigh` units. The caller's number. */
  window: number;
  /**
   * The versioned prompt artifact.
   *
   * **Absent means the shipped one** (`src/prompts/watch-v1.json`), which is what
   * "the prompt is a versioned file" has to mean for a default to exist at all.
   * A file, a version and a cut are one contract, so passing one here moves the
   * others with it — an artifact that declares no operating point needs a
   * threshold supplied, or there is none to apply.
   */
  prompt?: PromptArtifact;
  /**
   * The calibrated cut, and the prompt version it belongs to.
   *
   * **Absent means the artifact's own declaration**: `watch-v1` ships 0.600,
   * measured on 24 cases written after every prompt choice had been made
   * (`calibration/measured.json`). That is a default with a source rather than a
   * convenience — 0.5 is the value that looks reasonable and is measurably wrong,
   * and a number this file carried itself would be a second copy free to disagree
   * with the artifact it belongs to.
   */
  operatingPoint?: OperatingPoint;
  /** Overrides for the declared option tokens. Defaults to `act` / `ignore`. */
  optionTokens?: Partial<OptionTokens>;
  /**
   * The tokeniser the mask ids are measured with.
   *
   * **One of this and `mask` is required**, and neither has a default: a runtime
   * holding neither cannot say where its own answer is read, and the options it
   * cannot place may never be answerable at all. It refuses at construction for the
   * same reason the operating point does — the defect would otherwise show up as a
   * bot that always says no.
   *
   * Give this one when the tokeniser answers synchronously, which is what the suite's
   * stub does. Give `mask` instead when the ids have to be measured *before* the
   * runtime is built: a model behind HTTP cannot answer inside a synchronous bind,
   * so `llama.ts` measures first (`bindOverServer`) and hands the result over.
   */
  tokeniser?: Tokeniser;
  /**
   * The mask, already measured at the prompt's own end.
   *
   * The value `bindOptions` would have produced, measured by whoever could reach the
   * tokeniser — and checked here rather than trusted, because this is the one field
   * that reaches the model without passing through the function that normally
   * catches a mask that names no answer.
   */
  mask?: OptionBinding;
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
   * An unparseable answer counts as no act (§4), which means it leaves the same
   * verdict a confident "not about me" would — so the distinction is kept here,
   * where a caller can see the model has stopped answering, rather than by
   * inventing a fifth verdict the design does not have.
   */
  unparsed: number;
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
 * It is also where the resident context lives (§4): what this (bot, room) has
 * already read is the runtime's own memory rather than a row. A head is only warm
 * while the model that read it still holds it, so a persisted one would outlive the
 * cache that gave it meaning and tell the next process's first judgement to skip a
 * front it had never seen.
 */
export function watchAs(
  store: SeekStore,
  botId: Id,
  model: WatchModel,
  options: WatchOptions,
): Watch {
  const tokens = declaredOptions(options.optionTokens);
  // The artifact and the cut are one contract, so both are settled once, here: a
  // runtime whose prompt could change mid-life would be a runtime whose mask and
  // threshold belonged to a question it is no longer asking.
  const artifact = options.prompt ?? loadPromptArtifact();
  const point = resolveOperatingPoint(artifact, options.operatingPoint);
  // Measured once, and measured on the assembly's *end*: `skeletonOf` is the same
  // text with no summary and no entries, and it ends where every real assembly ends
  // (the artifact's last part is unconditional), so these are the ids the answer is
  // read at in every room and on every tick. Warmth is not this line's doing — that
  // is `resident` below, and it holds no ids of its own.
  const mask = maskFor(artifact, options, tokens);
  const front = frontOf(artifact);

  // The resident context, one per room (§4 "the box's tokens are kept warm"). One
  // `watchAs` is one bot, so the bot lives in the instance rather than in the key:
  // two bots are two instances and can share nothing, which is what keeps one bot's
  // warmth from being handed to another that never read it.
  const resident = new Map<Id, ResidentContext>();

  const watch = (async (entries: Observation[]): Promise<Observation[]> => {
    const outcome: WatchOutcome = {
      rooms: [],
      acting: [],
      ignored: 0,
      unparsed: 0,
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

    const acted = new Set<Id>();
    let wrote = false;

    for (const [roomId, group] of byRoom) {
      // The box is built from the record, so it already holds this batch: the
      // drain marked these entries rather than removing them, and a box that had
      // to be handed them back would be reading the room after the reason to look
      // was taken away.
      const boxOptions: BoxOptions = { window: options.window };
      if (options.weigh) boxOptions.weigh = options.weigh;
      const state = buildBox(store, botId, roomId, boxOptions);

      // What this judgement may assume was already read. The key names the front —
      // prompt, option binding, summary — and the entries are intersected with the
      // box, because an entry the window no longer holds is not something the model
      // is being given again.
      const head = headKey(botId, roomId, front, tokens, mask, state.summary);
      const previous = warmFrom(resident.get(roomId), head, state.delta);

      // What this judgement is asked, in the artifact's own order. The record keeps
      // a message's body on the message and an observation only names it, so the
      // bodies are read once per room — read, never copied onto the entry: a verdict
      // is the only thing stage 1 writes. Entries are rendered **oldest first**, so
      // an arrival can only ever be appended to the head (§4 "the box's tokens are
      // kept warm"), while `delta` itself is newest first because that is the order
      // the window filled it in.
      const bodies = new Map<Id, string>();
      for (const message of store.messagesOf(roomId)) bodies.set(message.id, message.text);
      const ask: WatchPrompt = {
        version: artifact.version,
        text: assemblePrompt(artifact, {
          ...(state.summary === undefined ? {} : { summary: state.summary }),
          texts: [...state.delta].reverse().map((entry) => textOf(entry, bodies)),
        }),
      };

      const input: WatchInput = {
        prompt: ask,
        state,
        options: tokens,
        mask,
      };
      if (previous) input.resident = previous;
      const reading = await model.read(input);

      // Read is read: everything in this box has just been handed over, so the next
      // judgement may claim it. Recorded after the model answered, because a call that
      // threw read nothing and a head rebuilt on a failed read would let the next
      // judgement skip a front it never saw.
      resident.set(roomId, { key: head, entries: state.delta.map((entry) => entry.id) });

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
 * The mask in force: measured here from a tokeniser, or measured elsewhere and
 * handed in.
 *
 * Exactly one route, because two would be two answers about where the answer is read
 * — a tokeniser that disagrees with the mask beside it is a runtime that cannot say
 * which id it is about to read, and the failure is silent in the worst way: the mask
 * goes to the model and an unreachable option reads as a confident "no".
 *
 * A supplied mask is checked, not trusted. The three refusals `bindOptions` makes are
 * about the mask rather than about the tokeniser, so they apply to this one too: an
 * id that is not a token id names no position, and one id for both options is one
 * answer wearing two names.
 */
function maskFor(
  artifact: PromptArtifact,
  options: WatchOptions,
  tokens: OptionTokens,
): OptionBinding {
  const supplied = options.mask;
  if (supplied !== undefined && options.tokeniser !== undefined) {
    throw new Error(
      'stage 1 was given both a tokeniser and a mask, and they are free to disagree ' +
        "about where this prompt's end is — hand over whichever one measured the ids, " +
        'not both',
    );
  }
  if (supplied !== undefined) return checkedMask(supplied);
  if (options.tokeniser !== undefined) {
    return bindOptions(options.tokeniser, skeletonOf(artifact), tokens);
  }
  throw new Error(
    'stage 1 needs a tokeniser or a mask measured from one: the ids are read off the ' +
      "prompt's own end, and without them a declared option may be unreachable for good " +
      '(src/README.md line 26)',
  );
}

/** A supplied mask, held to the same three refusals as a measured one. */
function checkedMask(mask: OptionBinding): OptionBinding {
  const ids = [mask.act?.id, mask.ignore?.id];
  for (const id of ids) {
    if (!Number.isInteger(id) || id < 0) {
      throw new Error(
        `a mask id must be a token id, got ${JSON.stringify(id)} — the answer is read by ` +
          'position, and an id that names no token names no answer',
      );
    }
  }
  if (ids[0] === ids[1]) {
    throw new Error(
      `the two options land on the same id (${ids[0]}), so ${JSON.stringify(mask.act?.token)} ` +
        `and ${JSON.stringify(mask.ignore?.token)} are one answer wearing two names`,
    );
  }
  return mask;
}

/**
 * The head's identity: every ingredient of the front of the box, and nothing else.
 *
 * The front is the prompt, the option binding and the room's summary (§4 "the box's
 * tokens are kept warm"), so a judgement may only be told "you have read this" while
 * all of them are unchanged. Each is here for a reason:
 *
 * - **The artifact** is version *and* content. The version is its identity, and the
 *   operating point is calibrated against it; the content is what the text is
 *   assembled from, and an artifact edited without moving its version would
 *   otherwise get a head it never read. What is **not** in the key is the assembled
 *   text: it carries this tick's messages, so a key built from it would move on
 *   every arrival and no head would ever stay warm.
 * - **The option tokens** change what the model is asked to continue from.
 * - **The mask ids** stand for the tokeniser: two vocabularies that bind the same ids
 *   read the same answer, and one that binds different ids is a different head even
 *   under the same prompt.
 * - **The summary** is the compaction's result, so a compaction is exactly the event
 *   that rewrites the front and must invalidate it (`agent-lifecycle.md` §3). A
 *   summary absent and a summary present are different heads, hence the `null`.
 *
 * Not here, deliberately: the counts, the last verdict, who spoke and the caller's
 * question set. They change with every tick, so a head that claimed them would be
 * invalidated by the next arrival — which is the cost the whole mechanism exists to
 * avoid. `decisions.md` default 11 is the row that says so.
 *
 * Serialised as a JSON array rather than joined with a separator: a summary is free
 * text, and a delimiter it can contain is a key two different heads can share.
 */
function headKey(
  botId: Id,
  roomId: Id,
  front: string,
  tokens: OptionTokens,
  mask: OptionBinding,
  summary: string | undefined,
): string {
  return JSON.stringify([
    botId,
    roomId,
    front,
    tokens.act,
    tokens.ignore,
    mask.act.id,
    mask.ignore.id,
    summary ?? null,
  ]);
}

/**
 * What of this box the head has already read, or `undefined` when it has read none
 * of it under this head.
 *
 * The intersection is the point. A compaction may have consumed entries the model
 * read, and the window may have pushed others out, so the previous list is filtered
 * against the box in hand rather than returned as it stands: an id this box does not
 * hold is not something the judgement can be asked to resume over. What survives is
 * still what was read, in the order it was read, because filtering preserves it.
 */
function warmFrom(
  previous: ResidentContext | undefined,
  key: string,
  delta: Observation[],
): ResidentContext | undefined {
  if (!previous || previous.key !== key) return undefined;
  const here = new Set(delta.map((entry) => entry.id));
  return { key, entries: previous.entries.filter((id) => here.has(id)) };
}

/** The two declared option tokens, checked for the shapes line 79 requires. */
function declaredOptions(override?: Partial<OptionTokens>): OptionTokens {
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
 * Bind the two declared options to the ids they take at the prompt's own end.
 *
 * `agent-lifecycle.md` §4, line 79: *"Option tokens must be single tokens, and
 * masked where they actually land. A word that the tokeniser splits cannot carry a
 * probability in one pass … And the id to mask is the one the option takes at the
 * prompt's own end (with its leading space, in its own case), not the id of the
 * bare word: masking the wrong form makes an option permanently unreachable and
 * reads as a confident wrong answer."*
 *
 * So the measurement is taken on `prompt.text + option` — the exact string the
 * model is asked to continue — and never on the option alone. Three things can go
 * wrong, each silent at the call site and each refused here instead:
 *
 * - the option **does not survive as one token** past the prompt;
 * - appending it **rewrites the prompt's own encoding**, so "the prompt's own end"
 *   names no fixed position and the id read there is not the option's. This is the
 *   real hazard rather than a theoretical one: a tokeniser that lets the last token
 *   of the prompt merge with the first of the option produces exactly this, and the
 *   prompt has to be the thing that changes — end it at a boundary that holds;
 * - both options **land on the same id**, which makes two answers one answer.
 *
 * The first case has a history: `snooze` had to be replaced because it split into
 * four pieces, and a fourth verdict cannot be asked of a model that answers by
 * reading probabilities.
 */
export function bindOptions(
  tokeniser: Tokeniser,
  prompt: WatchPrompt,
  options: OptionTokens,
): OptionBinding {
  if (!tokeniser || typeof tokeniser.encode !== 'function') {
    throw new Error(
      'stage 1 needs a tokeniser: the mask ids are read off the prompt\'s own end, and ' +
        'without them a declared option may be unreachable for good ' +
        '(src/README.md line 26)',
    );
  }
  // Encoded once for the pair: the prompt is the same text for both suffixes, and
  // re-encoding it per option is the first step towards re-encoding it per tick.
  const prefix = tokeniser.encode(prompt.text);
  const act = bindOne(tokeniser, prompt, prefix, options.act);
  const ignore = bindOne(tokeniser, prompt, prefix, options.ignore);
  if (act.id === ignore.id) {
    throw new Error(
      `the two options land on the same id (${act.id}) at this prompt's end, so ` +
        `${JSON.stringify(options.act)} and ${JSON.stringify(options.ignore)} are one ` +
        'answer wearing two names',
    );
  }
  return { act, ignore };
}

/** One option, measured where the model will read it. */
function bindOne(
  tokeniser: Tokeniser,
  prompt: WatchPrompt,
  prefix: number[],
  token: string,
): BoundOption {
  const whole = tokeniser.encode(prompt.text + token);
  // The prompt has to end where the option begins. Any earlier id differing means
  // the suffix changed the prefix, and then there is no position that is this
  // prompt's own end for this option.
  for (let index = 0; index < prefix.length; index += 1) {
    if (whole[index] !== prefix[index]) {
      throw new Error(
        `the tokeniser rewrites the prompt's own encoding once ${JSON.stringify(token)} ` +
          `is appended (position ${index} becomes ${whole[index]}, was ${prefix[index]}), ` +
          "so no id at the prompt's end belongs to this option — end the prompt at a " +
          'boundary that survives the suffix',
      );
    }
  }
  const tail = whole.slice(prefix.length);
  if (tail.length === 0) {
    throw new Error(
      `${JSON.stringify(token)} adds no token past this prompt, so there is no id to ` +
        'read an answer from',
    );
  }
  if (tail.length !== 1) {
    throw new Error(
      `${JSON.stringify(token)} takes ${tail.length} tokens at the prompt's end, and an ` +
        'option that splits cannot carry a probability in one pass ' +
        '(agent-lifecycle.md §4)',
    );
  }
  return { token, id: tail[0] };
}

/**
 * The operating point in force, checked against the question it claims to belong to.
 *
 * A cut outside (0, 1) is not a cut: at 0 every answer acts and at 1 none does,
 * and neither is a decision. A version mismatch is the one `decisions.md` warns
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
 * The artifact's identity, for the head key.
 *
 * Version *and* content, so an artifact edited without moving its version is still
 * a different head: the version is what the operating point names, and the content
 * is what the text is assembled from.
 */
function frontOf(artifact: PromptArtifact): string {
  return JSON.stringify(artifact);
}

/**
 * The line one box entry contributes to the assembled text.
 *
 * A message's body lives on the message, and an observation only names it —
 * `Observation.text` is the reminder's own words and nothing else — so a judgement
 * that reads one assembled string has to be given the body here. A reminder never
 * reaches this point (it has no room, so no box), but the fallback keeps that a
 * property of the loop rather than of this helper.
 */
function textOf(entry: Observation, bodies: Map<Id, string>): string {
  if (entry.text !== undefined) return entry.text;
  if (entry.message_id === undefined) return '';
  return bodies.get(entry.message_id) ?? '';
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

/** The loop's `Judge` type, named here so a mistake shows up at the seam. */
export type WatchJudge = Judge;
