import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { deliver } from './delivery.ts';
import { makeWorld } from './fixtures.ts';
import { emptyData, SeekStore } from './store.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

test('the on-disk shape keeps the shards apart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seek-store-'));
  const path = join(directory, 'seek.json');
  try {
    const world = makeWorld();
    const store = new SeekStore(world.store.data, path);
    deliver(store, {
      roomId: world.room,
      senderId: world.me,
      text: 'hello',
    });
    // Schema-only this round: a session row written straight into its shard.
    store.data.sessions[world.agentA1] = [
      {
        id: 'ss_1',
        agent_id: world.agentA1,
        room_id: world.room,
        workspace: '/tmp/seek/a/work',
        started_at: '2026-10-24T00:00:00.000Z',
      },
    ];
    await store.save();

    const raw = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(Object.keys(raw).sort(), [
      'agents',
      'bots',
      'memberships',
      'memories',
      'messages',
      'observations',
      'principals',
      'rooms',
      'schedule',
      'sessions',
      'turns',
    ]);

    // messages by room, observations by bot, sessions by agent.
    assert.equal(raw.messages[world.room].length, 1);
    assert.equal(raw.observations[world.botA].length, 1);
    assert.equal(raw.observations[world.botB].length, 1);
    assert.equal(Object.keys(raw.sessions).join(), world.agentA1);

    // bots and agents are separate shards, and the identity is not copied.
    assert.equal(raw.bots[world.botA].name, 'A');
    assert.equal(raw.agents[world.agentA1].bot_id, world.botA);
    assert.equal('name' in raw.agents[world.agentA1], false);

    const reloaded = await SeekStore.load(path);
    assert.deepEqual(reloaded.data, raw);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a store with no file yet starts empty', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seek-store-'));
  const path = join(directory, 'seek.json');
  try {
    const store = await SeekStore.load(path);
    assert.equal(store.data.bots && Object.keys(store.data.bots).length, 0);
    assert.equal(Object.keys(store.data).length, 11);
    assert.equal(store.hasPending('ou_nobody'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a store that is not the shape this version writes is refused, not reinterpreted', async () => {
  // The measured failure this replaces: `load` validated nothing, so a shard it did
  // not find became an empty one and the next `save()` wrote that loss to disk. The
  // store here had six messages across three turns; with `messages` removed it loaded
  // silently, ran, and left two messages and four turns naming ids that were gone.
  const directory = await mkdtemp(join(tmpdir(), 'seek-store-'));
  const path = join(directory, 'seek.json');
  try {
    // `makeWorld` builds an in-memory store, so bind its data to a real path first:
    // what this test is about is the file, and an unsaved store has none.
    const world = makeWorld();
    await new SeekStore(world.store.data, path).save();
    const healthy = await readFile(path, 'utf8');
    const shards = Object.keys(JSON.parse(healthy));

    const refuse = async (label: string, body: string, expected: RegExp) => {
      await writeFile(path, body, 'utf8');
      const before = await readFile(path, 'utf8');
      await assert.rejects(
        () => SeekStore.load(path),
        (error: Error) => {
          assert.match(error.message, expected, label);
          // The file names itself: a refusal a reader cannot locate is a shrug.
          assert.ok(error.message.includes(path), `${label} names the file`);
          return true;
        },
        label,
      );
      // And the point of the whole check: refusing never repairs, rewrites or moves it.
      assert.equal(await readFile(path, 'utf8'), before, `${label} left the file untouched`);
    };

    // A shard that is present but the wrong shape. `messages` is a map of room id to
    // rows; an array here would be written back as an array by the next save().
    await refuse(
      'a map that is an array',
      JSON.stringify({ ...JSON.parse(healthy), messages: [] }),
      /"messages" should be a map of ids to rows and is an array/,
    );
    await refuse(
      'a table that is an object',
      JSON.stringify({ ...JSON.parse(healthy), turns: {} }),
      /"turns" should be an array and is an object/,
    );

    // A shard that is absent at all — the truncation case and the older-file case,
    // which are indistinguishable from here and both read as empty if tolerated.
    const withoutMessages: Record<string, unknown> = JSON.parse(healthy);
    delete withoutMessages.messages;
    await refuse(
      'a missing shard',
      JSON.stringify(withoutMessages),
      /"messages" is absent, and an absent shard would read as an empty one/,
    );
    await refuse(
      'several missing shards',
      JSON.stringify({ bots: {}, agents: {} }),
      /"principals", "rooms".*are absent/s,
    );

    // Not a store at all, in the two shapes a half-written file takes.
    await refuse('not JSON', 'seek — the first milestone\n', /is not JSON, so it is not a store/);
    await refuse('a JSON array', '[]', /is an array, and a store is a JSON object/);
    await refuse('a JSON scalar', '"nope"', /is a string, and a store is a JSON object/);
    await refuse('JSON null', 'null', /is null, and a store is a JSON object/);

    // And the healthy file still loads, with every shard it named.
    await writeFile(path, healthy, 'utf8');
    const reopened = await SeekStore.load(path);
    assert.deepEqual(Object.keys(reopened.data).sort(), shards.sort());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a key this version does not read survives a round trip', async () => {
  // Keeping an unknown key is the non-destructive choice: `save()` writes `this.data`
  // whole, so refusing one would turn a newer file into a dead end for an older build.
  const directory = await mkdtemp(join(tmpdir(), 'seek-store-'));
  const path = join(directory, 'seek.json');
  try {
    const world = makeWorld();
    await new SeekStore(world.store.data, path).save();
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    parsed.from_a_later_version = { kept: true };
    await writeFile(path, JSON.stringify(parsed), 'utf8');

    const reopened = await SeekStore.load(path);
    await reopened.save();
    const written = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(written.from_a_later_version, { kept: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * Every document that states the on-disk shape states it the same way, and the code
 * agrees — because §7 and the checklist both tell a reader what the shards are.
 *
 * The sentence that made this worth a test is the one a person reads at the worst
 * possible moment. The store refuses a file it cannot read, and the refusal names its
 * authority: *"docs/design/data-model.md §7 fixes the eleven shards"*. A refusal citing
 * a specification that no longer says that sends its reader to a contradiction.
 *
 * **It had already drifted twice, in two documents.** §7 wrote `memories` with no shard
 * key while rule 8 of the same document says *"Memory is per agent, not per bot"* (#54
 * repaired that). And `src/README.md`'s checklist row still listed the shape it had
 * before the schedule ruling of 2026-10-24: **ten** names, with `schedule` absent
 * altogether, and no shard keys on the three maps that carry one. Both twins carried
 * each omission, so `docs.test.ts` — which compares a document with its twin, structure
 * against structure — saw two halves that agreed with each other and with nothing else.
 * This is the check against the code, and it reads the shard key as well as the name.
 *
 * **Nothing here lists the shards or the documents.** The code side is `SeekData`'s own
 * field declarations, read from source the way `calibration.test.ts` reads `llama.ts`
 * for the estimator it must name; the document side is a scan of the tree for the
 * statement itself. A list of either kept beside this test would be the second place to
 * forget — the objection `docs.test.ts` already makes to a table of twin pairs.
 */

/** A shard list as a document states it: names, and the key each map is sharded by. */
interface ShardStatement {
  where: string;
  shards: { name: string; key?: string }[];
}

/** Directories that hold no document of this repository. */
const NOT_DOCUMENTS = new Set(['node_modules', '.git', '.emrg', 'dist', 'prototype']);

/**
 * Every statement of the shard list in the tree.
 *
 * Matched **line by line**, not over the whole file: these documents use backticks in
 * prose that do not pair up across the file as a whole, and a file-wide scan pairs them
 * wrongly — it swallowed §7's own list into a span beginning several paragraphs earlier
 * when this was first written, which is how a scan reports zero problems on a broken
 * tree. A statement is one backticked span on one line that reads as a slash-separated
 * sequence starting with a shard the code has.
 */
function shardStatements(): ShardStatement[] {
  const known = new Set(Object.keys(emptyData()));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const found: ShardStatement[] = [];
  for (const entry of readdirSync(root, { recursive: true })) {
    const name = String(entry);
    if (!name.endsWith('.md')) continue;
    if (name.split('/').some((part) => NOT_DOCUMENTS.has(part))) continue;
    const text = readFileSync(join(root, name), 'utf8');
    text.split('\n').forEach((line, index) => {
      for (const match of line.matchAll(/`([^`]+)`/g)) {
        const span = match[1];
        if (!span.includes(' / ')) continue;
        const parts = span
          .split('/')
          .map((part) => part.trim())
          .filter((part) => part.length > 0);
        const first = (parts[0] ?? '').split('[')[0];
        if (!known.has(first)) continue;
        found.push({
          where: `${name}:${index + 1}`,
          shards: parts.map((part) => {
            const [, shard, key] = part.match(/^([^[]+)(?:\[(.+)\])?$/) ?? [];
            return key === undefined ? { name: shard } : { name: shard, key };
          }),
        });
      }
    });
  }
  return found;
}

/**
 * How `SeekData` declares each shard, which is the only place the code says whether a
 * shard is a whole table, a map keyed by id, or a map sharded by one.
 */
function declaredShards(source: string): {
  sharded: string[];
  keyed: string[];
  tables: string[];
} {
  const start = source.indexOf('export interface SeekData');
  assert.ok(start >= 0, 'SeekData is no longer declared where this test looks');
  const end = source.indexOf('\n}', start);
  assert.ok(end > start, 'SeekData is no longer a closed interface');
  const sharded: string[] = [];
  const keyed: string[] = [];
  const tables: string[] = [];
  for (const line of source.slice(start, end).split('\n')) {
    const declared = line.match(/^\s{2}([a-z_]+):\s*(.+?);\s*$/);
    if (!declared) continue;
    const [, name, type] = declared;
    if (/^Record<Id,\s*\w+\[\]>$/.test(type)) sharded.push(name);
    else if (/^Record<Id,\s*\w+>$/.test(type)) keyed.push(name);
    else if (/^\w+\[\]$/.test(type)) tables.push(name);
  }
  return { sharded, keyed, tables };
}

test('every document that states the on-disk shape states the one the code has', () => {
  const statements = shardStatements();
  const code = declaredShards(readFileSync(join(ROOT, 'src/store.ts'), 'utf8'));

  // Anti-vacuity, both halves. A scan that found no statement would agree with every
  // rule below without reading anything, and a parse that found no field would call
  // every document correct.
  assert.ok(statements.length >= 2, `only ${statements.length} statements of the shard list were found`);
  assert.ok(
    new Set(statements.map((own) => own.where.split(':')[0])).size >= 2,
    'every statement of the shard list came from one file — the scan is not reading the tree',
  );
  assert.ok(code.sharded.length >= 3, `only ${code.sharded.length} sharded maps were read`);
  assert.ok(code.keyed.length >= 3, `only ${code.keyed.length} keyed maps were read`);
  assert.ok(code.tables.length >= 2, `only ${code.tables.length} tables were read`);

  const everyName = [...code.sharded, ...code.keyed, ...code.tables].sort();
  for (const statement of statements) {
    assert.deepEqual(
      statement.shards.map((own) => own.name).sort(),
      everyName,
      `${statement.where} states a shard list the code does not have — the store refuses ` +
        'a file for shards it does not find and tells its reader §7 fixes them, so a ' +
        'document that disagrees makes that message point at a contradiction',
    );
    // The claim the drift was actually in. Comparing names alone let both omissions sit
    // unnoticed: `schedule` was missing outright, and `memories` was missing its key.
    assert.deepEqual(
      statement.shards.filter((own) => own.key !== undefined).map((own) => own.name).sort(),
      [...code.sharded].sort(),
      `${statement.where} and \`SeekData\` disagree about which shards are sharded — the ` +
        'documents mark a sharded map with its key (`sessions[agentId]`), and a field ' +
        'declared `Record<Id, X[]>` is sharded by that id',
    );
  }
});

test('two saves that overlap both land instead of one failing on the shared temp file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seek-store-'));
  const path = join(directory, 'seek.json');
  try {
    const world = makeWorld();
    const store = new SeekStore(world.store.data, path);

    // The temporary file `save()` writes through is named for the pid alone, so two
    // saves overlapping in one process shared it: whichever renamed first took it
    // away and the other failed `ENOENT` on a store whose data was perfectly fine.
    // They do overlap — `kernel.ts` starts compaction without awaiting it — and
    // `host-rulings.md` gives that overlap the atomicity being checked here.
    const first = store.save();
    store.data.memories[world.agentA1] = [
      {
        id: 'mem_1',
        agent_id: world.agentA1,
        level: 'diary',
        body: 'the arrival',
        consumed_to: 'ob_1',
        updated_at: '2026-10-25T00:00:00.000Z',
      },
    ];
    const second = store.save();

    // Neither may reject. A save that throws is a write the caller cannot retry and
    // a row it has no way to know is safe.
    await Promise.all([first, second]);

    const parsed = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(
      parsed.memories[world.agentA1]?.[0]?.body,
      'the arrival',
      'the later save is the one left on disk',
    );
    assert.deepEqual(
      readdirSync(directory),
      ['seek.json'],
      'no temporary file was left behind',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a save that failed does not stop the saves queued behind it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seek-store-'));
  const blocker = join(directory, 'not-a-directory');
  try {
    // A parent that is a file makes the write fail for real, without a permission
    // mode that a runner owned by root would quietly ignore.
    await writeFile(blocker, 'a file where a directory would have to be', 'utf8');
    const world = makeWorld();
    const store = new SeekStore(world.store.data, join(blocker, 'seek.json'));
    await assert.rejects(() => store.save(), /ENOTDIR|EEXIST/, 'the first save fails');

    // The chain's link must not carry that rejection forward: once the obstacle is
    // gone the store is still writable, and the save behind the failed one lands.
    await rm(blocker);
    const path = join(directory, 'seek.json');
    store.path = path;
    await store.save();
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(
      Object.keys(parsed).sort(),
      Object.keys(world.store.data).sort(),
      'the save behind the failed one wrote the whole file',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a reader never sees half a file, however many saves are in flight', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seek-store-'));
  const path = join(directory, 'seek.json');
  try {
    const world = makeWorld();
    const store = new SeekStore(world.store.data, path);
    // A file of realistic size on purpose. The window a reader can fall into is the
    // time a write spends writing, so a toy store hides it: measured on a 2.9 MB
    // store, 147 of 480 reads taken during a write that went straight to the file
    // were unparseable, and 0 of 480 during a write that renamed one into place.
    for (let i = 0; i < 1200; i += 1) {
      store.data.messages[`rm_${i}`] = [
        {
          id: `om_${i}`,
          room_id: `rm_${i}`,
          sender_id: world.me,
          text: 'x'.repeat(700),
          at: '2026-10-25T00:00:00.000Z',
        },
      ];
    }
    await store.save();

    // `save()` promises "a reader never sees half a file", and every other test here
    // reads only once a save has settled — so that sentence had nothing measuring it.
    // This reads while the write is in flight, which is when it can be false: a
    // partial read does not come back short, it comes back as JSON that does not
    // parse, and `load()` refuses it.
    const rounds = 20;
    let reads = 0;
    for (let round = 0; round < rounds; round += 1) {
      store.data.memories[world.agentA1] = [
        {
          id: `mem_${round}`,
          agent_id: world.agentA1,
          level: 'diary',
          body: 'an arrival during a write',
          updated_at: '2026-10-25T00:00:00.000Z',
        },
      ];
      const writing = store.save();
      const reading = Array.from({ length: 6 }, async () => {
        const reopened = await SeekStore.load(path);
        reads += 1;
        return reopened;
      });
      const settled = await Promise.all([writing, ...reading]);
      for (const reopened of settled.slice(1) as SeekStore[]) {
        // Whatever it read, it is one whole snapshot: every shard present.
        assert.deepEqual(
          Object.keys(reopened.data).sort(),
          Object.keys(store.data).sort(),
          `round ${round} read a file missing a shard`,
        );
      }
    }
    assert.ok(reads >= rounds * 6, `only ${reads} reads were taken during a write`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
