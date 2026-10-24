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

  inbox(botId: Id): Observation[] {
    return (this.data.observations[botId] ??= []);
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
   * inbox is no wake — not an idle tick.
   */
  hasPending(botId: Id): boolean {
    return this.inbox(botId).length > 0;
  }

  /**
   * Take the bot's whole queue in one step.
   *
   * The pop is a single synchronous `splice`, and only the save that follows it
   * is awaited. Anything delivered while that save is in flight lands in the
   * now-empty queue and is taken by the next round. Reading the queue and then
   * clearing it would lose exactly that arrival.
   */
  async drain(botId: Id): Promise<Observation[]> {
    const queue = this.inbox(botId);
    const taken = queue.splice(0, queue.length);
    if (taken.length > 0) await this.save();
    return taken;
  }

  // ---- persistence ----

  /** Write the shards atomically: a reader never sees half a file. */
  async save(): Promise<void> {
    if (!this.path) return;
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    await rename(temporary, this.path);
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
    const parsed = JSON.parse(raw) as Partial<SeekData>;
    return new SeekStore({ ...emptyData(), ...parsed }, path);
  }
}
