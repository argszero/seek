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
 * **No model is built, bundled or chosen here.** `WatchModel` is the seam, and
 * the only implementation in the tree is the stub the tests inject: which model
 * ships is `src/README.md` line 25, answered by measurement. This file is what
 * that model will be plugged into, testable without one.
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
 * - **The question** (checklist line 27, `decisions.md` "the question put to the
 *   watch model is part of the contract"). Rewording alone moved one model's
 *   discrimination from 0.09 to 0.77 and inverted it between Chinese and English,
 *   so the prompt is a versioned artifact handed in whole — never a string
 *   composed at this call site — and the operating point names the version it was
 *   measured against, because a cut measured on another question is not a cut for
 *   this one.
 * - **The option tokens** (§4 "one binary question", line 79). The model answers
 *   from the probabilities of two declared tokens, `act` and `ignore`; `keep` and
 *   `snooze` are the loop's to write and are never asked for, because a model that
 *   answers by reading token probabilities cannot emit an option it was not given.
 * - **Where the verdict lives** (`decisions.md` default 6): on the entry it judged,
 *   and nowhere else. Nothing here keeps a copy.
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
import type { SeekStore } from './store.ts';
import type { Id, Observation, Verdict } from './types.ts';

/**
 * The prompt, as an artifact rather than a string.
 *
 * `version` is part of the value because the operating point is calibrated
 * *against* a prompt: `decisions.md` §"the question put to the watch model" makes
 * the two one contract. `text` is handed to the model exactly as it stands.
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

/** One question put to the model. Fields, never prose. */
export interface WatchInput {
  /** The versioned artifact. */
  prompt: WatchPrompt;
  /** The room's box (§3): standing summary, delta, last verdict, unread count. */
  state: RoomBox;
  /** The declared options the answer is read from. */
  options: OptionTokens;
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
  /** The versioned question artifact. */
  prompt: WatchPrompt;
  /** The calibrated cut, and the prompt version it belongs to. */
  operatingPoint: OperatingPoint;
  /** Overrides for the declared option tokens. Defaults to `act` / `ignore`. */
  optionTokens?: Partial<OptionTokens>;
  /** What one observation costs against `window`. Passed through to the box. */
  weigh?: (entry: Observation) => number;
  /** The caller's question set, passed through. `agents.yml` still has no shape. */
  questions?: unknown;
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
 */
export function watchAs(
  store: SeekStore,
  botId: Id,
  model: WatchModel,
  options: WatchOptions,
): Watch {
  const tokens = declaredOptions(options.optionTokens);
  checkOperatingPoint(options);

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
      // The box holds the entries in flight: they were drained out of the queue
      // before stage 0 saw them, and a box built from the queue alone would be
      // the room as it looks *after* the reason to look was taken away.
      const boxOptions: BoxOptions = { window: options.window, inFlight: group };
      if (options.weigh) boxOptions.weigh = options.weigh;
      if (options.questions !== undefined) boxOptions.questions = options.questions;
      const state = buildBox(store, botId, roomId, boxOptions);

      const reading = await model.read({ prompt: options.prompt, state, options: tokens });
      const probability = probabilityOf(reading, tokens);

      if (probability === undefined) outcome.unparsed += 1;
      // No answer that could be read is no act (§4). The cut is inclusive: a
      // probability exactly at the operating point acts.
      const acts = probability !== undefined && probability >= options.operatingPoint.threshold;
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
 * The operating point, checked against the question it claims to belong to.
 *
 * A cut outside (0, 1) is not a cut: at 0 every answer acts and at 1 none does,
 * and neither is a decision. A version mismatch is the one `decisions.md` warns
 * about — a well-meant prompt edit that silently moves the threshold — so it is
 * refused here instead of being discovered from the verdicts later.
 */
function checkOperatingPoint(options: WatchOptions): void {
  const threshold = options.operatingPoint?.threshold;
  if (typeof threshold !== 'number' || !Number.isFinite(threshold)) {
    throw new Error(`the operating point needs a numeric threshold, got ${String(threshold)}`);
  }
  if (threshold <= 0 || threshold >= 1) {
    throw new Error(
      `the operating point must lie strictly between 0 and 1, got ${threshold} — ` +
        'the cut comes from a labelled set (src/README.md line 26), never from an edge',
    );
  }
  const measured = options.operatingPoint.promptVersion;
  if (measured !== options.prompt.version) {
    throw new Error(
      `the operating point was calibrated against prompt ${JSON.stringify(measured)}, ` +
        `but the prompt handed in is ${JSON.stringify(options.prompt.version)} — ` +
        'a cut measured on another question is not a cut for this one',
    );
  }
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
