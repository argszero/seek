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

import type { RunTurn } from './inbox.ts';
import { sayAs, type SayTool } from './say.ts';
import { newId, type SeekStore } from './store.ts';
import type { Agent, Id, Message, Observation, Session, Turn } from './types.ts';

export interface TurnSpec {
  /** The work agent this turn belongs to. */
  agentId: Id;
  /** The room the entries came from: the session's room. */
  roomId: Id;
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
  roomId: Id;
  /** The observations that woke it — the entries and nothing more. */
  entries: Observation[];
  /** `say(room, text)`: bound to this bot and this agent, addressed by the caller. */
  say: SayTool;
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
  if (!store.room(spec.roomId)) throw new Error(`unknown room: ${spec.roomId}`);
  for (const entry of spec.entries) {
    if (entry.room_id !== spec.roomId) {
      throw new Error(
        `entry ${entry.id} is not from ${spec.roomId}: one turn is one agent's work in one room`,
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

  try {
    await decide({
      botId: agent.bot_id,
      agentId: agent.id,
      sessionId: session.id,
      turnId: turn.id,
      roomId: spec.roomId,
      entries: spec.entries,
      say,
    });
  } finally {
    turn.ended_at = spec.now ?? new Date().toISOString();
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

    const byRoom = new Map<Id, Observation[]>();
    for (const entry of entries) {
      // A reminder carries no room (`Observation.room_id`), and its turn is the
      // schedule's business (`agent-lifecycle.md` §12): nothing produces one
      // yet, so this is a guard rather than a path. Left loud on purpose — the
      // alternative is a waking entry that no turn ever took.
      if (!entry.room_id) {
        throw new Error(
          `entry ${entry.id} has no room: a reminder's turn belongs to the schedule (§12), which is not built`,
        );
      }
      const group = byRoom.get(entry.room_id) ?? [];
      group.push(entry);
      byRoom.set(entry.room_id, group);
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
 * starts a new one.
 */
function openSession(
  store: SeekStore,
  agent: Agent,
  roomId: Id,
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
