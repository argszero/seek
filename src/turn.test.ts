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
  // The turn is the work agent's: what woke it is the one entry, and what it reads is
  // the room's box, which holds that entry among the others.
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

test("the watch side's verdict and reason stay behind; the entry itself crosses", async () => {
  const world = makeWorld();
  const spoke: TurnContext[] = [];
  const loop = new InboxLoop(
    world.store,
    makeTurn(world.store, world.botA, (context) => {
      spoke.push(context);
    }),
  );

  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: '@A the release is going out at six',
    mentions: [{ id: world.botA, name: 'A' }],
    now: '2026-10-24T01:00:00.000Z',
  });
  const result = await loop.tick(world.botA);

  // The watch side answered, on the entry it judged — which is where §4 keeps
  // that answer. Today nothing writes these (stage 1 is a stub still), so the
  // test writes them the way the loop will.
  const judged = result.entries[0];
  judged.verdict = 'act';
  judged.reason = 'it concerns the release this bot is waiting on';

  await runTurn(
    world.store,
    { agentId: world.agentA2, roomId: world.room, entries: [judged] },
    (context) => {
      spoke.push(context);
    },
  );

  const handed = spoke.at(-1)?.entries[0];
  assert.ok(handed);
  // What crosses: the entry, so the agent knows whose message it is answering.
  assert.equal(handed.id, judged.id);
  assert.equal(handed.message_id, judged.message_id);
  assert.equal(handed.kind, judged.kind);
  assert.deepEqual(handed.hints, judged.hints);
  // What does not: the watch side's sentence, in either of its two fields.
  assert.equal('verdict' in handed, false, 'the verdict did not cross');
  assert.equal('reason' in handed, false, 'the reason did not cross');
  // And the record still has both, which is the half §4 insists on.
  const onRecord = world.store.inbox(world.botA).find((entry) => entry.id === judged.id)
    ?? judged;
  assert.equal(onRecord.verdict, 'act');
  assert.equal(onRecord.reason, 'it concerns the release this bot is waiting on');

  // The box is the record too, so the same two facts stay out of it there.
  const inBox = spoke.at(-1)?.box?.entries ?? [];
  assert.ok(inBox.length > 0, 'the box was handed over');
  assert.equal(
    inBox.some((entry) => 'verdict' in entry || 'reason' in entry),
    false,
    'no entry in the box carries the watch side’s answer',
  );
});

test('a turn opens with the room’s box, not only the entries that woke it', async () => {
  const world = makeWorld();
  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: 'the deploy is red',
    now: '2026-10-24T00:30:00.000Z',
  });
  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: 'the retry queue failed twice',
    now: '2026-10-24T00:31:00.000Z',
  });
  const entries = await world.store.drain(world.botA);
  assert.equal(entries.length, 2);

  const spoke: TurnContext[] = [];
  await runTurn(
    world.store,
    { agentId: world.agentA2, roomId: world.room, entries: [entries[1]] },
    (context) => {
      spoke.push(context);
    },
  );

  // What woke it is the second message and only that; what it reads is the room.
  assert.deepEqual(
    spoke[0].entries.map((entry) => entry.id),
    [entries[1].id],
  );
  const box = spoke[0].box;
  assert.ok(box, 'a turn in a room is handed that room’s box');
  assert.deepEqual(
    box.entries.map((entry) => entry.id),
    [entries[0].id, entries[1].id],
    'the earlier message is in the box, oldest first, so the turn knows what was said',
  );
  assert.equal(box.summary, undefined, 'nothing has been compacted in this room yet');
});

/**
 * The box's pictures, handed over with the box.
 *
 * This is the layer issue #179 named first: `TurnBox` was `{summary?, entries}` while
 * `box.ts` had already collected the pictures beside those same entries, so the list
 * stopped at the judgement and the half that writes could only be told *that* a picture
 * had come. What the turn is handed here is the reference and never the bytes — loading
 * them is the client's — and it is in the same order as the entries, because a picture
 * reversed on its own would be read against the wrong line.
 */
test('the pictures the box holds are handed over with it, in the order the entries are read', async () => {
  const world = makeWorld();
  const media = { key: 'blobs/one.png', mime: 'image/png' };
  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    kind: 'image',
    text: 'the first thing',
    media,
    now: '2026-10-24T00:30:00.000Z',
  });
  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: 'and a second thing, in words',
    now: '2026-10-24T00:31:00.000Z',
  });
  const entries = await world.store.drain(world.botA);

  const spoke: TurnContext[] = [];
  await runTurn(
    world.store,
    { agentId: world.agentA2, roomId: world.room, entries: [entries[1]] },
    (context) => {
      spoke.push(context);
    },
  );

  const box = spoke[0].box;
  assert.ok(box, 'a turn in a room is handed that room’s box');
  assert.equal(box.media.length, 1, 'the one picture in the box is in the list');
  assert.deepEqual(
    box.media.map((picture) => picture.key),
    [media.key],
    'the picture is named by the reference the store keeps, never by its bytes',
  );
  assert.equal(
    box.media[0]?.entryId,
    box.entries[0]?.id,
    'and it is aligned with the entry it came with, oldest first like the entries',
  );
});

test('once a note exists, the box is the note and what arrived after it', async () => {
  const world = makeWorld();
  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: 'the deploy is red',
    now: '2026-10-24T00:30:00.000Z',
  });
  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: 'the retry queue failed twice',
    now: '2026-10-24T00:31:00.000Z',
  });
  const entries = await world.store.drain(world.botA);

  // A note the compaction wrote: it accounts for the first message, and the point it
  // consumed up to is that message.
  world.store.memoriesOf(world.agentA2).push({
    id: 'mm_note',
    agent_id: world.agentA2,
    level: 'room_digest',
    room_id: world.room,
    body: 'the deploy has been red since last night, cause unknown',
    consumed_to: entries[0].id,
    updated_at: '2026-10-24T00:32:00.000Z',
  });

  const spoke: TurnContext[] = [];
  await runTurn(
    world.store,
    { agentId: world.agentA2, roomId: world.room, entries: [entries[1]] },
    (context) => {
      spoke.push(context);
    },
  );

  const box = spoke[0].box;
  assert.ok(box, 'the box is still handed over');
  assert.equal(box.summary, 'the deploy has been red since last night, cause unknown');
  assert.deepEqual(
    box.entries.map((entry) => entry.id),
    [entries[1].id],
    'the compacted message is in the note rather than read again',
  );
});

test('a reminder’s turn has no box, because it is in no room', async () => {
  const world = makeWorld();
  addRow(world.store, {
    botId: world.botA,
    when: '2026-10-24T02:00:00.000Z',
    text: 'check the thread tomorrow',
    now: '2026-10-24T00:00:00.000Z',
  });
  const entries = fireDue(world.store, '2026-10-24T03:00:00.000Z');
  assert.equal(entries.length, 1);

  const spoke: TurnContext[] = [];
  await runTurn(world.store, { agentId: world.agentA2, entries }, (context) => {
    spoke.push(context);
  });
  assert.equal(spoke[0].box, undefined, 'no room, so nothing to be in the box');
  assert.deepEqual(
    spoke[0].entries.map((entry) => entry.id),
    entries.map((entry) => entry.id),
    'the reminder itself is what it opens with',
  );
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

test('a turn is told whose it is: its bot, and every agent of that bot', async () => {
  const world = makeWorld();
  let seen: TurnContext | undefined;
  await runTurn(
    world.store,
    { agentId: world.agentA2, roomId: world.room, entries: [] },
    (context) => {
      seen = context;
    },
  );

  assert.equal(seen?.identity.bot.id, world.botA);
  assert.equal(seen?.identity.bot.name, 'A');
  const self = seen?.identity.roster.filter((row) => row.self) ?? [];
  assert.deepEqual(
    self.map((row) => row.agentId),
    [world.agentA2],
    'the work agent is told which row is itself',
  );
  assert.deepEqual(
    (seen?.identity.roster ?? []).map((row) => row.role).sort(),
    ['watch', 'work'],
  );
});

test('the identity is read at the turn, not at the loop: a rename lands on the next turn', async () => {
  const world = makeWorld();
  const names: string[] = [];
  const loop = new InboxLoop(
    world.store,
    makeTurn(world.store, world.botA, (context) => {
      names.push(context.identity.bot.name);
    }),
  );

  for (const text of ['@A first', '@A second']) {
    deliver(world.store, {
      roomId: world.room,
      senderId: world.me,
      text,
      mentions: [{ id: world.botA, name: 'A' }],
    });
    await loop.tick(world.botA);
    // The bot is renamed between two turns of one loop — the case a copy taken
    // when `makeTurn` was built would answer with the old name for ever.
    world.store.data.bots[world.botA].name = 'Echo';
  }

  assert.deepEqual(names, ['A', 'Echo']);
});

/**
 * A turn is where a cost is recorded, and the decision that ran the model is the only
 * thing that knows what it spent — so the figure arrives as that decision's return value.
 *
 * `docs/host-rulings.md`, "No spending cap": no budget field, no "quiet because spent"
 * state, and the spend recorded and visible. The two cases below are the two halves of
 * that sentence as the ledger sees them.
 */
test('a turn records the spend its decision reports, and nothing caps the figure', async () => {
  const world = makeWorld();
  deliver(world.store, { roomId: world.room, senderId: world.me, text: 'the batch failed' });
  const entries = await world.store.drain(world.botA);

  // Deliberately far past any plausible ceiling. The way a spending cap would come back
  // is not a field named `budget` — it is a clamp on the way into the ledger, and a row
  // that records what was spent however much it was is the ruling's shape.
  const record = await runTurn(
    world.store,
    { agentId: world.agentA2, roomId: world.room, entries },
    () => ({ input_tokens: 4_000_000, output_tokens: 2_000_000 }),
  );

  assert.equal(record.turn.input_tokens, 4_000_000);
  assert.equal(record.turn.output_tokens, 2_000_000);
  assert.equal(
    world.store.data.turns[0].input_tokens,
    4_000_000,
    'the row the store keeps is the row that carries it, not a copy made for the caller',
  );
  // No money beside it: the model runs on the caller's own machine, so there is no bill
  // to name and a currency field would be a figure nothing measured.
  assert.equal(record.turn.cost, 0);
});

test('a decision that ran no model leaves the row at zero, because nothing was spent', async () => {
  const world = makeWorld();
  deliver(world.store, { roomId: world.room, senderId: world.me, text: 'the batch failed' });

  // The shipped `sayNothing`, and the placeholder path every build without a server
  // takes: a legal turn that calls no model at all.
  const record = await runTurn(world.store, {
    agentId: world.agentA2,
    roomId: world.room,
    entries: await world.store.drain(world.botA),
  });

  assert.equal(record.turn.input_tokens, 0);
  assert.equal(record.turn.output_tokens, 0);
});
