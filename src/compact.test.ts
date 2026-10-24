import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RoomCompactor } from './compact.ts';
import { deliver } from './delivery.ts';
import { makeWorld, type World } from './fixtures.ts';

/** `count` deliveries into the world's room, from the human, numbered from `start`. */
function fill(world: World, count: number, start = 0): void {
  for (let index = start; index < start + count; index += 1) {
    deliver(world.store, {
      roomId: world.room,
      senderId: world.me,
      text: `m${index}`,
    });
  }
}

const AT = '2026-10-24T01:00:00.000Z';

test('the summary is the work agent’s, and the watch agent keeps no row', async () => {
  const world = makeWorld();
  fill(world, 3);
  const compactor = new RoomCompactor(world.store, {
    summarise: () => 'the room, and what has been settled',
    lines: { maxObservations: 2 },
    now: () => AT,
  });

  const outcome = await compactor.compact(world.botA, world.room);
  assert.equal(outcome.ran, true);

  const digests = world.store
    .memoriesOf(world.agentA2)
    .filter((row) => row.level === 'room_digest');
  assert.equal(digests.length, 1);
  assert.equal(digests[0].room_id, world.room);
  assert.equal(digests[0].body, 'the room, and what has been settled');
  assert.equal(digests[0].updated_at, AT);

  // The half that cannot write owns nothing: a second copy would only be a
  // second version to disagree with.
  assert.equal(world.store.memoriesOf(world.agentA1).length, 0);
});

test('one digest per room per bot, and a second compaction replaces it', async () => {
  const world = makeWorld();
  fill(world, 2);
  const compactor = new RoomCompactor(world.store, {
    summarise: ({ delta }) => `covering ${delta.length}`,
    lines: { maxObservations: 2 },
    now: () => AT,
  });

  await compactor.compact(world.botA, world.room);
  fill(world, 2, 2);
  await compactor.compact(world.botA, world.room);

  const rows = world.store.memoriesOf(world.agentA2);
  assert.equal(rows.length, 1, 'rolling, not appended');
  assert.equal(rows[0].body, 'covering 2');
  assert.equal(rows[0].consumed_to, world.store.inbox(world.botA).at(-1)?.id);

  // Per bot: the other bot's bot-level box is its own.
  await compactor.compact(world.botB, world.room);
  assert.equal(world.store.memoriesOf(world.agentB1).length, 1);
  assert.notEqual(
    world.store.memoriesOf(world.agentB1)[0].agent_id,
    world.store.memoriesOf(world.agentA2)[0].agent_id,
  );
});

test('compaction opens no turn and produces no message', async () => {
  const world = makeWorld();
  fill(world, 2);
  const messagesBefore = world.store.messagesOf(world.room).length;
  const turnsBefore = world.store.data.turns.length;

  const compactor = new RoomCompactor(world.store, {
    summarise: () => 'summary',
    lines: { maxObservations: 2 },
    now: () => AT,
  });
  const outcome = await compactor.compact(world.botA, world.room);

  assert.equal(outcome.ran, true);
  assert.equal(world.store.data.turns.length, turnsBefore, 'not a turn');
  assert.equal(
    world.store.messagesOf(world.room).length,
    messagesBefore,
    'nothing said into the room',
  );
});

test('two compactions over one room run one summary, not two', async () => {
  const world = makeWorld();
  fill(world, 2);

  let calls = 0;
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const compactor = new RoomCompactor(world.store, {
    summarise: async () => {
      calls += 1;
      await held;
      return 'summary';
    },
    lines: { maxObservations: 2 },
    now: () => AT,
  });

  const first = compactor.compact(world.botA, world.room);
  const second = compactor.compact(world.botA, world.room);
  release();
  const [a, b] = await Promise.all([first, second]);

  assert.equal(calls, 1, 'the second caller joins the run in flight');
  assert.equal(a.ran, true);
  assert.equal(b.ran, true);
  assert.equal(world.store.memoriesOf(world.agentA2).length, 1);
});

test('an observation that arrives during a compaction stays in the delta', async () => {
  const world = makeWorld();
  fill(world, 2);

  const compactor = new RoomCompactor(world.store, {
    summarise: () => {
      // The room keeps moving while the summary is being written.
      deliver(world.store, {
        roomId: world.room,
        senderId: world.me,
        text: 'meanwhile',
      });
      return 'summary';
    },
    lines: { maxObservations: 2 },
    now: () => AT,
  });
  const outcome = await compactor.compact(world.botA, world.room);
  assert.equal(outcome.ran, true);

  // The summary covers what it read. The arrival is not inside it and not lost:
  // it is still on the queue, and it is the whole delta.
  assert.equal(world.store.inbox(world.botA).length, 3);
  const delta = compactor.delta(world.botA, world.room);
  assert.equal(delta.length, 1);
  assert.equal(delta[0].message_id, world.store.messagesOf(world.room).at(-1)?.id);
});

test('the delta is the queue after the consumed-to point, and the whole queue once it is gone', async () => {
  const world = makeWorld();
  fill(world, 3);
  const compactor = new RoomCompactor(world.store, {
    summarise: () => 'summary',
    lines: { maxObservations: 1 },
    now: () => AT,
  });

  await compactor.compact(world.botA, world.room);
  assert.equal(compactor.delta(world.botA, world.room).length, 0);

  fill(world, 2, 3);
  assert.equal(compactor.delta(world.botA, world.room).length, 2);

  // The loop drains the queue; the point leaves with it, so what is queued for
  // the room afterwards arrived after it.
  await world.store.drain(world.botA);
  fill(world, 1, 5);
  assert.equal(compactor.delta(world.botA, world.room).length, 1);
});

test('a judgement reading the box never waits for a compaction', async () => {
  const world = makeWorld();
  fill(world, 2);
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const compactor = new RoomCompactor(world.store, {
    summarise: async () => {
      await held;
      return 'summary';
    },
    lines: { maxObservations: 2 },
    now: () => AT,
  });

  const running = compactor.compact(world.botA, world.room);
  assert.equal(compactor.inFlight(world.botA, world.room), true);
  // Mid-flight the box is read as it stands — it is not held behind the write.
  assert.equal(compactor.delta(world.botA, world.room).length, 2);

  release();
  const outcome = await running;
  assert.equal(outcome.ran, true);
  assert.equal(compactor.inFlight(world.botA, world.room), false);
});

test('with no summariser nothing is due and nothing is written', async () => {
  const world = makeWorld();
  fill(world, 3);
  const compactor = new RoomCompactor(world.store, {
    lines: { maxObservations: 1 },
  });

  assert.equal(compactor.due(world.botA, world.room), false);
  assert.deepEqual(await compactor.compact(world.botA, world.room), {
    ran: false,
    reason: 'no-summarise',
  });
  assert.equal(world.store.memoriesOf(world.agentA2).length, 0);
});

test('only a stated line makes a delta due', async () => {
  const world = makeWorld();
  fill(world, 2);

  // No numbers are invented: with no line configured, nothing is ever due.
  const silent = new RoomCompactor(world.store, { summarise: () => 's' });
  assert.equal(silent.due(world.botA, world.room), false);
  assert.deepEqual(await silent.compact(world.botA, world.room), {
    ran: false,
    reason: 'not-due',
  });

  const short = new RoomCompactor(world.store, {
    summarise: () => 's',
    lines: { maxObservations: 3 },
  });
  assert.equal(short.due(world.botA, world.room), false);

  const reached = new RoomCompactor(world.store, {
    summarise: () => 's',
    lines: { maxObservations: 2 },
  });
  assert.equal(reached.due(world.botA, world.room), true);
});

test('an age line is measured against the oldest entry, on the injected clock', async () => {
  const world = makeWorld();
  fill(world, 2);
  // One old entry and one fresh one: a line crossed only by the oldest is the
  // case that tells "oldest" apart from "newest".
  const queued = world.store.inbox(world.botA);
  queued[0].delivered_at = '2026-10-24T00:00:00.000Z';
  queued[1].delivered_at = '2026-10-24T00:01:30.000Z';

  const early = new RoomCompactor(world.store, {
    summarise: () => 's',
    lines: { maxAgeMs: 60_000 },
    now: () => '2026-10-24T00:00:30.000Z',
  });
  assert.equal(early.due(world.botA, world.room), false);

  // 100s after the oldest, 10s after the newest: only the oldest has crossed.
  const late = new RoomCompactor(world.store, {
    summarise: () => 's',
    lines: { maxAgeMs: 60_000 },
    now: () => '2026-10-24T00:01:40.000Z',
  });
  assert.equal(late.due(world.botA, world.room), true);
});

test('a failing summariser writes nothing and backs off until the delta grows', async () => {
  const world = makeWorld();
  fill(world, 2);
  const compactor = new RoomCompactor(world.store, {
    summarise: () => {
      throw new Error('the model is offline');
    },
    lines: { maxObservations: 2 },
    now: () => AT,
  });

  assert.deepEqual(await compactor.compact(world.botA, world.room), {
    ran: false,
    reason: 'failed',
  });
  assert.equal(world.store.memoriesOf(world.agentA2).length, 0);

  // The same delta is not re-fired on the next tick: back off, do not retry in
  // a loop.
  assert.equal(compactor.due(world.botA, world.room), false);

  fill(world, 1, 2);
  assert.equal(compactor.due(world.botA, world.room), true);
});

test('a bot with no work agent has no writer', async () => {
  const world = makeWorld();
  fill(world, 2);
  delete world.store.data.agents[world.agentB1];
  const compactor = new RoomCompactor(world.store, {
    summarise: () => 's',
    lines: { maxObservations: 1 },
  });

  assert.deepEqual(await compactor.compact(world.botB, world.room), {
    ran: false,
    reason: 'no-work-agent',
  });
  assert.equal(compactor.due(world.botB, world.room), false);
});
