/**
 * The comparator: the one thing in this kernel that runs on a clock.
 *
 * `docs/design/agent-lifecycle.md` §12 states it, and §5 and the §6 table fix
 * the two things that make it safe:
 *
 * > **It is one table in the process plus one comparator** that reads the
 * > clock — not a heartbeat per bot. (§12)
 *
 * > The schedule comparator is the one background cost in the design … it reads
 * > the clock, compares it with **the next due row** and sleeps otherwise,
 * > calling no model and touching no bot. (§5)
 *
 * > It runs on a timer; the timer's fingerprints must not reach a bot — nothing
 * > a bot sees may say "a beat happened". (§6)
 *
 * Four properties follow, and each one is a defect this file exists to keep out:
 *
 * - **One timer in the process, not one per bot.** There is exactly one armed
 *   timer here whatever the roster holds: nothing in this file is keyed by
 *   `bot_id`, and nothing grows with the number of bots (§12 (a)).
 * - **The only output is a delivery.** A sweep hands the new entries to
 *   `onDelivered` and stops. It does not tick a bot itself, does not write a
 *   message, a verdict or a transcript line, and does not tell anyone that a
 *   beat happened — the bot learns what a person's message would have told it,
 *   which is that an entry arrived (§12 (b), (e); §6's timer-fingerprint rule).
 * - **It sleeps to the next due row, not for a fixed interval.** §5 says
 *   "compares it with the next due row and sleeps otherwise", so the delay is
 *   derived from the table rather than configured, and no interval number is
 *   invented anywhere. With nothing pending there is **no timer at all**, which
 *   is what makes an idle bot cost zero (§5's idle row).
 * - **A sweep is a firing, and firing is `fireDue`'s.** This file does not
 *   re-implement the one-write idempotence or the verbatim text: it calls
 *   `fireDue` (§12 (c), (d)) and then saves once, so a row marked `fired` and
 *   the entry it produced become durable together.
 *
 * **What calls what.** `start()` sweeps once immediately — a row that came due
 * while the process was closed fires on the next start, once (§12 (c)) — and
 * then arms the timer for whatever is left. A writer that adds a row nearer than
 * the one the timer is sleeping toward calls `refresh()`, which re-arms from the
 * table; `scheduleAs` already has the hook for it (`onWritten`).
 */

import { fireDue } from './schedule.ts';
import type { SeekStore } from './store.ts';
import type { Id, Observation } from './types.ts';

/**
 * The timers this file needs.
 *
 * Injectable so a test drives the clock instead of waiting on it: nothing in
 * this repository sleeps in a suite.
 */
export interface Timers {
  set(delayMs: number, run: () => void): unknown;
  clear(handle: unknown): void;
}

/** The real timers, used unless one was injected. */
export const wallTimers: Timers = {
  set: (delayMs, run) => setTimeout(run, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * The instant the earliest pending row is due, or `undefined` when none is.
 *
 * `fired` and `cancelled` rows are behind us (`state` moves once, never
 * backwards), and a row whose `when` cannot be read never fires — `fireDue`
 * skips it too, and it stays visible in `listRows` for its author to cancel. It
 * must be skipped here as well: a `NaN` delay would arm the timer forever.
 */
export function nextDueAt(store: SeekStore): number | undefined {
  let earliest: number | undefined;
  for (const row of store.data.schedule) {
    if (row.state !== 'pending') continue;
    const when = Date.parse(row.when);
    if (Number.isNaN(when)) continue;
    if (earliest === undefined || when < earliest) earliest = when;
  }
  return earliest;
}

/**
 * How long until the next row is due — `0` when one is already due, `undefined`
 * when nothing is pending.
 */
export function msUntilDue(store: SeekStore, now: string): number | undefined {
  const due = nextDueAt(store);
  if (due === undefined) return undefined;
  return Math.max(0, due - Date.parse(now));
}

export interface ComparatorOptions {
  /** An injectable clock, so a test does not depend on wall time. */
  now?: () => string;
  /** Injectable timers, for the same reason. */
  timers?: Timers;
  /**
   * What to do with the bots that just received a delivery.
   *
   * Called once per bot, and only when something actually fired. This is where
   * a runtime ticks them — the entry is already in their inbox and `save()` has
   * already made it durable, so the wake is exactly the wake a person's message
   * produces (§12: a second producer of deliveries, never a second wake source).
   */
  onDelivered?: (botIds: Id[]) => void | Promise<void>;
}

/**
 * The schedule's comparator: one table, one clock reading, one armed timer.
 *
 * Construct it once per process and `start()` it. Two comparators over one
 * store would be two timers and two sweeps racing for the same rows — `fireDue`
 * would keep the result correct, but the second one is exactly the per-bot
 * heartbeat shape the ruling forbids, arrived at from the other side.
 */
export class ScheduleComparator {
  store: SeekStore;
  #now: () => string;
  #timers: Timers;
  #onDelivered: ComparatorOptions['onDelivered'];
  #handle: unknown;
  #armed = false;
  #wakeAt: string | undefined;
  #running = false;
  /** Sweeps that fired something. Diagnostic only; nothing is written for it. */
  sweeps = 0;

  constructor(store: SeekStore, options: ComparatorOptions = {}) {
    this.store = store;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#timers = options.timers ?? wallTimers;
    this.#onDelivered = options.onDelivered;
  }

  /** Whether the comparator is sweeping. */
  get running(): boolean {
    return this.#running;
  }

  /**
   * When the armed timer will wake, as an ISO instant — `undefined` when no
   * timer is armed.
   *
   * Readable so a caller can answer "what is the next thing this process will
   * do" without reading the table itself.
   */
  get wakeAt(): string | undefined {
    return this.#wakeAt;
  }

  /**
   * Start sweeping, and catch up on everything that came due while nothing was
   * running.
   *
   * The catch-up is not an extra: §12 (c) says an instant missed while the
   * process was down must fire **once**, not zero times and not twice, and the
   * restart is precisely when the table and the clock have drifted apart.
   */
  async start(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    await this.#sweepAndArm();
  }

  /**
   * Stop: disarm the timer and leave the table exactly as it is.
   *
   * Nothing is fired on the way out. A row that comes due while the process is
   * closed is caught by the next `start()`.
   */
  stop(): void {
    this.#running = false;
    this.#disarm();
  }

  /**
   * Re-arm from the table, waking earlier if a nearer row has appeared.
   *
   * The timer sleeps toward one stated instant, so a row written for sooner
   * than that instant would otherwise wait for the further one. Whoever writes a
   * row calls this; a writer that does not is a reminder that arrives late,
   * which is the one thing a reminder must not do.
   */
  refresh(): void {
    if (!this.#running) return;
    this.#arm();
  }

  /**
   * One comparison: fire what is due, save once, hand the bots over.
   *
   * Nothing is written when nothing fired — an empty sweep is free, and a save
   * per idle sweep would be the idle path §5 says does not exist.
   */
  async sweep(now?: string): Promise<Observation[]> {
    const at = now ?? this.#now();
    const delivered = fireDue(this.store, at);
    if (delivered.length === 0) return delivered;

    this.sweeps += 1;
    // The row's state change and its entry, durable together, before anyone is
    // told they were woken: a bot must never act on a delivery a restart can
    // take away.
    await this.store.save();

    // Once per bot, however many of its rows fired: two reminders for one bot
    // are two entries in one inbox, not two wakes.
    const bots = [...new Set(delivered.map((entry) => entry.bot_id))];
    await this.#onDelivered?.(bots);
    return delivered;
  }

  async #sweepAndArm(): Promise<void> {
    try {
      await this.sweep();
    } finally {
      this.#arm();
    }
  }

  /**
   * Arm the one timer for the next due row, or leave none armed.
   *
   * `#armed` rather than the handle decides whether a timer exists: a handle is
   * an opaque value and `0` is a legal one, so testing it for truth would drop
   * a timer that does exist.
   */
  #arm(): void {
    this.#disarm();
    if (!this.#running) return;

    const now = this.#now();
    const delay = msUntilDue(this.store, now);
    // Nothing pending: no timer at all. This is the idle row of §5's table —
    // "no delivery, no tick, no call" — and it is why an empty schedule costs
    // nothing rather than costing a wake per interval.
    if (delay === undefined) return;

    this.#wakeAt = new Date(Date.parse(now) + delay).toISOString();
    this.#armed = true;
    this.#handle = this.#timers.set(delay, () => {
      void this.#onTimer();
    });
  }

  #disarm(): void {
    if (this.#armed) this.#timers.clear(this.#handle);
    this.#armed = false;
    this.#handle = undefined;
    this.#wakeAt = undefined;
  }

  async #onTimer(): Promise<void> {
    this.#armed = false;
    this.#handle = undefined;
    this.#wakeAt = undefined;
    // Stopped between arming and firing: the timer is stale and the table is
    // untouched, so the next start() catches up.
    if (!this.#running) return;
    await this.#sweepAndArm();
  }
}
