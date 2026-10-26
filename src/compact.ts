/**
 * Compaction: a room's standing summary, written by the half that can write.
 *
 * `docs/design/agent-lifecycle.md` §3 ("The observation box") fixes the whole
 * contract, and none of it is this file's to invent:
 *
 * - **One writer.** A decision model emits a choice and no text, so the summary
 *   is the work agent's and the watch side only reads the box. Nothing here can
 *   reach a second agent's store.
 * - **Per (bot, room), and rolling.** One digest row per room per bot, replaced
 *   in place rather than appended to: two rows would be two versions to
 *   disagree, which is the silent-amnesia defect in its other form.
 * - **The delta is derived, never stored.** It is read off the bot's queue — the
 *   entries for this room after the point the last summary consumed up to — so
 *   there stays exactly one copy of every observation.
 * - **Single-flight, one atomic write.** Two compactions over one room would
 *   each rewrite the summary from a state the other has already moved past, and
 *   whichever finished last would delete the difference without a trace. So the
 *   second caller joins the first, and the new summary and its consumed-to point
 *   are committed in a single `save()` — which is what makes "an arrival during
 *   a compaction is never lost" true rather than hoped for.
 * - **A runtime action, never a turn.** It produces no message, so it is not a
 *   proactive turn and opens no stretch of work: `compact()` touches neither the
 *   message log nor the ledger, and it is reachable without a turn existing.
 * - **The judgement is never asked whether to compact.** Whether the delta has
 *   outgrown itself is arithmetic over entries and minutes, which the runtime
 *   answers for free. A model that could ask would ask on every tick, and the
 *   one component built to stop spending would become the one that spends
 *   without a bound.
 *
 * **No model is called here.** The sentence that turns a delta into a summary is
 * the `Summarise` argument, exactly as `Decide` (`turn.ts`) and `Judge`
 * (`inbox.ts`) are before it: the runtime is finished first and the model
 * arrives as a value rather than as a rewrite. With no summariser there is
 * nothing that can write a summary, and the compactor says so instead of
 * pretending — which is also the state a judgement sees as "compaction cannot
 * run", to be degraded visibly rather than retried forever.
 *
 * **No threshold numbers are invented.** The design settles
 * the *shape* of the line — "a number of observations, or an age, whichever
 * comes first" — and says the numbers themselves are settled by measurement,
 * which has not happened. So the lines are the caller's, and with none
 * configured nothing is ever due.
 */

import { newId, type SeekStore } from './store.ts';
import type { Agent, Id, Memory, Observation } from './types.ts';

/** What the writer is handed: the delta, and the digest it replaces. */
export interface SummariseInput {
  botId: Id;
  agentId: Id;
  roomId: Id;
  /**
   * The entries this summary is written from — the snapshot taken before the
   * call. Never re-read afterwards: an arrival during the await is a later entry
   * and must stay in the delta.
   */
  delta: Observation[];
  /** The digest this replaces, when the room already has one. */
  previous?: Memory;
}

/** The writer. The real one is a chat model; this slice says nothing. */
export type Summarise = (input: SummariseInput) => Promise<string> | string;

/**
 * When a delta has outgrown itself.
 *
 * Both are optional because the numbers are the host's to settle by measurement,
 * and a line nobody stated is not a line. The one stated rule is "whichever
 * comes first", so either crossing is enough.
 */
export interface CompactLines {
  /** A count of pending observations for the room. */
  maxObservations?: number;
  /** The age of the oldest pending observation, in milliseconds. */
  maxAgeMs?: number;
}

export interface CompactOptions {
  /** The writer. Absent means nothing can write, and nothing pretends to. */
  summarise?: Summarise;
  lines?: CompactLines;
  /** An injectable clock, so no test depends on wall time. */
  now?: () => string;
}

/** Why a compaction did not run. Every one of these writes nothing. */
export type CompactSkip =
  | 'no-work-agent'
  | 'no-summarise'
  | 'empty-delta'
  | 'not-due'
  | 'failed';

export type CompactOutcome =
  | { ran: true; memory: Memory; delta: Observation[] }
  | { ran: false; reason: CompactSkip };

/** The room's digest for this agent, when one has been written. */
export function digestOf(
  store: SeekStore,
  agentId: Id,
  roomId: Id,
): Memory | undefined {
  return store
    .memoriesOf(agentId)
    .find((row) => row.level === 'room_digest' && row.room_id === roomId);
}

/**
 * The delta: this room's entries on this bot's record, after the point the last
 * summary consumed up to.
 *
 * It is *derived* — read off the record — and never stored, so there is one copy
 * of every observation and no second log to keep true (`agent-lifecycle.md`
 * §3). The consumed-to point is an id, and the record is in arrival order, so
 * "after" is a slice. When that entry is no longer on the record (a file written
 * before the record kept what it consumed) everything there arrived after it.
 *
 * **Read off the record, not off the queue**, and the two are no longer the same
 * list: `drain` marks an entry consumed instead of splicing it out, because a
 * verdict lives on the entry it judged and nowhere else, so
 * discarding the entry would destroy the judgement's only copy. That
 * changes what this function may read. A tick's own entries used to be gone from
 * the queue by the time a box or a compaction asked, and a caller had to hand
 * them back in (`inFlight`) for the delta to be the delta and not "the room after
 * the reason to look was removed"; on the record they are simply there, at their
 * arrival position, so no caller passes anything and no second copy exists.
 *
 * It also means the delta spans ticks rather than one of them: an entry stays in
 * it — consumed, awaiting a summary — until a compaction moves the consumed-to
 * point past it. That is what makes the box's last-verdict part a fact in
 * operation rather than only in a test, and bounding the span is compaction's
 * job (`RoomCompactor`), not this slice's.
 */
export function deltaFor(
  store: SeekStore,
  botId: Id,
  roomId: Id,
  agentId?: Id,
): Observation[] {
  const record = store
    .inbox(botId)
    .filter((entry) => entry.room_id === roomId);
  if (record.length === 0) return [];

  const point = agentId ? digestOf(store, agentId, roomId)?.consumed_to : undefined;
  if (!point) return record;

  const at = record.findIndex((entry) => entry.id === point);
  return at === -1 ? record : record.slice(at + 1);
}

/**
 * The room digest writer for one store.
 *
 * It holds no timer and no life of its own — like an agent, it is a runnable,
 * called by whatever owns the clock. The comparator is the only thing in the
 * kernel that arms a timer, and compaction is not one of its outputs.
 */
export class RoomCompactor {
  store: SeekStore;
  summarise?: Summarise;
  lines: CompactLines;
  /** Injected so a test can age a delta without waiting for one. */
  clock: () => string;
  /** The one compaction running per (bot, room): single-flight, not a queue. */
  private running = new Map<string, Promise<CompactOutcome>>();
  /**
   * The delta size a failed run saw, per (bot, room).
   *
   * A writer that keeps failing must not be re-fired every tick against the same
   * delta: it backs off until the delta has actually grown. That is a rule about
   * state rather than a retry delay, so it invents no number.
   */
  private failed = new Map<string, number>();

  constructor(store: SeekStore, options: CompactOptions = {}) {
    this.store = store;
    this.summarise = options.summarise;
    this.lines = options.lines ?? {};
    this.clock = options.now ?? (() => new Date().toISOString());
  }

  /** The bot's `work` agent: the half that can write. */
  workAgent(botId: Id): Agent | undefined {
    return this.store.agentsOf(botId).find((agent) => agent.role === 'work');
  }

  /**
   * What a compaction would fold in right now.
   *
   * No argument carries the tick's own entries: `deltaFor` reads the record, and
   * a drained entry is on it. What a compaction folds in is therefore the same
   * set whether it runs before, during or after a tick.
   */
  delta(botId: Id, roomId: Id): Observation[] {
    return deltaFor(this.store, botId, roomId, this.workAgent(botId)?.id);
  }

  /** Whether a compaction is in flight for this room. */
  inFlight(botId: Id, roomId: Id): boolean {
    return this.running.has(key(botId, roomId));
  }

  /**
   * Whether the runtime should compact now.
   *
   * This is the question the runtime answers for itself and never puts to a
   * model: a count, and an age, both free.
   */
  due(botId: Id, roomId: Id): boolean {
    if (!this.summarise) return false;
    if (this.inFlight(botId, roomId)) return false;
    if (!this.workAgent(botId)) return false;

    const delta = this.delta(botId, roomId);
    if (delta.length === 0) return false;
    if (this.failed.get(key(botId, roomId)) === delta.length) return false;
    return this.crosses(delta);
  }

  /**
   * Write the room's summary, or say why not.
   *
   * One at a time per room: a second caller joins the run in flight instead of
   * starting a rival one. The snapshot is taken before the writer is awaited and
   * is what the summary covers, so an entry that arrives meanwhile is still in
   * the delta afterwards — never summarised by accident and never dropped.
   */
  async compact(botId: Id, roomId: Id): Promise<CompactOutcome> {
    const room = key(botId, roomId);
    const inFlight = this.running.get(room);
    if (inFlight) return inFlight;

    const run = this.write(botId, roomId, room);
    this.running.set(room, run);
    try {
      return await run;
    } finally {
      this.running.delete(room);
    }
  }

  private crosses(delta: Observation[]): boolean {
    const { maxObservations, maxAgeMs } = this.lines;
    if (maxObservations === undefined && maxAgeMs === undefined) return false;
    if (maxObservations !== undefined && delta.length >= maxObservations) {
      return true;
    }
    if (maxAgeMs !== undefined) {
      // The queue is in arrival order, so the first entry is the oldest.
      const age = Date.parse(this.clock()) - Date.parse(delta[0].delivered_at);
      if (Number.isFinite(age) && age >= maxAgeMs) return true;
    }
    return false;
  }

  private async write(botId: Id, roomId: Id, room: string): Promise<CompactOutcome> {
    const agent = this.workAgent(botId);
    if (!agent) return { ran: false, reason: 'no-work-agent' };
    const summarise = this.summarise;
    if (!summarise) return { ran: false, reason: 'no-summarise' };

    const snapshot = deltaFor(this.store, botId, roomId, agent.id);
    if (snapshot.length === 0) return { ran: false, reason: 'empty-delta' };
    if (!this.crosses(snapshot)) return { ran: false, reason: 'not-due' };

    const previous = digestOf(this.store, agent.id, roomId);
    let body: string;
    try {
      body = await summarise({
        botId,
        agentId: agent.id,
        roomId,
        delta: snapshot,
        previous,
      });
    } catch {
      this.failed.set(room, snapshot.length);
      return { ran: false, reason: 'failed' };
    }
    this.failed.delete(room);

    const at = this.clock();
    const consumedTo = snapshot[snapshot.length - 1].id;
    let memory: Memory;
    if (previous) {
      // Rolling: the digest is replaced where it stands. Appending would leave
      // two summaries of one room, which is a disagreement waiting to surface.
      previous.body = body;
      previous.consumed_to = consumedTo;
      previous.updated_at = at;
      memory = previous;
    } else {
      memory = {
        id: newId('mm'),
        agent_id: agent.id,
        level: 'room_digest',
        room_id: roomId,
        body,
        consumed_to: consumedTo,
        updated_at: at,
      };
      this.store.memoriesOf(agent.id).push(memory);
    }
    // The summary and its consumed-to point land together: one `save()`, and
    // `save()` writes a temporary file and renames it, so a reader sees both or
    // neither.
    await this.store.save();
    return { ran: true, memory, delta: snapshot };
  }
}

function key(botId: Id, roomId: Id): string {
  return `${botId}:${roomId}`;
}
