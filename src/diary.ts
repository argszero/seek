/**
 * §11.6's third ending: at a wall, record it and let the thread rest.
 *
 * `docs/design/agent-lifecycle.md` §11.6 gives an agent exactly three deliberate
 * endings at the depth cap or the room's turn cap — escalate, say so in the room,
 * stop and record. This file is the third one and nothing else. The first two are
 * acts of a turn (a `say` to a direct room, a `say` to the room this turn is in)
 * and need no code of their own: what they need is a turn, and a turn at the wall
 * is exactly what the wall prevents.
 *
 * **Who writes it.** `docs/host-rulings.md` settles that: "memory writes and
 * compaction are runtime behaviour, as for any agent" — there is no memory tool
 * and none is to be added. So the diary row is a runtime write, like the box's
 * note, and it is written at the end of the turn.
 *
 * **Which turn.** The one whose own facts reached the wall — not the turn the wall
 * blocks, because there is no such turn: `chain.ts` holds the waking entry and
 * `gate.ts` settles it as `block`, so the bot is deliberately not woken and could
 * not choose an ending if it wanted to. A record that waited for the agent would
 * be a record that sometimes never happens, and §11.6 forbids precisely that —
 * "silence that nobody can see is not [allowed]".
 *
 * **Why the body is the reason and not a sentence.** Two readings, both already
 * the project's. `ui/electron/snapshot.js` states the split: "this layer carries
 * the fact and the window chooses the sentence" — a sentence written here would be
 * English shown inside a Chinese window, and the catalogue is where words live. And
 * a sentence about an agent that was never asked to write one is a claim nothing
 * measured. So the row carries the same closed vocabulary the entry's own
 * `hints.chainBlocked` already uses (`ChainBlockReason`), and the window puts it
 * into words.
 *
 * **A crossing, not a state.** Both readings are of the moment this turn became the
 * one that reached the wall: a message it sent at exactly `DEPTH_CAP`, and the room
 * arriving at `AGENT_TURN_CAP` because of this turn. Written as a state instead, a
 * room sitting past its cap would write a row for every turn that ever ran there
 * after a person spoke — a diary that grows without saying anything new.
 */

import { AGENT_TURN_CAP, DEPTH_CAP } from './chain.ts';
import { newId, type SeekStore } from './store.ts';
import type { Agent, ChainBlockReason, Id, Memory, Message } from './types.ts';

/**
 * Which wall this turn reached, or `undefined` for none.
 *
 * The two are asked in `chainBlock()`'s own order — depth first — so a turn that
 * reached both records the one the arbiter would have named. `botTurnsBefore` is
 * the room's run **before** this turn was counted: the turn whose end takes the
 * run to the cap is the one that reached it.
 */
export function reasonAtTheWall(
  roomId: Id | undefined,
  produced: readonly Message[],
  botTurnsBefore: number,
): ChainBlockReason | undefined {
  // A reminder has no room, and §12 says it does not touch this counter: there is
  // no thread to rest and nothing to record.
  if (roomId === undefined) return undefined;
  if (produced.some((message) => message.depth === DEPTH_CAP)) return 'depth';
  if (botTurnsBefore + 1 === AGENT_TURN_CAP) return 'room_agent_turns';
  return undefined;
}

/**
 * Write §11.6's record, or nothing.
 *
 * The row is sharded by the agent that ran the turn (`store.memoriesOf`), so it
 * lands in the work agent's own memory and no other agent can reach it — the
 * property `data-model.md` rule 8 gives that shard. It carries no `consumed_to`:
 * a diary row accounts for no stretch of observations, which is what the field
 * means and what the type says it is absent on.
 *
 * **Saved by the caller's own write.** `runTurn` calls this inside the `finally`
 * that ends the turn and saves once afterwards, so the row and the turn's ledger
 * land together or not at all — the same atomicity `compact.ts` gives a summary
 * and its consumed-to point.
 */
export function recordTheWall(
  store: SeekStore,
  agent: Agent,
  roomId: Id | undefined,
  produced: readonly Message[],
  botTurnsBefore: number,
  at: string,
): Memory | undefined {
  const reason = reasonAtTheWall(roomId, produced, botTurnsBefore);
  if (reason === undefined || roomId === undefined) return undefined;

  const row: Memory = {
    id: newId('mm'),
    agent_id: agent.id,
    level: 'diary',
    room_id: roomId,
    body: reason,
    updated_at: at,
  };
  store.memoriesOf(agent.id).push(row);
  return row;
}
