import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { Timers } from './comparator.ts';
import type { Judge } from './inbox.ts';
import type { Fetcher } from './llama.ts';
import {
  defaultStorePath,
  format,
  main,
  parseArgv,
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

/**
 * A model server that answers by path, and records what it was asked.
 *
 * A recorder rather than a socket: what the harness has to prove is that it asked
 * *this* server and reported the answer, which is visible without a model. The
 * vocabulary makes one word one token, so an option appended at the prompt's own
 * end is a single id and can carry a probability (`watch.ts` §4) — the shape the
 * suite's other fake already pins.
 *
 * `act` is the probability this server reports for `act` and nothing else about it
 * is a model: the fixture says exactly what it is told to say.
 */
function fakeModelServer(options: { act?: number } = {}): { fetch: Fetcher; asked: string[] } {
  const asked: string[] = [];
  const ids = new Map<string, number>();
  let next = 100;
  const idOf = (piece: string): number => {
    const known = ids.get(piece);
    if (known !== undefined) return known;
    ids.set(piece, next);
    next += 1;
    return ids.get(piece) as number;
  };
  const act = options.act ?? 0.95;
  const head = '<|im_start|>system\n';

  const fetcher: Fetcher = async (url, init) => {
    const pathname = new URL(url).pathname;
    asked.push(pathname);
    const body =
      init.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>);

    let payload: unknown;
    if (pathname === '/props') {
      payload = {
        chat_template: head,
        build_info: 'test build',
        default_generation_settings: { n_ctx: 4096 },
      };
    } else if (pathname === '/tokenize') {
      payload = { tokens: (String(body.content).match(/\s+|[^\s]+/g) ?? []).map(idOf) };
    } else if (pathname === '/v1/systemone') {
      // The decision endpoint's own shape: one forward pass, a probability per declared
      // answer, and nothing generated (`output_tokens: 0` is what the real binary reports).
      payload = {
        answers: {
          respond: {
            type: 'choice',
            choice: act >= 0.5 ? 'act' : 'ignore',
            probabilities: { act, ignore: 1 - act },
            confidence: act,
          },
        },
        usage: { input_tokens: 81, output_tokens: 0 },
      };
    } else {
      return { ok: false, status: 404, text: async () => 'no such route' };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };

  return { fetch: fetcher, asked };
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

test('the seeded bot carries the card the host named, filled rather than blank', async () => {
  const { store, dir } = await onDisk();
  try {
    const world = seedOneRoom(store);
    const bot = store.data.bots[world.bot];

    // The three the host stated on 2026-10-26T21:22, in his own words. They are content
    // rather than chrome, so no catalogue translates them and a test compares them as they
    // were written (`docs/design/i18n.md` §2).
    assert.deepEqual(
      { gender: bot.gender, position: bot.position, personality: bot.personality },
      { gender: '男', position: '研发', personality: '实事求是、老实听话' },
    );
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

    // The person and the bot: two memberships, and that is what a first run is. Two members
    // is a direct message — `direct` is a headcount — so everything said in the room the
    // person lands in addresses the bot and it answers without stage 1 being asked. Nobody
    // else is in it: a first launch puts no stranger in anybody's organization (host,
    // 2026-10-27).
    const members = Object.values(store.data.memberships).filter(
      (row) => row.room_id === scene.room,
    );
    assert.equal(members.length, 2);
    assert.equal(store.data.principals[scene.me]?.kind, 'human');
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
  const dir = await mkdtemp(join(tmpdir(), 'seek-milestone-'));
  try {
    const path = join(dir, 'seek.json');
    await writeFile(join(dir, 'agents.yml'), ROSTER_YAML);
    const store = await SeekStore.load(path);

    const run = await runFirstMilestone(store, {
      now: () => AT,
      timers: makeTimers(),
      summarise: () => 'the room so far',
      compactLines: { maxObservations: 1 },
    });

    assert.equal(run.spoke, true);
    // The compaction is the background action the tick started and the turn did not
    // finish. It has completed before the run reports, which is what the wait is for —
    // without it the run would describe a store still moving.
    //
    // Read back off the file rather than off a save the store happened to make: a
    // counter of "saves that saw a summary" answers how many saves had one in hand,
    // which any later save moves, and this turn makes one. What the wait promises is
    // that the summary is *durable*, so that is what is read.
    const reloaded = await SeekStore.load(path);
    const digest = reloaded
      .memoriesOf(run.scene.work)
      .filter((row) => row.level === 'box_digest');
    assert.equal(digest.length, 1, 'the summary was written before the run returned');
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

    // Stage 1's stub acts on everything it is given, and reads none of it — including
    // the bot it is asked about, which it takes and ignores.
    const entries = [{ id: 'ob_1' }, { id: 'ob_2' }] as never;
    assert.equal(stubJudge(world.bot, entries).length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the server and the box’s budget are read off the command line, and neither is guessed', async () => {
  const parsed = parseArgv(['--server', 'http://127.0.0.1:8080', '--window', '24', 'a.json']);
  assert.equal(parsed.server, 'http://127.0.0.1:8080');
  assert.equal(parsed.window, '24');
  assert.deepEqual(parsed.paths, ['a.json']);
  // `=` is the same request, and the value stays out of the paths either way.
  assert.equal(parseArgv(['--server=http://127.0.0.1:8080', '--window=8']).window, '8');
  assert.deepEqual(parseArgv(['--server', 'a', '--server', 'b']).repeated, ['--server']);

  const refused: [string[], RegExp][] = [
    // One without the other asks the harness to guess half of a judgement.
    [['--server', 'http://127.0.0.1:8080'], /go together/],
    [['--window', '8'], /go together/],
    // The spelling a person writes reads as a scheme to a parser, so it is refused
    // here rather than inside a request that is already on its way.
    [['--server', '127.0.0.1:8080', '--window', '8'], /not a server origin/],
    [['--server', 'ftp://127.0.0.1', '--window', '8'], /not a server origin/],
    [['--server', 'http://127.0.0.1:8080', '--window', '0'], /is not a window/],
    [['--server', 'http://127.0.0.1:8080', '--window', 'many'], /is not a window/],
  ];
  for (const [argv, expected] of refused) {
    await assert.rejects(
      async () => main(argv, { timers: makeTimers(), out: () => {} }),
      expected,
      argv.join(' '),
    );
  }
});

test('a run pointed at a model server asks that server, and the report says stage one is real', async () => {
  const { store, dir } = await onDisk();
  try {
    const server = fakeModelServer({ act: 0.95 });
    const run = await runFirstMilestone(store, {
      now: () => AT,
      timers: makeTimers(),
      watchServer: {
        baseUrl: 'http://127.0.0.1:8080',
        fetch: server.fetch,
      },
      window: 8,
    });

    // The requests are the proof the wiring happened; the answer's *effect* is the
    // proof it was the server's and not the stub's — the stub acts on everything it
    // is handed, so a bot that spoke proves nothing until a server saying `ignore`
    // silences it. That pair is below.
    assert.equal(server.asked.includes('/props'), true, 'the server was read before it was asked');
    assert.equal(server.asked.includes('/tokenize'), true, 'the state was counted on it');
    assert.equal(
      server.asked.at(-1),
      '/v1/systemone',
      'the last thing asked was the question, at the decision endpoint',
    );
    assert.equal(run.stage1Server, 'http://127.0.0.1:8080');
    assert.equal(run.spoke, true, 'a server reading 0.95 for act is a bot that acts');

    const printed = format(run, '/tmp/seek.json');
    assert.match(printed, /stage one came from a model/);
    assert.match(printed, /http:\/\/127\.0\.0\.1:8080/);
    assert.doesNotMatch(printed, /nothing above came from a model/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  const quiet = await onDisk();
  try {
    const server = fakeModelServer({ act: 0.01 });
    const run = await runFirstMilestone(quiet.store, {
      now: () => AT,
      timers: makeTimers(),
      watchServer: {
        baseUrl: 'http://127.0.0.1:8080',
        fetch: server.fetch,
      },
      window: 8,
    });
    assert.equal(run.spoke, false, 'the same run against a server reading 0.01 says nothing');
  } finally {
    await rm(quiet.dir, { recursive: true, force: true });
  }
});

test('a stage one the caller built itself is not overruled by a server it also named', async () => {
  const { store, dir } = await onDisk();
  try {
    const server = fakeModelServer();
    const run = await runFirstMilestone(store, {
      now: () => AT,
      timers: makeTimers(),
      judge: () => [],
      watchServer: {
        baseUrl: 'http://127.0.0.1:8080',
        fetch: server.fetch,
      },
      window: 8,
    });
    assert.deepEqual(server.asked, [], 'the caller’s own stage one asked the server nothing');
    assert.equal(run.stage1Server, undefined, 'and the run does not claim a model answered');
    assert.equal(run.spoke, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a server named without the box’s budget is refused before anything is delivered', async () => {
  const { store, dir } = await onDisk();
  try {
    const server = fakeModelServer();
    await assert.rejects(
      async () =>
        runFirstMilestone(store, {
          now: () => AT,
          timers: makeTimers(),
          watchServer: {
            baseUrl: 'http://127.0.0.1:8080',
            fetch: server.fetch,
          },
        }),
      /is the caller's number/,
    );
    assert.deepEqual(server.asked, [], 'nothing was asked of a server the run refused');
    // The refusal came before delivery, which is the point of settling stage one
    // first: a message nothing judged is the state this ordering exists to avoid.
    const room = Object.keys(store.data.rooms)[0];
    assert.equal(store.messagesOf(room).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
