/**
 * Stage 2: one turn of the work agent, and the wire that makes one room work
 * end to end.
 *
 * `docs/design/agent-lifecycle.md` §4 defines the turn and the three places the
 * boundary sits:
 *
 * - **It receives the room's box** — the note written last time and every
 *   observation since — and not the watch agent's reason, which stays on the
 *   record where this agent may go and read it ("what crosses the line from watch
 *   to work"). The box is the whole of what it opens with, and the entries that
 *   woke it are inside it: a turn handed only those answered "我看不到上文" to a
 *   question the room had been discussing for twenty messages.
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

import { buildBox } from './box.ts';
import { bumpAgentTurns } from './chain.ts';
import { identityFor, type AgentIdentity } from './identity.ts';
import type { RunTurn } from './inbox.ts';
import { sayAs, type SayTool } from './say.ts';
import { scheduleAs, type ScheduleTool } from './schedule.ts';
import { newId, type SeekStore } from './store.ts';
import type {
  Agent,
  Id,
  Message,
  Observation,
  ScheduleRow,
  Session,
  TokenUsage,
  Turn,
} from './types.ts';

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
  /**
   * Called when this turn's `schedule` tool writes a row.
   *
   * The timer sleeps toward one stated instant, so a row written for sooner
   * than that instant would otherwise wait for the further one. Re-arming is
   * the engine's (`comparator.ts`, `refresh()`); this is the seam that tells it,
   * and it is absent when nothing owns a comparator — a bare `runTurn` in a
   * test, for one.
   */
  onScheduleWritten?: (row: ScheduleRow) => void;
  /**
   * Called when this turn's `say` tool puts a message in a room.
   *
   * A message is what wakes whoever it addresses — the same thing a person's message
   * does — and that wake belongs to whoever owns the loop. This is the seam that says
   * "this bot has spoken", so the caller can hand the message to the wake path without
   * this file knowing there is one. Absent when nothing owns a kernel, as in a bare
   * `runTurn` in a test.
   */
  onSaid?: (message: Message) => void;
  /** An injectable clock, so a test does not depend on wall time. */
  now?: string;
}

/**
 * One observation as the work agent receives it: the entry, with the watch
 * side's answer taken off.
 *
 * `agent-lifecycle.md` §4, "what crosses the line from watch to work": *"The
 * observation entries are handed over; the reasoning stays on the record."* The
 * section gives the reason in one sentence — a reason in the work agent's
 * context is not advice, it is a premise, and where the watch agent is wrong the
 * expensive one would amplify rather than correct it — and it gives the remedy:
 * *"The runtime never puts it in the work agent's context, and the work agent
 * may go and read it."* The reason is still on the entry in the store; what it
 * cannot do is ride along in here.
 *
 * So this is a copy with `verdict` and `reason` removed, and everything else
 * kept: the entry is what the turn was woken for, and a work agent that cannot
 * see whose message it is answering has been handed a riddle instead of a turn.
 */
export type HandedEntry = Omit<Observation, 'verdict' | 'reason'>;

/**
 * The room's box as the turn reads it: the note, and the observations after it.
 *
 * Oldest first, which is the order the record wrote them and the order a
 * conversation is read in. `box.ts` builds it newest-first, because a judgement
 * fills its window from the newest end; the reversal happens once, in `runTurn`,
 * so no reader has to know which end either shape starts at.
 */
export interface TurnBox {
  /** The last compaction's result, when the room has one. */
  summary?: string;
  /** Every observation since it, oldest first. */
  entries: HandedEntry[];
}

/**
 * Whose agent this is — the bot's identity and the roster of its agents,
 * itself included (`agent-lifecycle.md` §2).
 *
 * Read from the store when this turn opens rather than when the loop was built,
 * so a renamed bot or a new roster row reaches the next turn without a
 * migration. Nothing of it is stored on the agent: the copy in the store stays
 * the only one, which is what keeps a name from disagreeing with itself.
 */
export interface TurnContext {
  botId: Id;
  agentId: Id;
  sessionId: Id;
  turnId: Id;
  /** Absent on a reminder's turn: a reminder is in no room (§12). */
  roomId?: Id;
  /** The bot it belongs to, and every agent of that bot: pushed, never stored. */
  identity: AgentIdentity;
  /**
   * The entries that woke it, and nothing else.
   *
   * This is *what woke me*, not *what I read* — the box below is what the turn
   * opens with. It is kept separate because it answers a different question: a
   * turn woken by exactly one message is answering that message and says so by
   * linking its reply to it (`work-server.ts`, `replyOf`), which a box holding
   * twenty observations cannot tell.
   *
   * No verdict, no reason: those are the watch side's answer to a question this
   * agent was never asked (§4).
   */
  entries: HandedEntry[];
  /**
   * The room's box as it stands, oldest first: the note written last time and
   * every observation since it (`box.ts`).
   *
   * Absent on a reminder's turn, which is in no room (§12) and so has no box to
   * read — what it opens with is the reminder itself.
   */
  box?: TurnBox;
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
 *
 * **What it returns is what the turn spent, and it is the only source of that
 * figure.** The runtime does not count tokens: it would be measuring the prompt it
 * assembled rather than the one the server read, and the two diverge by the chat
 * template the server wraps around it. So the decision that ran the model reports back
 * the usage the model reported, and `runTurn` writes it on the ledger row. A decision
 * that calls no model returns nothing, which is the placeholder path and is not the same
 * statement as "spent zero" — the row's zeros are honest there because nothing ran.
 */
export type Decide = (context: TurnContext) => Promise<TokenUsage | void> | TokenUsage | void;

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
 *
 * **The two token counts are the decision's report, not this file's estimate.** A turn
 * is where a cost is recorded — `docs/host-rulings.md`, "No spending cap", says recorded
 * and visible and never enforced — and only the thing that ran the model knows what it
 * spent, so `Decide` returns the figure and this file writes it down. A decision that
 * returns nothing leaves the row's zeros, which is the placeholder path and is honest
 * there: nothing ran, so nothing was spent.
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

  // §2: whose agent this is, read *here* rather than when the loop was built.
  // A bot renamed between two turns is seen renamed by the second one, and a
  // roster row added meanwhile arrives with no migration — which is the whole of
  // "pushed, not stored". Read before the ledger row is written, so a store that
  // cannot answer fails like the unknown-agent guard above rather than leaving a
  // turn that ran with nobody's identity.
  const identity = identityFor(store, agent.bot_id, agent.id);

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
    spec.onSaid?.(message);
  });
  // §12: the tool over the one table, bound the same way. A row written here is
  // saved with the turn — the `store.save()` in the `finally` below makes both
  // the row and the turn's own ledger durable together.
  const schedule = scheduleAs(
    store,
    agent.bot_id,
    agent.id,
    spec.onScheduleWritten,
  );

  // What the decision reports having spent, held across the `finally` so a turn that
  // throws still closes its row. `null` is "nobody reported anything", which is the
  // placeholder path and also a server that answered without a usage block.
  // §4: what the turn opens with is the room's box, read off the record here so no
  // caller can hand it a different one, and so a turn can never be woken with a
  // window into a conversation it is being asked to continue.
  const box = spec.roomId === undefined ? undefined : boxFor(store, agent.bot_id, spec.roomId);

  let spent: TokenUsage | null = null;
  try {
    spent = (await decide({
      botId: agent.bot_id,
      agentId: agent.id,
      sessionId: session.id,
      turnId: turn.id,
      roomId: spec.roomId,
      identity,
      entries: spec.entries.map(handOver),
      ...(box === undefined ? {} : { box }),
      say,
      schedule,
    })) ?? null;
  } finally {
    // A turn carries what it spent, and this is the only writer of those two numbers
    // (`docs/host-rulings.md`, "No spending cap": recorded and visible, never enforced).
    // It is written from the decision's own report and from nothing else — a rule about
    // what a turn *should* cost would be the spending budget the ruling refuses, wearing
    // a different hat. A decision that threw has no report, and the row keeps the zeros
    // it was created with rather than inventing a figure for work it cannot see.
    turn.input_tokens = spent?.input_tokens ?? 0;
    turn.output_tokens = spent?.output_tokens ?? 0;
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
  onScheduleWritten?: (row: ScheduleRow) => void,
  onSaid?: (message: Message) => void,
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
      await runTurn(
        store,
        { agentId: agent.id, roomId, entries: group, onScheduleWritten, onSaid },
        decide,
      );
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

/**
 * The entry as it crosses into the work agent's context.
 *
 * A copy, never the stored record: handing over the entry itself would let the
 * model's turn mutate a queue row it does not own, and would put the watch
 * side's verdict and reason within reach of a prompt that §4 keeps them out of.
 */
function handOver(entry: Observation): HandedEntry {
  const { verdict, reason, ...crosses } = entry;
  // Named so a later edit cannot quietly keep one of them and still compile.
  void verdict;
  void reason;
  return crosses;
}

/**
 * The room's box, as the turn opens with it.
 *
 * **The window is infinite on purpose.** What bounds this box is the compaction
 * threshold, not a number picked here: no work model's window has been measured in
 * this repository, and a figure invented now would refuse a turn over a guess. It is
 * the same trade the judgement's box makes from the other end — its window is a
 * measured count, and the same threshold is what keeps that count from having to
 * grow.
 *
 * Reversed once, here: `buildBox` fills from the newest end because a judgement has
 * to, and a turn reads a conversation oldest first. `handOver` strips the verdict
 * and the reason off every entry, exactly as it does for the entries that woke the
 * turn — the box is the record, never the watch side's answer to it.
 */
function boxFor(store: SeekStore, botId: Id, roomId: Id): TurnBox {
  const built = buildBox(store, botId, roomId, { window: Number.POSITIVE_INFINITY });
  const box: TurnBox = { entries: [...built.delta].reverse().map(handOver) };
  if (built.summary !== undefined) box.summary = built.summary;
  return box;
}
