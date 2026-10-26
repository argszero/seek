import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deliver, toggleReaction } from './delivery.ts';
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

/**
 * The three things a message carries besides its own words — `quoted`,
 * `forwarded_from` and `reactions` (`src/types.ts`).
 *
 * Both snapshots are taken by `deliver()` out of the store, and both are refused
 * when the caller tries to supply them from outside: a quotation is a claim about
 * what somebody said, and the only copy of that this program has is the message
 * itself.
 */
test('a reply keeps the quoted message as it read when the reply was sent', () => {
  const world = makeWorld();
  const first = deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: 'the gate stays local',
    now: '2026-10-26T01:00:00.000Z',
  });
  const reply = deliver(world.store, {
    roomId: world.room,
    senderId: world.botA,
    text: 'agreed',
    quoteOf: first.message.id,
    now: '2026-10-26T01:01:00.000Z',
  });

  assert.deepEqual(reply.message.quoted, {
    message_id: first.message.id,
    name: 'me',
    text: 'the gate stays local',
  });

  // A snapshot, not a live view: renaming the quoted sender afterwards is a fact
  // about the roster, not a rewrite of what the reply answered.
  world.store.data.principals[world.me].name = 'renamed';
  assert.equal(reply.message.quoted?.name, 'me');
});

test('a quotation is cut to the block that draws it', () => {
  const world = makeWorld();
  const first = deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: 'x'.repeat(400),
  });
  const reply = deliver(world.store, {
    roomId: world.room,
    senderId: world.botA,
    text: 'that is long',
    quoteOf: first.message.id,
  });
  assert.equal(reply.message.quoted?.text.length, 160, 'one line, cut where the block ends');
});

test('a forward carries the original message and says whose words they are', () => {
  const world = makeWorld();
  const original = deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: 'the numbers are in the sheet',
  });
  const forward = deliver(world.store, {
    roomId: world.room,
    senderId: world.botB,
    forwardOf: original.message.id,
  });

  assert.notEqual(forward.message.id, original.message.id, 'a forward is its own message');
  assert.equal(forward.message.text, 'the numbers are in the sheet', 'with the same words');
  assert.equal(forward.message.kind, 'text');
  assert.deepEqual(forward.message.forwarded_from, {
    message_id: original.message.id,
    name: 'me',
  });
  assert.equal('quoted' in forward.message, false, 'a forward quotes nothing');
});

test('forwarding a picture carries the picture, not a claim about it', () => {
  const world = makeWorld();
  const original = deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    kind: 'image',
    text: '',
    media: { key: 'blobs/screen.png', mime: 'image/png' },
  });
  const forward = deliver(world.store, {
    roomId: world.room,
    senderId: world.botA,
    forwardOf: original.message.id,
  });

  assert.equal(forward.message.kind, 'image');
  assert.deepEqual(forward.message.media, { key: 'blobs/screen.png', mime: 'image/png' });
  // The reference is copied, not shared: two messages must not point at one
  // mutable object, which is the reason `mediaFor` copies too.
  assert.notEqual(forward.message.media, original.message.media);
});

test('a forward cannot be given content of its own', () => {
  const world = makeWorld();
  const original = deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: 'the original',
  });
  assert.throws(
    () =>
      deliver(world.store, {
        roomId: world.room,
        senderId: world.botA,
        text: 'something else entirely',
        forwardOf: original.message.id,
      }),
    /carrying content of its own/,
  );
  assert.equal(world.store.messagesOf(world.room).length, 1, 'a refusal writes nothing');
});

test('a message cannot both quote and forward', () => {
  const world = makeWorld();
  const original = deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: 'the original',
  });
  assert.throws(
    () =>
      deliver(world.store, {
        roomId: world.room,
        senderId: world.botA,
        text: '',
        quoteOf: original.message.id,
        forwardOf: original.message.id,
      }),
    /both quotes and forwards/,
  );
});

test('naming a message that is not in this room is refused, not ignored', () => {
  const world = makeWorld();
  assert.throws(
    () =>
      deliver(world.store, {
        roomId: world.room,
        senderId: world.me,
        text: 'reply to nothing',
        quoteOf: 'om_not_here',
      }),
    /unknown message in/,
  );
  assert.throws(
    () =>
      deliver(world.store, {
        roomId: world.room,
        senderId: world.me,
        forwardOf: 'om_not_here',
      }),
    /unknown message in/,
  );
  assert.equal(world.store.messagesOf(world.room).length, 0);
});

test('a message nobody reacted to, quoted or forwarded carries none of the three', () => {
  const world = makeWorld();
  const sent = deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: 'plain',
  });
  const stored = JSON.stringify(sent.message);
  for (const field of ['reactions', 'quoted', 'forwarded_from']) {
    assert.equal(stored.includes(field), false, `${field} is absent until something sets it`);
  }
});

test('a reaction stores its operators and no count of its own', () => {
  const world = makeWorld();
  const sent = deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: 'who is in?',
  });

  const once = toggleReaction(world.store, {
    roomId: world.room,
    messageId: sent.message.id,
    principalId: world.botA,
    emojiType: 'OK',
  });
  assert.deepEqual(once.reactions, [{ emoji_type: 'OK', operators: [world.botA] }]);

  toggleReaction(world.store, {
    roomId: world.room,
    messageId: sent.message.id,
    principalId: world.botB,
    emojiType: 'OK',
  });
  assert.deepEqual(once.reactions?.[0].operators, [world.botA, world.botB]);

  // The count Feishu stores is this array's length and nothing else: a stored
  // total beside a list is a second answer, and a hand-repaired file could then
  // say four people while naming two.
  const stored = JSON.stringify(world.store.messagesOf(world.room));
  assert.equal(stored.includes('"count"'), false, 'no stored count');
  assert.equal(stored.includes('"mine"'), false, "and no per-reader 'mine'");

  // The same click takes it back.
  toggleReaction(world.store, {
    roomId: world.room,
    messageId: sent.message.id,
    principalId: world.botA,
    emojiType: 'OK',
  });
  assert.deepEqual(once.reactions?.[0].operators, [world.botB]);
});

test('taking back the last reaction leaves no field behind', () => {
  const world = makeWorld();
  const sent = deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: 'anyone?',
  });
  const input = {
    roomId: world.room,
    messageId: sent.message.id,
    principalId: world.botA,
    emojiType: 'SMILE',
  };
  toggleReaction(world.store, input);
  const after = toggleReaction(world.store, input);

  assert.equal('reactions' in after, false, 'no zero row to draw');
  const stored = JSON.stringify(world.store.messagesOf(world.room));
  assert.equal(stored.includes('reactions'), false, 'and nothing on disk either');
});

test('a reaction needs a real principal who is in the room, and an emoji', () => {
  const world = makeWorld();
  const sent = deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: 'hello',
  });
  const base = {
    roomId: world.room,
    messageId: sent.message.id,
    principalId: world.botA,
    emojiType: 'OK',
  };

  assert.throws(
    () => toggleReaction(world.store, { ...base, principalId: 'ou_nobody' }),
    /unknown principal/,
  );

  // A principal the store knows but this room has never heard of: a reaction is
  // somebody's answer to a message they were there for.
  world.store.data.principals.ou_outsider = {
    id: 'ou_outsider',
    kind: 'human',
    name: 'outsider',
  };
  assert.throws(
    () => toggleReaction(world.store, { ...base, principalId: 'ou_outsider' }),
    /not a member of/,
  );

  assert.throws(
    () => toggleReaction(world.store, { ...base, emojiType: '   ' }),
    /no emoji_type/,
  );

  assert.equal('reactions' in sent.message, false, 'no refusal wrote anything');
});
