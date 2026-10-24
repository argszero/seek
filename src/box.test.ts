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

test('the reason comes back with the verdict, and only when there was one', () => {
  const world = makeWorld();
  fill(world, 2);
  const queued = world.store.inbox(world.botA);
  queued[0].verdict = 'ignore';
  queued[0].reason = 'not addressed to me, and someone else is answering';
  queued[1].verdict = 'keep';

  // The newer verdict carries no reason. That must stay absent rather than
  // become an empty string or the older entry's sentence.
  const newer = buildBox(world.store, world.botA, world.room, { window: 10 });
  assert.equal(newer.lastVerdict?.verdict, 'keep');
  assert.equal('reason' in (newer.lastVerdict ?? {}), false);

  // Drop it, and the older verdict comes back with its own sentence attached.
  queued[1].verdict = undefined;
  const older = buildBox(world.store, world.botA, world.room, { window: 10 });
  assert.equal(older.lastVerdict?.verdict, 'ignore');
  assert.equal(
    older.lastVerdict?.reason,
    'not addressed to me, and someone else is answering',
  );
  assert.equal(older.lastVerdict?.entryId, queued[0].id, 'the reason belongs to that entry');
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

test('who spoke puts the busiest speaker first, whatever the ids say', () => {
  const world = makeWorld();
  // The ids are fixed, and deliberately the wrong way round: the speaker who says
  // the most sorts *last* by id. `newId` is a random UUID slice, so a test over
  // `makeWorld`'s own principals agreed with an id sort about half the time and
  // pinned nothing — which is how a mutation survived a green suite.
  const quiet = 'ou_0000000000000001';
  const busy = 'ou_0000000000000002';
  const speakers: [string, string][] = [
    [quiet, 'quiet'],
    [busy, 'busy'],
  ];
  for (const [id, name] of speakers) {
    world.store.data.principals[id] = { id, kind: 'human', name };
    const membership = `mb_${name}`;
    world.store.data.memberships[membership] = {
      id: membership,
      room_id: world.room,
      principal_id: id,
      joined_at: '2026-10-24T00:00:00.000Z',
      role: 'member',
    };
  }
  fill(world, 1, quiet);
  fill(world, 3, busy);

  // The order is part of what the box says: a judgement reads the room’s
  // shape, so the speaker it hears most has to come first.
  const box = buildBox(world.store, world.botA, world.room, { window: 10 });
  assert.deepEqual(
    box.whoSpoke.map((speaker) => speaker.principalId),
    [busy, quiet],
    'by how much they said, not by id',
  );
  assert.deepEqual(box.whoSpoke.map((speaker) => speaker.count), [3, 1]);
});

test('the box is what the judgement is told, and it carries no question', () => {
  const world = makeWorld();
  fill(world, 1);

  const box = buildBox(world.store, world.botA, world.room, { window: 5 });

  // Asserted whole rather than one key at a time, because the point is the absence:
  // the question is what a judgement is *asked*, and it is the prompt artifact's own
  // last part (`prompts.ts` — `watch-v1`'s third part, whose trailing space is the
  // boundary the option token is appended at). A field here would be a second
  // question, free to disagree with the text the shipped cut was measured against,
  // and a key set spelled out is what makes adding one an edit somebody reviews
  // rather than a quiet arrival. `summary`, `lastVerdict` and
  // `observationsSinceLastVerdict` are missing here because this room has been
  // neither compacted nor judged.
  assert.deepEqual(Object.keys(box).sort(), [
    'botId',
    'delta',
    'media',
    'read',
    'roomId',
    'total',
    'unread',
    'whoSpoke',
  ]);
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

test('the entries a tick drained are still in the delta the box reads', async () => {
  const world = makeWorld();
  const ids = fill(world, 2);
  // The loop takes the whole queue before stage 0 or stage 1 sees anything. What
  // it takes is marked consumed rather than removed — a verdict lives on the entry
  // it judged — so the box still holds what woke the bot, with nothing handed back
  // in by a caller.
  await world.store.drain(world.botA);
  const later = fill(world, 1);

  const box = buildBox(world.store, world.botA, world.room, { window: 10 });
  assert.equal(box.total, 3, 'the drained entries are still on the record');
  assert.equal(box.read + box.unread, box.total);
  assert.deepEqual(
    box.delta.map((entry) => entry.message_id),
    [later[0], ids[1], ids[0]],
    'newest first, and each at its own arrival position',
  );
});

test("another room's entries are not let into this room's box", async () => {
  const world = makeWorld();
  const ids = fill(world, 1);
  await world.store.drain(world.botA);

  const here = buildBox(world.store, world.botA, world.room, { window: 10 });
  assert.equal(here.total, 1, 'the room the entry belongs to reads it');
  assert.deepEqual(here.delta.map((entry) => entry.message_id), ids);

  const elsewhere = buildBox(world.store, world.botA, 'oc_elsewhere', { window: 10 });
  assert.equal(elsewhere.total, 0, "a box is one room's");
  assert.deepEqual(elsewhere.delta, []);
});

function postImage(world: World, key: string, text = '看这张'): string {
  const { message } = deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    kind: 'image',
    text,
    media: { key, mime: 'image/png' },
  });
  return message.id;
}

test('a picture arrives with the entry that carries it, named and located', () => {
  const world = makeWorld();
  const messageId = postImage(world, 'blobs/screen.png');
  const box = buildBox(world.store, world.botA, world.room, { window: 10 });

  assert.equal(box.media.length, 1, 'the image is in the box, not only its text');
  const [picture] = box.media;
  assert.equal(picture.entryId, box.delta[0].id, 'the line it is the picture for');
  assert.equal(picture.messageId, messageId);
  assert.equal(picture.key, 'blobs/screen.png');
  assert.equal(picture.mime, 'image/png');
});

test('a picture the window left out is not handed over', () => {
  const world = makeWorld();
  postImage(world, 'blobs/old.png');
  const newest = postImage(world, 'blobs/new.png');

  const box = buildBox(world.store, world.botA, world.room, { window: 1 });
  assert.equal(box.read, 1);
  assert.equal(box.unread, 1, 'the older entry is outside what the judgement read');
  assert.deepEqual(
    box.media.map((picture) => picture.key),
    ['blobs/new.png'],
    'an image whose entry was left out is not slipped in beside the ones that fit',
  );
  assert.equal(box.media[0].messageId, newest);
});

test('a box of text has an empty media list rather than a missing one', () => {
  const world = makeWorld();
  fill(world, 2);
  const box = buildBox(world.store, world.botA, world.room, { window: 10 });

  assert.deepEqual(box.media, []);
  assert.equal(box.read, 2);
});
