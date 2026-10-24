import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deliver } from './delivery.ts';
import { makeWorld } from './fixtures.ts';
import { agentTurnsIn } from './chain.ts';
import { InboxLoop } from './inbox.ts';
import { addRow, fireDue } from './schedule.ts';
import { newId, SeekStore } from './store.ts';
import { makeTurn, runTurn, type TurnContext } from './turn.ts';
import type { Id, MembershipRole, ScheduleRow } from './types.ts';

/** A second room this world's bot A and the human share. */
function addRoom(world: ReturnType<typeof makeWorld>, members: Id[]): Id {
  const room = newId('oc');
  const at = '2026-10-24T00:00:00.000Z';
  world.store.data.rooms[room] = { id: room, chat_mode: 'group', created_at: at };
  for (const principal of members) {
    const id = newId('mb');
    world.store.data.memberships[id] = {
      id,
      room_id: room,
      principal_id: principal,
      joined_at: at,
      role: 'member' as MembershipRole,
    };
  }
  return room;
}

test('one room end to end: an @-mention reaches the work agent, and what it says lands in the room', async () => {
  const world = makeWorld();
  const spoke: TurnContext[] = [];
  const loop = new InboxLoop(
    world.store,
    makeTurn(world.store, world.botA, (context) => {
      spoke.push(context);
      context.say(context.roomId, 'on it');
    }),
  );

  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: '@A can you take this?',
    mentions: [{ id: world.botA, name: 'A' }],
    now: '2026-10-24T01:00:00.000Z',
  });
  const result = await loop.tick(world.botA);

  assert.equal(result.woke, true);
  assert.equal(spoke.length, 1);
  // The turn is the work agent's, and it is handed the entries and nothing else.
  assert.equal(spoke[0].agentId, world.agentA2);
  assert.equal(spoke[0].botId, world.botA);
  assert.equal(spoke[0].roomId, world.room);
  assert.deepEqual(
    spoke[0].entries.map((entry) => entry.id),
    result.entries.map((entry) => entry.id),
  );

  // What it said is a message in the room, in the bot's voice.
  const log = world.store.messagesOf(world.room);
  assert.equal(log.length, 2);
  assert.equal(log[1].sender_id, world.botA);
  assert.equal(log[1].agent_id, world.agentA2);
  assert.equal(log[1].text, 'on it');

  // A said it and does not wake itself; B has both messages on its queue.
  assert.equal(world.store.hasPending(world.botA), false);
  assert.equal(world.store.inbox(world.botB).length, 2);
});

test('a turn that says nothing posts nothing, and is still a turn', async () => {
  const world = makeWorld();
  // The shipped decision, and the shipped shape of the loop.
  const loop = new InboxLoop(world.store, makeTurn(world.store, world.botA));

  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: '@A over to you',
    mentions: [{ id: world.botA, name: 'A' }],
    now: '2026-10-24T01:00:00.000Z',
  });
  const result = await loop.tick(world.botA);

  assert.equal(result.woke, true);
  assert.equal(world.store.messagesOf(world.room).length, 1);
  assert.equal(world.store.data.turns.length, 1);
  assert.deepEqual(world.store.data.turns[0].produced, []);
});

test('the ledger records which agent acted, in which session, and what it produced', async () => {
  const world = makeWorld();
  const record = await runTurn(
    world.store,
    {
      agentId: world.agentA2,
      roomId: world.room,
      entries: [],
      now: '2026-10-24T02:00:00.000Z',
    },
    (context) => {
      context.say(world.room, 'first');
      context.say(world.room, 'second');
    },
  );

  assert.equal(record.turn.agent_id, world.agentA2);
  assert.equal(record.turn.session_id, record.session.id);
  assert.equal(record.turn.started_at, '2026-10-24T02:00:00.000Z');
  assert.equal(record.turn.ended_at, '2026-10-24T02:00:00.000Z');
  // A turn may say three things, or none: three calls, three messages.
  assert.equal(record.produced.length, 2);
  assert.deepEqual(
    record.turn.produced,
    record.produced.map((message) => message.id),
  );
  // No model ran, so the ledger's spend is zero rather than absent.
  assert.equal(record.turn.input_tokens, 0);
  assert.equal(record.turn.output_tokens, 0);
  assert.equal(record.turn.cost, 0);
  // The session opened in the agent's own home.
  assert.equal(record.session.workspace, world.store.data.agents[world.agentA2].home);
});

test('one session per agent per room, reused across turns', async () => {
  const world = makeWorld();
  const first = await runTurn(world.store, {
    agentId: world.agentA2,
    roomId: world.room,
    entries: [],
  });
  const second = await runTurn(world.store, {
    agentId: world.agentA2,
    roomId: world.room,
    entries: [],
  });

  assert.equal(first.session.id, second.session.id);
  assert.notEqual(first.turn.id, second.turn.id);
  assert.equal(world.store.sessionsOf(world.agentA2).length, 1);
  assert.equal(world.store.data.turns.length, 2);
});

test('sessions are the agent\'s own: the watch agent never gets one', async () => {
  const world = makeWorld();
  await runTurn(world.store, {
    agentId: world.agentA2,
    roomId: world.room,
    entries: [],
  });

  assert.equal(world.store.sessionsOf(world.agentA2).length, 1);
  assert.equal(world.store.data.sessions[world.agentA1], undefined);
  assert.deepEqual(world.store.sessionsOf(world.agentA1), []);
});

test('entries from two rooms open two turns, one per room', async () => {
  const world = makeWorld();
  const other = addRoom(world, [world.me, world.botA]);
  const seen: Id[] = [];

  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: '@A here',
    mentions: [{ id: world.botA, name: 'A' }],
  });
  deliver(world.store, {
    roomId: other,
    senderId: world.me,
    text: '@A and here',
    mentions: [{ id: world.botA, name: 'A' }],
  });

  const loop = new InboxLoop(
    world.store,
    makeTurn(world.store, world.botA, (context) => {
      seen.push(context.roomId);
    }),
  );
  await loop.tick(world.botA);

  assert.deepEqual(seen.sort(), [world.room, other].sort());
  assert.equal(world.store.data.turns.length, 2);
  // Each room's session is its own thread of work.
  const sessions = world.store.sessionsOf(world.agentA2);
  assert.equal(sessions.length, 2);
  assert.deepEqual(
    sessions.map((session) => session.room_id).sort(),
    [world.room, other].sort(),
  );
});

test('a reminder opens the one turn that has no room, and moves no room\'s burst', async () => {
  const world = makeWorld();
  addRow(world.store, {
    botId: world.botA,
    when: '2026-10-24T08:00:00.000Z',
    text: 'look at the release thread',
    now: '2026-10-24T08:00:00.000Z',
  });
  const [reminder] = fireDue(world.store, '2026-10-24T12:00:00.000Z');
  assert.ok(reminder);

  await makeTurn(world.store, world.botA)([reminder]);

  // §12 keeps "the turn that fired it" on the record, so the reminder opens a
  // turn rather than being a waking entry no turn ever took.
  assert.equal(world.store.data.turns.length, 1);
  const sessions = world.store.sessionsOf(world.agentA2);
  assert.equal(sessions.length, 1);
  // A reminder is in no room, so its session is in no room either.
  assert.equal(sessions[0]?.room_id, undefined);
  // §12: a bot reminding itself is not a conversation in a room, so no room's
  // run of consecutive bot turns moves.
  assert.equal(agentTurnsIn(world.store, world.room), 0);
});

test('one batch holding a room entry and a reminder opens two turns, one with no room', async () => {
  const world = makeWorld();
  addRow(world.store, {
    botId: world.botA,
    when: '2026-10-24T08:00:00.000Z',
    text: 'and this too',
    now: '2026-10-24T08:00:00.000Z',
  });
  const [reminder] = fireDue(world.store, '2026-10-24T12:00:00.000Z');
  assert.ok(reminder);
  const { observations } = deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: '@A and this',
    mentions: [{ id: world.botA, name: 'A' }],
  });
  const fromRoom = observations.find((entry) => entry.bot_id === world.botA);
  assert.ok(fromRoom);

  await makeTurn(world.store, world.botA)([reminder, fromRoom]);

  assert.equal(world.store.data.turns.length, 2);
  // The room's session and the reminder's session never merge: one carries the
  // room, the other carries none.
  assert.deepEqual(
    world.store.sessionsOf(world.agentA2).map((session) => session.room_id),
    [undefined, world.room],
  );
  // Only the room's turn counts toward the room's burst.
  assert.equal(agentTurnsIn(world.store, world.room), 1);
});

test('a bot with no work agent cannot open a turn, and an empty batch opens none', async () => {
  const world = makeWorld();
  // An empty batch is not a turn, whatever the roster says: the loop never
  // opens one without entries, so this is the guard that keeps a no-op tick
  // from turning a roster error into a thrown tick.
  await makeTurn(world.store, 'ou_nobody-at-all')([]);
  assert.equal(world.store.data.turns.length, 0);

  // Without a work agent there is nothing to run at all, and that is a roster
  // error rather than a busier tick: it is thrown, not swallowed.
  delete world.store.data.agents[world.agentA2];
  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: '@A anyone there?',
    mentions: [{ id: world.botA, name: 'A' }],
  });
  await assert.rejects(
    async () => makeTurn(world.store, world.botA)(world.store.inbox(world.botA)),
    /no 'work' agent/,
  );
  assert.equal(world.store.data.turns.length, 0);
});

test('one turn is one agent\'s work in one room, and a stray entry is refused', async () => {
  const world = makeWorld();
  const other = addRoom(world, [world.me, world.botA]);
  deliver(world.store, {
    roomId: other,
    senderId: world.me,
    text: '@A elsewhere',
    mentions: [{ id: world.botA, name: 'A' }],
  });

  await assert.rejects(
    async () =>
      runTurn(world.store, {
        agentId: world.agentA2,
        roomId: world.room,
        entries: world.store.inbox(world.botA),
      }),
    /one turn is one agent's work in one room/,
  );
});

test('a turn holds the schedule tool, bound to its own bot and agent', async () => {
  const world = makeWorld();
  world.store.data.agents[world.agentA2]?.tools.push('schedule');

  let written: ScheduleRow | undefined;
  await runTurn(
    world.store,
    { agentId: world.agentA2, roomId: world.room, entries: [] },
    (context) => {
      written = context.schedule.add('2026-10-24T08:00:00.000Z', 'come back to this');
    },
  );

  // The turn is where a promise is made: the row exists, it names the bot it is
  // for and the agent that wrote it, and `runTurn`'s own save makes it durable.
  assert.equal(world.store.data.schedule.length, 1);
  assert.equal(written?.bot_id, world.botA);
  assert.equal(written?.created_by, world.agentA2);
  assert.equal(written?.state, 'pending');
  assert.equal(world.store.data.turns.length, 1);
});
