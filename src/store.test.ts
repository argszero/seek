import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
