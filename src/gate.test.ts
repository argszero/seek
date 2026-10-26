import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deliver } from './delivery.ts';
import { classify, gate } from './gate.ts';
import { makeDirectWorld, makeWorld } from './fixtures.ts';
import { newId } from './store.ts';
import type { Observation } from './types.ts';

/** The entry one delivery gave a named bot. */
function entryFor(
  observations: Observation[],
  botId: string,
): Observation {
  const entry = observations.find((o) => o.bot_id === botId);
  assert.ok(entry, `expected an entry for ${botId}`);
  return entry;
}

/** Mute a bot in a room, through the membership that carries it. */
function mute(world: ReturnType<typeof makeWorld>, botId: string): void {
  const membership = Object.values(world.store.data.memberships).find(
    (m) => m.room_id === world.room && m.principal_id === botId,
  );
  assert.ok(membership, 'expected a membership to mute');
  membership.muted = true;
}

/** A reminder entry, as `schedule.ts` fires one: no room, no message, its own text. */
function reminder(botId: string): Observation {
  return {
    id: newId('ob'),
    bot_id: botId,
    kind: 'reminder',
    text: 'a note to my future self',
    hints: { mentionsMe: false, repliesToMe: false, direct: false },
    delivered_at: '2026-10-24T00:00:00.000Z',
  };
}

test('row 1: an empty queue ends the tick before a stage is chosen', () => {
  const world = makeWorld();
  const result = gate(world.store, world.botA, []);

  assert.equal(result.action, 'return');
  assert.deepEqual(result.act, []);
  assert.deepEqual(result.ignore, []);
  assert.deepEqual(result.judge, []);
});

test('row 2: a mention, a reply, a direct message and a reminder all pass for free', () => {
  // A mention.
  const mentioned = makeWorld();
  const byMention = deliver(mentioned.store, {
    roomId: mentioned.room,
    senderId: mentioned.me,
    text: '@A look at this',
    mentions: [{ id: mentioned.botA, name: 'A' }],
  });
  const mentionEntry = byMention.observations.find(
    (o) => o.bot_id === mentioned.botA,
  );
  assert.ok(mentionEntry);
  assert.equal(classify(mentioned.store, mentioned.botA, mentionEntry), 'act');

  // A reply to something this bot said.
  const replied = makeWorld();
  const said = deliver(replied.store, {
    roomId: replied.room,
    senderId: replied.botA,
    text: 'on it',
    agentId: replied.agentA2,
  });
  const byReply = deliver(replied.store, {
    roomId: replied.room,
    senderId: replied.me,
    text: 'thanks',
    rootId: said.message.id,
  });
  const replyEntry = byReply.observations.find((o) => o.bot_id === replied.botA);
  assert.ok(replyEntry);
  assert.equal(replied.store.messagesOf(replied.room).length, 2);
  assert.equal(classify(replied.store, replied.botA, replyEntry), 'act');

  // A direct message: a headcount, not a type.
  const direct = makeDirectWorld();
  const byDirect = deliver(direct.store, {
    roomId: direct.room,
    senderId: direct.me,
    text: 'just you and me',
  });
  assert.equal(
    classify(direct.store, direct.botA, entryFor(byDirect.observations, direct.botA)),
    'act',
  );

  // Its own reminder coming due — the one entry whose author is the bot itself.
  const own = reminder(mentioned.botA);
  assert.equal(classify(mentioned.store, mentioned.botA, own), 'act');
});

test('a fast-pass entry is consumed without a verdict being written', () => {
  const world = makeWorld();
  const { observations } = deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: '@A quick one',
    mentions: [{ id: world.botA, name: 'A' }],
  });
  const entry = observations.find((o) => o.bot_id === world.botA);
  assert.ok(entry);

  const result = gate(world.store, world.botA, [entry]);
  assert.equal(result.action, 'act');
  assert.deepEqual(result.act, [entry]);
  // `data-model.md`'s Observation row: the fast pass may skip the verdict.
  assert.equal(entry.verdict, undefined);
});

test("row 3: another bot's broadcast is ignored, and the verdict lands on the entry", () => {
  const world = makeWorld();
  const { observations } = deliver(world.store, {
    roomId: world.room,
    senderId: world.botB,
    text: 'standup in five',
    agentId: world.agentB1,
  });
  const entry = observations.find((o) => o.bot_id === world.botA);
  assert.ok(entry);
  assert.equal(classify(world.store, world.botA, entry), 'ignore');

  const result = gate(world.store, world.botA, [entry]);
  // Row 3's own ending: nothing else runs, and nothing is spent.
  assert.equal(result.action, 'return');
  assert.deepEqual(result.ignore, [entry]);
  // Recorded on the entry it judged, and nowhere else.
  assert.equal(entry.verdict, 'ignore');
});

test('row 3: a muted room is ignored, and muting is the membership that carries it', () => {
  const world = makeWorld();
  mute(world, world.botA);

  const { observations } = deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: 'anyone about?',
  });
  const entryA = observations.find((o) => o.bot_id === world.botA);
  const entryB = observations.find((o) => o.bot_id === world.botB);
  assert.ok(entryA && entryB);

  assert.equal(classify(world.store, world.botA, entryA), 'ignore');
  // The same message, one room away from the mute, is still ambiguous.
  assert.equal(classify(world.store, world.botB, entryB), 'judge');

  gate(world.store, world.botA, [entryA]);
  assert.equal(entryA.verdict, 'ignore');
  assert.equal(entryB.verdict, undefined);
  assert.equal(world.store.data.bots[world.botA].id, world.botA);
  assert.equal('muted' in world.store.data.bots[world.botA], false);
});

test('row 2 outranks row 3: a muted room and another bot still act when they address me', () => {
  const world = makeWorld();
  mute(world, world.botA);

  const named = deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: '@A are you there?',
    mentions: [{ id: world.botA, name: 'A' }],
  });
  const namedEntry = named.observations.find((o) => o.bot_id === world.botA);
  assert.ok(namedEntry);
  assert.equal(classify(world.store, world.botA, namedEntry), 'act');

  // Another bot answering something A said is a reply to A, not a broadcast.
  const byB = deliver(world.store, {
    roomId: world.room,
    senderId: world.botA,
    text: 'yes',
  });
  const answer = deliver(world.store, {
    roomId: world.room,
    senderId: world.botB,
    text: 'here is the detail',
    rootId: byB.message.id,
  });
  const answerEntry = answer.observations.find((o) => o.bot_id === world.botA);
  assert.ok(answerEntry);
  assert.equal(classify(world.store, world.botA, answerEntry), 'act');
});

test('row 4: a room talking near the bot is the only case that costs a call', () => {
  const world = makeWorld();
  const { observations } = deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: 'we should try the other approach',
  });
  const entry = observations.find((o) => o.bot_id === world.botA);
  assert.ok(entry);
  assert.equal(classify(world.store, world.botA, entry), 'judge');

  const result = gate(world.store, world.botA, [entry]);
  assert.equal(result.action, 'judge');
  assert.deepEqual(result.judge, [entry]);
  // Stage 1 writes this one's verdict; the rules must not guess for it.
  assert.equal(entry.verdict, undefined);
});

test("the tick's stage follows the loop's order, not the order entries arrived in", () => {
  const world = makeWorld();
  // Arrival order is deliberately ambiguous-first, act-last.
  const broadcast = deliver(world.store, {
    roomId: world.room,
    senderId: world.botB,
    text: 'deploying now',
  });
  const chatter = deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: 'we could ship it tomorrow',
  });
  const named = deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: '@A can you confirm?',
    mentions: [{ id: world.botA, name: 'A' }],
  });

  const batch = [
    broadcast.observations.find((o) => o.bot_id === world.botA),
    chatter.observations.find((o) => o.bot_id === world.botA),
    named.observations.find((o) => o.bot_id === world.botA),
  ].filter((entry): entry is Observation => entry !== undefined);
  assert.equal(batch.length, 3);

  const result = gate(world.store, world.botA, batch);
  assert.equal(result.action, 'act');
  assert.equal(result.act.length, 1);
  assert.equal(result.ignore.length, 1);
  assert.equal(result.judge.length, 1);
  // Every entry is accounted for exactly once.
  assert.equal(result.act.length + result.ignore.length + result.judge.length, 3);
  assert.equal(result.act[0].hints.mentionsMe, true);
});

test('a batch settled entirely by the rules runs no stage', () => {
  const world = makeWorld();
  const { observations } = deliver(world.store, {
    roomId: world.room,
    senderId: world.botB,
    text: 'still here',
  });
  const entry = observations.find((o) => o.bot_id === world.botA);
  assert.ok(entry);

  const result = gate(world.store, world.botA, [entry]);
  assert.equal(result.action, 'return');
  assert.deepEqual(result.act, []);
  assert.deepEqual(result.judge, []);
});

test("a bot's own words never reach its own stage 0", () => {
  const world = makeWorld();
  deliver(world.store, {
    roomId: world.room,
    senderId: world.botA,
    text: 'looking now',
    agentId: world.agentA1,
  });

  // Row 3's "my own message" has no producer: delivery writes an entry per
  // member bot *except the sender*, so the gate has nothing to decide there.
  assert.deepEqual(world.store.inbox(world.botA), []);
  assert.equal(world.store.hasPending(world.botA), false);
});

test('the hints decide, not a fresh scan of the message', () => {
  const world = makeWorld();
  const { message, observations } = deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: 'look at this',
    mentions: [{ id: world.botA, name: 'A' }],
  });
  const entry = observations.find((o) => o.bot_id === world.botA);
  assert.ok(entry);

  // The message is a shared fact and may be edited or re-read later; the answer
  // for this bot was taken at delivery and is what stage 0 reads.
  message.mentions = [];
  assert.equal(classify(world.store, world.botA, entry), 'act');
});
