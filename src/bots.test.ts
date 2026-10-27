import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBot, removeBot } from './bots.ts';
import { deliver } from './delivery.ts';
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

// ---- taking a bot out of the organization (2026-10-27) ----

const AT = '2026-10-27T00:00:00.000Z';

test('a bot taken out is stamped, loses its rooms, and keeps the messages it wrote', () => {
  const world = makeWorld();
  const { room } = createRoom(world.store, {
    name: 'the room',
    members: [{ principalId: world.me }, { principalId: world.botA }],
    now: AT,
  });
  deliver(world.store, { roomId: room.id, senderId: world.botA, text: 'I was here', now: AT });

  const gone = removeBot(world.store, { botId: world.botA, now: AT });
  // It held two memberships in this world — the fixture's room and the one made here —
  // and taking it out of the organization takes it out of both.
  assert.deepEqual(gone.rooms.slice().sort(), [world.room, room.id].sort());
  assert.equal(gone.bot.removed_at, AT);
  assert.equal(world.store.isMember(world.room, world.botA), false);

  // Out of every room, and out of the one that mattered: `botsIn` is what delivery
  // wakes, so a membership left behind is a bot that keeps answering.
  assert.equal(world.store.membershipsOf(room.id).length, 1);
  assert.deepEqual(world.store.botsIn(room.id), []);
  const after = deliver(world.store, { roomId: room.id, senderId: world.me, text: 'hello', now: AT });
  assert.deepEqual(after.observations, []);

  // **The row is still there**, because every message it wrote names it.
  assert.equal(world.store.data.bots[world.botA].name, 'A');
  assert.equal(world.store.messagesOf(room.id)[0].sender_id, world.botA);
  // And a reader can still resolve that name: a reference to a deleted row is a room
  // drawing its own history with a blank in it.
  assert.equal(world.store.principal(world.botA)?.name, 'A');
});

test('a bot that is the only member of a room may not be taken out', () => {
  const world = makeWorld();
  const { room } = createRoom(world.store, {
    members: [{ principalId: world.botB }],
    now: AT,
  });

  const refusal = (() => {
    try {
      removeBot(world.store, { botId: world.botB, now: AT });
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  })();
  assert.match(String(refusal), /only member of/);
  // Refused in its sentence, naming the room — and nothing written before it threw.
  assert.equal(String(refusal).includes(room.id), true);
  assert.equal(world.store.membershipsOf(room.id).length, 1);
  assert.equal(world.store.data.bots[world.botB].removed_at, undefined);
});

test('taking out an unknown bot, or the same bot twice, is refused in the kernel\'s words', () => {
  const world = makeWorld();
  createRoom(world.store, {
    members: [{ principalId: world.me }, { principalId: world.botA }],
    now: AT,
  });

  assert.throws(() => removeBot(world.store, { botId: 'ou_nowhere' }), /unknown bot/);
  // A person is not a bot: the shard it reads is `bots`, so the human in this world is
  // not found rather than silently taken out.
  assert.throws(() => removeBot(world.store, { botId: world.me }), /unknown bot/);

  removeBot(world.store, { botId: world.botA, now: AT });
  assert.throws(
    () => removeBot(world.store, { botId: world.botA, now: '2026-10-28T00:00:00.000Z' }),
    /already taken out/,
  );
  // A second stamp would move the moment it happened, so the first one stands.
  assert.equal(world.store.data.bots[world.botA].removed_at, AT);
});
