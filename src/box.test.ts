import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildBox } from './box.ts';
import { RoomCompactor } from './compact.ts';
import { deliver } from './delivery.ts';
import { makeWorld, type World } from './fixtures.ts';

function fill(world: World, count: number, senderId = world.me): string[] {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const { message } = deliver(world.store, {
      roomId: world.room,
      senderId,
      text: `m${index}`,
    });
    ids.push(message.id);
  }
  return ids;
}

test('a box that fits reads every entry, newest first, with nothing unread', () => {
  const world = makeWorld();
  const ids = fill(world, 3);
  const box = buildBox(world.store, world.botA, world.room, { window: 10 });

  assert.equal(box.read, 3);
  assert.equal(box.total, 3);
  assert.equal(box.unread, 0);
  assert.deepEqual(
    box.delta.map((entry) => entry.message_id),
    [ids[2], ids[1], ids[0]],
    'newest first',
  );
});

test('an over-full box keeps the newest, and the unread count says how many were left', () => {
  const world = makeWorld();
  const ids = fill(world, 5);
  const box = buildBox(world.store, world.botA, world.room, { window: 2 });

  assert.equal(box.read, 2);
  assert.equal(box.total, 5);
  assert.equal(box.unread, 3);
  assert.equal(box.read + box.unread, box.total);
  assert.deepEqual(
    box.delta.map((entry) => entry.message_id),
    [ids[4], ids[3]],
    'the two newest, not the two oldest',
  );
});

test('the window is never exceeded, even by one entry that cannot fit', () => {
  const world = makeWorld();
  fill(world, 3);
  const box = buildBox(world.store, world.botA, world.room, {
    window: 2,
    // Every entry costs more than the whole window.
    weigh: () => 3,
  });

  assert.equal(box.read, 0, 'an oversized entry is not quietly let in');
  assert.equal(box.unread, 3, 'and it shows up as unread');
});

test('weigh() makes the window a budget rather than a count', () => {
  const world = makeWorld();
  const ids = fill(world, 4);
  // The last entry is expensive; the rest are cheap.
  const box = buildBox(world.store, world.botA, world.room, {
    window: 3,
    weigh: (entry) => (entry.message_id === ids[3] ? 2 : 1),
  });

  assert.equal(box.read, 2, 'one expensive plus one cheap fits in three');
  assert.equal(box.unread, 2);
  assert.deepEqual(
    box.delta.map((entry) => entry.message_id),
    [ids[3], ids[2]],
  );
});

test('a weigh() that returns no real cost is refused, not looped on', () => {
  const world = makeWorld();
  fill(world, 1);
  for (const cost of [0, -1, Number.NaN]) {
    assert.throws(
      () => buildBox(world.store, world.botA, world.room, { window: 5, weigh: () => cost }),
      /positive number/,
    );
  }
});

test('an empty room gives an empty box, not an error', () => {
  const world = makeWorld();
  const box = buildBox(world.store, world.botA, world.room, { window: 5 });

  assert.deepEqual(box.delta, []);
  assert.equal(box.read, 0);
  assert.equal(box.unread, 0);
  assert.equal(box.summary, undefined);
  assert.equal(box.lastVerdict, undefined);
  assert.deepEqual(box.whoSpoke, []);
});

test('the summary is the digest that exists, and a judgement does not wait for one', () => {
  const world = makeWorld();
  fill(world, 2);

  // Nothing compacted yet: an empty summary and a long delta still read.
  const before = buildBox(world.store, world.botA, world.room, { window: 10 });
  assert.equal(before.summary, undefined);
  assert.equal(before.read, 2);

  const compactor = new RoomCompactor(world.store, {
    summarise: () => 'what this room is',
    lines: { maxObservations: 2 },
    now: () => '2026-10-24T01:00:00.000Z',
  });
  // A compaction in flight must not block the read: the box is whatever exists.
  void compactor.compact(world.botA, world.room);
  const during = buildBox(world.store, world.botA, world.room, { window: 10 });
  assert.equal(during.read, 2);
});

test('a digest narrows the delta to what it has not consumed', async () => {
  const world = makeWorld();
  fill(world, 2);
  const compactor = new RoomCompactor(world.store, {
    summarise: () => 'the first two settled',
    lines: { maxObservations: 2 },
    now: () => '2026-10-24T01:00:00.000Z',
  });
  await compactor.compact(world.botA, world.room);

  const compacted = buildBox(world.store, world.botA, world.room, { window: 10 });
  assert.equal(compacted.summary, 'the first two settled');
  assert.equal(compacted.total, 0);

  fill(world, 1);
  const after = buildBox(world.store, world.botA, world.room, { window: 10 });
  assert.equal(after.summary, 'the first two settled');
  assert.equal(after.total, 1, 'only what arrived after the digest');
});

test('the last verdict is read off the entry it was written on', () => {
  const world = makeWorld();
  fill(world, 3);
  const queued = world.store.inbox(world.botA);
  // The loop writes verdicts; the box only reads them.
  queued[1].verdict = 'keep';
  queued[2].verdict = 'snooze';

  const box = buildBox(world.store, world.botA, world.room, { window: 10 });
  assert.equal(box.lastVerdict?.verdict, 'snooze', 'the newest one wins');
  assert.equal(box.lastVerdict?.entryId, queued[2].id);
  assert.equal(box.lastVerdict?.delivered_at, queued[2].delivered_at);
  assert.equal(box.observationsSinceLastVerdict, 0);

  // A verdict older than the newest entry reports how stale it is.
  queued[2].verdict = undefined;
  const stale = buildBox(world.store, world.botA, world.room, { window: 10 });
  assert.equal(stale.lastVerdict?.verdict, 'keep');
  assert.equal(stale.observationsSinceLastVerdict, 1);
});

test('no verdict on the record means no last verdict, and no staleness', () => {
  const world = makeWorld();
  fill(world, 2);
  const box = buildBox(world.store, world.botA, world.room, { window: 10 });
  assert.equal(box.lastVerdict, undefined);
  assert.equal(box.observationsSinceLastVerdict, undefined);
});

test('who spoke is counted off the messages, not stored on the box', () => {
  const world = makeWorld();
  fill(world, 2, world.me);
  fill(world, 1, world.botB);

  const box = buildBox(world.store, world.botA, world.room, { window: 10 });
  const byId = new Map(box.whoSpoke.map((speaker) => [speaker.principalId, speaker]));
  assert.equal(byId.get(world.me)?.count, 2);
  assert.equal(byId.get(world.me)?.name, 'me');
  assert.equal(byId.get(world.botB)?.count, 1);
  assert.equal(box.whoSpoke.length, 2);
});

test('who spoke puts the busiest speaker first', () => {
  const world = makeWorld();
  fill(world, 1, world.botB);
  fill(world, 3, world.me);

  // The order is part of what the box says: a judgement reads the room’s
  // shape, so the speaker it hears most has to come first.
  const box = buildBox(world.store, world.botA, world.room, { window: 10 });
  assert.deepEqual(
    box.whoSpoke.map((speaker) => speaker.principalId),
    [world.me, world.botB],
  );
});

test('the question set is the caller’s, and absent when nobody has one', () => {
  const world = makeWorld();
  fill(world, 1);

  const without = buildBox(world.store, world.botA, world.room, { window: 5 });
  assert.equal('questions' in without, false, 'no invented question set');

  const questions = [{ name: 'act', options: ['act', 'not'] }];
  const with_ = buildBox(world.store, world.botA, world.room, {
    window: 5,
    questions,
  });
  assert.deepEqual(with_.questions, questions);
});

test('building a box writes nothing and opens no turn', () => {
  const world = makeWorld();
  fill(world, 3);
  const before = {
    messages: world.store.messagesOf(world.room).length,
    turns: world.store.data.turns.length,
    memories: world.store.memoriesOf(world.agentA2).length,
    inbox: world.store.inbox(world.botA).length,
  };

  buildBox(world.store, world.botA, world.room, { window: 2 });

  assert.equal(world.store.messagesOf(world.room).length, before.messages);
  assert.equal(world.store.data.turns.length, before.turns, 'not a turn');
  assert.equal(world.store.memoriesOf(world.agentA2).length, before.memories);
  assert.equal(world.store.inbox(world.botA).length, before.inbox, 'the queue is untouched');
});

test('a box is per bot: each bot reads its own queue', () => {
  const world = makeWorld();
  fill(world, 2);
  const boxA = buildBox(world.store, world.botA, world.room, { window: 10 });
  const boxB = buildBox(world.store, world.botB, world.room, { window: 10 });

  assert.equal(boxA.botId, world.botA);
  assert.equal(boxB.botId, world.botB);
  assert.equal(boxA.total, 2);
  assert.equal(boxB.total, 2);
  assert.notEqual(boxA.delta[0].id, boxB.delta[0].id, 'two entries, one per bot');
});
