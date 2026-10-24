import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { Timers } from './comparator.ts';
import type { Judge } from './inbox.ts';
import {
  defaultStorePath,
  format,
  main,
  runFirstMilestone,
  sceneOf,
  seedOneRoom,
  stubDecide,
  stubJudge,
  transcriptOf,
} from './main.ts';
import { applyRoster, readRosterFor } from './roster.ts';
import { SeekStore } from './store.ts';
import type { TurnContext } from './turn.ts';

const AT = '2026-10-24T09:00:00.000Z';

/** Timers a run never uses, but a test must not let a real one keep the process alive. */
function makeTimers(): Timers & { armed: number[] } {
  const armed: number[] = [];
  return {
    armed,
    set(delayMs: number) {
      armed.push(delayMs);
      return delayMs;
    },
    clear() {},
  };
}

/**
 * The roster the harness's stores are given.
 *
 * Written beside every throwaway store, because that is where a run looks for it
 * (`src/roster.ts`): the file is the roster, so a test that skipped it would be
 * testing a path no real run takes.
 */
const ROSTER_YAML = `agents:
  - bot: Echo
    role: watch
    tools: []
  - bot: Echo
    role: work
    tools: [say]
`;

/** A store on a throwaway path, its roster, and its directory. */
async function onDisk(): Promise<{ store: SeekStore; path: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'seek-milestone-'));
  const path = join(dir, 'seek.json');
  await writeFile(join(dir, 'agents.yml'), ROSTER_YAML);
  return { store: await SeekStore.load(path), path, dir };
}

test('the first milestone runs: a person speaks, and the bot answers a message that named nobody', async () => {
  const { store, path, dir } = await onDisk();
  try {
    const run = await runFirstMilestone(store, {
      now: () => AT,
      timers: makeTimers(),
    });

    // The milestone's question, answered from the room's log rather than from a
    // return value.
    assert.equal(run.spoke, true);
    assert.equal(run.failures.length, 0);

    // Positional, not by timestamp: both messages can share an instant.
    assert.equal(run.transcript.length, 2);
    assert.equal(run.transcript[0].senderId, run.scene.me);
    assert.equal(run.transcript[0].byBot, false);
    assert.equal(run.transcript[1].senderId, run.scene.bot);
    assert.equal(run.transcript[1].byBot, true);

    // The message named nobody, so this is the gate's ambiguous remainder — the
    // only row that costs anything, and the one the milestone is about.
    assert.equal(store.messagesOf(run.scene.room)[0].mentions.length, 0);

    // Nothing was left behind: the wake spent the delivery that woke it.
    assert.equal(store.hasPending(run.scene.bot), false);

    // What the store holds is what the next process reads.
    const reloaded = await SeekStore.load(path);
    assert.equal(reloaded.messagesOf(run.scene.room).length, 2);
    assert.equal(reloaded.data.turns.length, 1);
    assert.equal(transcriptOf(reloaded, run.scene.room)[1].byBot, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('nothing says it on its own without a stage-1 answer, and the run says so', async () => {
  const { store, dir } = await onDisk();
  try {
    // Stage 1 declining every entry is the shipped default (`inbox.ts`'s
    // `judgeNothing`), so this is the honest reading of the kernel as it stands:
    // an unaddressed message is not answered unless something judged it worth
    // answering.
    const declining: Judge = () => [];
    const run = await runFirstMilestone(store, {
      now: () => AT,
      timers: makeTimers(),
      judge: declining,
      said: 'a line of my own choosing',
    });

    assert.equal(run.spoke, false);
    assert.equal(run.transcript.length, 1, 'the person spoke; the bot did not');
    assert.equal(run.transcript[0].text, 'a line of my own choosing');
    assert.equal(store.data.turns.length, 0, 'no turn was opened at all');
    // And the words it would have used are not in the room.
    assert.equal(
      run.transcript.some((line) => line.text.includes('stub')),
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a second run continues the room instead of seeding a second one', async () => {
  const { store, path, dir } = await onDisk();
  try {
    const first = await runFirstMilestone(store, { now: () => AT, timers: makeTimers() });
    const second = await runFirstMilestone(
      // A new process reads the store back; that is the case worth testing.
      await SeekStore.load(path),
      { now: () => AT, timers: makeTimers() },
    );

    assert.equal(second.scene.room, first.scene.room);
    assert.equal(second.scene.bot, first.scene.bot);
    assert.equal(second.transcript.length, 4, 'two messages per run, in one room');
    assert.equal(second.spoke, true);

    const reloaded = await SeekStore.load(path);
    assert.equal(Object.keys(reloaded.data.bots).length, 1, 'one bot, not two');
    assert.equal(Object.keys(reloaded.data.rooms).length, 1, 'one room, not two');
    assert.equal(Object.keys(reloaded.data.agents).length, 2, 'its two halves');
    assert.equal(reloaded.data.turns.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the roster supplies the agents, the seed supplies the world', async () => {
  const { store, dir } = await onDisk();
  try {
    const world = seedOneRoom(store);
    // The seed writes no agents at all: nothing exists until the roster is read,
    // which is what keeps the file the one place agents come from.
    assert.deepEqual(store.agentsOf(world.bot), []);

    const rows = await readRosterFor(store);
    assert.ok(rows, 'the harness wrote a roster beside the store');
    applyRoster(store, rows);

    const scene = sceneOf(store);
    assert.ok(scene, 'the roster is what completes the scene');
    const watch = store.data.agents[scene.watch];
    const work = store.data.agents[scene.work];

    assert.equal(watch.role, 'watch');
    assert.equal(work.role, 'work');
    assert.equal(watch.bot_id, scene.bot);
    assert.equal(work.bot_id, scene.bot);
    // The half that cannot write holds no tool; the half that answers may speak
    // and nothing else — read off `agents.yml` rather than out of a table in the
    // code (checklist line 13, "exactly two additions").
    assert.deepEqual(watch.tools, []);
    assert.deepEqual(work.tools, ['say']);
    // No model was chosen: that is a measurement, and this file does not take it.
    assert.equal(work.model, 'unset');
    assert.equal(watch.home.startsWith('/'), true, 'an agent has a home');

    // Two people and a bot: three memberships, so the room is a group and not a
    // direct message — the fast path would otherwise skip stage 1 entirely.
    const members = Object.values(store.data.memberships).filter(
      (row) => row.room_id === scene.room,
    );
    assert.equal(members.length, 3);
    assert.notEqual(scene.other, scene.me);
    assert.equal(
      members.find((row) => row.principal_id === scene.me)?.role,
      'owner',
    );
    assert.equal(
      members.find((row) => row.principal_id === scene.bot)?.role,
      'member',
    );

    assert.deepEqual(sceneOf(store), scene, 'the seeded world reads back as itself');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the run settles the compaction it started before it reports', async () => {
  /**
   * A store that counts the saves which completed while a summary was in memory.
   *
   * The compaction pushes its digest and *then* saves, so exactly one save has a
   * digest to write: the compaction's own. Counting that instead of a total keeps
   * the assertion off "how many saves a turn happens to make".
   */
  class DigestStore extends SeekStore {
    savedWithDigest = 0;

    async save(): Promise<void> {
      await super.save();
      if (Object.keys(this.data.memories).length > 0) this.savedWithDigest += 1;
    }
  }

  const dir = await mkdtemp(join(tmpdir(), 'seek-milestone-'));
  try {
    const path = join(dir, 'seek.json');
    await writeFile(join(dir, 'agents.yml'), ROSTER_YAML);
    const store = new DigestStore((await SeekStore.load(path)).data, path);

    const run = await runFirstMilestone(store, {
      now: () => AT,
      timers: makeTimers(),
      summarise: () => 'the room so far',
      compactLines: { maxObservations: 1 },
    });

    assert.equal(run.spoke, true);
    // The compaction is the background action the tick started and the turn did
    // not finish. It has completed before the run reports, which is what the
    // wait is for — without it the run would describe a store still moving.
    assert.equal(
      store.savedWithDigest,
      1,
      'the summary was written before the run returned',
    );
    const digest = store
      .memoriesOf(run.scene.work)
      .filter((row) => row.level === 'room_digest');
    assert.equal(digest.length, 1);
    assert.equal(digest[0].body, 'the room so far');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a store with no scene says so instead of inventing one', async () => {
  const { store, dir } = await onDisk();
  try {
    assert.equal(sceneOf(store), undefined, 'an empty store has no scene');

    // A bot without its two halves is not a scene either: something would have
    // to guess which agent answers, and guessing is what this file must not do.
    const world = seedOneRoom(store);
    const rows = await readRosterFor(store);
    assert.ok(rows);
    // A roster that declares the watch row and not the work one: one agent is
    // not a scene, however well-formed the file is.
    applyRoster(store, rows.filter((row) => row.role !== 'work'));
    assert.equal(store.agentsOf(world.bot).length, 1);
    assert.equal(sceneOf(store), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the printed run says its words are a stub, and the exit status is the milestone', async () => {
  const { store, path, dir } = await onDisk();
  try {
    // `main` is the command line: it reads the store, runs, prints and returns
    // the verdict.
    const printedBy: string[] = [];
    const code = await main([path], {
      now: () => AT,
      timers: makeTimers(),
      out: (text) => printedBy.push(text),
    });
    assert.equal(printedBy.length, 1, 'the command line printed once');
    assert.equal(code, 0, 'it spoke and nothing threw');
    // It wrote where it was told, not to a default beside the repository.
    assert.equal((await SeekStore.load(path)).messagesOf(
      Object.keys((await SeekStore.load(path)).data.rooms)[0],
    ).length, 2);

    // A run that says nothing is a failure, not a page of success: the exit
    // status is the milestone's answer.
    const silent = await main([join(dir, 'silent.json')], {
      now: () => AT,
      timers: makeTimers(),
      judge: () => [],
      out: () => {},
    });
    assert.equal(silent, 1, 'a bot that never spoke is a failed run');

    const run = await runFirstMilestone(await SeekStore.load(path), {
      now: () => AT,
      timers: makeTimers(),
    });
    const printed = format(run, path);
    assert.match(printed, /seek — the first milestone/);
    assert.match(printed, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    // The hazard this guards: a placeholder read as a bot that thought.
    assert.match(printed, /nothing above came from a model/);
    assert.match(printed, /stubs in src\/main\.ts/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a run with no path goes to a predictable place, and never to the repository', async () => {
  const path = defaultStorePath();
  assert.equal(path.endsWith(join('seek-data', 'seek.json')), true);
  assert.equal(path.startsWith(process.cwd()), true);
  assert.equal(path.includes(`${join('src', 'main.ts')}`), false);
});

test('the stubs answer without reading, and a reminder’s turn says nothing', async () => {
  const { store, dir } = await onDisk();
  try {
    const world = seedOneRoom(store);
    const said: string[] = [];
    const context = {
      roomId: world.room,
      say: (roomId: string, text: string) => {
        said.push(`${roomId}:${text}`);
        return { id: 'om_x' };
      },
    } as unknown as TurnContext;

    await stubDecide(context);
    assert.equal(said.length, 1);
    assert.equal(said[0].startsWith(`${world.room}:`), true);

    // A reminder's turn has no room (`agent-lifecycle.md` §12), and `say`
    // addresses a room by name — so it has nothing to address.
    said.length = 0;
    await stubDecide({ ...context, roomId: undefined } as TurnContext);
    assert.deepEqual(said, []);

    // Stage 1's stub acts on everything it is given, and reads none of it.
    const entries = [{ id: 'ob_1' }, { id: 'ob_2' }] as never;
    assert.equal(stubJudge(entries, context).length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
