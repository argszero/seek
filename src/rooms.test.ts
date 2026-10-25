import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deliver } from './delivery.ts';
import { makeWorld } from './fixtures.ts';
import { addMember, createRoom } from './rooms.ts';

const AT = '2026-10-26T00:00:00.000Z';

test('a room and its members are written in one step, and it is speakable at once', () => {
  const world = makeWorld();
  const roomsBefore = Object.keys(world.store.data.rooms).length;

  const { room, memberships } = createRoom(world.store, {
    name: 'the second room',
    members: [
      { principalId: world.me, role: 'owner' },
      { principalId: world.botA },
    ],
    now: AT,
  });

  assert.equal(Object.keys(world.store.data.rooms).length, roomsBefore + 1);
  assert.equal(world.store.room(room.id)?.name, 'the second room');
  assert.equal(room.chat_mode, 'group');
  assert.equal(room.created_at, AT);
  // The default role is `member`, and nobody's row is written twice.
  assert.deepEqual(
    memberships.map((row) => [row.principal_id, row.role, row.joined_at]),
    [
      [world.me, 'owner', AT],
      [world.botA, 'member', AT],
    ],
  );
  assert.equal(world.store.membershipsOf(room.id).length, 2);

  // The membership is not a separate step, so the room answers on the first
  // delivery rather than after a second call nobody remembered to make.
  const { observations } = deliver(world.store, {
    roomId: room.id,
    senderId: world.me,
    text: 'morning',
    now: AT,
  });
  assert.equal(observations.length, 1);
  assert.equal(observations[0].bot_id, world.botA);
});

test('chat_mode is stored as given, and two rooms that differ only in it behave the same', () => {
  const world = makeWorld();

  const group = createRoom(world.store, {
    chatMode: 'group',
    members: [{ principalId: world.me }, { principalId: world.botA }],
    now: AT,
  });
  const direct = createRoom(world.store, {
    chatMode: 'p2p',
    members: [{ principalId: world.me }, { principalId: world.botA }],
    now: AT,
  });
  const topic = createRoom(world.store, {
    chatMode: 'topic',
    members: [
      { principalId: world.me },
      { principalId: world.botA },
      { principalId: world.botB },
    ],
    now: AT,
  });

  // The field is kept, spelled the way Feishu spells it.
  assert.equal(world.store.room(group.room.id)?.chat_mode, 'group');
  assert.equal(world.store.room(direct.room.id)?.chat_mode, 'p2p');
  assert.equal(world.store.room(topic.room.id)?.chat_mode, 'topic');
  // And it is the only difference: same members, same shape.
  assert.equal(
    world.store.membershipsOf(group.room.id).length,
    world.store.membershipsOf(direct.room.id).length,
  );

  // `direct` is a headcount, not a mode (`data-model.md`): the same two members
  // give the same answer whichever mode the room carries, and three give the
  // other one whichever mode they are in.
  const directHint = (roomId: string): boolean | undefined =>
    deliver(world.store, {
      roomId,
      senderId: world.me,
      text: 'hello',
      now: AT,
    }).observations.find((entry) => entry.bot_id === world.botA)?.hints.direct;
  assert.equal(directHint(group.room.id), true);
  assert.equal(directHint(direct.room.id), true);
  assert.equal(directHint(topic.room.id), false);
});

test('a refusal writes nothing, so a caller can retry without orphaning a room', () => {
  const world = makeWorld();
  const roomsBefore = Object.keys(world.store.data.rooms).length;
  const membershipsBefore = Object.keys(world.store.data.memberships).length;

  assert.throws(
    () =>
      createRoom(world.store, {
        members: [{ principalId: world.me }, { principalId: 'ou_nobody' }],
        now: AT,
      }),
    /unknown principal: ou_nobody/,
  );

  // Not a half-written room: the whole write is refused before the first row.
  assert.equal(Object.keys(world.store.data.rooms).length, roomsBefore);
  assert.equal(
    Object.keys(world.store.data.memberships).length,
    membershipsBefore,
  );
});

test('the same principal twice is refused, because a duplicate breaks the headcount', () => {
  const world = makeWorld();
  const roomsBefore = Object.keys(world.store.data.rooms).length;

  assert.throws(
    () =>
      createRoom(world.store, {
        members: [
          { principalId: world.me },
          { principalId: world.me, role: 'owner' },
          { principalId: world.botA },
        ],
        now: AT,
      }),
    /named twice in one room/,
  );
  assert.equal(Object.keys(world.store.data.rooms).length, roomsBefore);
});

test('a room with no members is refused: nothing could be said in it', () => {
  const world = makeWorld();
  assert.throws(
    () => createRoom(world.store, { members: [], now: AT }),
    /a room with no members/,
  );
});

test('a room whose only member is a bot is an ordinary room, with no approval step', () => {
  const world = makeWorld();

  // A bot makes its own room (ruled 2026-10-23: no approval, no human gate).
  const { room } = createRoom(world.store, {
    name: 'bots',
    members: [{ principalId: world.botA, role: 'owner' }],
    now: AT,
  });
  assert.deepEqual(world.store.botsIn(room.id).map((bot) => bot.id), [
    world.botA,
  ]);
  assert.equal(world.store.isMember(room.id, world.me), false);

  // And it is a room like any other: a bot may open a conversation in it, and a
  // human joins by the same write a bot would.
  const { message } = deliver(world.store, {
    roomId: room.id,
    senderId: world.botA,
    text: 'on my own',
    now: AT,
  });
  assert.equal(world.store.messagesOf(room.id).length, 1);
  assert.equal(message.room_id, room.id);

  const joined = addMember(world.store, {
    roomId: room.id,
    principalId: world.me,
    now: AT,
  });
  assert.equal(joined.role, 'member');
  assert.equal(joined.joined_at, AT);
  assert.equal(world.store.isMember(room.id, world.me), true);
  assert.equal(world.store.membershipsOf(room.id).length, 2);
});

test('addMember refuses a room that does not exist, and a principal that does not', () => {
  const world = makeWorld();
  const membershipsBefore = Object.keys(world.store.data.memberships).length;

  assert.throws(
    () =>
      addMember(world.store, {
        roomId: 'oc_nothing',
        principalId: world.me,
        now: AT,
      }),
    /unknown room: oc_nothing/,
  );
  assert.throws(
    () =>
      addMember(world.store, {
        roomId: world.room,
        principalId: 'ou_nobody',
        now: AT,
      }),
    /unknown principal: ou_nobody/,
  );
  assert.equal(
    Object.keys(world.store.data.memberships).length,
    membershipsBefore,
  );
});

test('addMember refuses a principal who is already in the room', () => {
  const world = makeWorld();
  const count = world.store.membershipsOf(world.room).length;

  assert.throws(
    () => addMember(world.store, { roomId: world.room, principalId: world.me }),
    /already a member of/,
  );
  assert.equal(world.store.membershipsOf(world.room).length, count);
});

test('the clock is injectable: no member row is stamped with wall time the caller did not give', () => {
  const world = makeWorld();
  const { room, memberships } = createRoom(world.store, {
    members: [{ principalId: world.botB }],
    now: '2026-01-01T00:00:00.000Z',
  });
  const added = addMember(world.store, {
    roomId: room.id,
    principalId: world.me,
    role: 'owner',
    now: '2026-01-02T00:00:00.000Z',
  });

  assert.deepEqual(
    [...memberships, added].map((row) => [row.role, row.joined_at]),
    [
      ['member', '2026-01-01T00:00:00.000Z'],
      ['owner', '2026-01-02T00:00:00.000Z'],
    ],
  );
  // Without a clock the kernel still stamps one — the field is never absent.
  const later = addMember(world.store, { roomId: room.id, principalId: world.botA });
  assert.match(later.joined_at, /^\d{4}-\d{2}-\d{2}T/);
});
