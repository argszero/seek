import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deliver } from './delivery.ts';
import { deleteMessage, deleteRoom, deleteThread } from './erase.ts';
import { makeWorld } from './fixtures.ts';

const AT = '2026-10-27T10:00:00.000Z';

/** One text message from the human, so a test can say something and then take it back. */
function said(world: ReturnType<typeof makeWorld>, text: string, extra = {}) {
  return deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text,
    now: AT,
    ...extra,
  }).message;
}

test('a deleted message keeps its row and loses its words', () => {
  const world = makeWorld();
  const message = said(world, 'said in a hurry');
  const room = world.store.data.messages[world.room];
  const before = room.length;

  deleteMessage(world.store, { messageId: message.id, now: AT });

  // The words are gone, which is what was asked for: a delete that leaves the text on disk
  // is a hide wearing a delete's name.
  assert.equal(message.text, '');
  assert.equal(message.deleted_at, AT);
  // The row is still there, which is the other half: an `Observation`, a reply's `chain` and a
  // `Turn` all name this id, and a hole would make every one of them point at nothing.
  assert.equal(room.length, before);
  assert.equal(room.find((one) => one.id === message.id), message);
  // What a tombstone still has to say: who, where, when, and where it sat in a thread.
  assert.equal(message.sender_id, world.me);
  assert.equal(message.room_id, world.room);
  assert.equal(message.created_at, AT);
  assert.equal(message.depth, 0);
  assert.equal(message.chain, message.id);
});

test('the picture and the attachment come off the row, and back out to the caller', () => {
  const world = makeWorld();
  const picture = said(world, 'look', {
    kind: 'image',
    media: { key: 'om_picture', mime: 'image/png' },
  });
  const document = said(world, '', {
    kind: 'file',
    file: { key: 'om_file', mime: 'application/pdf', name: 'plan.pdf', size: 3 },
  });

  const gonePicture = deleteMessage(world.store, { messageId: picture.id, now: AT });
  const goneFile = deleteMessage(world.store, { messageId: document.id, now: AT });

  // Off the record: a tombstone that still named a picture would draw one.
  assert.equal('media' in picture, false);
  assert.equal('file' in document, false);
  // And handed back, because the bytes are files beside the store and this file does not own
  // them: a caller that drops this return value leaves a deleted picture on disk.
  assert.deepEqual(gonePicture.media, { key: 'om_picture', mime: 'image/png' });
  assert.deepEqual(goneFile.file, {
    key: 'om_file',
    mime: 'application/pdf',
    name: 'plan.pdf',
    size: 3,
  });
  // The kind stays, because what a message *was* is part of the tombstone.
  assert.equal(picture.kind, 'image');
  assert.equal(document.kind, 'file');
});

test('a message is deleted once, and a second stamp is refused rather than moved', () => {
  const world = makeWorld();
  const message = said(world, 'once');

  deleteMessage(world.store, { messageId: message.id, now: AT });

  assert.throws(
    () => deleteMessage(world.store, { messageId: message.id, now: '2026-10-27T11:00:00.000Z' }),
    /already deleted on 2026-10-27T10:00:00.000Z/,
  );
  // The refusal wrote nothing: the moment it happened is still the first one.
  assert.equal(message.deleted_at, AT);
});

test('a message that is not in the store is refused, and nothing is stamped', () => {
  const world = makeWorld();
  const message = said(world, 'still here');

  assert.throws(() => deleteMessage(world.store, { messageId: 'om_nope' }), /unknown message/);
  assert.equal(message.deleted_at, undefined);
});

test('a deleted message stops waking the bot it was delivered to', () => {
  const world = makeWorld();
  const message = said(world, 'A, look at this', {
    mentions: [{ id: world.botA, name: 'A' }],
  });
  assert.equal(world.store.pending(world.botA).length, 1, 'the mention is a delivery');

  deleteMessage(world.store, { messageId: message.id, now: AT });

  // The queue drops it, so no bot answers something that is no longer there.
  assert.equal(world.store.pending(world.botA).length, 0);
  // The record keeps it, because the entry carried a delivery that did happen and `drain`
  // marks rather than splices for the same reason.
  const entry = world.store.inbox(world.botA).find((one) => one.message_id === message.id);
  assert.equal(entry?.state, 'consumed');
});

test('a thread is deleted whole, at one instant, and another thread is left alone', () => {
  const world = makeWorld();
  const root = said(world, 'a question');
  const reply = deliver(world.store, {
    roomId: world.room,
    senderId: world.botA,
    text: 'an answer',
    rootId: root.id,
    now: AT,
  }).message;
  const deeper = deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: 'a follow-up',
    rootId: reply.id,
    now: AT,
  }).message;
  const elsewhere = said(world, 'another thread entirely');

  const gone = deleteThread(world.store, { rootId: root.id, now: AT });

  // Every message in the run, and nothing outside it.
  assert.deepEqual(
    gone.erased.map((one) => one.message.id),
    [root.id, reply.id, deeper.id],
  );
  for (const message of [root, reply, deeper]) {
    assert.equal(message.text, '');
    assert.equal(message.deleted_at, AT, 'one instant, so the thread went at one time');
  }
  assert.equal(elsewhere.deleted_at, undefined);
  assert.equal(elsewhere.text, 'another thread entirely');
});

test('a thread is asked for from its root, and asking from a reply is refused', () => {
  const world = makeWorld();
  const root = said(world, 'the root');
  const reply = deliver(world.store, {
    roomId: world.room,
    senderId: world.botA,
    text: 'the reply',
    rootId: root.id,
    now: AT,
  }).message;

  assert.throws(
    () => deleteThread(world.store, { rootId: reply.id, now: AT }),
    new RegExp(`belongs to starts at ${root.id}`),
  );
  // Nothing was taken back by the refusal, which is the point of refusing rather than widening.
  assert.equal(root.deleted_at, undefined);
  assert.equal(reply.deleted_at, undefined);
  assert.equal(root.text, 'the root');
});

test('deleting a room takes its messages and its memberships, and refuses a delivery after', () => {
  const world = makeWorld();
  const first = said(world, 'one');
  const second = said(world, 'two');
  const members = world.store.membershipsOf(world.room).length;
  assert.ok(members > 0);

  const gone = deleteRoom(world.store, { roomId: world.room, now: AT });

  assert.equal(gone.room.deleted_at, AT);
  assert.deepEqual(
    gone.erased.map((one) => one.message.id),
    [first.id, second.id],
  );
  assert.equal(first.text, '');
  assert.equal(second.deleted_at, AT);
  // The memberships are what make the room disappear from every list: a room is listed for the
  // people in it, and a bot is woken by being in one.
  assert.equal(world.store.membershipsOf(world.room).length, 0);
  assert.equal(gone.memberships.length, members);

  // And the sentence a person meets is the room's, not the membership's: "sender … is not a
  // member" is true of a deleted room and is not the truth about it.
  assert.throws(
    () =>
      deliver(world.store, {
        roomId: world.room,
        senderId: world.me,
        text: 'anybody there?',
        now: AT,
      }),
    /was deleted on 2026-10-27T10:00:00.000Z/,
  );

  // A second deletion is refused for the reason every other stamp refuses one.
  assert.throws(
    () => deleteRoom(world.store, { roomId: world.room, now: '2026-10-27T12:00:00.000Z' }),
    /already deleted/,
  );
});

test('quoting or forwarding a deleted message is refused rather than carried empty', () => {
  const world = makeWorld();
  const message = said(world, 'something worth quoting');
  deleteMessage(world.store, { messageId: message.id, now: AT });

  for (const [what, input] of [
    ['quoting', { quoteOf: message.id }],
    ['forwarding', { forwardOf: message.id }],
  ] as const) {
    assert.throws(
      () =>
        deliver(world.store, {
          roomId: world.room,
          senderId: world.me,
          text: what === 'quoting' ? 'about that' : '',
          now: AT,
          ...input,
        }),
      /was deleted on/,
      `${what} a deleted message has no content left to take`,
    );
  }
});
