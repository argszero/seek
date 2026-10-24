/**
 * The inbox loop: a bot wakes because an entry arrived, and for no other
 * reason.
 *
 * There is no clock here and no idle path. A timer creeping back in as a
 * per-bot heartbeat is the defect this file exists to keep out (the schedule
 * adds a second *producer of deliveries*, never a second wake source).
 */

import type { SeekStore } from './store.ts';
import type { Id, Observation } from './types.ts';

export type RunTurn = (entries: Observation[]) => Promise<void> | void;

export interface TickResult {
  /** Whether a turn was opened. */
  woke: boolean;
  /** The entries that turn was opened with. */
  entries: Observation[];
}

export class InboxLoop {
  store: SeekStore;
  run: RunTurn;
  /** Turns actually opened. A tick over an empty inbox opens none. */
  turns = 0;

  constructor(store: SeekStore, run: RunTurn) {
    this.store = store;
    this.run = run;
  }

  /**
   * One pass for one bot: no entry, no wake.
   *
   * What the turn receives is the whole queue taken in one atomic step, so
   * anything delivered while the turn is running waits for the next round
   * instead of being cleared out from under it.
   */
  async tick(botId: Id): Promise<TickResult> {
    if (!this.store.hasPending(botId)) return { woke: false, entries: [] };

    const entries = await this.store.drain(botId);
    // A second drainer took the queue between the check and the pop.
    if (entries.length === 0) return { woke: false, entries: [] };

    this.turns += 1;
    await this.run(entries);
    return { woke: true, entries };
  }
}
