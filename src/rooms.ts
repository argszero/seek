/**
 * Rooms and their members: the two writes that make a room exist.
 *
 * Until this file there was no way to create a room **through the kernel**.
 * Three places wrote `store.data.rooms` and `store.data.memberships` by hand —
 * the seed (`main.ts`), the test fixtures (`fixtures.ts`) and the second room
 * `turn.test.ts` builds — so a room could be made by an author with the store
 * open and by nobody else. The product's next step is a second room, and
 * `src/README.md` puts the kernel before the interface, so the write becomes a
 * function here before the window is allowed to reach for it.
 *
 * Three things this file is the only place for:
 *
 * - **A room and its members are one write.** A `createRoom` that returned a
 *   room and left membership to a later call would leave a window in which the
 *   room exists and nobody is in it — unspeakable in (`deliver` refuses a
 *   non-member sender) and invisible to every bot, which is a state no retry
 *   repairs, because the retry creates a second room.
 *
 * - **A membership names a principal that exists, once.** A row pointing at no
 *   principal is dropped in silence by `botsIn` and by `principal()`, and a
 *   second row for one principal is one person counted twice — which is not
 *   cosmetic, because `direct` in `deriveHints` **is** that count: a three-member
 *   room with a duplicated member reads as a direct message to the gate.
 *
 * - **`chat_mode` is stored and never branched on** (`src/README.md`, last
 *   checklist row; `docs/design/data-model.md`: a direct message is a headcount,
 *   not a type). There is nothing here that treats `p2p` as a different kind of
 *   room, and nothing that infers it from the member count either: the open platform has
 *   the field, the caller sets it, and the domain sees one kind of Room. A bot
 *   creating a room of its own needs no approval step (ruled 2026-10-23), so
 *   nothing here asks one for permission or looks for an owner: a room whose
 *   only member is a bot is an ordinary room.
 */

import { newId, SeekStore } from './store.ts';
import type { ChatMode, Id, Membership, MembershipRole, Room } from './types.ts';

/** One principal joining a room that is about to exist. */
export interface NewMember {
  /** A human or a bot — the store holds both, and a room may hold either alone. */
  principalId: Id;
  /** Defaults to `member`. No role is required of a room, not even `owner`. */
  role?: MembershipRole;
}

export interface CreateRoomInput {
  name?: string;
  /** Defaults to `group`, which is what a room is when nothing else is said. */
  chatMode?: ChatMode;
  /**
   * Who is in it, in the order the room will list them.
   *
   * Required rather than defaulted: `[]` is a room nobody can speak in, so the
   * caller has to say who it is for, and a refusal is louder than an empty room.
   */
  members: NewMember[];
  /** An injectable clock, so a test does not depend on wall time. */
  now?: string;
}

export interface CreatedRoom {
  room: Room;
  /** One row per member, in the order they were given. */
  memberships: Membership[];
}

/**
 * Create a room and put its members in it, in one step.
 *
 * Synchronous for the same reason `deliver()` is: the room and every membership
 * are appended in one uninterrupted step, so a reader never sees a room whose
 * members are still arriving. The caller persists once, with `await store.save()`.
 */
export function createRoom(
  store: SeekStore,
  input: CreateRoomInput,
): CreatedRoom {
  if (input.members.length === 0) {
    throw new Error(
      'a room with no members: `deliver` refuses a sender who is not a member, so ' +
        'nothing could ever be said in it and no bot could be woken by it — that is a ' +
        'row, not a room',
    );
  }

  // Checked before anything is written, so a refusal leaves the store exactly as
  // it was. A half-written room is the one outcome a caller cannot recover from:
  // it would create a second room and leave the first one orphaned.
  for (const member of input.members) {
    assertPrincipal(store, member.principalId);
  }
  const named = input.members.map((member) => member.principalId);
  const duplicate = named.find((id, index) => named.indexOf(id) !== index);
  if (duplicate) {
    throw new Error(
      `${duplicate} named twice in one room: two rows for one principal is one person ` +
        'counted twice, and the count is what `direct` reads — a three-member room would ' +
        'be delivered as a direct message',
    );
  }

  const now = input.now ?? new Date().toISOString();
  const room: Room = {
    id: newId('oc'),
    chat_mode: input.chatMode ?? 'group',
    created_at: now,
  };
  if (input.name !== undefined) room.name = input.name;
  store.data.rooms[room.id] = room;

  const memberships = input.members.map((member) => {
    const membership: Membership = {
      id: newId('mb'),
      room_id: room.id,
      principal_id: member.principalId,
      joined_at: now,
      role: member.role ?? 'member',
    };
    store.data.memberships[membership.id] = membership;
    return membership;
  });

  return { room, memberships };
}

export interface AddMemberInput {
  roomId: Id;
  principalId: Id;
  /** Defaults to `member`. */
  role?: MembershipRole;
  /** An injectable clock, so a test does not depend on wall time. */
  now?: string;
}

/**
 * Put one more principal into a room that already exists.
 *
 * This is the only way a membership is written after a room has been created —
 * and in particular the only way a bot joins a room somebody else made, which
 * is how a room of two bots is reached without inventing a second kind of room.
 */
export function addMember(
  store: SeekStore,
  input: AddMemberInput,
): Membership {
  if (!store.room(input.roomId)) {
    throw new Error(`unknown room: ${input.roomId}`);
  }
  assertPrincipal(store, input.principalId);
  if (store.isMember(input.roomId, input.principalId)) {
    throw new Error(
      `${input.principalId} is already a member of ${input.roomId}: a second row is one ` +
        'principal counted twice, and `direct` is that count',
    );
  }

  const membership: Membership = {
    id: newId('mb'),
    room_id: input.roomId,
    principal_id: input.principalId,
    joined_at: input.now ?? new Date().toISOString(),
    role: input.role ?? 'member',
  };
  store.data.memberships[membership.id] = membership;
  return membership;
}

/**
 * A membership may only name somebody the store knows.
 *
 * `store.principal()` reads `principals` and `bots` together, which is the point:
 * a human and a bot are joined the same way, and a room that holds only a bot is
 * an ordinary room. Checked here rather than left to the caller because the
 * failure is silent in every direction — `botsIn` filters an unknown id out, so
 * the room reads as smaller than it is and no later check can tell that from a
 * room somebody was never in.
 */
function assertPrincipal(store: SeekStore, principalId: Id): void {
  if (!store.principal(principalId)) {
    throw new Error(`unknown principal: ${principalId}`);
  }
}

export interface UpdateRoomInput {
  roomId: Id;
  /**
   * The four texts a person may edit. **A field left out is a field nobody touched**
   * — `undefined` leaves what is stored alone — while `''` is a person having
   * deleted the text, which clears it. Two different answers, so they are two
   * different values rather than one "empty".
   */
  name?: string;
  description?: string;
  announcement?: string;
  tag?: string;
  /** An injectable clock, so a test does not depend on wall time. */
  now?: string;
}

/**
 * Change what a room says about itself: its name, its description, its announcement,
 * its tag.
 *
 * **The first write in this file that changes something already written**, and what
 * it may change is deliberately narrow. A `Message` carries `room_id` and never a
 * copy of the room's name, so renaming a room rewrites no history: every message
 * still names the room it was said in, and the room says what it is now. That is
 * the difference between this and `Message.text`, which `deliver()` writes once and
 * nothing in the kernel moves.
 *
 * **A name is required to be a name.** `''` would draw as the room's own id in every
 * list (`snapshotOf` falls back to the id, which is the right fallback for a room the
 * roster made and the wrong one for a room somebody just emptied), so a blank name is
 * refused rather than stored. The other three *may* be cleared, because "no
 * announcement" is a state a room is allowed to be in.
 *
 * Returns the room as it now stands, so a caller need not re-read it.
 */
export function updateRoom(store: SeekStore, input: UpdateRoomInput): Room {
  const room = store.room(input?.roomId);
  if (!room) {
    throw new Error(`unknown room: ${input?.roomId}`);
  }

  if (input.name !== undefined) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (name === '') {
      throw new Error(
        'a room with no name: every list would draw it under its own id, and ' +
          '`delete room.name` is how this kernel has no name at all — a person who ' +
          'cleared the box has not asked for that',
      );
    }
    room.name = name;
  }

  for (const field of ['description', 'announcement', 'tag'] as const) {
    if (input[field] === undefined) continue;
    const text = typeof input[field] === 'string' ? input[field].trim() : '';
    if (text === '') delete room[field];
    else room[field] = text;
  }

  return room;
}

export interface RemoveMemberInput {
  roomId: Id;
  principalId: Id;
}

/**
 * Take one principal out of a room — leaving a group, or being taken out of one.
 *
 * Both directions are one write, because the kernel has no permission model to tell
 * them apart: `MembershipRole` is stored and never branched on, so "I leave" and
 * "somebody takes me out" are the same row going away. Who may do it is the
 * interface's question and is not answered here.
 *
 * **A room may not be emptied.** `createRoom` refuses `members: []` because a room
 * nobody is in is unrunnable in (`deliver` refuses a non-member sender) and invisible
 * to every bot, so nothing could ever repair it; the same sentence applies from the
 * other end, and the last member leaving is refused. This is what a person hits when
 * they press 退出 in a room that holds only them, and the refusal says so instead of
 * leaving behind a room that can never be used again.
 *
 * Removing somebody who has spoken changes nothing already written: a `Message`
 * keeps `sender_id`, so the room's history still names who said what. It is *being
 * in the room* that goes away, not having been in it.
 */
export function removeMember(store: SeekStore, input: RemoveMemberInput): Membership {
  const { roomId, principalId } = input ?? ({} as RemoveMemberInput);
  if (!store.room(roomId)) {
    throw new Error(`unknown room: ${roomId}`);
  }
  const held = store
    .membershipsOf(roomId)
    .find((membership) => membership.principal_id === principalId);
  if (!held) {
    throw new Error(
      `${principalId} is not a member of ${roomId}: there is no membership to remove, ` +
        'and writing a deletion for a row that is not there would report that a room ' +
        'changed when it did not',
    );
  }
  if (store.membershipsOf(roomId).length === 1) {
    throw new Error(
      `${principalId} is the last member of ${roomId}: a room nobody is in can never be ` +
        'spoken in again (`deliver` refuses a sender who is not a member) and no bot can ' +
        'be woken by it, which is the state `createRoom` already refuses to make',
    );
  }

  delete store.data.memberships[held.id];
  return held;
}
