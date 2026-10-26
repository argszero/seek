/**
 * The on-disk shape (`docs/design/data-model.md` §7): one `seek.json` per
 * account, split into shards inside it.
 *
 * Three sharding keys, each matching what grows fastest and what must be
 * prunable on its own:
 *
 * - `messages` by room — one shared log per room.
 * - `observations` by bot, `sessions` by agent — the queue is the bot's (one per
 *   bot, so a message is delivered once and "already handled" is one state),
 *   while the work is the agent's.
 * - `turns` stay together: they are the ledger, they are small, and a ledger
 *   split by agent stops being a ledger.
 *
 * `schedule` is one global table, never sharded by bot: the one operation it
 * exists for is a bot writing a row for another bot.
 *
 * `bots` and `agents` are separate shards on purpose: a bot is a handful of rows
 * that change when someone renames it, while agents are the things that are many
 * and busy.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type {
  Agent,
  Bot,
  Id,
  Membership,
  Memory,
  Message,
  Observation,
  Principal,
  Room,
  ScheduleRow,
  Session,
  Turn,
} from './types.ts';

export interface SeekData {
  bots: Record<Id, Bot>;
  agents: Record<Id, Agent>;
  principals: Record<Id, Principal>;
  rooms: Record<Id, Room>;
  memberships: Record<Id, Membership>;
  /** Sharded by agent. */
  sessions: Record<Id, Session[]>;
  /** Sharded by room. */
  messages: Record<Id, Message[]>;
  /** Sharded by bot. */
  observations: Record<Id, Observation[]>;
  /** The ledger, deliberately unsharded. */
  turns: Turn[];
  /** Sharded by agent. */
  memories: Record<Id, Memory[]>;
  /** One global table. */
  schedule: ScheduleRow[];
}

export function emptyData(): SeekData {
  return {
    bots: {},
    agents: {},
    principals: {},
    rooms: {},
    memberships: {},
    sessions: {},
    messages: {},
    observations: {},
    turns: [],
    memories: {},
    schedule: [],
  };
}

/**
 * A fresh id.
 *
 * `ou_`, `oc_`, `om_` and `ag_` are the prefixes data-model rule 10 fixes; the
 * rest are the shortest prefixes that keep the shards readable, and no rule
 * pins them.
 */
export function newId(prefix: string): Id {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export class SeekStore {
  data: SeekData;
  /** Where `save()` writes. Absent for an in-memory store. */
  path?: string;

  constructor(data: SeekData = emptyData(), path?: string) {
    this.data = data;
    this.path = path;
  }

  // ---- who and where ----

  /** A participant, whether a human (`principals`) or a bot (`bots`). */
  principal(id: Id): Principal | Bot | undefined {
    return this.data.principals[id] ?? this.data.bots[id];
  }

  room(id: Id): Room | undefined {
    return this.data.rooms[id];
  }

  agentsOf(botId: Id): Agent[] {
    return Object.values(this.data.agents).filter((a) => a.bot_id === botId);
  }

  membershipsOf(roomId: Id): Membership[] {
    return Object.values(this.data.memberships).filter(
      (m) => m.room_id === roomId,
    );
  }

  isMember(roomId: Id, principalId: Id): boolean {
    return this.membershipsOf(roomId).some(
      (m) => m.principal_id === principalId,
    );
  }

  /**
   * Every bot in the room.
   *
   * Delivery is written for these and for nothing else: a member is a bot's
   * projection into a room, so an agent never receives anything of its own.
   */
  botsIn(roomId: Id): Bot[] {
    return this.membershipsOf(roomId)
      .map((m) => this.data.bots[m.principal_id])
      .filter((bot): bot is Bot => Boolean(bot));
  }

  // ---- shards ----

  messagesOf(roomId: Id): Message[] {
    return (this.data.messages[roomId] ??= []);
  }

  /**
   * The bot's observations: everything ever delivered to it, append-only.
   *
   * `agent-lifecycle.md` §3: *"The inbox is append-only and the writer never
   * blocks"*, and *"no entry has to be silently dropped to keep it small"*. What
   * grows without bound is therefore not bounded here but in what a judgement
   * *reads* — the delta since the last digest — which is `compact.ts`'s job.
   *
   * This array is mutable on purpose: `delivery.ts` and `schedule.ts` append to it.
   * A caller that wants the queue rather than the record wants `pending()`.
   */
  inbox(botId: Id): Observation[] {
    return (this.data.observations[botId] ??= []);
  }

  /**
   * What is still waiting to be taken: the queue the loop sees.
   *
   * A consumed entry stays in the record (its verdict lives on it and nowhere
   * else), so "the queue" and "the inbox" are no longer
   * the same list. This is the difference, and it is a read: nothing is moved.
   */
  pending(botId: Id): Observation[] {
    return this.inbox(botId).filter((entry) => entry.state !== 'consumed');
  }

  /**
   * An agent's own stretches of work.
   *
   * Sharded by agent, not by bot: a session is the agent's (data-model rule
   * 13), and two agents behind one bot must never share a thread.
   */
  sessionsOf(agentId: Id): Session[] {
    return (this.data.sessions[agentId] ??= []);
  }

  /**
   * An agent's own memory rows: diary, room digests, session memory.
   *
   * Sharded by agent (data-model rule 8), so one agent's digest is never in
   * another agent's shard — which is what keeps "one writer per room" a property
   * of the shape rather than a discipline.
   */
  memoriesOf(agentId: Id): Memory[] {
    return (this.data.memories[agentId] ??= []);
  }

  /**
   * Whether this bot has anything to wake for.
   *
   * A bot wakes because an entry arrived and for no other reason, so an empty
   * queue is no wake — not an idle tick. It reads `pending()`: the record keeps
   * what it consumed, and a bot woken again for an entry it already settled would
   * be the "mark it handled" bookkeeping this design exists to avoid.
   */
  hasPending(botId: Id): boolean {
    return this.pending(botId).length > 0;
  }

  /**
   * Take everything the bot has waiting, in one step.
   *
   * The queue is emptied in a single synchronous pass, and only the save that
   * follows it is awaited. Anything delivered while that save is in flight lands in
   * the queue unmarked and is taken by the next round. Reading the queue and then
   * clearing it would lose exactly that arrival.
   *
   * **What is taken is marked `consumed`, not removed.** The entries are returned
   * to the caller, which is where a verdict is written on them — and a verdict
   * lives on its entry and nowhere else. Splicing them
   * out here would mean the judgement's only copy is destroyed by the same tick
   * that produced it, and the box's last-verdict part could never be filled: the
   * mark is what makes a verdict survive to be read back.
   */
  async drain(botId: Id): Promise<Observation[]> {
    const taken = this.pending(botId);
    for (const entry of taken) entry.state = 'consumed';
    if (taken.length > 0) await this.save();
    return taken;
  }

  // ---- persistence ----

  /**
   * The saves in flight, in the order they were asked for.
   *
   * `save()` writes a temporary file and renames it, which is atomic for a *reader*
   * and for nothing else: the temporary name carries the pid, so two saves that
   * overlap in one process share one temporary file, the first rename takes it away,
   * and the second fails `ENOENT` on a store whose data is perfectly fine. They do
   * overlap: `kernel.ts` starts compaction without awaiting it (`#compactAfter`), so
   * `compact.ts`'s save runs alongside the tick's.
   *
   * Chaining them is the fix, rather than giving each save a temporary name of its
   * own. A unique name would turn a failed write into two renames racing, and the
   * slower one wins: a save holding an older snapshot could land last and undo a row
   * the other had already made durable. Queued, a write cannot start before the one
   * ahead has renamed, and because each snapshot is taken when its own write runs,
   * the later write is the newer one by construction.
   */
  #writing: Promise<void> = Promise.resolve();

  /**
   * Write the shards atomically: a reader never sees half a file.
   *
   * Serialized against the saves already in flight in this process (`#writing`), so
   * callers that overlap all land instead of all but one rejecting.
   */
  async save(): Promise<void> {
    const path = this.path;
    if (!path) return;
    const written = this.#writing.then(() => this.#write(path));

    // The chain's own link never rejects: a write that failed has already been
    // reported to its own caller, and the save queued behind it still has to run.
    this.#writing = written.then(
      () => undefined,
      () => undefined,
    );
    return written;
  }

  async #write(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    await rename(temporary, path);
  }

  /** Read the shards, or start empty when there is no file yet. */
  static async load(path: string): Promise<SeekStore> {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') {
        return new SeekStore(emptyData(), path);
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `${path} is not JSON, so it is not a store: ${(error as Error).message}. ` +
          'Nothing was changed or removed — the file is exactly as it was.',
      );
    }
    return new SeekStore({ ...emptyData(), ...assertStoredShape(parsed, path) }, path);
  }
}

/**
 * The eleven shards `save()` writes, and the shape each one has.
 *
 * Read off `docs/design/data-model.md` §7 rather than invented here: nine are maps
 * the model shards by a key (`messages` by room, `observations` by bot, `sessions`
 * and `memories` by agent), and `turns` and `schedule` are whole tables. The list is
 * what "the on-disk shape is fixed" has to mean mechanically, in the one place that
 * reads the file back.
 */
const SHARDS: Readonly<Record<keyof SeekData, 'map' | 'table'>> = {
  bots: 'map',
  agents: 'map',
  principals: 'map',
  rooms: 'map',
  memberships: 'map',
  sessions: 'map',
  messages: 'map',
  observations: 'map',
  memories: 'map',
  turns: 'table',
  schedule: 'table',
};

/** What a JSON value is, for an error message a reader can act on. */
function shapeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  const kind = typeof value;
  // "an object" and not "a object": this string is read by the person whose file was
  // just refused, which is the worst moment to look careless.
  return kind === 'object' ? 'an object' : `a ${kind}`;
}

/**
 * The file `load` was handed, held to the shape `save` writes.
 *
 * **This used to validate nothing.** `load` was `JSON.parse(raw) as Partial<SeekData>`
 * and then `{ ...emptyData(), ...parsed }`, so any JSON object was accepted and every
 * shard it did not carry became an empty one. The consequence was measured, not
 * supposed: a store holding six messages across three turns, with its `messages` shard
 * removed, loaded without a word, ran, and saved — six messages replaced by two, the
 * ledger grown to four turns naming message ids that no longer exist. The write is
 * atomic, so `save()` does not lose data; `load()` did, and then committed it.
 *
 * That is the one failure a local-only store has no answer for. There is no other copy:
 * The design and the README both put the data in the client, and nowhere else,
 * so a read that silently reinterprets the file is a read that can destroy the only
 * copy of a person's history, and the next `save()` makes it permanent.
 *
 * **So it refuses rather than repairs**, and it refuses *before* constructing anything:
 * the file is only ever read, never rewritten, never moved, never deleted. A store this
 * version understands is the only kind it opens. Three refusals, each naming the file:
 *
 * - the file is not a JSON object (not a store at all);
 * - a shard is present but the wrong shape — a map that is an array, a table that is an
 *   object — which is a corrupt or foreign file, and the next `save()` would write the
 *   corruption back in the shape this version reads;
 * - a shard is **absent**. This is the truncation case and the older-file case at once,
 *   and they are indistinguishable from here, so both are refused: absent reads as
 *   empty, and empty is exactly what has to stop being guessed at.
 *
 * **Absence is a refusal rather than a default on purpose.** Adding a twelfth shard
 * later will make every file written before it unreadable, and that pressure is the
 * point: the alternative is a version boundary crossed in silence, which is the same
 * defect one release later. A migration written when the shard is added is the cost,
 * and the design already argues that a file read as configuration
 * should fail loudly rather than quietly mean something else.
 *
 * **Keys outside the eleven are kept, not refused.** `save()` writes `this.data`
 * whole, so an unknown key survives a round trip today; refusing one would turn a
 * newer file into a dead end for an older build, and keeping a key this version does
 * not read costs nothing.
 */
function assertStoredShape(parsed: unknown, path: string): Partial<SeekData> {
  const refuse = (detail: string): never => {
    throw new Error(
      `${path} is not a store this version can read: ${detail}. Nothing was changed ` +
        'or removed — the file is exactly as it was. Restore it from a backup, fix it ' +
        'by hand, or move it aside to start over deliberately ' +
        '(docs/design/data-model.md §7 fixes the eleven shards)',
    );
  };
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return refuse(`it is ${shapeOf(parsed)}, and a store is a JSON object`);
  }
  const file = parsed as Record<string, unknown>;
  const wrong: string[] = [];
  const missing: string[] = [];
  for (const [name, kind] of Object.entries(SHARDS)) {
    const value = file[name];
    if (value === undefined) {
      missing.push(name);
      continue;
    }
    const holds =
      kind === 'table'
        ? Array.isArray(value)
        : typeof value === 'object' && value !== null && !Array.isArray(value);
    if (!holds) {
      wrong.push(`${JSON.stringify(name)} should be ${kind === 'table' ? 'an array' : 'a map of ids to rows'} and is ${shapeOf(value)}`);
    }
  }
  if (wrong.length > 0) return refuse(wrong.join('; '));
  if (missing.length > 0) {
    return refuse(
      `${missing.map((name) => JSON.stringify(name)).join(', ')} ` +
        `${missing.length === 1 ? 'is' : 'are'} absent, and an absent shard would read ` +
        'as an empty one — which loses whatever it held, silently, on the next save',
    );
  }
  return file as Partial<SeekData>;
}
