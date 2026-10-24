import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ScheduleComparator,
  msUntilDue,
  nextDueAt,
  type Timers,
} from './comparator.ts';
import { makeWorld } from './fixtures.ts';
import { addRow, listRows, scheduleAs } from './schedule.ts';

const MORNING = '2026-10-24T08:00:00.000Z';
const NOON = '2026-10-24T12:00:00.000Z';
const TOMORROW = '2026-10-25T08:00:00.000Z';

/**
 * Timers a test drives by hand: nothing in this suite waits on wall time.
 *
 * `armed` is the list of delays that were set and not cleared, which is what
 * makes "exactly one timer exists" observable.
 */
function makeTimers(): Timers & { armed: number[]; fire(): void } {
  let pending: { delayMs: number; run: () => void } | undefined;
  const armed: number[] = [];
  return {
    armed,
    set(delayMs, run) {
      pending = { delayMs, run };
      armed.push(delayMs);
      return delayMs;
    },
    clear() {
      pending = undefined;
    },
    fire() {
      const own = pending;
      pending = undefined;
      own?.run();
    },
  };
}

/** A comparator over one world, with a clock pinned to a stated instant. */
function makeComparator(
  world: ReturnType<typeof makeWorld>,
  options: {
    at?: string;
    timers?: Timers;
    onDelivered?: (botIds: string[]) => void | Promise<void>;
    saved?: { count: number };
  } = {},
) {
  const timers = options.timers ?? makeTimers();
  const store = world.store;
  const save = store.save.bind(store);
  if (options.saved) {
    store.save = async () => {
      options.saved!.count += 1;
      await save();
    };
  }
  const comparator = new ScheduleComparator(store, {
    now: () => options.at ?? MORNING,
    timers,
    onDelivered: options.onDelivered,
  });
  return { comparator, timers: timers as ReturnType<typeof makeTimers> };
}

test('starting catches up on what came due while the process was closed, once', async () => {
  const world = makeWorld();
  addRow(world.store, { botId: world.botA, when: MORNING, text: 'while you were out' });
  const woken: string[][] = [];
  const saved = { count: 0 };
  const { comparator } = makeComparator(world, {
    at: NOON,
    onDelivered: (botIds) => {
      woken.push(botIds);
    },
    saved,
  });

  await comparator.start();

  // §12 (c): an instant missed is not a reminder skipped — and it is not one
  // delivered twice either, which the second start below pins.
  const inbox = world.store.inbox(world.botA);
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0]?.kind, 'reminder');
  assert.equal(inbox[0]?.text, 'while you were out');
  // The delivery is durable before anyone is told they were woken.
  assert.equal(saved.count, 1);
  assert.deepEqual(woken, [[world.botA]]);
  assert.equal(listRows(world.store)[0]?.state, 'fired');

  await comparator.start();
  assert.equal(world.store.inbox(world.botA).length, 1);
  assert.equal(saved.count, 1);
});

test('the only output is a delivery: no message, no room, no beat on the record', async () => {
  const world = makeWorld();
  const row = addRow(world.store, { botId: world.botA, when: MORNING, text: 'look at this' });
  const { comparator } = makeComparator(world, { at: NOON });

  await comparator.start();

  // §12 (e): a fired reminder is not displayed, so nothing gained a line.
  assert.deepEqual(world.store.data.messages, {});
  assert.equal(world.store.data.turns.length, 0);
  const entry = world.store.inbox(world.botA)[0];
  assert.ok(entry);
  // "The timer's fingerprints must not reach a bot" (§6): the entry is what a
  // reminder produces and carries nothing about the sweep that produced it.
  assert.deepEqual(Object.keys(entry).sort(), [
    'bot_id',
    'delivered_at',
    'hints',
    'id',
    'kind',
    'schedule_id',
    'text',
  ]);
  assert.equal(entry.schedule_id, row.id);
  assert.equal(entry.verdict, undefined);
});

test('an empty sweep writes nothing at all', async () => {
  const world = makeWorld();
  addRow(world.store, { botId: world.botA, when: TOMORROW, text: 'not yet' });
  const saved = { count: 0 };
  const { comparator } = makeComparator(world, { at: MORNING, saved });

  const delivered = await comparator.sweep();

  // Idle is free (§5): no delivery, no wake, and no save either.
  assert.deepEqual(delivered, []);
  assert.equal(saved.count, 0);
  assert.equal(comparator.sweeps, 0);
  assert.equal(listRows(world.store)[0]?.state, 'pending');
});

test('it sleeps to the next due row rather than for a fixed interval', async () => {
  const world = makeWorld();
  // Written out of order on purpose: the nearest row is the second one.
  addRow(world.store, { botId: world.botA, when: TOMORROW, text: 'later' });
  addRow(world.store, { botId: world.botB, when: NOON, text: 'sooner' });
  const { comparator, timers } = makeComparator(world, { at: MORNING });

  await comparator.start();

  // Four hours, because that is when the nearest row is due — the delay is read
  // off the table (§5), so no interval number is configured or invented.
  assert.deepEqual(timers.armed, [4 * 60 * 60 * 1000]);
  assert.equal(comparator.wakeAt, NOON);
});

test('with nothing pending there is no timer at all', async () => {
  const world = makeWorld();
  const { comparator, timers } = makeComparator(world, { at: MORNING });

  await comparator.start();

  // The idle row of §5's table: nothing pending, nothing armed, nothing paid.
  assert.deepEqual(timers.armed, []);
  assert.equal(comparator.wakeAt, undefined);
  assert.equal(comparator.running, true);
});

test('one timer for the whole process, however many bots and rows', async () => {
  const world = makeWorld();
  for (const botId of [world.botA, world.botB]) {
    addRow(world.store, { botId, when: NOON, text: 'one' });
    addRow(world.store, { botId, when: TOMORROW, text: 'two' });
  }
  const { comparator, timers } = makeComparator(world, { at: MORNING });

  await comparator.start();
  // A second start is a no-op rather than a second timer.
  await comparator.start();
  comparator.refresh();

  // Four rows, two bots, two armings, and never more than one timer at a time:
  // a per-bot heartbeat is the defect §12 (a) names, and it cannot be reached
  // from here.
  assert.equal(timers.armed.length, 2);
  assert.equal(comparator.wakeAt, NOON);
});

test('two rows for one bot that come due together are one wake, two entries', async () => {
  const world = makeWorld();
  addRow(world.store, { botId: world.botA, when: MORNING, text: 'first' });
  addRow(world.store, { botId: world.botA, when: MORNING, text: 'second' });
  addRow(world.store, { botId: world.botB, when: MORNING, text: 'for B' });
  const woken: string[][] = [];
  const { comparator } = makeComparator(world, {
    at: NOON,
    onDelivered: (botIds) => {
      woken.push(botIds);
    },
  });

  await comparator.start();

  // Three entries, two bots: delivery is per entry, the wake is per bot.
  assert.equal(world.store.inbox(world.botA).length, 2);
  // Two rows written for one instant have no order between them — the tie-break
  // is `created_at`, then a random `id` — so what is pinned is the grouping, not
  // the order the bots happen to be named in.
  assert.equal(woken.length, 1);
  assert.deepEqual([...(woken[0] ?? [])].sort(), [world.botA, world.botB].sort());
});

test('when the timer fires it sweeps, and arms again for what is left', async () => {
  const world = makeWorld();
  addRow(world.store, { botId: world.botA, when: NOON, text: 'noon' });
  addRow(world.store, { botId: world.botA, when: TOMORROW, text: 'tomorrow' });
  const timers = makeTimers();
  const at = { value: MORNING };
  const comparator = new ScheduleComparator(world.store, {
    now: () => at.value,
    timers,
  });

  await comparator.start();
  assert.equal(world.store.inbox(world.botA).length, 0);
  assert.equal(comparator.wakeAt, NOON);

  // The instant arrives: the timer fires and the sweep does its work.
  at.value = NOON;
  timers.fire();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(world.store.inbox(world.botA).length, 1);
  assert.equal(world.store.inbox(world.botA)[0]?.text, 'noon');
  // And it is armed again, for the row that is still ahead of it.
  assert.equal(comparator.wakeAt, TOMORROW);
});

test('a row written while it sleeps wakes it at once', async () => {
  const world = makeWorld();
  addRow(world.store, { botId: world.botA, when: TOMORROW, text: 'later' });
  const timers = makeTimers();
  const at = { value: MORNING };
  const comparator = new ScheduleComparator(world.store, {
    now: () => at.value,
    timers,
  });

  await comparator.start();
  assert.equal(comparator.wakeAt, TOMORROW);

  // A bot leaves itself a note for nearer than the instant already armed.
  world.store.data.agents[world.agentA2]?.tools.push('schedule');
  const tool = scheduleAs(world.store, world.botA, world.agentA2, () => comparator.refresh());
  tool.add(MORNING, 'right now');

  // Without the refresh the reminder would wait for tomorrow's row.
  assert.equal(timers.armed.length, 2);
  assert.equal(comparator.wakeAt, MORNING);
});

test('stop() disarms, and a stale timer delivers nothing', async () => {
  const world = makeWorld();
  addRow(world.store, { botId: world.botA, when: NOON, text: 'noon' });
  const { comparator, timers } = makeComparator(world, { at: MORNING });

  await comparator.start();
  const stale = timers.armed.length;
  comparator.stop();

  assert.equal(comparator.running, false);
  assert.equal(comparator.wakeAt, undefined);
  timers.fire();
  await new Promise((resolve) => setImmediate(resolve));

  // Stopped: the table is untouched, and the next start() is what catches up.
  assert.equal(world.store.inbox(world.botA).length, 0);
  assert.equal(listRows(world.store)[0]?.state, 'pending');
  assert.equal(timers.armed.length, stale);
});

test('a row whose instant cannot be read neither fires nor breaks the arithmetic', async () => {
  const world = makeWorld();
  // Only reachable from a hand-edited file: `addRow` refuses such a row.
  world.store.data.schedule.push({
    id: 'sc_handwritten',
    bot_id: world.botA,
    when: 'not a time',
    text: 'when?',
    state: 'pending',
    created_at: MORNING,
  });
  addRow(world.store, { botId: world.botA, when: NOON, text: 'readable' });
  const { comparator, timers } = makeComparator(world, { at: MORNING });

  await comparator.start();

  // The readable row sets the wake; the other is skipped rather than arming a
  // NaN delay, and it stays visible for its author to cancel.
  assert.deepEqual(timers.armed, [4 * 60 * 60 * 1000]);
  assert.equal(listRows(world.store).length, 2);
  assert.equal(nextDueAt(world.store), Date.parse(NOON));
  assert.equal(msUntilDue(world.store, MORNING), 4 * 60 * 60 * 1000);
});

test('the delay is never negative when a row is already due', () => {
  const world = makeWorld();
  addRow(world.store, { botId: world.botA, when: MORNING, text: 'now' });

  assert.equal(msUntilDue(world.store, NOON), 0);
  assert.equal(nextDueAt(world.store), Date.parse(MORNING));
});
