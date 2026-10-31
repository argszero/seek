import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AGENT_TURN_CAP,
  DEPTH_CAP,
  agentTurnsIn,
  bumpAgentTurns,
  chainBlock,
  resetAgentTurns,
} from './chain.ts';
import { deliver } from './delivery.ts';
import { makeWorld } from './fixtures.ts';
import { gate } from './gate.ts';
import { InboxLoop } from './inbox.ts';
import { say } from './say.ts';
import { makeTurn, runTurn, type Decide } from './turn.ts';
import type { Id, Observation } from './types.ts';

/** Run `count` bot turns in the world's room, saying nothing. */
async function runTurns(
  world: ReturnType<typeof makeWorld>,
  agentId: Id,
  count: number,
): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await runTurn(world.store, { agentId, roomId: world.room, entries: [] });
  }
}

/** Bot A says something in the room that names nobody. */
function speakToB(world: ReturnType<typeof makeWorld>, replyTo?: Id) {
  return say(world.store, {
    botId: world.botA,
    agentId: world.agentA2,
    roomId: world.room,
    text: 'about that thing',
    replyTo,
  });
}

/** The last entry on a bot's queue. */
function lastEntry(world: ReturnType<typeof makeWorld>, botId: Id): Observation {
  const queue = world.store.inbox(botId);
  const entry = queue.at(-1);
  assert.ok(entry, 'expected an entry on the queue');
  return entry;
}

/** An entry for a list of one message, addressed to this bot. */
function addressed(messageId: Id, roomId: Id, depthHint = 'reply'): Observation {
  return {
    id: 'ob_probe',
    bot_id: 'ou_probe',
    message_id: messageId,
    room_id: roomId,
    kind: depthHint as Observation['kind'],
    hints: { mentionsMe: false, repliesToMe: true, direct: false },
    delivered_at: '2026-10-24T00:00:00.000Z',
  };
}

test('the caps are the ones §11.3 states, not numbers invented here', () => {
  assert.equal(DEPTH_CAP, 24);
  assert.equal(AGENT_TURN_CAP, 24);
});

test('a bot turn is counted once, and a bot message under the caps still wakes', async () => {
  const world = makeWorld();
  assert.equal(agentTurnsIn(world.store, world.room), 0);

  await runTurns(world, world.agentA2, 1);
  assert.equal(agentTurnsIn(world.store, world.room), 1);

  // A reply is enough to wake the bot it answers, and nothing here is blocked.
  const byB = speakToB(world);
  const answer = say(world.store, {
    botId: world.botB,
    agentId: world.agentB1,
    roomId: world.room,
    text: 'answering you',
    replyTo: byB.id,
  });
  const toA = lastEntry(world, world.botA);
  assert.equal(toA.message_id, answer.id);
  assert.equal(toA.hints.repliesToMe, true);
  assert.equal(toA.hints.chainBlocked, undefined);
  assert.equal(chainBlock(world.store, world.botA, toA), undefined);
});

test('three bot turns in a row and the next addressed message wakes nobody — but still lands, marked', async () => {
  const world = makeWorld();
  const loop = new InboxLoop(world.store, makeTurn(world.store, world.botB));
  await runTurns(world, world.agentA2, AGENT_TURN_CAP);
  assert.equal(agentTurnsIn(world.store, world.room), AGENT_TURN_CAP);

  // A reply to B's own message: without a cap this would wake B.
  const byB = say(world.store, {
    botId: world.botB,
    agentId: world.agentB1,
    roomId: world.room,
    text: 'B speaking first',
  });
  const answer = say(world.store, {
    botId: world.botA,
    agentId: world.agentA2,
    roomId: world.room,
    text: 'A answering B',
    replyTo: byB.id,
  });

  const entry = lastEntry(world, world.botB);
  assert.equal(entry.message_id, answer.id);
  assert.equal(entry.hints.repliesToMe, true, 'it addresses B by construction');
  // It landed — nothing lost — and it carries why the wall held it.
  assert.equal(entry.hints.chainBlocked, 'room_agent_turns');

  const tick = await loop.tick(world.botB);
  assert.equal(tick.woke, false);
  assert.equal(tick.settled?.blocked.length, 1);
  assert.equal(world.store.inbox(world.botB).length, 1, 'the entry is kept, not consumed');
});

test('a person is never blocked by the wall, and breaks the room\'s run', async () => {
  const world = makeWorld();
  await runTurns(world, world.agentA2, AGENT_TURN_CAP);

  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: '@B hello there',
    mentions: [{ id: world.botB, name: 'B' }],
  });

  assert.equal(agentTurnsIn(world.store, world.room), 0, 'a human message resets the run');
  const entry = lastEntry(world, world.botB);
  assert.equal(entry.hints.mentionsMe, true);
  assert.equal(entry.hints.chainBlocked, undefined);
  assert.equal(chainBlock(world.store, world.botB, entry), undefined);
});

test('a held entry is reconsidered once the room moves on', async () => {
  const world = makeWorld();
  const loop = new InboxLoop(world.store, makeTurn(world.store, world.botB));
  await runTurns(world, world.agentB1, AGENT_TURN_CAP);

  const byB = say(world.store, {
    botId: world.botB,
    agentId: world.agentB1,
    roomId: world.room,
    text: 'B speaking first',
  });
  say(world.store, {
    botId: world.botA,
    agentId: world.agentA2,
    roomId: world.room,
    text: 'A answering B',
    replyTo: byB.id,
  });
  const held = lastEntry(world, world.botB);

  const blockedTick = await loop.tick(world.botB);
  assert.equal(blockedTick.woke, false);
  assert.equal(world.store.inbox(world.botB).length, 1);
  assert.equal(held.verdict, undefined, 'nothing has been decided about it yet');

  // A person touches the room: the burst is over.
  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: 'carry on',
  });

  const afterHuman = await loop.tick(world.botB);
  assert.equal(afterHuman.woke, true);
  assert.equal(
    afterHuman.entries.some((entry) => entry.id === held.id),
    true,
    'the held entry was reconsidered rather than dropped',
  );
});

test('a person replying deep in a chain is never held back', () => {
  const world = makeWorld();
  let parent = deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: 'chain root',
  }).message;
  for (let hop = 1; hop <= DEPTH_CAP + 1; hop += 1) {
    const fromA = hop % 2 === 1;
    parent = say(world.store, {
      botId: fromA ? world.botA : world.botB,
      agentId: fromA ? world.agentA2 : world.agentB1,
      roomId: world.room,
      text: `hop ${hop}`,
      replyTo: parent.id,
    });
  }
  assert.ok(parent.depth > DEPTH_CAP, 'the chain is past its cap');

  // The same hop count from a person wakes the bot it names: the wall exists to
  // stop one bot answering another, not to make a bot deaf to a human.
  const fromHuman = deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: '@A over to you',
    mentions: [{ id: world.botA, name: 'A' }],
    rootId: parent.id,
  }).message;
  assert.ok(fromHuman.depth > DEPTH_CAP, 'and the person is just as deep');

  const entry = lastEntry(world, world.botA);
  assert.equal(entry.message_id, fromHuman.id);
  assert.equal(entry.hints.mentionsMe, true);
  assert.equal(chainBlock(world.store, world.botA, entry), undefined);
  assert.equal(entry.hints.chainBlocked, undefined);
  assert.equal(gate(world.store, world.botA, [entry]).act.length, 1);
});

test('an unaddressed bot message at the cap is row 3, consumed — not held for later', async () => {
  const world = makeWorld();
  await runTurns(world, world.agentA2, AGENT_TURN_CAP);

  // A bot talking to the room without naming B. §11.4's first clause already
  // says this never wakes B, so it is ordinary chatter and is consumed: nothing
  // about it is preserved, and the wall is not a second copy of that rule.
  speakToB(world);
  const entry = lastEntry(world, world.botB);
  assert.equal(entry.hints.chainBlocked, undefined, 'no reason is recorded for a broadcast');
  assert.equal(chainBlock(world.store, world.botB, entry), undefined);

  const settled = gate(world.store, world.botB, [entry]);
  assert.equal(settled.ignore.length, 1);
  assert.equal(settled.blocked.length, 0);
});

test('the depth cap stops a chain at four hops, read off the message itself', () => {
  const world = makeWorld();
  let parent = deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: 'chain root',
  }).message;
  for (let hop = 1; hop <= DEPTH_CAP; hop += 1) {
    const fromA = hop % 2 === 1;
    parent = say(world.store, {
      botId: fromA ? world.botA : world.botB,
      agentId: fromA ? world.agentA2 : world.agentB1,
      roomId: world.room,
      text: `hop ${hop}`,
      replyTo: parent.id,
    });
  }
  assert.equal(parent.depth, DEPTH_CAP, 'the record carries the hop count');

  // At the cap a reply may not continue the chain, however few turns ran.
  assert.equal(agentTurnsIn(world.store, world.room), 0, 'the burst cap is not what stops this');
  assert.equal(
    chainBlock(world.store, world.botA, addressed(parent.id, world.room)),
    'depth',
  );
  // One hop earlier it would still wake.
  const oneEarlier = world.store
    .messagesOf(world.room)
    .find((message) => message.depth === DEPTH_CAP - 1);
  assert.ok(oneEarlier);
  assert.equal(chainBlock(world.store, world.botA, addressed(oneEarlier.id, world.room)), undefined);
});

test('a bot broadcast that names nobody is row 3, not the wall', () => {
  const world = makeWorld();
  speakToB(world);
  const entry = lastEntry(world, world.botB);

  // No cap is in play, so this is the gate's own reading of "a broadcast"; the
  // wall must not be a second copy of that rule.
  assert.equal(chainBlock(world.store, world.botB, entry), undefined);
  const settled = gate(world.store, world.botB, [entry]);
  assert.equal(settled.ignore.length, 1);
  assert.equal(settled.blocked.length, 0);
  assert.equal(entry.verdict, 'ignore');
  assert.equal(entry.hints.chainBlocked, undefined);
});

test('one turn is one turn, however many things it says', async () => {
  const world = makeWorld();
  await runTurn(
    world.store,
    { agentId: world.agentA2, roomId: world.room, entries: [] },
    (context) => {
      context.say(context.roomId, 'one');
      context.say(context.roomId, 'two');
      context.say(context.roomId, 'three');
    },
  );

  assert.equal(world.store.messagesOf(world.room).length, 3);
  assert.equal(agentTurnsIn(world.store, world.room), 1, 'a burst of lines is one turn');
});

test('a turn that throws is still a turn, and still counted', async () => {
  const world = makeWorld();
  await assert.rejects(async () =>
    runTurn(
      world.store,
      { agentId: world.agentA2, roomId: world.room, entries: [] },
      () => {
        throw new Error('the decide function fell over');
      },
    ),
  );
  assert.equal(agentTurnsIn(world.store, world.room), 1);
  assert.equal(world.store.data.turns.length, 1);
  assert.ok(world.store.data.turns[0].ended_at, 'the ledger row is closed');
});

test('a reminder is not a chain: no room, and no sender to answer', () => {
  const world = makeWorld();
  bumpAgentTurns(world.store, world.room);
  const reminder: Observation = {
    id: 'ob_reminder',
    bot_id: world.botA,
    message_id: 'om_reminder',
    kind: 'reminder',
    hints: { mentionsMe: false, repliesToMe: false, direct: false },
    delivered_at: '2026-10-24T00:00:00.000Z',
  };
  assert.equal(chainBlock(world.store, world.botA, reminder), undefined);
  assert.equal(gate(world.store, world.botA, [reminder]).act.length, 1);
});

test('two bots cannot answer each other forever', async () => {
  const world = makeWorld();

  // The shortest possible loop: each agent answers the message that woke it,
  // naming the peer so the peer hears it (§11.4's @-mention route).
  const answer =
    (peer: Id): Decide =>
    (context) => {
      const woke = context.entries[0];
      context.say(context.roomId, 'right back at you', {
        replyTo: woke.message_id,
        mentions: [{ id: peer, name: 'peer' }],
      });
    };
  const loopA = new InboxLoop(
    world.store,
    makeTurn(world.store, world.botA, answer(world.botB)),
  );
  const loopB = new InboxLoop(
    world.store,
    makeTurn(world.store, world.botB, answer(world.botA)),
  );

  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: '@A and @B, settle this between you',
    mentions: [
      { id: world.botA, name: 'A' },
      { id: world.botB, name: 'B' },
    ],
  });

  let rounds = 0;
  const limit = AGENT_TURN_CAP + 2;
  while (rounds < limit) {
    rounds += 1;
    const a = await loopA.tick(world.botA);
    const b = await loopB.tick(world.botB);
    if (!a.woke && !b.woke) break;
  }

  assert.ok(rounds < limit, 'the exchange stopped on its own');
  assert.equal(world.store.data.turns.length, AGENT_TURN_CAP, 'three turns, then the wall');
  assert.ok(
    agentTurnsIn(world.store, world.room) >= AGENT_TURN_CAP,
    'the room reached its cap rather than the chain running out',
  );
  // The queue, not the record: what each bot has already consumed stays on its
  // record for good, so only what is still waiting says whether the wall held.
  const waiting =
    world.store.pending(world.botA).length + world.store.pending(world.botB).length;
  assert.equal(waiting, 1, 'the last answer waits instead of vanishing');
});

test('the counter is the room\'s, and an unknown room is not an error', () => {
  const world = makeWorld();
  bumpAgentTurns(world.store, world.room);
  bumpAgentTurns(world.store, 'oc_unknown');
  resetAgentTurns(world.store, 'oc_unknown');
  assert.equal(agentTurnsIn(world.store, world.room), 1);
  assert.equal(agentTurnsIn(world.store, 'oc_unknown'), 0);
});
