/**
 * The inbox loop: a bot wakes because an entry arrived, and for no other
 * reason.
 *
 * There is no clock here and no idle path. A timer creeping back in as a
 * per-bot heartbeat is the defect this file exists to keep out (the schedule
 * adds a second *producer of deliveries*, never a second wake source).
 *
 * **Stage 0 is consulted before anything else.** The loop drains the queue and
 * hands it to `gate()` (`gate.ts`), which settles everything certain and free:
 * an @-mention, a reply, a direct message or a due reminder goes straight to
 * stage 2; a muted room or another bot's broadcast is recorded as `ignore` and
 * opens no turn; only the genuinely ambiguous remainder reaches stage 1. That
 * ordering is the whole economy of the design — an observed but unaddressed
 * message must never cost a call — so a loop that runs a turn straight off the
 * drain skips the one thing that makes aliveness affordable.
 */

import { gate, type GateResult } from './gate.ts';
import type { SeekStore } from './store.ts';
import type { Id, Observation } from './types.ts';

export type RunTurn = (entries: Observation[]) => Promise<void> | void;

/**
 * Stage 1: the judgement, as this loop sees it.
 *
 * It is handed **which bot** the tick belongs to, and the entries stage 0 could not
 * settle, and returns the ones that act. The bot comes with the call rather than being
 * bound into the judge: the box a judgement reads is the bot's own (§3), one judge serves
 * every bot in the store, and an instance per bot would be the same fact kept in a place
 * nothing checks.
 *
 * It never sees what stage 0 already settled — that is what the rules are for.
 *
 * The real stage 1 is a decision model (`agent-lifecycle.md` §4): one forward
 * pass over the room's box, an answer per named question, "unparseable counts
 * as no act". It is not built yet, so the default below is a placeholder that
 * acts on nothing — **no model is called this round**, and no verdict is
 * written, because the verdict for a judged entry is the watch side's to write
 * and a placeholder has nothing to record.
 */
export type Judge = (
  botId: Id,
  entries: Observation[],
) => Promise<Observation[]> | Observation[];

/** Stage 1 until it exists: no act. Nothing is spent and nothing is written. */
const judgeNothing: Judge = () => [];

export interface TickResult {
  /** Whether a turn was opened. */
  woke: boolean;
  /**
   * The entries that turn was opened with — never every entry the tick drained.
   * An entry stage 0 ignored, or one stage 1 declined, is not in here.
   */
  entries: Observation[];
  /**
   * What the tick took off the queue and consumed — a held-back entry is not in
   * here, because the chain wall put it back (§11.4).
   *
   * The pop is atomic, so by the time anything else looks the queue no longer
   * holds these. That is why they are reported rather than re-derived: a delta
   * read from the queue alone has forgotten the very entries the tick was woken
   * by, and a compaction after a tick would fold in nothing.
   */
  drained: Observation[];
  /**
   * What stage 0 settled, per bucket, so a caller can see who was ignored
   * without re-deriving it. Empty on a tick that drained nothing.
   */
  settled: GateResult | undefined;
}

export class InboxLoop {
  store: SeekStore;
  run: RunTurn;
  /** Stage 1. Injectable, so its absence never hides behind a model call. */
  judge: Judge;
  /** Turns actually opened. A tick over an empty inbox opens none. */
  turns = 0;

  constructor(store: SeekStore, run: RunTurn, judge: Judge = judgeNothing) {
    this.store = store;
    this.run = run;
    this.judge = judge;
  }

  /**
   * One pass for one bot: no entry, no wake.
   *
   * What the turn receives is what survived the rules, taken in one atomic
   * step, so anything delivered while the turn is running waits for the next
   * round instead of being cleared out from under it.
   *
   * The order is the table's: drain, settle with the rules, ask stage 1 about
   * the remainder only, and open a turn only if something still acts.
   */
  async tick(botId: Id): Promise<TickResult> {
    if (!this.store.hasPending(botId)) {
      return { woke: false, entries: [], drained: [], settled: undefined };
    }

    const drained = await this.store.drain(botId);
    // A second drainer took the queue between the check and the pop.
    if (drained.length === 0) {
      return { woke: false, entries: [], drained: [], settled: undefined };
    }

    const settled = gate(this.store, botId, drained);

    // Row 2 is already decided: nothing is asked about it.
    const acting = [...settled.act];
    // Row 4 is the only row that costs anything, and it costs it here. A tick
    // where the rules settled everything never reaches this line.
    if (settled.judge.length > 0) {
      acting.push(...(await this.judge(botId, settled.judge)));
    }

    // §11.4: an entry the chain wall held back still belongs to this bot's
    // inbox — "nothing is lost and nothing is spent" — so it is left waiting
    // instead of being consumed, and is reconsidered when the room moves on.
    // Consuming it here is what would make a held message disappear instead of
    // wait.
    if (settled.blocked.length > 0) {
      // Back on the queue means waiting again: the entry went nowhere, so its
      // mark comes off rather than the entry being copied or re-created. It is
      // *not* re-inserted — it never left the record (`drain` marks, it does not
      // splice), and putting the same entry back would store one observation
      // twice and count it twice. Its arrival position is already where the
      // queue wants it: it was delivered before whatever arrived meanwhile.
      for (const entry of settled.blocked) entry.state = 'new';
      await this.store.save();
    }

    // What this tick consumed: everything it drained except what went back on the
    // queue. Reporting the held entries as consumed would fold them into a
    // summary while they are still waiting to be judged.
    const consumed =
      settled.blocked.length === 0
        ? drained
        : drained.filter((entry) => !settled.blocked.includes(entry));

    // Row 3's ending, stage 1's "no act", and a tick where everything was held
    // back: nothing was asked to happen.
    if (acting.length === 0) {
      return { woke: false, entries: [], drained: consumed, settled };
    }

    this.turns += 1;
    await this.run(acting);
    return { woke: true, entries: acting, drained: consumed, settled };
  }
}
