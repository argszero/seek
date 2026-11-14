/**
 * §11.6's third ending: at a wall the agent stops and records it.
 *
 * `docs/design/agent-lifecycle.md` §11.6 gives an agent three deliberate endings at the depth cap
 * or the room's turn cap — escalate, say so in the room, stop and record — and forbids the fourth:
 * *"What it may not do is drop the question without a trace… Silence is allowed; silence that
 * nobody can see is not."* Before this file's subject existed, the wall held the waking entry
 * (`chain.ts` `chainBlock()`) and nothing wrote anything down: the bot was not woken, no turn ran,
 * and the room had no trace at all.
 *
 * **Which turn writes it is the whole design question, and the answer is not the obvious one.** It
 * is not the turn the wall blocks — there is no such turn, because the arbiter keeps the entry and
 * the loop does not wake the bot for it. It is the turn whose own facts *reached* the wall: the one
 * that sent a reply at `DEPTH_CAP`, and the one whose end took the room to `AGENT_TURN_CAP`. A
 * record that waited for a turn that never opens would be a record that never happens.
 *
 * **Nothing here writes a message or a turn by hand.** The chain is built by `say()` and the turns
 * by `runTurn()`, which is what makes the readings here readings of the kernel rather than of this
 * file's idea of it — the failure `snapshot.test.mjs` records for `at` and `kind`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AGENT_TURN_CAP, DEPTH_CAP, agentTurnsIn } from './chain.ts';
import { reasonAtTheWall, recordTheWall } from './diary.ts';
import { makeWorld } from './fixtures.ts';
import { say } from './say.ts';
import { runTurn, type Decide } from './turn.ts';
import type { Message } from './types.ts';

const AT = '2026-10-24T02:00:00.000Z';

type World = ReturnType<typeof makeWorld>;

/** A room whose bot turn cap is already spent, and the rows recording it. */
async function turnsToTheCap(world: World, count: number): Promise<void> {
  for (let turn = 0; turn < count; turn += 1) {
    await runTurn(world.store, { agentId: world.agentA2, roomId: world.room, entries: [], now: AT });
  }
}

/** A chain of replies, one hop at a time, ending at the depth asked for. */
function chainToDepth(world: World, depth: number): Message {
  let last: Message | undefined;
  // A run's first message is its own root and sits at depth **0**, so reaching depth `d` takes
  // `d + 1` messages — read off `delivery.ts` (depth is the parent's plus one) rather than
  // assumed, which is what a loop of `d` messages gets wrong by one.
  while (last === undefined || last.depth < depth) {
    last = say(world.store, {
      botId: world.botA,
      agentId: world.agentA2,
      roomId: world.room,
      text: `hop ${last === undefined ? 0 : last.depth + 1}`,
      ...(last === undefined ? {} : { replyTo: last.id }),
    });
  }
  assert.equal(last.depth, depth, `the chain reached depth ${last.depth}, not ${depth}`);
  return last;
}

test('the wall is read from the two facts the arbiter reads, and a reminder has none', () => {
  const world = makeWorld();
  // A room sitting below its cap, and a turn that produced no message: nothing was reached.
  assert.equal(reasonAtTheWall(world.room, [], 0), undefined);
  assert.equal(reasonAtTheWall(world.room, [], AGENT_TURN_CAP - 2), undefined);

  // The turn whose end takes the run **to** the cap is the one that reached it — read from the
  // count before it, because afterwards the room only says where it stands.
  assert.equal(reasonAtTheWall(world.room, [], AGENT_TURN_CAP - 1), 'room_agent_turns');

  // §12: a reminder has no room, so it has no thread to rest and nothing to record.
  assert.equal(reasonAtTheWall(undefined, [], AGENT_TURN_CAP - 1), undefined);
});

test('a message at the depth cap is the depth wall, and it outranks the room count', () => {
  const world = makeWorld();
  const deep = chainToDepth(world, DEPTH_CAP);
  assert.equal(deep.depth, DEPTH_CAP, 'the chain reached the cap the design names');
  // Both walls are reachable in one turn; the depth is the one named, in `chainBlock()`'s order.
  assert.equal(reasonAtTheWall(world.room, [deep], AGENT_TURN_CAP - 1), 'depth');
});

test('the turn that takes the room to its cap writes one row, and the turns after it write none', async () => {
  const world = makeWorld();
  await turnsToTheCap(world, AGENT_TURN_CAP - 1);
  assert.equal(world.store.memoriesOf(world.agentA2).length, 0, 'nothing has been reached yet');

  await turnsToTheCap(world, 1);
  assert.equal(agentTurnsIn(world.store, world.room), AGENT_TURN_CAP);

  const rows = world.store.memoriesOf(world.agentA2);
  assert.equal(rows.length, 1, 'the crossing is recorded once');
  const row = rows[0]!;
  assert.equal(row.level, 'diary');
  assert.equal(row.agent_id, world.agentA2);
  assert.equal(row.room_id, world.room);
  // The reason is the code the entry's own `hints.chainBlocked` carries, not a sentence: the
  // window words it, and a sentence written here would be English inside a Chinese window.
  assert.equal(row.body, 'room_agent_turns');
  // Stamped with the turn's own end — one instant for the row and the ledger it belongs beside.
  assert.equal(row.updated_at, AT);
  // A diary row accounts for no stretch of observations, which is what absent `consumed_to` says.
  assert.equal(row.consumed_to, undefined);

  // **A crossing, not a state.** A room left sitting past its cap does not grow a diary every
  // time a turn runs there.
  await turnsToTheCap(world, 1);
  assert.equal(world.store.memoriesOf(world.agentA2).length, 1);
});

test('the row is the agent that ran the turn, and no other agent of either bot has one', async () => {
  const world = makeWorld();
  await turnsToTheCap(world, AGENT_TURN_CAP);

  assert.equal(world.store.memoriesOf(world.agentA2).length, 1);
  // The watch half of the same bot never runs a turn, and the other bot's agent was not there.
  assert.equal(world.store.memoriesOf(world.agentA1).length, 0);
  assert.equal(world.store.memoriesOf(world.agentB1).length, 0);
});

test('a turn that answers at the depth cap writes the depth record, through the turn that ran it', async () => {
  const world = makeWorld();
  const deepest = chainToDepth(world, DEPTH_CAP - 1);
  assert.equal(deepest.depth, DEPTH_CAP - 1);

  // The decision speaks one reply under the deepest message, so the tool — not this test — builds
  // the message that lands on the cap.
  const answer: Decide = ({ say: speak }) => {
    speak(world.room, 'one more', { replyTo: deepest.id });
  };
  await runTurn(
    world.store,
    { agentId: world.agentA2, roomId: world.room, entries: [], now: AT },
    answer,
  );

  const rows = world.store.memoriesOf(world.agentA2);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.body, 'depth');
  assert.equal(rows[0]!.room_id, world.room);
});

test('a turn with no room writes no row, and the store it saves is the one that is read back', async () => {
  const world = makeWorld();
  // §12's reminder turn: it opens, closes, and touches no room's counter and no room's diary.
  await runTurn(world.store, { agentId: world.agentA2, entries: [], now: AT });
  assert.equal(agentTurnsIn(world.store, world.room), 0);
  assert.equal(world.store.memoriesOf(world.agentA2).length, 0);

  // And the row a wall did write is in the store's own data, in the shape it is written to disk
  // and read back from: `runTurn` writes it inside the `finally` that saves once at the end, so a
  // record that lived only in a local would be gone at the next open.
  await turnsToTheCap(world, AGENT_TURN_CAP);
  const written = world.store.memoriesOf(world.agentA2);
  assert.equal(written.length, 1);
  const back = JSON.parse(JSON.stringify(world.store.data)) as typeof world.store.data;
  assert.equal(back.memories[world.agentA2]?.length, 1);
  assert.equal(back.memories[world.agentA2]?.[0]?.body, 'room_agent_turns');
});

test('recordTheWall writes nothing when no wall was reached, and says so by returning nothing', () => {
  const world = makeWorld();
  const agent = world.store.data.agents[world.agentA2]!;
  assert.equal(recordTheWall(world.store, agent, world.room, [], 0, AT), undefined);
  assert.equal(world.store.memoriesOf(world.agentA2).length, 0);

  const row = recordTheWall(world.store, agent, world.room, [], AGENT_TURN_CAP - 1, AT);
  assert.ok(row, 'the crossing at the cap is a row');
  assert.equal(row.level, 'diary');
  assert.equal(world.store.memoriesOf(world.agentA2).length, 1);
});
