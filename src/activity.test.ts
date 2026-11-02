/**
 * What each bot is doing right now, as two live readings and nothing stored.
 *
 * `docs/design/agent-lifecycle.md` §8 item 1 asks the window for a state dot —
 * watching / working / asleep / needy — and §6 lists `agent_state` among the frames. None of
 * that is a field on the bot: a bot in a turn is working, a bot whose wake timer is armed is
 * watching, and a bot with neither is asleep. The window derives the four words from these two
 * readings at the snapshot (`ui/electron/snapshot.js`), the way `mentionsMe` and `depth` are
 * derived from what the record already holds.
 *
 * **Why not a `status` field on the bot.** It would be a second copy of one fact, and a copy
 * is the one that goes stale: a turn that throws leaves a stored `working` behind, while
 * `#busy` is emptied in the same `then` that reports the error. What the person reads on the
 * avatar then keeps saying the bot is busy long after it stopped being busy, and nothing on
 * the screen can tell that apart from a bot genuinely still thinking.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Timers } from './comparator.ts';
import { deliver } from './delivery.ts';
import { makeWorld } from './fixtures.ts';
import { Kernel, type KernelOptions } from './kernel.ts';
import type { Decide } from './turn.ts';

const MORNING = '2026-10-24T08:00:00.000Z';

/** Timers a test fires by hand, so a wait is armed without waiting on wall time. */
function makeTimers(): Timers & { fire(): void } {
  let pending: (() => void) | undefined;
  return {
    set(_delayMs, run) {
      pending = run;
      return run;
    },
    clear() {
      pending = undefined;
    },
    fire() {
      const own = pending;
      pending = undefined;
      own?.();
    },
  };
}

/** Let every pending microtask run: a turn takes several awaits to open. */
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

function makeKernel(store: ConstructorParameters<typeof Kernel>[0], options: KernelOptions = {}) {
  const timers = makeTimers();
  return { kernel: new Kernel(store, { ...options, now: () => MORNING, timers }), timers };
}

test('a bot in a turn is working, and the bot beside it is not', async () => {
  const world = makeWorld();
  const gate = makeGate();
  const decide: Decide = async () => {
    await gate.promise;
  };
  const { kernel } = makeKernel(world.store, { decide });

  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: '@A one',
    mentions: [{ id: world.botA, name: 'A' }],
    now: MORNING,
  });

  assert.deepEqual(kernel.activity(), { working: [], watching: [] }, 'nothing runs before a wake');

  const waking = kernel.tick(world.botA);
  await settle();

  // A's turn is open and blocked on the gate, so A is working and B, which was never woken,
  // is not. One bot working must not colour the roster: the reading is per bot or it is a lie
  // about every other one.
  assert.deepEqual(kernel.activity().working, [world.botA]);
  assert.deepEqual(kernel.activity().watching, []);

  gate.release();
  await waking;
  await kernel.whenIdle();
  world.store.data.turns.length = 0;

  assert.deepEqual(kernel.activity(), { working: [], watching: [] }, 'a finished turn is not working');
});

test('a bot whose wake timer is armed is watching, and firing it ends that', async () => {
  const world = makeWorld();
  const { kernel, timers } = makeKernel(world.store, { wakeDelay: () => 3000 });

  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: '@A one',
    mentions: [{ id: world.botA, name: 'A' }],
    now: MORNING,
  });

  const waiting = kernel.wake(world.botA);
  // The wait is a bot that has something to read and has not started reading it — the state
  // the design calls watching, and the opposite of the one above.
  assert.deepEqual(kernel.activity(), { working: [], watching: [world.botA] });

  timers.fire();
  await waiting;
  await kernel.whenIdle();

  assert.deepEqual(kernel.activity(), { working: [], watching: [] }, 'the wait is over once it read');
});

test('stop() leaves neither reading behind', async () => {
  const world = makeWorld();
  const { kernel } = makeKernel(world.store, { wakeDelay: () => 3000 });

  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: '@A one',
    mentions: [{ id: world.botA, name: 'A' }],
    now: MORNING,
  });
  void kernel.wake(world.botA);
  assert.equal(kernel.activity().watching.length, 1);

  kernel.stop();

  // Nothing outlives the kernel: a stopped loop that still reported a bot as watching would
  // draw a dot for work nobody is going to do.
  assert.deepEqual(kernel.activity(), { working: [], watching: [] });
});

test('the observer is told every time the two readings move, and a throwing one fails nothing', async () => {
  const world = makeWorld();
  let told = 0;
  const { kernel, timers } = makeKernel(world.store, {
    wakeDelay: () => 3000,
    // **A window that has already closed is the ordinary case for this hook**, and it is the
    // one that throws: `webContents.send` on a destroyed window. If that reached the turn, a
    // person closing the window would be a bot that failed to answer.
    onActivity: () => {
      told += 1;
      throw new Error('the window is gone');
    },
  });

  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: '@A one',
    mentions: [{ id: world.botA, name: 'A' }],
    now: MORNING,
  });

  const waiting = kernel.wake(world.botA);
  // Arming the wait is the watching state, and a state the window never hears about is a dot
  // drawn from the last thing it was told.
  assert.equal(told, 1, 'the wait being armed is one report');

  timers.fire();
  await waiting;
  await kernel.whenIdle();

  // The wait firing opens a turn (one report) and that turn ending is another: a hook that
  // only fired on the way in would leave the dot saying `working` for good.
  assert.ok(told >= 3, `the turn opening and ending are two more reports, and there were ${told}`);
  assert.deepEqual(
    kernel.activity(),
    { working: [], watching: [] },
    'the observer threw twice and the readings still moved',
  );
});
