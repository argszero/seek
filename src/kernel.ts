/**
 * The kernel assembled: one store, one inbox loop per bot, one comparator.
 *
 * Every piece of this already exists and none of it had a caller. A store
 * (`store.ts`), delivery into one inbox per bot (`delivery.ts`), the loop that
 * consults stage 0 and opens a turn (`inbox.ts`), the turn itself (`turn.ts`)
 * and the schedule's comparator (`comparator.ts`) are all written and tested —
 * but nothing in this repository ever *constructed* them together, so a row
 * that came due had nothing to fire it and a bot had nothing to wake it. This
 * file is that missing caller and nothing more: it adds no rule of its own.
 *
 * What it composes, and where each part is stated:
 *
 * - **One comparator, for the whole process.** §12: "It is one table in the
 *   process plus one comparator" — so this class holds exactly one, and builds
 *   it once. Two would be two timers over one table.
 *
 * - **One loop per bot, and the loop's `run` is why.** `makeTurn(store, botId,
 *   decide)` closes over the bot it was built for, and `InboxLoop.tick(botId)`
 *   only decides whose queue to drain. One loop shared by two bots would tick
 *   the second bot with the first bot's work agent, so the loop is keyed by
 *   bot here and created on first use: a loop per bot, exactly.
 *
 * - **A wake is serialized per bot.** `agent-lifecycle.md` §4: "**One turn per
 *   bot, by a lock.** A second message never starts a second turn; it queues",
 *   and "nothing is ever dropped silently — the turn ends, the loop reads the
 *   inbox again, and if anything is left that the gate would act on, the next
 *   turn starts at once". This is the first place in the kernel where two wake
 *   sources can reach one bot at the same time (a person's message and a due
 *   row), so it is the first place that lock has to exist: a wake arriving
 *   mid-turn waits for the turn and then drains again, which is both halves of
 *   that rule at once — one turn at a time, and nothing left behind.
 *
 * - **A due row wakes its bot the way a person's message does.** The comparator
 *   delivers and stops (§12: "its only output is a delivery"); the kernel is
 *   what turns that delivery into a wake, through the same `tick()` a message
 *   uses. There is one wake path in this file and both producers reach it.
 *
 * - **The comparator does not wait for the turn.** §5 makes it a background
 *   cost — "it reads the clock, compares it with the next due row and sleeps
 *   otherwise" — so a turn that took minutes, or never returned, must not be
 *   what keeps the next reminder from being armed. Delivery starts the wake and
 *   the sweep finishes; `whenIdle()` is how a caller waits for what is in
 *   flight.
 *
 * - **A failed turn is recorded, not swallowed and not fatal.** A turn that
 *   throws is already audited by `runTurn`; here it is kept on `failures` (and
 *   handed to `onError` when one was injected) instead of escaping. An
 *   exception escaping into the timer callback would take the process down on
 *   the first model failure, and one bot's bad turn is not the others'.
 *
 * **What is deliberately not here.** Nothing sweeps the inboxes at start: §12
 * (c) makes a *schedule* row that came due while the process was closed fire on
 * the next start, and there is no matching rule for a person's message — a
 * delivery is something that happens while the kernel is running. Inventing a
 * startup sweep would be writing behaviour the documents do not state.
 */

import { Compactor, type CompactLines, type Summarise } from './compact.ts';
import { ScheduleComparator, wallTimers, type Timers } from './comparator.ts';
import { InboxLoop, type Judge, type TickResult } from './inbox.ts';
import { applyRoster, readRosterFor } from './roster.ts';
import { SeekStore } from './store.ts';
import { makeTurn, type Decide } from './turn.ts';
import type { Id, Message, Observation } from './types.ts';

/**
 * What a bot was waiting for when its wait began.
 *
 * The one thing a delay needs to know: whether the words that just arrived were
 * addressed to this bot. Somebody who hears their own name looks up; somebody
 * listening to a room full of people finishes what they were doing first.
 */
export interface WakeArrival {
  /** Named, replied to, or alone in the room with the sender. */
  addressed: boolean;
}

/** A turn that opened nothing, for a wait that ended without one. */
function nothingDrained(): TickResult {
  return { woke: false, entries: [], drained: [], settled: undefined };
}

export interface KernelOptions {
  /**
   * What the work agent does with a turn.
   *
   * Left out, a turn says nothing — `turn.ts`'s own default, kept as the
   * default here so that "no model is called yet" stays one fact in one place.
   * **This one fact then means silence, and silence is the answer**: a bot with no model
   * behind it writes nothing into a room rather than a line standing in for one
   * (`docs/host-rulings.md`, "A bot whose model is not ready says nothing").
   *
   * One function serves every bot, like `judge` below: a turn names its bot in the
   * context, so a caller whose bots are bound to different servers dispatches on
   * `context.botId` rather than handing the kernel a table.
   */
  decide?: Decide;
  /**
   * Stage 1. Left out, the loop's own "act on nothing" placeholder.
   *
   * **One judge serves every bot**, because it is told which bot each tick is for: the
   * box a judgement reads belongs to that bot (§3), and the store's bots are not a fact
   * about the model server. This layer used to bind one bot and refuse a store holding
   * two, which refused the store the host's own machine carries.
   */
  judge?: Judge;
  /**
   * The room summary's writer — the half that can write (`compact.ts`).
   *
   * Left out, nothing can write a summary and no compaction ever runs. That is
   * the honest state: a summary is a chat model's text, and there is no model
   * here yet.
   */
  summarise?: Summarise;
  /**
   * When a delta has outgrown itself: a count, an age, or both.
   *
   * §3 gives the shape and leaves the numbers to
   * measurement, so they are the caller's — with none configured, nothing is
   * ever due.
   */
  compactLines?: CompactLines;
  /** An injectable clock, so a test does not depend on wall time. */
  now?: () => string;
  /** Injectable timers, for the same reason. They reach the comparator and the waits. */
  timers?: Timers;
  /**
   * How long a bot waits before it reads what just arrived, in milliseconds.
   *
   * **This is the room's tempo, and it belongs to the caller, not to this file.** A
   * delivery is a fact and a turn is what the bot does about it; how long the bot takes
   * to look is the difference between a room of people and four mouths answering on the
   * same tick. With no function given there is no wait at all — a kernel that has not
   * been told how people behave does not invent a pause, and every test that is about
   * what a turn *does* gets it without waiting for a timer.
   *
   * A wake already waiting is not restarted and not doubled: what arrives during a wait
   * is read by the tick that wait ends in, because a tick drains whatever is in the box.
   */
  wakeDelay?: (arrived: WakeArrival) => number;
  /**
   * Where a wake that threw is reported. The record on `failures` is written
   * either way: this is what a caller does about it.
   */
  onError?: (error: unknown, botId: Id) => void;
}

/** A turn that threw, kept so that nothing disappears without a trace. */
export interface KernelFailure {
  botId: Id;
  error: unknown;
}

export class Kernel {
  store: SeekStore;
  /** The one comparator: one table, one clock reading, one armed timer (§12). */
  comparator: ScheduleComparator;
  /** Turns that threw on the wake path, oldest first. */
  failures: KernelFailure[] = [];
  /** Compaction: a runtime action, never a turn (§3). */
  compactor: Compactor;

  #decide: Decide | undefined;
  #judge: Judge | undefined;
  #onError: KernelOptions['onError'];
  #wakeDelay: KernelOptions['wakeDelay'];
  #timers: Timers;
  #loops = new Map<Id, InboxLoop>();
  #busy = new Map<Id, Promise<void>>();
  /**
   * The bots that are waiting to read what arrived, one wait each.
   *
   * Kept apart from `#busy` because they are the opposite state: a bot in `#busy` is
   * working, and a bot here has not started. What they share is that both are "in
   * flight" as far as `whenIdle()` is concerned, and that `stop()` ends both — nothing
   * outlives the kernel.
   */
  #waits = new Map<Id, { handle: unknown; promise: Promise<TickResult>; settle: (result: TickResult) => void }>();
  /**
   * Compactions in flight, kept apart from `#busy` on purpose.
   *
   * In `#busy` they would serialize behind the next wake, and a judgement would
   * wait for a summary — which §3 forbids. `whenIdle()` still waits for them, so
   * "what is this process doing" has one answer.
   */
  #compacting = new Set<Promise<void>>();

  constructor(store: SeekStore, options: KernelOptions = {}) {
    this.store = store;
    this.#decide = options.decide;
    this.#judge = options.judge;
    this.#onError = options.onError;
    this.#wakeDelay = options.wakeDelay;
    this.#timers = options.timers ?? wallTimers;

    this.compactor = new Compactor(store, {
      summarise: options.summarise,
      lines: options.compactLines,
      now: options.now ?? (() => new Date().toISOString()),
    });

    this.comparator = new ScheduleComparator(store, {
      now: options.now ?? (() => new Date().toISOString()),
      timers: options.timers,
      // The comparator's one output: a delivery. Turning it into a wake is this
      // class's job, which is why the two producers have one path between them.
      onDelivered: (botIds) => this.#deliver(botIds),
    });
  }

  /**
   * Open the kernel over a store on disk.
   *
   * A path with no file yet is not an error: `SeekStore.load` starts empty and
   * remembers where to write, so a first run needs no fixture.
   *
   * The roster is read here, from `agents.yml` beside the store, and the store's
   * agents are rebuilt from it before anything can wake a bot — the file is the
   * roster and the shard is derived from it.
   * A store with no roster file beside it keeps whatever agents it already has:
   * a missing file says nothing, while a file with no rows says the bot has no
   * agents. A store over an empty directory therefore starts, arms nothing and
   * does nothing, which is the honest state of a kernel nobody has given a bot.
   */
  static async open(path: string, options: KernelOptions = {}): Promise<Kernel> {
    const store = await SeekStore.load(path);
    const rows = await readRosterFor(store);
    if (rows !== undefined) applyRoster(store, rows);
    return new Kernel(store, options);
  }

  /** Whether the comparator is sweeping. */
  get running(): boolean {
    return this.comparator.running;
  }

  /**
   * The one loop for this bot, created the first time it is asked for.
   *
   * Keyed by bot because `run` is bound to one bot: `makeTurn` resolves *this*
   * bot's `work` agent, and handing one loop's `run` another bot's entries would
   * run them on the wrong agent. The judge is not bound that way: it is handed the
   * bot with the entries, so the one judge reaches every loop unchanged.
   *
   * A row written during a turn re-arms the comparator from here, through
   * `scheduleAs`'s `onWritten`: a reminder written for sooner than the instant
   * the timer is sleeping toward would otherwise wait for that further one.
   */
  loopFor(botId: Id): InboxLoop {
    const open = this.#loops.get(botId);
    if (open) return open;

    const loop = new InboxLoop(
      this.store,
      makeTurn(this.store, botId, this.#decide, () => this.comparator.refresh(), (message) =>
        this.#said(message),
      ),
      this.#judge,
    );
    this.#loops.set(botId, loop);
    return loop;
  }

  /**
   * Wake one bot: the single wake path, whoever asked for it.
   *
   * Serialized per bot, so one turn runs at a time and a wake that arrives
   * mid-turn waits rather than being dropped — when it runs, it drains whatever
   * is in the inbox by then, which is the "read the inbox again" half of the
   * lock rule.
   *
   * The error reaches the caller here; the comparator's own path records it
   * instead (`#deliver`), because a sweep must not be failed by a bot.
   */
  async tick(botId: Id): Promise<TickResult> {
    const previous = this.#busy.get(botId) ?? Promise.resolve();
    const next = previous.then(() => this.loopFor(botId).tick(botId));

    // The chain's own link never rejects: a turn that threw has already been
    // reported to its own caller, and the wake behind it still has to run.
    const link = next.then(
      () => undefined,
      () => undefined,
    );
    this.#busy.set(botId, link);
    void link.then(() => {
      if (this.#busy.get(botId) === link) this.#busy.delete(botId);
    });

    const result = await next;
    // Compaction is a runtime action (§3), so it starts here — once the tick has
    // settled, and awaited by nobody. It is reachable on a tick that opened no
    // turn, which is the point: a busy room that never needs a word said still
    // has to be compactable.
    this.#compactAfter(botId, result.drained);
    return result;
  }

  /**
   * Something new arrived for this bot: it reads it after the room's tempo, and then
   * this is the ordinary `tick()`.
   *
   * **This is the wake a message uses, and `tick()` is the drain it ends in.** The
   * difference between them is the one thing a room needs and a lock cannot give: a
   * person who has just been spoken to does not answer on the same instant as everybody
   * else in the room, and four bots that do are not four people. So the wait is here,
   * once, on the one path — a wait per bot, not one per message, because what arrives
   * during a wait is read by the tick that wait ends in.
   *
   * No delay configured means no wait: this answers `tick()` directly, so every test
   * about what a turn does sees the turn and never a timer.
   */
  wake(botId: Id): Promise<TickResult> {
    const delay = Math.max(0, this.#wakeDelay?.({ addressed: this.#addressed(botId) }) ?? 0);
    if (delay === 0) return this.tick(botId);

    const waiting = this.#waits.get(botId);
    if (waiting) return waiting.promise;

    let handle: unknown;
    let settle!: (result: TickResult) => void;
    const promise = new Promise<TickResult>((resolve, reject) => {
      settle = resolve;
      handle = this.#timers.set(delay, () => {
        this.#waits.delete(botId);
        this.tick(botId).then(resolve, reject);
      });
    });
    this.#waits.set(botId, { handle, promise, settle });
    return promise;
  }

  /** Whether what is waiting for this bot was addressed to it. */
  #addressed(botId: Id): boolean {
    return this.store
      .pending(botId)
      .some((entry) => entry.hints.mentionsMe || entry.hints.repliesToMe || entry.hints.direct);
  }

  /**
   * A bot has spoken: the bots it named are woken, and nobody else is.
   *
   * **The name is read off the entry, not scanned for in the text.** `deliver()` wrote one
   * entry per recipient and put the verdict's own hints on each, so this asks the same
   * question stage 0 will ask rather than looking for an `@` that means nothing there.
   *
   * **Only a naming, and not a reply or a direct message — measured, not assumed.** The
   * three of them all make an entry *addressed*, and `gate.ts` row 2 still fast-passes it;
   * what they cannot be is what starts the wake. Every message a turn produces is a reply
   * to the one that woke it (`replyOf`), so with the reply edge waking, two bots answer
   * each other forever: a room of four produced twelve consecutive messages that named
   * nobody, alternating between the same two bots, agreeing the same three things six
   * times, and it could not end — a closing sentence is a reply too, and it woke the person
   * it was closing with. Two bots alone in a room are the same trap by a different edge,
   * which is why `direct` is not a wake either. **A room ends when somebody has the last
   * word**, and only a name calls somebody back.
   */
  #said(message: Message): void {
    for (const botId of Object.keys(this.store.data.bots)) {
      if (botId === message.sender_id) continue;
      const named = this.store
        .pending(botId)
        .some((entry) => entry.message_id === message.id && entry.hints.mentionsMe);
      if (named) this.#wakeQuietly(botId);
    }
  }

  /** A wake nobody awaited: its failure is recorded rather than left as a rejection. */
  #wakeQuietly(botId: Id): void {
    this.wake(botId).catch((error: unknown) => {
      this.failures.push({ botId, error });
      this.#onError?.(error, botId);
    });
  }

  /** Resolve when no wake is in flight, including one started while waiting. */
  async whenIdle(): Promise<void> {
    while (this.#busy.size > 0 || this.#compacting.size > 0 || this.#waits.size > 0) {
      await Promise.all([
        ...this.#busy.values(),
        ...this.#compacting.values(),
        // A wait is in flight, and a wait whose turn threw is not this method's failure:
        // the error is on `failures` and its own caller has it.
        ...[...this.#waits.values()].map((wait) => wait.promise.then(
          () => undefined,
          () => undefined,
        )),
      ]);
    }
  }

  /**
   * Start the comparator: catch up on what came due while nothing was running,
   * then arm the one timer for whatever is still pending.
   *
   * Nothing else is started. No bot is woken because the process came up — a
   * delivery wakes a bot, and a start is not one.
   */
  async start(): Promise<void> {
    await this.comparator.start();
  }

  /**
   * Stop the comparator and end every wait: disarm the timer and leave the table as it is.
   *
   * A row that comes due while nothing is sweeping is caught by the next `start()`, once
   * (§12 (c)) — which is the whole restart story, and the reason stopping loses nothing. A
   * bot that was waiting to read a room is a different matter: nothing outlives the kernel,
   * so its timer is cleared and its wait answers the one thing that is true — it opened no
   * turn.
   */
  stop(): void {
    this.comparator.stop();
    for (const [botId, wait] of this.#waits) {
      this.#timers.clear(wait.handle);
      this.#waits.delete(botId);
      wait.settle(nothingDrained());
    }
  }

  /**
   * Hand each delivered bot to the wake path, without waiting for its turn.
   *
   * Not awaited: the comparator is a background cost that must reach its next
   * arming whatever a turn takes. The promise is still kept, so `whenIdle()`
   * can answer "what is this process doing" and a test can wait for the turns
   * this started.
   */
  #compactAfter(botId: Id, drained: Observation[]): void {
    if (drained.length === 0) return;

    // **One compaction per bot, because the note is the bot's.** It used to be one per
    // room, when a box was one room's; `box.ts` and `docs/host-rulings.md` now say the
    // box travels with the bot, so a tick that touched two rooms has one delta to fold
    // and not two. Whatever the tick drained needs no hand-off: it is on the record the
    // delta is read from, so this only decides whether to ask at all.
    // The question the runtime answers for itself and never puts to a model: a count
    // and an age, both free (§3).
    if (!this.compactor.due(botId)) return;

    const run = this.compactor.compact(botId).then(
      () => undefined,
      (error: unknown) => {
        // A background action that threw must not take the process down, and
        // must not vanish either: §@ "nothing is ever dropped silently".
        this.failures.push({ botId, error });
        this.#onError?.(error, botId);
      },
    );
    this.#compacting.add(run);
    void run.then(() => this.#compacting.delete(run));
  }

  #deliver(botIds: Id[]): void {
    for (const botId of botIds) {
      this.tick(botId).catch((error: unknown) => {
        this.failures.push({ botId, error });
        this.#onError?.(error, botId);
      });
    }
  }
}
