import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { deliver } from './delivery.ts';
import { makeWorld } from './fixtures.ts';
import { SeekStore } from './store.ts';

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
