import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deliver } from './delivery.ts';
import { makeWorld, type World } from './fixtures.ts';
import { newId } from './store.ts';
import type { Id, MembershipRole, Observation } from './types.ts';
import { watchAs, type Watch, type WatchInput, type WatchReading } from './watch.ts';

const PROMPT = { version: 'watch-v1', text: 'Does this room need you to act? Answer act or ignore.' };
const POINT = {
  threshold: 0.9,
  promptVersion: 'watch-v1',
  measuredOn: '76 hand-written cases, three disjoint sets',
};

interface Stub {
  /** Every question put to the model, in the order it was asked. */
  seen: WatchInput[];
  model: { read(input: WatchInput): WatchReading };
}

/** A decision model that answers the same way every time, and remembers being asked. */
function stub(answer: WatchReading | ((input: WatchInput) => WatchReading)): Stub {
  const seen: WatchInput[] = [];
  return {
    seen,
    model: {
      read(input: WatchInput): WatchReading {
        seen.push(input);
        return typeof answer === 'function' ? answer(input) : answer;
      },
    },
  };
}

function say(world: World, texts: string[], roomId: Id = world.room): void {
  for (const text of texts) {
    deliver(world.store, { roomId, senderId: world.me, text });
  }
}

/** A second room the same bot is in, so one tick can hold two rooms. */
function addRoom(world: World): Id {
  const roomId = newId('oc');
  world.store.data.rooms[roomId] = {
    id: roomId,
    name: 'elsewhere',
    chat_mode: 'group',
    created_at: '2026-10-24T00:00:00.000Z',
  };
  const members: { principal: Id; role: MembershipRole }[] = [
    { principal: world.me, role: 'owner' },
    { principal: world.botA, role: 'member' },
  ];
  for (const member of members) {
    const id = newId('mb');
    world.store.data.memberships[id] = {
      id,
      room_id: roomId,
      principal_id: member.principal,
      joined_at: '2026-10-24T00:00:00.000Z',
      role: member.role,
    };
  }
  return roomId;
}

function bind(world: World, model: Stub['model'], threshold = POINT.threshold): Watch {
  return watchAs(world.store, world.botA, model, {
    window: 10,
    prompt: PROMPT,
    operatingPoint: { ...POINT, threshold },
  });
}

test('the box a judgement reads still holds the entries that woke it', async () => {
  const world = makeWorld();
  say(world, ['one', 'two', 'three']);
  // The loop pops the whole queue before stage 0 or stage 1 sees anything.
  const entries = await world.store.drain(world.botA);
  assert.equal(entries.length, 3);

  const { model, seen } = stub({ probabilities: { act: 0.1, ignore: 0.9 } });
  const watch = bind(world, model);
  const acting = await watch(entries);

  assert.deepEqual(acting, [], 'a decided non-act opens no turn');
  assert.equal(seen.length, 1, 'one room, one question');
  assert.equal(seen[0].state.total, 3, 'the drained entries are not forgotten');
  assert.deepEqual(
    seen[0].state.delta.map((entry) => entry.id),
    [entries[2].id, entries[1].id, entries[0].id],
    'newest first, and the newest is the line that woke the bot',
  );
});

test('the unread count reaches the model even when the box overflows', async () => {
  const world = makeWorld();
  say(world, ['m0', 'm1', 'm2', 'm3', 'm4']);
  const entries = await world.store.drain(world.botA);

  const { model, seen } = stub({ probabilities: { act: 0.1, ignore: 0.9 } });
  await watchAs(world.store, world.botA, model, {
    window: 2,
    prompt: PROMPT,
    operatingPoint: POINT,
  })(entries);

  const state = seen[0].state;
  assert.equal(state.read, 2);
  assert.equal(state.total, 5);
  assert.equal(state.unread, 3, 'a judgement that could not read everything says so');
  assert.equal(state.read + state.unread, state.total);
});

test('the previous verdict arrives as a fact about the record, never as an instruction', async () => {
  const world = makeWorld();
  say(world, ['one', 'two', 'three']);
  // A previous judgement kept the oldest entry: `keep` takes no action and leaves
  // the line where it was, so it is still on the queue.
  const queued = world.store.inbox(world.botA);
  queued[0].verdict = 'keep';
  queued[0].reason = 'waiting for a reply';
  const entries = await world.store.drain(world.botA);

  const { model, seen } = stub({ probabilities: { act: 0.1, ignore: 0.9 } });
  await bind(world, model)(entries);

  const last = seen[0].state.lastVerdict;
  assert.deepEqual(
    last,
    {
      verdict: 'keep',
      entryId: entries[0].id,
      delivered_at: entries[0].delivered_at,
      reason: 'waiting for a reply',
    },
    'the record as it stands: what was decided, on which entry, when, and why',
  );
  assert.notEqual(typeof last, 'string', 'a sentence here would be the box arguing');
  assert.equal(seen[0].state.observationsSinceLastVerdict, 2, 'and how stale it is');
});

test('the operating point is the caller\'s: the same answer acts at 0.62 and does not at 0.93', async () => {
  async function decideAt(threshold: number) {
    const world = makeWorld();
    say(world, ['one']);
    const entries = await world.store.drain(world.botA);
    const { model } = stub({ probabilities: { act: 0.8, ignore: 0.2 } });
    const acting = await bind(world, model, threshold)(entries);
    return { acting, entry: entries[0] };
  }

  const loose = await decideAt(0.62);
  assert.equal(loose.acting.length, 1, '0.8 is above a cut of 0.62');
  assert.equal(loose.entry.verdict, 'act');

  const tight = await decideAt(0.93);
  assert.equal(tight.acting.length, 0, '0.8 is below a cut of 0.93');
  assert.equal(tight.entry.verdict, 'ignore', 'and not 0.5, which would have acted');
});

test('the cut is inclusive: a probability exactly at the operating point acts', async () => {
  const world = makeWorld();
  say(world, ['one']);
  const entries = await world.store.drain(world.botA);
  const { model } = stub({ probabilities: { act: 0.8, ignore: 0.2 } });
  const acting = await bind(world, model, 0.8)(entries);
  assert.equal(acting.length, 1);
});

test('a verdict lands on the entries that were judged and on nothing else', async () => {
  const world = makeWorld();
  const elsewhere = addRoom(world);
  say(world, ['here'], world.room);
  say(world, ['there'], elsewhere);
  const entries = await world.store.drain(world.botA);
  // One more arrives after the pop: nobody has asked about it yet.
  say(world, ['arrived while the tick was running'], world.room);
  const waiting = world.store.inbox(world.botA).map((entry) => entry.id);
  assert.equal(waiting.length, 1);

  const { model, seen } = stub((input) => ({
    probabilities:
      input.state.roomId === world.room
        ? { act: 0.99, ignore: 0.01 }
        : { act: 0.01, ignore: 0.99 },
  }));
  const acting = await bind(world, model)(entries);

  assert.equal(seen.length, 2, 'one question per room, never one for the batch');
  assert.equal(acting.length, 1);
  assert.equal(acting[0].room_id, world.room);

  const [here, there] = entries;
  assert.equal(here.verdict, 'act');
  assert.equal(there.verdict, 'ignore');

  const queued = world.store.inbox(world.botA).find((entry) => entry.id === waiting[0]);
  assert.equal(queued?.verdict, undefined, 'an entry nobody judged keeps no verdict');
});

test('an answer that cannot be read is no act, and is never keep or snooze', async () => {
  const unreadable: unknown[] = [
    {},
    { probabilities: undefined },
    { probabilities: { act: 0.99 } },
    { probabilities: { ignore: 0.99 } },
    { probabilities: { act: Number.NaN, ignore: 0.1 } },
    { probabilities: { act: 1.4, ignore: 0.1 } },
    { probabilities: { act: '0.99', ignore: '0.01' } },
    { reason: 'I am not answering' },
  ];

  for (const answer of unreadable) {
    const world = makeWorld();
    say(world, ['one']);
    const entries = await world.store.drain(world.botA);
    const { model } = stub(answer as WatchReading);
    const watch = bind(world, model);
    const acting = await watch(entries);

    assert.deepEqual(acting, [], `${JSON.stringify(answer)} must not act`);
    assert.equal(entries[0].verdict, 'ignore', `${JSON.stringify(answer)} is no act (§4)`);
    assert.equal(watch.last?.unparsed, 1, 'and the runtime says it could not read it');
  }
});

test('a reason is written when one came back, and never invented', async () => {
  async function decideWith(answer: WatchReading) {
    const world = makeWorld();
    say(world, ['one']);
    const entries = await world.store.drain(world.botA);
    const { model } = stub(answer);
    await bind(world, model)(entries);
    return entries[0];
  }

  const withReason = await decideWith({
    probabilities: { act: 0.99, ignore: 0.01 },
    reason: 'they asked me by name',
  });
  assert.equal(withReason.verdict, 'act');
  assert.equal(withReason.reason, 'they asked me by name');

  const without = await decideWith({ probabilities: { act: 0.99, ignore: 0.01 } });
  assert.equal(without.reason, undefined, 'no reason came back, so none is written');
});

test('an entry with no room is left alone and counted, not judged against some room', async () => {
  const world = makeWorld();
  say(world, ['one']);
  const entries = await world.store.drain(world.botA);
  const reminder: Observation = {
    id: newId('ob'),
    bot_id: world.botA,
    kind: 'reminder',
    hints: { mentionsMe: false, repliesToMe: false, direct: false },
    text: 'note to my future self',
    delivered_at: '2026-10-24T00:00:00.000Z',
  };

  const { model, seen } = stub({ probabilities: { act: 0.99, ignore: 0.01 } });
  const watch = bind(world, model);
  const acting = await watch([...entries, reminder]);

  assert.equal(seen.length, 1, 'still one question, about the one room that has one');
  assert.equal(reminder.verdict, undefined, 'a reminder is stage 0\'s, not stage 1\'s');
  assert.deepEqual(watch.last?.roomless, [reminder.id]);
  assert.deepEqual(acting, entries, 'and it does not ride along into the turn');
});

test('one save per call, however many rooms were asked about', async () => {
  const world = makeWorld();
  const elsewhere = addRoom(world);
  say(world, ['here'], world.room);
  say(world, ['there'], elsewhere);
  const entries = await world.store.drain(world.botA);

  let saves = 0;
  const save = world.store.save.bind(world.store);
  world.store.save = async () => {
    saves += 1;
    await save();
  };

  const { model, seen } = stub({ probabilities: { act: 0.99, ignore: 0.01 } });
  const acting = await bind(world, model)(entries);

  assert.equal(seen.length, 2);
  assert.equal(saves, 1, 'the verdicts of one judgement are one write');
  assert.deepEqual(
    acting.map((entry) => entry.id),
    entries.map((entry) => entry.id),
    'the entries come back in the order they arrived',
  );
});

test('a runtime wired to a cut measured on another question refuses to run', () => {
  const world = makeWorld();
  const { model } = stub({ probabilities: { act: 0.99, ignore: 0.01 } });
  const options = { window: 10, prompt: PROMPT };

  assert.throws(
    () =>
      watchAs(world.store, world.botA, model, {
        ...options,
        operatingPoint: { threshold: 0.9, promptVersion: 'watch-v0' },
      }),
    /calibrated against prompt "watch-v0"/,
    'a prompt edit moves what the number means',
  );
  assert.throws(
    () =>
      watchAs(world.store, world.botA, model, {
        ...options,
        operatingPoint: { threshold: 1, promptVersion: PROMPT.version },
      }),
    /strictly between 0 and 1/,
    'a cut of 1 acts on nothing and is not a cut',
  );
  assert.throws(
    () =>
      watchAs(world.store, world.botA, model, {
        ...options,
        operatingPoint: { threshold: Number.NaN, promptVersion: PROMPT.version },
      }),
    /numeric threshold/,
  );
  assert.throws(
    () =>
      watchAs(world.store, world.botA, model, {
        ...options,
        operatingPoint: POINT,
        optionTokens: { act: 'yes', ignore: 'yes' },
      }),
    /must be different tokens/,
  );
});
