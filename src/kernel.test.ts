import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

    // Nothing is written beside this store, so there is no roster to read:
    // a missing `agents.yml` says nothing about the store, and a kernel over an
    // empty directory must start rather than throw. It arms nothing and does
    // nothing.
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

test('opening a store reads the roster beside it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seek-kernel-'));
  try {
    const path = join(directory, 'seek.json');
    // A bot in the store, and a roster beside it naming that bot by name — the
    // two files a real run has, and the reason `open` is the place the roster is
    // applied: it is the one call that knows where the store lives.
    const store = new SeekStore(undefined, path);
    const bot = 'ou_echo';
    store.data.bots[bot] = { id: bot, name: 'Echo', description: 'the one' };
    await store.save();
    await writeFile(
      join(directory, 'agents.yml'),
      `agents:
  - bot: Echo
    role: work
    tools: [say]
`,
    );

    const kernel = await Kernel.open(path, { now: () => MORNING, timers: makeTimers() });
    const agents = kernel.store.agentsOf(bot);
    assert.deepEqual(
      agents.map((agent) => [agent.role, agent.tools]),
      [['work', ['say']]],
    );
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
    .filter((row) => row.level === 'box_digest');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].body, 'the standup, and what was settled');
  // The port is the drained entry's, so the entry this tick settled is never
  // folded in a second time.
  assert.equal(rows[0].consumed_to, pending);
  assert.equal(kernel.compactor.delta(world.botA).length, 0);
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
  assert.equal(kernel.compactor.inFlight(world.botA), true);

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

test('a reminder is in no room, and the note is the bot’s, so it is folded in with the rest', async () => {
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
  // The note is the bot's and not a room's (`compact.ts`), so a reminder — which is on the
  // bot's record and in no room — is folded in like anything else. Before the box became
  // the bot's there was a note per room and this reminder belonged to none, so nothing
  // consumed it and every later note was written with it still standing in the delta.
  assert.equal(summarised, 1, 'the reminder is folded into the bot’s note');
  assert.equal(world.store.memoriesOf(world.agentA2).length, 1);
  assert.equal(world.store.memoriesOf(world.agentA2)[0].room_id, undefined);
});

/**
 * The room's tempo: a bot is told at one instant and reads at another.
 *
 * Without it, four bots delivered the same message in the same millisecond began a model
 * call in the same millisecond, so a person got four answers arriving together and then a
 * room that never spoke again. The wait is what makes the second bot able to answer the
 * first — which is the whole difference between a chorus and a conversation.
 */
test('a wake waits for the room’s tempo, and what arrives while it waits is read once', async () => {
  const world = makeWorld();
  const turns: Observation[][] = [];
  const decide: Decide = (context) => {
    turns.push(context.entries);
  };
  const { kernel, timers } = makeKernel(world.store, {
    decide,
    // A person's message in a group room addresses nobody, so stage 0 ignores it and
    // only stage 1 can open a turn: this test is about the wait, not about the gate.
    judge: (_botId, entries) => entries,
    wakeDelay: () => 90_000,
  });

  deliver(world.store, { roomId: world.room, senderId: world.me, text: 'first' });
  const first = kernel.wake(world.botA);

  deliver(world.store, { roomId: world.room, senderId: world.me, text: 'second' });
  const second = kernel.wake(world.botA);

  assert.deepEqual(timers.armed, [90_000], 'one wait, not one per message');
  await settle();
  assert.equal(turns.length, 0, 'the bot has not looked yet — that is the tempo');

  timers.fire();
  await first;
  await second;

  assert.equal(turns.length, 1, 'both arrivals were read by the one turn');
  assert.equal(turns[0].length, 2, 'and it read both of them');
});

test('a bot that was named is read sooner than a room that was not talking to it', async () => {
  const world = makeWorld();
  const arrivals: boolean[] = [];
  const { kernel } = makeKernel(world.store, {
    wakeDelay: (arrived) => {
      arrivals.push(arrived.addressed);
      return 0;
    },
  });

  deliver(world.store, { roomId: world.room, senderId: world.me, text: 'anybody here' });
  await kernel.wake(world.botA);

  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: 'B, you take this one',
    mentions: [{ id: world.botB, name: 'B' }],
  });
  await kernel.wake(world.botB);

  assert.deepEqual(
    arrivals,
    [false, true],
    'a room talking among itself is ambient; a bot named is addressed',
  );
});

test('a bot’s message wakes the bots it names, and nobody else', async () => {
  const world = makeWorld();
  const spoke: Id[] = [];
  const decide: Decide = (context) => {
    spoke.push(context.botId);
    if (context.botId === world.botA && context.roomId !== undefined) {
      context.say(context.roomId, 'B, look at the schema before you start', {
        mentions: [{ id: world.botB, name: 'B' }],
      });
    }
  };
  const { kernel } = makeKernel(world.store, { decide, judge: (_botId, entries) => entries });

  deliver(world.store, { roomId: world.room, senderId: world.me, text: 'get started' });
  await kernel.wake(world.botA);
  await kernel.whenIdle();

  assert.deepEqual(spoke, [world.botA, world.botB], 'the named bot was woken by the naming');
});

test('a bot that names nobody is talking to the room, and wakes no one', async () => {
  const world = makeWorld();
  const spoke: Id[] = [];
  const decide: Decide = (context) => {
    spoke.push(context.botId);
    if (context.botId === world.botA && context.roomId !== undefined) {
      context.say(context.roomId, 'I will start on the schema');
    }
  };
  const { kernel } = makeKernel(world.store, { decide, judge: (_botId, entries) => entries });

  deliver(world.store, { roomId: world.room, senderId: world.me, text: 'get started' });
  await kernel.wake(world.botA);
  await kernel.whenIdle();

  assert.deepEqual(spoke, [world.botA], 'a broadcast is not an address');
  assert.equal(world.store.hasPending(world.botB), true, 'B still has it to read when it wakes');
});

test('two bots alone in a room do not answer each other forever', async () => {
  const world = makeWorld();
  // A room of exactly two, which the kernel reads as a direct message — so every line
  // either of them says addresses the other, and the chain wall would be the only thing
  // that ever stopped them. What keeps this finite is that a wake is a naming.
  const room = 'oc_direct_a_b';
  world.store.data.rooms[room] = { id: room, name: '', chat_mode: 'group', created_at: MORNING };
  for (const principal of [world.botA, world.botB]) {
    const id = `mb_${principal}`;
    world.store.data.memberships[id] = { id, room_id: room, principal_id: principal, role: 'member' };
  }

  const spoke: Id[] = [];
  const decide: Decide = (context) => {
    spoke.push(context.botId);
    if (context.roomId !== undefined) context.say(context.roomId, 'still here');
  };
  const { kernel } = makeKernel(world.store, { decide });

  deliver(world.store, { roomId: room, senderId: world.botA, text: 'are you there' });
  await kernel.wake(world.botB);
  await kernel.whenIdle();

  assert.deepEqual(spoke, [world.botB], 'B answered once, and A was not woken by it');
});

test('a bot still waiting when the kernel stops opens no turn', async () => {
  const world = makeWorld();
  const turns: Observation[][] = [];
  const { kernel, timers } = makeKernel(world.store, {
    decide: (context) => {
      turns.push(context.entries);
    },
    wakeDelay: () => 60_000,
  });

  deliver(world.store, { roomId: world.room, senderId: world.me, text: 'later' });
  const waiting = kernel.wake(world.botA);
  assert.deepEqual(timers.armed, [60_000]);

  kernel.stop();
  timers.fire();

  const result = await waiting;
  assert.equal(result.woke, false, 'a wait the kernel ended opened nothing');
  assert.equal(turns.length, 0);
  assert.equal(world.store.hasPending(world.botA), true, 'and the entry is still there to read');
});

test('a bot that answers another bot without naming it does not call it back', async () => {
  const world = makeWorld();
  const spoke: Id[] = [];
  const decide: Decide = (context) => {
    spoke.push(context.botId);
    // The turn was woken by A's message, so `replyOf` makes this an answer to it — and it
    // names nobody. That is what the last word in a room looks like, and it has to be
    // possible: with the reply edge waking, every closing sentence wakes the person it
    // closes with and the room cannot stop.
    if (context.botId === world.botB && context.roomId !== undefined) {
      context.say(context.roomId, 'understood, the schema is mine');
    }
  };
  const { kernel } = makeKernel(world.store, { decide });

  deliver(world.store, {
    roomId: world.room,
    senderId: world.botA,
    text: 'B, take the schema',
    mentions: [{ id: world.botB, name: 'B' }],
  });
  await kernel.wake(world.botB);
  await kernel.whenIdle();

  assert.deepEqual(spoke, [world.botB], 'B answered, and A was not called back');
  assert.equal(
    world.store.hasPending(world.botA),
    true,
    'A still has the answer in its box, addressed, for whenever it is next woken',
  );
});
