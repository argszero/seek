import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deliver } from './delivery.ts';
import { makeDirectWorld, makeWorld } from './fixtures.ts';

test('mentionsMe is derived at delivery and never written onto the message', () => {
  const world = makeWorld();
  const { message, observations } = deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: '@A can you look at this?',
    mentions: [{ id: world.botA, name: 'A' }],
    now: '2026-10-24T01:00:00.000Z',
  });

  const toA = observations.find((entry) => entry.bot_id === world.botA);
  const toB = observations.find((entry) => entry.bot_id === world.botB);
  assert.equal(toA?.hints.mentionsMe, true);
  assert.equal(toB?.hints.mentionsMe, false);
  assert.equal(toA?.kind, 'mention');

  // The shared fact keeps Feishu's field and nothing per-reader.
  assert.deepEqual(message.mentions, [{ id: world.botA, name: 'A' }]);
  assert.equal('mentionsMe' in message, false);
  assert.equal('hints' in message, false);
  assert.equal(JSON.stringify(message).includes('mentionsMe'), false);

  // Nor does a second reader's answer land on the stored log.
  const log = JSON.stringify(world.store.messagesOf(world.room));
  assert.equal(log.includes('mentionsMe'), false);
  assert.equal(world.store.messagesOf(world.room).length, 1);
});

test('the answer is a snapshot taken at delivery, not a live view', () => {
  const world = makeWorld();
  const mentions = [{ id: world.botA, name: 'A' }];
  const { observations } = deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: 'first',
    mentions,
  });
  const toB = observations.find((entry) => entry.bot_id === world.botB);
  assert.equal(toB?.hints.mentionsMe, false);

  // B is named afterwards: that is a different message's fact, not this one's.
  mentions.push({ id: world.botB, name: 'B' });
  assert.equal(toB?.hints.mentionsMe, false);
  assert.equal(world.store.messagesOf(world.room)[0].mentions.length, 1);
});

test('one entry per recipient bot, not one per agent', () => {
  const world = makeWorld();
  const { observations } = deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: 'hello room',
  });

  assert.equal(observations.length, 2);
  assert.equal(world.store.agentsOf(world.botA).length, 2);
  assert.equal(world.store.inbox(world.botA).length, 1);
  assert.equal(world.store.inbox(world.botB).length, 1);

  for (const agentId of [world.agentA1, world.agentA2, world.agentB1]) {
    assert.equal(agentId in world.store.data.observations, false);
  }
});

test('a bot does not deliver its own message to itself', () => {
  const world = makeWorld();
  const { observations } = deliver(world.store, {
    roomId: world.room,
    senderId: world.botA,
    agentId: world.agentA2,
    text: 'looking now',
  });

  assert.deepEqual(
    observations.map((entry) => entry.bot_id),
    [world.botB],
  );
  assert.equal(world.store.hasPending(world.botA), false);
  // The room still records which agent of the bot spoke.
  assert.equal(world.store.messagesOf(world.room)[0].agent_id, world.agentA2);
});

test('the kind is decided once at delivery: mention, reply, direct, message', () => {
  const group = makeWorld();
  const plain = deliver(group.store, {
    roomId: group.room,
    senderId: group.me,
    text: 'just talking',
  });
  assert.equal(plain.observations[0].kind, 'message');

  const byA = deliver(group.store, {
    roomId: group.room,
    senderId: group.botA,
    text: 'on it',
  });
  const answer = deliver(group.store, {
    roomId: group.room,
    senderId: group.me,
    text: 'thanks',
    rootId: byA.message.id,
  });
  const toA = answer.observations.find((entry) => entry.bot_id === group.botA);
  assert.equal(toA?.hints.repliesToMe, true);
  assert.equal(toA?.kind, 'reply');
  assert.equal(answer.message.depth, 1);
  assert.equal(answer.message.chain, byA.message.id);

  const direct = makeDirectWorld();
  const inDirect = deliver(direct.store, {
    roomId: direct.room,
    senderId: direct.me,
    text: 'just you and me',
  });
  assert.equal(inDirect.observations.length, 1);
  assert.equal(inDirect.observations[0].hints.direct, true);
  assert.equal(inDirect.observations[0].kind, 'direct');
});

test('a mention outranks a reply, and both outrank a plain message', () => {
  const world = makeWorld();
  const byA = deliver(world.store, {
    roomId: world.room,
    senderId: world.botA,
    text: 'question for you',
  });
  const answer = deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: '@A answering you',
    rootId: byA.message.id,
    mentions: [{ id: world.botA, name: 'A' }],
  });
  const toA = answer.observations.find((entry) => entry.bot_id === world.botA);
  assert.equal(toA?.hints.repliesToMe, true);
  assert.equal(toA?.hints.mentionsMe, true);
  assert.equal(toA?.kind, 'mention');
});

test('an image message carries its picture, as a copy of the caller\'s reference', () => {
  const world = makeWorld();
  const media = { key: 'blobs/screen.png', mime: 'image/png' };
  const { message } = deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    kind: 'image',
    text: '这个报错怎么办',
    media,
  });

  assert.equal(message.kind, 'image');
  assert.deepEqual(message.media, { key: 'blobs/screen.png', mime: 'image/png' });

  // The message is written once and stays clean: a caller still holding the
  // reference cannot rename the picture under a message already delivered.
  media.key = 'blobs/somewhere-else.png';
  assert.equal(message.media?.key, 'blobs/screen.png');
  assert.equal(world.store.messagesOf(world.room)[0].media?.key, 'blobs/screen.png');
});

test('an image message with no picture is refused at the door', () => {
  const world = makeWorld();
  // The alt-text failure itself: a kind that says "look at this" with nothing to
  // look at, which every reader downstream treats as a text message.
  assert.throws(
    () =>
      deliver(world.store, {
        roomId: world.room,
        senderId: world.me,
        kind: 'image',
        text: '看这张',
      }),
    /no image/,
  );
  // A picture whose key names no blob is the same failure wearing a field.
  assert.throws(
    () =>
      deliver(world.store, {
        roomId: world.room,
        senderId: world.me,
        kind: 'image',
        text: '看这张',
        media: { key: '   ', mime: 'image/png' },
      }),
    /no image/,
  );
  assert.equal(world.store.messagesOf(world.room).length, 0, 'a refusal writes nothing');
});

test('a picture on a message whose kind disowns it is refused', () => {
  const world = makeWorld();
  assert.throws(
    () =>
      deliver(world.store, {
        roomId: world.room,
        senderId: world.me,
        kind: 'text',
        text: 'hello',
        media: { key: 'blobs/screen.png', mime: 'image/png' },
      }),
    /only 'image' carries a picture/,
  );
  assert.equal(world.store.messagesOf(world.room).length, 0);
});

test('an image message whose bytes are not an image is refused', () => {
  const world = makeWorld();
  assert.throws(
    () =>
      deliver(world.store, {
        roomId: world.room,
        senderId: world.me,
        kind: 'image',
        text: 'the invoice',
        media: { key: 'blobs/invoice.pdf', mime: 'application/pdf' },
      }),
    /bytes say otherwise/,
  );
  assert.equal(world.store.messagesOf(world.room).length, 0);
});
