import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makeWorld } from './fixtures.ts';
import { say } from './say.ts';

test('the speaking tool posts in the bot\'s own voice and names the agent', () => {
  const world = makeWorld();
  const message = say(world.store, {
    botId: world.botA,
    agentId: world.agentA2,
    roomId: world.room,
    text: 'on it',
    now: '2026-10-24T01:00:00.000Z',
  });

  const log = world.store.messagesOf(world.room);
  assert.equal(log.length, 1);
  assert.equal(log[0].id, message.id);
  assert.equal(message.sender_id, world.botA);
  assert.equal(message.agent_id, world.agentA2);
  // The text is posted as the agent chose it, not rewritten on the way out.
  assert.equal(message.text, 'on it');
});

test('an agent of another bot cannot speak for this bot', () => {
  const world = makeWorld();
  assert.throws(
    () =>
      say(world.store, {
        botId: world.botA,
        agentId: world.agentB1,
        roomId: world.room,
        text: 'borrowing a voice',
      }),
    /does not work for bot/,
  );
  assert.equal(world.store.messagesOf(world.room).length, 0);
});

test('an agent without the tool in its list cannot speak', () => {
  const world = makeWorld();
  // The watch agent is a decision model that makes no tool call at all.
  assert.deepEqual(world.store.data.agents[world.agentA1].tools, []);
  assert.throws(
    () =>
      say(world.store, {
        botId: world.botA,
        agentId: world.agentA1,
        roomId: world.room,
        text: 'should never arrive',
      }),
    /is not in its tool list/,
  );
  assert.equal(world.store.messagesOf(world.room).length, 0);
});

test('a call with no text says nothing rather than posting an empty message', () => {
  const world = makeWorld();
  assert.throws(
    () =>
      say(world.store, {
        botId: world.botA,
        agentId: world.agentA2,
        roomId: world.room,
        text: '   \n ',
      }),
    /with no text/,
  );
  assert.equal(world.store.messagesOf(world.room).length, 0);
});

test('what a bot says reaches the other bots and not itself', () => {
  const world = makeWorld();
  say(world.store, {
    botId: world.botA,
    agentId: world.agentA2,
    roomId: world.room,
    text: 'morning all',
  });

  // A does not wake itself with its own words; B learns of it like any message.
  assert.equal(world.store.hasPending(world.botA), false);
  assert.equal(world.store.inbox(world.botB).length, 1);
  assert.equal(world.store.inbox(world.botB)[0].kind, 'message');
});

test('answering a message carries the chain the receiver reads', () => {
  const world = makeWorld();
  const first = say(world.store, {
    botId: world.botB,
    agentId: world.agentB1,
    roomId: world.room,
    text: 'anyone about?',
  });
  const answer = say(world.store, {
    botId: world.botA,
    agentId: world.agentA2,
    roomId: world.room,
    text: 'here',
    replyTo: first.id,
  });

  assert.equal(answer.root_id, first.id);
  assert.equal(answer.caused_by, first.id);
  assert.equal(answer.chain, first.id);
  assert.equal(answer.depth, 1);
  // B reads it off the hints computed at delivery: a reply to its own message.
  const toB = world.store.inbox(world.botB).at(-1);
  assert.equal(toB?.hints.repliesToMe, true);
  assert.equal(toB?.kind, 'reply');
});

test('the room has to be one the bot is in', () => {
  const world = makeWorld();
  const elsewhere = 'oc_notmine';
  world.store.data.rooms[elsewhere] = {
    id: elsewhere,
    chat_mode: 'group',
    created_at: '2026-10-24T00:00:00.000Z',
  };
  assert.throws(
    () =>
      say(world.store, {
        botId: world.botA,
        agentId: world.agentA2,
        roomId: elsewhere,
        text: 'talking to myself',
      }),
    /not a member/,
  );
  assert.equal(world.store.messagesOf(elsewhere).length, 0);
});
