import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Kernel, type KernelOptions } from './kernel.ts';
import type { Timers } from './comparator.ts';
import { deliver } from './delivery.ts';
import { makeWorld } from './fixtures.ts';
import { addRow, scheduleAs } from './schedule.ts';
import { SeekStore } from './store.ts';
import type { Decide } from './turn.ts';
import type { Id, Observation } from './types.ts';

const MORNING = '2026-10-24T08:00:00.000Z';
const NOON = '2026-10-24T12:00:00.000Z';
const TOMORROW = '2026-10-25T08:00:00.000Z';

/**
 * Timers a test drives by hand.
 *
 * `armed` is what makes "one timer, and it sleeps to the next due row"
 * observable without waiting on wall time; `fire()` is what a real timer would
 * do when the delay elapsed.
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

/**
 * Let every pending microtask run.
 *
 * A turn takes several awaits to open, so a test that wants to observe "the
 * turn is open and blocked" has to get past them first. This drains the queue
 * without waiting on wall time, which is the only thing forbidden here.
 */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A deferred a test releases by hand, so a turn can be held open. */
function makeGate() {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function makeKernel(
  store: SeekStore,
  options: KernelOptions & { at?: string; timers?: Timers } = {},
) {
  const timers = options.timers ?? makeTimers();
  const kernel = new Kernel(store, {
    ...options,
    now: () => options.at ?? MORNING,
    timers,
  });
  return { kernel, timers: timers as ReturnType<typeof makeTimers> };
}

/**
 * The entry point's whole job: what already existed, constructed together.
 *
 * The comparator delivers a due row and stops; the kernel turns that delivery
 * into the one wake path a person's message also uses. Before this file nothing
 * constructed either, so a row that came due had nothing to fire it.
 */
test('a due row fires, and the bot it was for runs a turn', async () => {
  const world = makeWorld();
  const seen: { agentId: Id; entries: Observation[] }[] = [];

  const decide: Decide = (context) => {
    seen.push({ agentId: context.agentId, entries: context.entries });
  };
  addRow(world.store, { botId: world.botA, when: MORNING, text: 'check the thread' });

  const { kernel } = makeKernel(world.store, { decide });
  await kernel.start();
  await kernel.whenIdle();

  // A reminder arrives as a delivery, so the ordinary wake opens a turn — and
  // the turn is the work agent's, not the watch agent's.
  assert.equal(seen.length, 1);
  assert.equal(seen[0].agentId, world.agentA2);
  assert.equal(seen[0].entries.length, 1);
  assert.equal(seen[0].entries[0].kind, 'reminder');
  assert.equal(seen[0].entries[0].text, 'check the thread');
  assert.equal(world.store.data.schedule[0].state, 'fired');

  // The wake spent the delivery: the inbox is empty, not holding what woke it.
  assert.equal(world.store.hasPending(world.botA), false);
});

test('one loop per bot, and each bot is woken on its own work agent', async () => {
  const world = makeWorld();
  const ran: { agentId: Id; entries: Observation[] }[] = [];
  const decide: Decide = (context) => {
    ran.push({ agentId: context.agentId, entries: context.entries });
  };

  addRow(world.store, { botId: world.botA, when: MORNING, text: 'for A' });
  addRow(world.store, { botId: world.botB, when: MORNING, text: 'for B' });

  const { kernel } = makeKernel(world.store, { decide });
  await kernel.start();
  await kernel.whenIdle();

  // `InboxLoop.run` is bound to one bot at construction, so one loop shared by
  // two bots would run B's reminder on A's agent. Two loops, two agents.
  assert.notEqual(kernel.loopFor(world.botA), kernel.loopFor(world.botB));
  // ... and the same bot always gets the same loop, however often it is asked.
  assert.equal(kernel.loopFor(world.botA), kernel.loopFor(world.botA));

  assert.equal(ran.length, 2);
  const byAgent = new Map(ran.map((turn) => [turn.agentId, turn.entries]));
  assert.equal(byAgent.get(world.agentA2)?.[0].text, 'for A');
  assert.equal(byAgent.get(world.agentB1)?.[0].text, 'for B');
});

test('a reminder for one bot does not wake the other', async () => {
  const world = makeWorld();
  addRow(world.store, { botId: world.botA, when: MORNING, text: 'for A only' });

  const { kernel } = makeKernel(world.store, { decide: () => {} });
  await kernel.start();
  await kernel.whenIdle();

  assert.equal(kernel.loopFor(world.botA).turns, 1);
  assert.equal(kernel.loopFor(world.botB).turns, 0);
  assert.equal(world.store.hasPending(world.botB), false);
});

test('the sweep does not wait for the turn it started', { timeout: 5000 }, async () => {
  const world = makeWorld();
  const gate = makeGate();
  let finished = false;

  const decide: Decide = async () => {
    await gate.promise;
    finished = true;
  };
  addRow(world.store, { botId: world.botA, when: MORNING, text: 'a slow one' });

  const { kernel } = makeKernel(world.store, { decide });
  // §5 makes the comparator a background cost: it reads the clock, arms for the
  // next due row and sleeps. A turn that took minutes must not be what keeps
  // the next reminder from being armed.
  await kernel.start();
  await settle();

  assert.equal(finished, false);
  // It did start the turn, and it armed the timer while the turn was open.
  assert.equal(kernel.loopFor(world.botA).turns, 1);
  assert.equal(kernel.comparator.wakeAt, undefined);

  gate.release();
  await kernel.whenIdle();
  assert.equal(finished, true);
});

test('a wake that arrives mid-turn waits, and nothing is dropped', { timeout: 5000 }, async () => {
  const world = makeWorld();
  const gate = makeGate();
  const opened: Observation[][] = [];

  const decide: Decide = async (context) => {
    opened.push(context.entries);
    if (opened.length === 1) await gate.promise;
  };

  const { kernel } = makeKernel(world.store, { decide });
  const first = deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: '@A one',
    mentions: [{ id: world.botA, name: 'A' }],
    now: MORNING,
  });
  // One entry per recipient bot: A and B are both in this room, so the
  // delivery writes two — A's is the one that wakes it.
  assert.equal(first.observations.length, 2);
  assert.equal(world.store.inbox(world.botA).length, 1);

  const waking = kernel.tick(world.botA);
  // A second wake for the same bot, while the first turn is open.
  const queued = kernel.tick(world.botA);
  await settle();

  // Two conversations would make a persona and its memory fight each other
  // (`agent-lifecycle.md` §4): one turn at a time, by a lock.
  assert.equal(opened.length, 1);

  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: '@A two',
    mentions: [{ id: world.botA, name: 'A' }],
    now: MORNING,
  });

  gate.release();
  const firstResult = await waking;
  const secondResult = await queued;
  await kernel.whenIdle();

  assert.equal(firstResult.woke, true);
  // The queued wake drains what arrived meanwhile and opens the next turn —
  // "the loop reads the inbox again, and if anything is left that the gate would
  // act on, the next turn starts at once".
  assert.equal(secondResult.woke, true);
  assert.equal(opened.length, 2);
  assert.equal(opened[1][0].message_id !== opened[0][0].message_id, true);
  assert.equal(world.store.hasPending(world.botA), false);
});

test('a row written during a turn re-arms the comparator', async () => {
  const world = makeWorld();
  // The work agent may keep a calendar; without it the tool refuses (§12).
  world.store.data.agents[world.agentA2].tools = ['say', 'schedule'];

  addRow(world.store, { botId: world.botA, when: TOMORROW, text: 'far away' });

  const decide: Decide = (context) => {
    // A promise to itself for later today, written while the timer sleeps
    // toward tomorrow: without the re-arm it would wait for tomorrow.
    context.schedule.add(NOON, 'nearer', { now: MORNING });
  };

  const { kernel } = makeKernel(world.store, { decide });
  await kernel.start();
  // Armed for the row that was already there.
  assert.equal(kernel.comparator.wakeAt, TOMORROW);

  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: '@A do this',
    mentions: [{ id: world.botA, name: 'A' }],
    now: MORNING,
  });
  await kernel.tick(world.botA);

  assert.equal(kernel.comparator.wakeAt, NOON);
});

test('a row written with nothing pending arms the timer', async () => {
  const world = makeWorld();
  world.store.data.agents[world.agentA2].tools = ['say', 'schedule'];

  const decide: Decide = (context) => {
    context.schedule.add(NOON, 'later', { now: MORNING });
  };
  const { kernel, timers } = makeKernel(world.store, { decide });

  await kernel.start();
  // Nothing pending: no timer at all, which is what makes an idle bot cost
  // nothing (§5's idle row).
  assert.equal(kernel.comparator.wakeAt, undefined);
  assert.deepEqual(timers.armed, []);

  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: '@A remember',
    mentions: [{ id: world.botA, name: 'A' }],
    now: MORNING,
  });
  await kernel.tick(world.botA);

  assert.equal(kernel.comparator.wakeAt, NOON);
});

test('one timer, whatever the roster holds', async () => {
  const world = makeWorld();
  // Three rows, two bots, all due at the same instant.
  addRow(world.store, { botId: world.botA, when: MORNING, text: 'a1' });
  addRow(world.store, { botId: world.botA, when: MORNING, text: 'a2' });
  addRow(world.store, { botId: world.botB, when: MORNING, text: 'b1' });

  const { kernel, timers } = makeKernel(world.store, { decide: () => {} });
  await kernel.start();
  await kernel.whenIdle();

  // One timer for the whole process, not one per bot or one per row (§12 (a)).
  assert.equal(timers.armed.length <= 1, true);
  assert.equal(world.store.data.schedule.every((row) => row.state === 'fired'), true);
  assert.equal(kernel.loopFor(world.botA).turns, 1);
  assert.equal(kernel.loopFor(world.botB).turns, 1);
});

test('a turn that throws is recorded, and the other bot still runs', async () => {
  const world = makeWorld();
  const decide: Decide = (context) => {
    if (context.botId === world.botA) throw new Error('the model fell over');
  };
  addRow(world.store, { botId: world.botA, when: MORNING, text: 'for A' });
  addRow(world.store, { botId: world.botB, when: MORNING, text: 'for B' });

  const { kernel } = makeKernel(world.store, { decide });
  await kernel.start();
  await kernel.whenIdle();

  // One bot's bad turn is not the others', and it does not escape into the
  // timer callback — an exception there would end the process.
  assert.equal(kernel.failures.length, 1);
  assert.equal(kernel.failures[0].botId, world.botA);
  assert.equal(kernel.loopFor(world.botB).turns, 1);
});

test('stop() disarms and leaves the table for the next start', async () => {
  const world = makeWorld();
  addRow(world.store, { botId: world.botA, when: TOMORROW, text: 'tomorrow' });

  const { kernel } = makeKernel(world.store, { decide: () => {} });
  await kernel.start();

  assert.equal(kernel.running, true);
  assert.equal(kernel.comparator.wakeAt, TOMORROW);

  kernel.stop();
  assert.equal(kernel.running, false);
  assert.equal(kernel.comparator.wakeAt, undefined);
  // Nothing was fired on the way out: the row is still the bot's to keep.
  assert.equal(world.store.data.schedule[0].state, 'pending');
});

test('a store with no file yet is a legal kernel', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seek-kernel-'));
  try {
    const path = join(directory, 'seek.json');
    // Fake timers here too: nothing in this suite may arm a real one, or a
    // regression that arms a timer with nothing pending would keep the test
    // process alive instead of failing it.
    const timers = makeTimers();
    const kernel = await Kernel.open(path, { now: () => MORNING, timers });

    // No roster is read: `agents.yml` has no settled shape, so an empty store
    // must start rather than throw. It arms nothing and does nothing.
    await kernel.start();
    assert.equal(kernel.running, true);
    assert.equal(kernel.comparator.wakeAt, undefined);
    await kernel.whenIdle();

    const ticked = await kernel.tick('ou_nobody');
    assert.equal(ticked.woke, false);
    assert.deepEqual(timers.armed, []);
    kernel.stop();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the schedule tool is handed to a turn only through the kernel', async () => {
  const world = makeWorld();
  world.store.data.agents[world.agentA2].tools = ['say', 'schedule'];
  const seen: string[] = [];

  const decide: Decide = (context) => {
    // `scheduleAs` is what makes the tool: the turn receives it bound to its own
    // bot and agent, and the kernel is what re-arms on a write.
    seen.push(scheduleAs(world.store, context.botId, context.agentId).list().length > 0 ? 'shared' : 'empty');
    context.schedule.add(NOON, 'from the turn', { now: MORNING });
  };

  const { kernel } = makeKernel(world.store, { decide });
  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: '@A note this',
    mentions: [{ id: world.botA, name: 'A' }],
    now: MORNING,
  });
  await kernel.tick(world.botA);

  // One table, every bot reads it (§12): what this turn wrote is in it.
  assert.deepEqual(seen, ['empty']);
  assert.equal(world.store.data.schedule.length, 1);
  assert.equal(world.store.data.schedule[0].text, 'from the turn');
  assert.equal(world.store.data.schedule[0].created_by, world.agentA2);
});

test("the caller that woke a bot gets the turn's error", { timeout: 5000 }, async () => {
  const world = makeWorld();
  const decide: Decide = () => {
    throw new Error('the model fell over');
  };
  const { kernel } = makeKernel(world.store, { decide });
  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: '@A try this',
    mentions: [{ id: world.botA, name: 'A' }],
    now: MORNING,
  });

  // The comparator's path records a failed turn instead of failing the sweep,
  // but a caller that woke the bot itself is owed the error.
  await assert.rejects(kernel.tick(world.botA), /fell over/);

  // ... and the chain is not wedged by it: the next wake still runs.
  const again = await kernel.tick(world.botA);
  assert.equal(again.woke, false);
});

test('a delivery wakes the bots it was for, and nobody else', async () => {
  const world = makeWorld();
  addRow(world.store, { botId: world.botA, when: MORNING, text: 'for A only' });

  const { kernel } = makeKernel(world.store, { decide: () => {} });
  // Watch the bot that was not delivered to. Waking it would be invisible in
  // its inbox — an empty inbox is no wake — so this counts the wakes instead:
  // the sweep must not grow with the roster (§12: "nothing that grows with the
  // number of bots").
  const other = kernel.loopFor(world.botB);
  let wakes = 0;
  other.tick = async () => {
    wakes += 1;
    return { woke: false, entries: [], settled: undefined };
  };

  await kernel.start();
  await kernel.whenIdle();

  assert.equal(kernel.loopFor(world.botA).turns, 1);
  assert.equal(wakes, 0);
});

/** Another bot talking to the room: stage 0 settles it, so no turn opens. */
function broadcast(store: SeekStore, world: ReturnType<typeof makeWorld>): void {
  deliver(store, {
    roomId: world.room,
    senderId: world.botB,
    text: 'standup now',
    agentId: world.agentB1,
    now: MORNING,
  });
}

test('a tick that opens no turn still compacts the room it settled', async () => {
  const world = makeWorld();
  broadcast(world.store, world);
  const pending = world.store.inbox(world.botA)[0].id;

  const covered: number[] = [];
  const { kernel } = makeKernel(world.store, {
    decide: () => {
      throw new Error('a settled broadcast opens no turn');
    },
    summarise: ({ delta }) => {
      covered.push(delta.length);
      return 'the standup, and what was settled';
    },
    compactLines: { maxObservations: 1 },
  });

  await kernel.tick(world.botA);
  await kernel.whenIdle();

  // §3 makes compaction a runtime action: reachable on a tick that opened no
  // turn, which is the whole point of it not being a turn.
  assert.equal(covered.length, 1);
  assert.equal(covered[0], 1);
  assert.equal(kernel.loopFor(world.botA).turns, 0);

  const rows = world.store
    .memoriesOf(world.agentA2)
    .filter((row) => row.level === 'room_digest');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].body, 'the standup, and what was settled');
  // The port is the drained entry's, so the entry this tick settled is never
  // folded in a second time.
  assert.equal(rows[0].consumed_to, pending);
  assert.equal(kernel.compactor.delta(world.botA, world.room).length, 0);
});

test('a tick does not wait for the compaction it starts, and whenIdle does', { timeout: 5000 }, async () => {
  const world = makeWorld();
  const gate = makeGate();
  let written = false;
  broadcast(world.store, world);

  const { kernel } = makeKernel(world.store, {
    decide: () => {},
    summarise: async () => {
      await gate.promise;
      written = true;
      return 'summary';
    },
    compactLines: { maxObservations: 1 },
  });

  await kernel.tick(world.botA);
  await settle();

  // The tick has settled and the summary is still being written: a summary is
  // nobody's wake, so nothing waits on it.
  assert.equal(written, false);
  assert.equal(kernel.compactor.inFlight(world.botA, world.room), true);

  let idle = false;
  const waiting = kernel.whenIdle().then(() => {
    idle = true;
  });
  await settle();
  // "What is this process doing" still has one answer.
  assert.equal(idle, false, 'whenIdle waits for the background action');

  gate.release();
  await waiting;
  assert.equal(written, true);
  assert.equal(world.store.memoriesOf(world.agentA2).length, 1);
});

test('a summariser that throws is a skip with a back-off, not a failure of the process', async () => {
  const world = makeWorld();
  broadcast(world.store, world);
  let calls = 0;

  const { kernel } = makeKernel(world.store, {
    decide: () => {},
    summarise: () => {
      calls += 1;
      throw new Error('the model is offline');
    },
    compactLines: { maxObservations: 1 },
  });

  const result = await kernel.tick(world.botA);
  await kernel.whenIdle();
  assert.equal(result.woke, false);
  assert.equal(calls, 1);
  assert.equal(world.store.memoriesOf(world.agentA2).length, 0);

  // The back-off is keyed on this room's delta, so a room that has grown is tried
  // again. That the *same* delta is not re-fired is pinned in `compact.test.ts`,
  // where a delta can be held still; here the point is that the writer is
  // reachable at all after a tick, which a delta emptied by the tick would not be.
  broadcast(world.store, world);
  await kernel.tick(world.botA);
  await kernel.whenIdle();
  assert.equal(calls, 2, 'a room whose delta has grown is retried, not abandoned');

  // And it is a skip, not a crash: the kernel's failure record stays empty.
  assert.equal(kernel.failures.length, 0);
});

test('a background action that throws outside the writer is recorded and leaves the tick alone', async () => {
  const world = makeWorld();
  broadcast(world.store, world);
  const reported: unknown[] = [];

  /** A store whose save the test can fail — the one throw the compactor does not absorb. */
  class FailingStore extends SeekStore {
    fail = false;
    async save(): Promise<void> {
      if (this.fail) throw new Error('the disk is full');
      await super.save();
    }
  }
  const store = new FailingStore(world.store.data);

  const { kernel } = makeKernel(store, {
    decide: () => {},
    summarise: () => {
      // After the drain: from here on every save fails.
      store.fail = true;
      return 'summary';
    },
    compactLines: { maxObservations: 1 },
    onError: (error) => {
      reported.push(error);
    },
  });

  // The tick still resolves, and the throw behind it is reported rather than
  // swallowed (§@: nothing is ever dropped silently).
  const result = await kernel.tick(world.botA);
  await kernel.whenIdle();

  assert.equal(result.woke, false);
  assert.equal(reported.length, 1);
  assert.equal(kernel.failures.length, 1);
  assert.equal(kernel.failures[0].botId, world.botA);
});

test('a reminder belongs to no room, so it is folded into nobody’s summary', async () => {
  const world = makeWorld();
  addRow(world.store, { botId: world.botA, when: MORNING, text: 'check the thread' });

  let summarised = 0;
  const { kernel } = makeKernel(world.store, {
    decide: () => {},
    summarise: () => {
      summarised += 1;
      return 'summary';
    },
    compactLines: { maxObservations: 1 },
  });

  await kernel.start();
  await kernel.whenIdle();

  assert.equal(kernel.loopFor(world.botA).turns, 1, 'the reminder did wake the bot');
  assert.equal(summarised, 0, 'a reminder is no room’s conversation');
  assert.equal(world.store.memoriesOf(world.agentA2).length, 0);
});
