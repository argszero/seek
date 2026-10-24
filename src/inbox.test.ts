import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deliver } from './delivery.ts';
import { makeWorld } from './fixtures.ts';
import { InboxLoop } from './inbox.ts';
import { SeekStore } from './store.ts';
import type { Id } from './types.ts';

function textOf(store: SeekStore, roomId: Id, messageId: Id): string {
  const message = store.messagesOf(roomId).find((m) => m.id === messageId);
  assert.ok(message, `message ${messageId} is on the room's log`);
  return message.text;
}

function deferred(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** A store whose save can be held open, so a delivery can land mid-drain. */
class HoldingStore extends SeekStore {
  gate: Promise<void> = Promise.resolve();
  hold = false;

  async save(): Promise<void> {
    if (this.hold) {
      this.hold = false;
      await this.gate;
    }
    await super.save();
  }
}

test('an empty inbox opens no turn', async () => {
  const world = makeWorld();
  const seen: number[] = [];
  const loop = new InboxLoop(world.store, (entries) => {
    seen.push(entries.length);
  });

  const result = await loop.tick(world.botA);

  assert.equal(result.woke, false);
  assert.deepEqual(result.entries, []);
  assert.equal(seen.length, 0);
  assert.equal(loop.turns, 0);
});

test('the drain takes the whole queue in one step, and nothing is left behind', async () => {
  const world = makeWorld();
  for (const text of ['one', 'two', 'three']) {
    deliver(world.store, {
      roomId: world.room,
      senderId: world.me,
      text,
    });
  }

  const seen: string[][] = [];
  const loop = new InboxLoop(world.store, (entries) => {
    seen.push(
      entries.map((entry) => textOf(world.store, world.room, entry.message_id)),
    );
  });

  const result = await loop.tick(world.botA);

  assert.equal(result.woke, true);
  assert.deepEqual(seen, [['one', 'two', 'three']]);
  assert.equal(world.store.inbox(world.botA).length, 0);

  // With nothing left, the next tick does not wake it a second time.
  const again = await loop.tick(world.botA);
  assert.equal(again.woke, false);
  assert.equal(loop.turns, 1);
});

test('an arrival during the drain survives to the next round', async () => {
  const world = makeWorld();
  const store = new HoldingStore(world.store.data);
  deliver(store, { roomId: world.room, senderId: world.me, text: 'first' });

  const hold = deferred();
  store.gate = hold.promise;
  store.hold = true;

  const drained = store.drain(world.botA);

  // Lands after the queue was popped and before the save finished.
  deliver(store, { roomId: world.room, senderId: world.me, text: 'second' });
  hold.release();

  const taken = await drained;
  assert.deepEqual(
    taken.map((entry) => textOf(store, world.room, entry.message_id)),
    ['first'],
  );
  assert.equal(store.inbox(world.botA).length, 1);

  const nextRound = await store.drain(world.botA);
  assert.deepEqual(
    nextRound.map((entry) => textOf(store, world.room, entry.message_id)),
    ['second'],
  );
});

test('an arrival during the turn waits for the next round', async () => {
  const world = makeWorld();
  deliver(world.store, { roomId: world.room, senderId: world.me, text: 'first' });

  const rounds: string[][] = [];
  const loop = new InboxLoop(world.store, (entries) => {
    rounds.push(
      entries.map((entry) => textOf(world.store, world.room, entry.message_id)),
    );
    if (rounds.length === 1) {
      deliver(world.store, {
        roomId: world.room,
        senderId: world.me,
        text: 'second',
      });
    }
  });

  await loop.tick(world.botA);
  assert.deepEqual(rounds, [['first']]);
  assert.equal(world.store.hasPending(world.botA), true);

  await loop.tick(world.botA);
  assert.deepEqual(rounds, [['first'], ['second']]);
  assert.equal(loop.turns, 2);
  assert.equal(world.store.hasPending(world.botA), false);
});
