/**
 * Stage 2: one turn of the work agent, and the wire that makes one room work
 * end to end.
 *
 * `docs/design/agent-lifecycle.md` §4 defines the turn and the three places the
 * boundary sits:
 *
 * - **It receives the observation entries and nothing else** — not the watch
 *   agent's reason, which stays on the record where this agent may go and read
 *   it ("what crosses the line from watch to work").
 * - **To say anything it calls the speaking tool** (`say.ts`). Nothing is
 *   posted on its behalf; a turn that ends without that call has said nothing.
 * - **To keep a promise it calls `schedule`** (`schedule.ts`). A turn that
 *   wants to look at something tomorrow writes the row that will wake it, which
 *   is the only way a purely message-triggered agent can come back to anything
 *   (§12). A row written here is saved with the turn, not before it.
 * - **Session, turn and cost are the agent's**; the queue, the tick and the
 *   wake are the bot's (`data-model.md` rule 13). So a turn is opened for one
 *   agent in one room, and its ledger row names that agent.
 *
 * **No model is called here.** The decision of what to say is the `Decide`
 * argument: the real one is a chat model with tools and a memory, and the one
 * this slice ships with says nothing at all. That is the same shape as stage 1
 * being an injectable `Judge` — the runtime is finished first, and the model
 * arrives as a value rather than as a rewrite. A turn that says nothing is not
 * a failure: silence is the default, and speaking costs a tool call.
 *
 * **One turn per room.** An agent keeps one continuous stretch of work per room
 * (§2, "agent ≠ session"), so a drain that took entries from two rooms opens
 * two turns rather than one turn with two rooms in it.
 */

import { bumpAgentTurns } from './chain.ts';
import type { RunTurn } from './inbox.ts';
import { sayAs, type SayTool } from './say.ts';
import { scheduleAs, type ScheduleTool } from './schedule.ts';
import { newId, type SeekStore } from './store.ts';
import type { Agent, Id, Message, Observation, Session, Turn } from './types.ts';

export interface TurnSpec {
  /** The work agent this turn belongs to. */
  agentId: Id;
  /**
   * The room the entries came from: the session's room.
   *
   * Absent for a reminder, which has no room (§12). Its turn still runs — the
   * reminder wakes the bot exactly as a person's message would — but it is the
   * bot's own work rather than a contribution to a room, so it opens a session
   * that belongs to no room and counts toward no room's burst.
   */
  roomId?: Id;
  /** The entries the turn opens with. Never the whole inbox. */
  entries: Observation[];
  /** Where the session opens. Defaults to the agent's own home. */
  workspace?: string;
  /** An injectable clock, so a test does not depend on wall time. */
  now?: string;
}

/** What the agent is given when the loop calls it. */
export interface TurnContext {
  botId: Id;
  agentId: Id;
  sessionId: Id;
  turnId: Id;
  /** Absent on a reminder's turn: a reminder is in no room (§12). */
  roomId?: Id;
  /** The observations that woke it — the entries and nothing more. */
  entries: Observation[];
  /** `say(room, text)`: bound to this bot and this agent, addressed by the caller. */
  say: SayTool;
  /**
   * `schedule.list() / add() / cancel()`: the one tool over the one global
   * table (§12), bound to this bot and this agent.
   *
   * It is handed over whether or not this agent's tool list carries it, exactly
   * as `say` is: the tool refuses at the call, and a turn whose agent was never
   * given the tool is a turn that keeps no promise rather than one that cannot.
   */
  schedule: ScheduleTool;
}

/**
 * What the work agent does with its turn.
 *
 * The real one runs a model with the kernel's tools; the default below is a
 * turn that stays silent, which is a legal turn in every respect.
 */
export type Decide = (context: TurnContext) => Promise<void> | void;

export interface TurnRecord {
  turn: Turn;
  session: Session;
  /** Every message this turn chose to send. Empty when it said nothing. */
  produced: Message[];
}

/** The shipped decision: nothing to say. */
const sayNothing: Decide = () => {};

/**
 * Run one turn of one agent in one room.
 *
 * The ledger row is appended before the agent runs, so a turn that throws is
 * still audited; it is closed and saved in a `finally` for the same reason.
 * Cost stays at zero because no model is called: the numbers are the turn's,
 * and this turn's spend is wall-clock.
 */
export async function runTurn(
  store: SeekStore,
  spec: TurnSpec,
  decide: Decide = sayNothing,
): Promise<TurnRecord> {
  const agent = store.data.agents[spec.agentId];
  if (!agent) throw new Error(`unknown agent: ${spec.agentId}`);
  if (spec.roomId !== undefined && !store.room(spec.roomId)) {
    throw new Error(`unknown room: ${spec.roomId}`);
  }
  for (const entry of spec.entries) {
    if (entry.room_id !== spec.roomId) {
      throw new Error(
        `entry ${entry.id} is not from ${spec.roomId ?? 'no room'}: one turn is one agent's work in one room`,
      );
    }
  }

  const now = spec.now ?? new Date().toISOString();
  const workspace = spec.workspace ?? agent.home;
  const session = openSession(store, agent, spec.roomId, workspace, now);

  const turn: Turn = {
    id: newId('tn'),
    agent_id: agent.id,
    session_id: session.id,
    started_at: now,
    input_tokens: 0,
    output_tokens: 0,
    cost: 0,
    produced: [],
  };
  store.data.turns.push(turn);

  const produced: Message[] = [];
  const say = sayAs(store, agent.bot_id, agent.id, (message) => {
    produced.push(message);
    turn.produced.push(message.id);
  });
  // §12: the tool over the one table, bound the same way. A row written here is
  // saved with the turn — the `store.save()` in the `finally` below makes both
  // the row and the turn's own ledger durable together.
  const schedule = scheduleAs(store, agent.bot_id, agent.id);

  try {
    await decide({
      botId: agent.bot_id,
      agentId: agent.id,
      sessionId: session.id,
      turnId: turn.id,
      roomId: spec.roomId,
      entries: spec.entries,
      say,
      schedule,
    });
  } finally {
    turn.ended_at = spec.now ?? new Date().toISOString();
    // §11.3: this room has now had one more bot turn in a row, with no human
    // message between. Counted when the turn ends so that the third turn's own
    // words still reach the other side — the cap stops *further* messages.
    //
    // Only a turn *in a room* counts. §12 says a reminder does not touch this
    // counter: the cap exists to stop two bots trading turns in a room, and a
    // bot reminding itself is not a conversation in a room.
    if (spec.roomId !== undefined) bumpAgentTurns(store, spec.roomId);
    await store.save();
  }

  return { turn, session, produced };
}

/**
 * The loop's stage 2 for one bot: what `InboxLoop` is constructed with.
 *
 * It resolves the bot's `work` agent — the expensive one that generates and
 * speaks (`agent-lifecycle.md` §2, "behind every bot there are two agents") —
 * and opens one turn per room the entries came from. A bot with no `work` agent
 * is a roster error, and it is thrown rather than swallowed: a loop that
 * silently opens nothing is a bot that looks deaf.
 */
export function makeTurn(
  store: SeekStore,
  botId: Id,
  decide: Decide = sayNothing,
): RunTurn {
  return async (entries: Observation[]) => {
    if (entries.length === 0) return;

    const agent = store.agentsOf(botId).find((own) => own.role === 'work');
    if (!agent) {
      throw new Error(`bot ${botId} has no 'work' agent, so nothing can run`);
    }

    const byRoom = new Map<Id | undefined, Observation[]>();
    for (const entry of entries) {
      // A reminder carries no room (`Observation.room_id`) and its turn still
      // runs: §12 keeps "the turn that fired it" on the record, so a reminder is
      // not a waking entry that no turn ever took. It opens the one turn that
      // has no room, and that turn does not count toward any room's burst.
      const key = entry.room_id;
      const group = byRoom.get(key) ?? [];
      group.push(entry);
      byRoom.set(key, group);
    }

    for (const [roomId, group] of byRoom) {
      await runTurn(store, { agentId: agent.id, roomId, entries: group }, decide);
    }
  };
}

/**
 * The agent's open stretch of work in this room, or a new one.
 *
 * A session is per (agent, room, workspace): it is the agent's private
 * bookkeeping, never shown to the user, and a change of workspace is what
 * starts a new one. A reminder's turn has no room, and that is its own key — it
 * never joins a room's session.
 */
function openSession(
  store: SeekStore,
  agent: Agent,
  roomId: Id | undefined,
  workspace: string,
  now: string,
): Session {
  const open = store
    .sessionsOf(agent.id)
    .find(
      (session) =>
        session.room_id === roomId &&
        session.workspace === workspace &&
        session.ended_at === undefined,
    );
  if (open) return open;

  const session: Session = {
    id: newId('ss'),
    agent_id: agent.id,
    room_id: roomId,
    workspace,
    started_at: now,
  };
  store.sessionsOf(agent.id).push(session);
  return session;
}
