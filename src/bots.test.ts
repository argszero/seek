import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBot } from './bots.ts';
import { makeWorld } from './fixtures.ts';
import { createRoom } from './rooms.ts';

test('a bot is written with the card it was given, and can be put in a room at once', () => {
  const world = makeWorld();
  const before = Object.keys(world.store.data.bots).length;

  const { bot } = createBot(world.store, {
    name: '关龙',
    gender: '男',
    position: '接口与联调',
    personality: '先给结论再给理由；改接口前列出谁会被影响。',
  });

  assert.equal(Object.keys(world.store.data.bots).length, before + 1);
  assert.equal(bot.name, '关龙');
  assert.equal(bot.gender, '男');
  assert.equal(bot.position, '接口与联调');
  // Verbatim, newlines included: a personality is what the person typed, not a label
  // this file trims into shape.
  assert.equal(bot.personality, '先给结论再给理由；改接口前列出谁会被影响。');
  // The id is the store's own shape, so a bot made here is no different from a seeded one.
  assert.match(bot.id, /^ou_[0-9a-f]{16}$/);

  // And it is a member a room can be given: `createRoom` reads `principals` and `bots`
  // together, which is the fact that makes one write enough.
  const { memberships } = createRoom(world.store, {
    name: 'a room with the new bot',
    members: [{ principalId: world.me, role: 'owner' }, { principalId: bot.id }],
  });
  assert.equal(memberships.length, 2);
  assert.equal(world.store.principal(bot.id)?.name, '关龙');
});

test('a bot with no name is refused, and the store is left as it was', () => {
  const world = makeWorld();
  const before = Object.keys(world.store.data.bots).sort();

  for (const name of ['', '   ', '\t\n']) {
    assert.throws(
      () => createBot(world.store, { name }),
      /a bot with no name/,
      `'${name}' is not a name`,
    );
  }

  // Nothing was written by any of the three attempts: a refusal that leaves half a bot
  // behind is a row the window would draw and nobody could name.
  assert.deepEqual(Object.keys(world.store.data.bots).sort(), before);
});

test('the three card fields are optional, and not being asked is not the same as declining', () => {
  const world = makeWorld();

  const bare = createBot(world.store, { name: 'a bot with no card' }).bot;
  assert.deepEqual(Object.keys(bare).sort(), ['id', 'name']);
  // A field that was never given is absent, so nothing claims it was answered.
  assert.equal('gender' in bare, false);
  assert.equal('position' in bare, false);
  assert.equal('personality' in bare, false);

  // `gender: ''` is kept: the window's own `未选` is an answer, and the store keeps it
  // apart from a bot that was never asked (`types.ts`, `Bot`).
  const declined = createBot(world.store, { name: 'declined', gender: '' }).bot;
  assert.equal(declined.gender, '');
  assert.equal('position' in declined, false);
});

test('what is stored is trimmed, and whitespace is not an answer', () => {
  const world = makeWorld();
  const { bot } = createBot(world.store, {
    name: '  李静  ',
    gender: ' 女 ',
    position: '   ',
    personality: '  排期与提醒  ',
  });

  assert.equal(bot.name, '李静');
  assert.equal(bot.gender, '女');
  // Whitespace-only is nothing typed, so the field is absent rather than blank.
  assert.equal('position' in bot, false);
  assert.equal(bot.personality, '排期与提醒');
});

test('two bots may carry the same name: a name is a label, and the id tells them apart', () => {
  const world = makeWorld();
  const first = createBot(world.store, { name: '周敏' }).bot;
  const second = createBot(world.store, { name: '周敏' }).bot;

  assert.notEqual(first.id, second.id);
  assert.equal(world.store.data.bots[first.id].name, '周敏');
  assert.equal(world.store.data.bots[second.id].name, '周敏');
});
