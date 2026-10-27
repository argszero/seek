import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deliver } from './delivery.ts';
import { makeWorld } from './fixtures.ts';
import { addMember, createRoom, removeMember, updateRoom } from './rooms.ts';

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

// ---- what a room says about itself, and who is out of it (2026-10-27) ----

test('a room may be told what it is about, and the fields nobody touched stay as they were', () => {
  const world = makeWorld();
  const { room } = createRoom(world.store, {
    name: 'before',
    members: [{ principalId: world.me }, { principalId: world.botA }],
    now: AT,
  });

  const changed = updateRoom(world.store, {
    roomId: room.id,
    name: '  after  ',
    description: 'what this room is for',
    announcement: 'read me',
    tag: '外部群',
  });
  // Trimmed, as the kernel trims a bot's name: the box a person typed into is a box,
  // and the spaces around a name are the box's, not the name's.
  assert.equal(changed.name, 'after');
  assert.equal(changed.description, 'what this room is for');
  assert.equal(changed.announcement, 'read me');
  assert.equal(changed.tag, '外部群');

  // A second call that names one field changes one field: no other text is cleared
  // by an edit that did not mention it.
  updateRoom(world.store, { roomId: room.id, announcement: 'a new notice' });
  assert.equal(room.name, 'after');
  assert.equal(room.description, 'what this room is for');
  assert.equal(room.announcement, 'a new notice');
  assert.equal(room.tag, '外部群');

  // `''` is a person having deleted a text, which is different from not mentioning it.
  updateRoom(world.store, { roomId: room.id, description: '', tag: '   ' });
  assert.equal('description' in room, false);
  assert.equal('tag' in room, false);
});

test('a blank name is refused, and a refused edit changes nothing at all', () => {
  const world = makeWorld();
  const { room } = createRoom(world.store, {
    name: 'kept',
    members: [{ principalId: world.me }, { principalId: world.botA }],
    now: AT,
  });

  assert.throws(
    () => updateRoom(world.store, { roomId: room.id, name: '   ', description: 'said' }),
    /a room with no name/,
  );
  // The description was given in the same call and was not applied: an edit is one
  // step, and half of a refused one is worse than none of it.
  assert.equal(room.name, 'kept');
  assert.equal('description' in room, false);

  assert.throws(() => updateRoom(world.store, { roomId: 'oc_nowhere' }), /unknown room/);
});

test('renaming a room rewrites no message: what was said still says where it was said', () => {
  const world = makeWorld();
  const { room } = createRoom(world.store, {
    name: 'the old name',
    members: [{ principalId: world.me }, { principalId: world.botA }],
    now: AT,
  });
  const { message } = deliver(world.store, {
    roomId: room.id,
    senderId: world.me,
    text: 'morning',
    now: AT,
  });
  updateRoom(world.store, { roomId: room.id, name: 'the new name' });

  const [stored] = world.store.messagesOf(room.id);
  assert.equal(stored.id, message.id);
  assert.equal(stored.text, 'morning');
  assert.equal(stored.room_id, room.id);
  // Nothing in the log copied the name, so there is nothing to disagree with.
  assert.equal(JSON.stringify(stored).includes('the old name'), false);
  assert.equal(room.name, 'the new name');
});

test('one person may leave a room, and the room still names what they said in it', () => {
  const world = makeWorld();
  const { room } = createRoom(world.store, {
    name: 'the room',
    members: [{ principalId: world.me }, { principalId: world.botA }],
    now: AT,
  });
  deliver(world.store, { roomId: room.id, senderId: world.botA, text: 'I was here', now: AT });

  const gone = removeMember(world.store, { roomId: room.id, principalId: world.botA });
  assert.equal(gone.principal_id, world.botA);
  assert.equal(world.store.isMember(room.id, world.botA), false);
  assert.deepEqual(
    world.store.membershipsOf(room.id).map((row) => row.principal_id),
    [world.me],
  );
  // The message is still there and still names the bot: being in a room is what went
  // away, not having been in it.
  assert.equal(world.store.messagesOf(room.id)[0].sender_id, world.botA);
  // And it is no longer woken by it, because delivery is written for members only.
  const again = deliver(world.store, { roomId: room.id, senderId: world.me, text: 'hello', now: AT });
  assert.deepEqual(again.observations, []);
});

test('the last member may not leave, and a member who is not there may not be removed', () => {
  const world = makeWorld();
  const { room } = createRoom(world.store, {
    members: [{ principalId: world.me }, { principalId: world.botA }],
    now: AT,
  });

  assert.throws(
    () => removeMember(world.store, { roomId: room.id, principalId: world.botB }),
    /is not a member of/,
  );
  assert.throws(
    () => removeMember(world.store, { roomId: 'oc_nowhere', principalId: world.me }),
    /unknown room/,
  );

  removeMember(world.store, { roomId: room.id, principalId: world.me });
  assert.equal(world.store.membershipsOf(room.id).length, 1);
  assert.throws(
    () => removeMember(world.store, { roomId: room.id, principalId: world.botA }),
    /is the last member of/,
  );
  // Refused before anything was written, so the room is exactly as it was.
  assert.equal(world.store.membershipsOf(room.id).length, 1);
});
