import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
 * §7 of `data-model.md` names the eleven shards and the key each map is sharded by; the
 * code refuses a file that does not carry them. Nothing tied the two lists together.
 *
 * The sentence that made this worth a test is the one a person reads at the worst
 * possible moment — the refusal names its authority: *"docs/design/data-model.md §7 fixes
 * the eleven shards"*. A refusal citing a specification that no longer says that sends
 * its reader to a contradiction.
 *
 * **It had already drifted, in the one place the twin check cannot see.** §7 writes the
 * sharded maps with their key — `sessions[agentId]`, `messages[roomId]`,
 * `observations[botId]` — and wrote `memories` with none, which reads as a plain table
 * beside `turns` and `schedule`. Rule 8 of the same document says the opposite in as many
 * words (*"Memory is per agent, not per bot"*), and so does `SeekData`, whose `memories`
 * is `Record<Id, Memory[]>`. Both twins carried the same omission, so `docs.test.ts` —
 * which compares structure, not claims — saw two halves that agreed with each other and
 * with nothing else. This check is therefore against the code rather than against the
 * twin, and it is the bracket it reads, not only the name.
 *
 * **Neither side's list is written here.** The code side is `SeekData`'s own field
 * declarations, read from source the way `calibration.test.ts` reads `llama.ts` for the
 * estimator it must name; the document side is §7's own sentence. A list kept beside the
 * test would be the second place to forget — the objection `docs.test.ts` already makes
 * to a table of twin pairs.
 */

/** The shard names §7 lists, with the shard key it gives each one. */
function shardListOf(text: string, name: string): { name: string; key?: string }[] {
  const start = text.indexOf('## 7');
  assert.ok(start >= 0, `${name} has no §7`);
  const after = text.indexOf('\n## ', start + 1);
  const section = after === -1 ? text.slice(start) : text.slice(start, after);
  // The list is the one backticked span in §7 that reads as a slash-separated sequence.
  const span = (section.match(/`[^`]+`/g) ?? []).find((own) => own.includes(' / '));
  assert.ok(span, `${name} §7 names no slash-separated shard list`);
  return span
    .slice(1, -1)
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const [, shard, key] = part.match(/^([^[]+)(?:\[(.+)\])?$/) ?? [];
      return key === undefined ? { name: shard } : { name: shard, key };
    });
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

test('the shards the refusal names are the shards the specification fixes', () => {
  const english = shardListOf(
    readFileSync(join(ROOT, 'docs/design/data-model.md'), 'utf8'),
    'data-model.md',
  );
  const chinese = shardListOf(
    readFileSync(join(ROOT, 'docs/design/data-model.zh-CN.md'), 'utf8'),
    'data-model.zh-CN.md',
  );
  const code = declaredShards(readFileSync(join(ROOT, 'src/store.ts'), 'utf8'));

  // Anti-vacuity: an extraction that found nothing would agree with every rule below.
  assert.ok(english.length >= 8, `only ${english.length} shards were read out of §7`);
  assert.ok(code.sharded.length >= 3, `only ${code.sharded.length} sharded maps were read`);
  assert.ok(code.keyed.length >= 3, `only ${code.keyed.length} keyed maps were read`);
  assert.ok(code.tables.length >= 2, `only ${code.tables.length} tables were read`);

  const named = english.map((part) => part.name).sort();
  assert.deepEqual(
    named,
    [...code.sharded, ...code.keyed, ...code.tables].sort(),
    'docs/design/data-model.md §7 and the `SeekData` interface name different shards — ' +
      'the store refuses a file for shards it does not find and tells its reader §7 fixes ' +
      'them, so a shard added on one side alone makes that message point at a contradiction',
  );

  // The claim the drift was in: a map the code shards by an id is written with that shard
  // key, and a plain table is not. Comparing names alone is what let this sit unnoticed.
  const bracketed = english.filter((part) => part.key !== undefined).map((part) => part.name);
  assert.deepEqual(
    bracketed.sort(),
    [...code.sharded].sort(),
    '§7 and `SeekData` disagree about which shards are sharded — §7 marks a sharded map ' +
      'with its shard key (`sessions[agentId]`), and a map that carries `Record<Id, X[]>` ' +
      'is sharded by that id',
  );

  // And the pair states one list: the twin of a document is the document.
  assert.deepEqual(
    chinese.map((part) => `${part.name}${part.key === undefined ? '' : `[${part.key}]`}`),
    english.map((part) => `${part.name}${part.key === undefined ? '' : `[${part.key}]`}`),
    'docs/design/data-model.md §7 and its Chinese twin list different shards',
  );
});
