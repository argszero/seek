import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AGENT_TURN_CAP } from './chain.ts';
import { deliver } from './delivery.ts';
import { makeWorld } from './fixtures.ts';
import { InboxLoop } from './inbox.ts';
import { say } from './say.ts';
import { SeekStore } from './store.ts';
import { runTurn } from './turn.ts';
import type { Id, Observation } from './types.ts';

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

/**
 * Stage 1 that says every ambiguous entry acts (the shipped default says none do).
 *
 * The bot the tick belongs to is the first argument and these two ignore it: the box a
 * judgement reads is the bot's own, and a judge that does not read one has no use for it.
 */
const judgeActs = (_botId: Id, entries: Observation[]): Observation[] => entries;

/** Stage 1 that says nothing acts — the shipped default, named for readability. */
const judgeDeclines = (): Observation[] => [];

/** Mute a bot in the world's room. */
function mute(world: ReturnType<typeof makeWorld>, botId: Id): void {
  const membership = Object.values(world.store.data.memberships).find(
    (m) => m.room_id === world.room && m.principal_id === botId,
  );
  assert.ok(membership, 'expected a membership to mute');
  membership.muted = true;
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
  assert.deepEqual(result.drained, []);
  assert.equal(result.settled, undefined);
  assert.equal(seen.length, 0);
  assert.equal(loop.turns, 0);
});

/** A store that counts drains, so an idle tick's cost is observable. */
class CountingStore extends SeekStore {
  drains = 0;

  async drain(botId: Id): Promise<Observation[]> {
    this.drains += 1;
    return super.drain(botId);
  }
}

test('an idle tick does not touch the queue at all', async () => {
  const world = makeWorld();
  const store = new CountingStore(world.store.data);
  const loop = new InboxLoop(store, () => {
    throw new Error('an idle tick may not open a turn');
  });

  const result = await loop.tick(world.botA);

  assert.equal(result.woke, false);
  // Not merely "the turn did not open": the drain — and the save behind it —
  // is never reached, which is what keeps a tick over nothing free.
  assert.equal(store.drains, 0);

  // And a record that has grown is not a queue: what a tick takes stays on the
  // record for good, so a tick after one has consumed it must not reach the drain
  // either — otherwise every wake from here on pays for the whole history.
  deliver(store, { roomId: world.room, senderId: world.me, text: 'hello' });
  await loop.tick(world.botA);
  assert.equal(store.drains, 1, 'a real queue is drained once');
  const after = await loop.tick(world.botA);
  assert.equal(after.woke, false);
  assert.equal(store.drains, 1, 'a consumed record is not a reason to drain again');
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
  // Plain chatter is stage 1's to settle, so the stub is asked — and says yes.
  const loop = new InboxLoop(
    world.store,
    (entries) => {
      seen.push(
        entries.map((entry) => textOf(world.store, world.room, entry.message_id)),
      );
    },
    judgeActs,
  );

  const result = await loop.tick(world.botA);

  assert.equal(result.woke, true);
  assert.deepEqual(seen, [['one', 'two', 'three']]);
  assert.equal(world.store.pending(world.botA).length, 0, 'nothing is left waiting');
  assert.equal(world.store.inbox(world.botA).length, 3, 'and nothing is destroyed');
  assert.equal(
    world.store.inbox(world.botA).every((entry) => entry.state === 'consumed'),
    true,
    'what a tick took is on the record, marked',
  );

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
  assert.equal(store.pending(world.botA).length, 1);

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
  const loop = new InboxLoop(
    world.store,
    (entries) => {
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
    },
    judgeActs,
  );

  await loop.tick(world.botA);
  assert.deepEqual(rounds, [['first']]);
  assert.equal(world.store.hasPending(world.botA), true);

  await loop.tick(world.botA);
  assert.deepEqual(rounds, [['first'], ['second']]);
  assert.equal(loop.turns, 2);
  assert.equal(world.store.hasPending(world.botA), false);
});

test('a fast-passed entry opens a turn without stage 1 being asked', async () => {
  const world = makeWorld();
  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: '@A can you check this?',
    mentions: [{ id: world.botA, name: 'A' }],
  });

  const asked: Observation[][] = [];
  const seen: string[][] = [];
  const loop = new InboxLoop(
    world.store,
    (entries) => {
      seen.push(
        entries.map((entry) => textOf(world.store, world.room, entry.message_id)),
      );
    },
    (entries) => {
      asked.push(entries);
      return entries;
    },
  );

  const result = await loop.tick(world.botA);

  assert.equal(result.woke, true);
  assert.deepEqual(seen, [['@A can you check this?']]);
  // Row 2 is certain and free: the model is never asked about it.
  assert.deepEqual(asked, []);
  assert.equal(result.settled?.act.length, 1);
  assert.equal(result.settled?.judge.length, 0);
});

test('an ignored-only tick opens no turn, and stage 1 never sees it', async () => {
  const world = makeWorld();
  mute(world, world.botA);
  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: 'anyone about?',
  });

  const asked: Observation[][] = [];
  let ran = 0;
  const loop = new InboxLoop(
    world.store,
    () => {
      ran += 1;
    },
    (entries) => {
      asked.push(entries);
      return entries;
    },
  );

  const result = await loop.tick(world.botA);

  // Row 3's own ending: the tick stops here, and nothing was spent.
  assert.equal(result.woke, false);
  assert.deepEqual(result.entries, []);
  assert.equal(ran, 0);
  assert.equal(loop.turns, 0);
  assert.deepEqual(asked, []);
  assert.equal(result.settled?.ignore.length, 1);
  assert.equal(result.settled?.ignore[0].verdict, 'ignore');
  // The queue was drained, so it does not come back next round.
  assert.equal(world.store.hasPending(world.botA), false);
  assert.equal((await loop.tick(world.botA)).woke, false);
});

test("another bot's broadcast opens no turn", async () => {
  const world = makeWorld();
  deliver(world.store, {
    roomId: world.room,
    senderId: world.botB,
    text: 'deploying in five',
    agentId: world.agentB1,
  });

  let ran = 0;
  const loop = new InboxLoop(world.store, () => {
    ran += 1;
  });

  const result = await loop.tick(world.botA);

  assert.equal(result.woke, false);
  assert.equal(ran, 0);
  assert.equal(result.settled?.ignore.length, 1);
});

test('an ambiguous entry reaches stage 1, and only acts if stage 1 says so', async () => {
  const world = makeWorld();
  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: 'we could ship tomorrow',
  });

  // The shipped default: no act, no turn, nothing spent.
  const declining = new InboxLoop(world.store, () => {
    throw new Error('stage 1 declined: no turn may open');
  });
  const declined = await declining.tick(world.botA);
  assert.equal(declined.woke, false);
  assert.equal(declining.turns, 0);
  assert.equal(declined.settled?.judge.length, 1);

  // Delivered again, and this time stage 1 acts on it.
  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: 'we could ship tomorrow',
  });
  const seen: Observation[][] = [];
  const acting = new InboxLoop(
    world.store,
    (entries) => {
      seen.push(entries);
    },
    judgeActs,
  );
  const acted = await acting.tick(world.botA);
  assert.equal(acted.woke, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].length, 1);
  assert.equal(seen[0][0].hints.mentionsMe, false);
});

test('a mixed tick runs one turn carrying what acted, and nothing else', async () => {
  const world = makeWorld();
  deliver(world.store, {
    roomId: world.room,
    senderId: world.botB,
    text: 'standup now',
    agentId: world.agentB1,
  });
  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: 'unrelated chatter',
  });
  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: '@A confirm please',
    mentions: [{ id: world.botA, name: 'A' }],
  });

  const seen: Observation[][] = [];
  const loop = new InboxLoop(
    world.store,
    (entries) => {
      seen.push(entries);
    },
    judgeActs,
  );

  const result = await loop.tick(world.botA);

  assert.equal(result.woke, true);
  assert.equal(loop.turns, 1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].length, 2);
  // The ignored broadcast is in neither the turn nor stage 1's input.
  const carried = seen[0].map((entry) => entry.hints.direct);
  assert.equal(carried.length, 2);
  assert.equal(
    seen[0].some((entry) => entry.verdict === 'ignore'),
    false,
  );
  assert.equal(result.settled?.ignore.length, 1);
  assert.equal(result.settled?.act.length, 1);
  assert.equal(result.settled?.judge.length, 1);
});

test('a tick reports what it consumed, which is not what its turn carried', async () => {
  const world = makeWorld();
  // Another bot talking to the room: stage 0 settles it as an ignore, so the
  // tick opens no turn — and the entry is still consumed rather than held.
  deliver(world.store, {
    roomId: world.room,
    senderId: world.botB,
    text: 'standup now',
    agentId: world.agentB1,
  });

  const loop = new InboxLoop(world.store, () => {
    throw new Error('a settled broadcast opens no turn');
  });
  const result = await loop.tick(world.botA);

  assert.equal(result.woke, false);
  assert.deepEqual(result.entries, []);
  assert.equal(result.drained.length, 1);
  assert.equal(result.drained[0].verdict, 'ignore');
  assert.equal(world.store.hasPending(world.botA), false);
});

test('an entry the chain wall held back is not reported as consumed', async () => {
  const world = makeWorld();
  for (let index = 0; index < AGENT_TURN_CAP; index += 1) {
    await runTurn(world.store, {
      agentId: world.agentA2,
      roomId: world.room,
      entries: [],
    });
  }
  const byB = say(world.store, {
    botId: world.botB,
    agentId: world.agentB1,
    roomId: world.room,
    text: 'B speaking first',
  });
  const answer = say(world.store, {
    botId: world.botA,
    agentId: world.agentA2,
    roomId: world.room,
    text: 'A answering B',
    replyTo: byB.id,
  });

  const loop = new InboxLoop(world.store, () => {
    throw new Error('a held-back entry opens no turn');
  });
  const result = await loop.tick(world.botB);

  assert.equal(result.woke, false);
  assert.equal(result.settled?.blocked.length, 1);
  // Kept rather than consumed, so a summary written now must not fold it in:
  // nothing has been decided about it, only postponed.
  assert.deepEqual(result.drained, []);
  assert.equal(world.store.inbox(world.botB)[0].message_id, answer.id);
});
