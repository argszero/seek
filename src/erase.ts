/**
 * Taking things back: one message, one thread, one room.
 *
 * The host asked for all four of the window's things to be deletable — a message, a group, a
 * bot, a topic (2026-10-27, 消息、群、机器人、话题都应该支持删除). A bot already had its verb
 * (`removeBot`, `src/bots.ts`); this file is the other three.
 *
 * **What a deletion is: a stamp, and the words gone.** The row stays and the content does not,
 * and the two halves answer two different questions:
 *
 * - **The row stays because other records point at it.** An `Observation` carries the
 *   `message_id` it delivers, a reply carries `root_id` and `chain`, a `Turn` names the message
 *   that woke it, and a `quoted` snapshot names the message it answers. Erasing the row would
 *   leave every one of those pointing at an id the store has never heard of — the state
 *   `Bot.removed_at` refuses from the other end ("deleting it would leave every message it wrote
 *   naming a principal the store has never heard of"). A stamped row keeps every reference
 *   resolvable and every list shippable.
 * - **The content goes because that is what the person asked for.** A delete that leaves the
 *   words on disk is not a delete; it is a hide, and a hide promises something it cannot keep.
 *   So the text, the picture reference, the attachment, the mentions, the reactions and the two
 *   snapshots (`quoted`, `forwarded_from` — other people's words copied onto this row) are all
 *   dropped in the same write, and what is left is: who said it, where, when, its place in the
 *   chain, and when it was taken back.
 *
 * **A deleted message therefore reads as a tombstone, and the window draws one**: the room shows
 * that something was there and stops showing what. That is the shape every client a person
 * already uses draws, and it is why the stamp is per message rather than a hole in the room's
 * log — a hole makes a conversation skip, and a tombstone lets it read.
 *
 * **Deletion settles the deliveries it made.** An `Observation` for a message that has been
 * taken back would wake a bot about something no longer there, and a bot answering a deleted
 * message is exactly the surprise this avoids. The pending entries are marked `consumed` — the
 * state the loop already uses for "taken", and what `pending()` filters on — so the record keeps
 * the fact that the message was once delivered and nothing acts on it again.
 *
 * **A thread is deleted whole, and only from its root.** `deleteThread` stamps the root and
 * every message whose `chain` is that root, in one write: a thread missing its middle is a
 * thread whose replies answer nothing. Asking it of a reply is refused rather than widened,
 * because a caller naming a reply has named a message, not a thread.
 *
 * **The picture and the attachment are bytes beside the store, and this file does not own
 * them.** The kernel keeps references; the files themselves are written and removed by the
 * interface (`ui/electron/main.js`), so each verb here returns what it took off the row and the
 * caller removes the bytes. A store whose `media/` outlives a deletion is a caller that dropped
 * the return value, not a kernel that forgot.
 */

import { SeekStore } from './store.ts';
import type { Id, Membership, Message, MessageFile, MessageMedia, Observation, Room } from './types.ts';

/** A message and the shard it lives in — a message is filed under the room it was said in. */
interface Found {
  roomId: Id;
  message: Message;
}

/**
 * Where one message lives, or nothing.
 *
 * Read through `data.messages` and not through `store.messagesOf()`, which creates the shard it
 * is asked about: a lookup that leaves a new empty room behind would make a read a write.
 */
function findMessage(store: SeekStore, messageId: Id): Found | undefined {
  for (const [roomId, messages] of Object.entries(store.data.messages)) {
    const message = messages.find((one) => one.id === messageId);
    if (message) return { roomId, message };
  }
  return undefined;
}

/** The record, once its words are gone and its stamp is on. */
export interface Erased {
  message: Message;
  /** The picture the row carried, so the caller can remove the bytes beside the store. */
  media?: MessageMedia;
  /** The attachment it carried, for the same reason. */
  file?: MessageFile;
}

/**
 * Take the words off one message and stamp it. The one write all three verbs end in.
 *
 * Content that goes: `text`, `media`, `file`, `mentions`, `reactions`, `quoted`,
 * `forwarded_from`. Content that stays: `id`, `room_id`, `sender_id`, `agent_id`, `kind`, the
 * chain (`root_id`, `caused_by`, `chain`, `depth`), `created_at` — and the stamp.
 *
 * `text` becomes `''` rather than the field going away, because `Message.text` is required and
 * every reader of it already handles an empty string; a message whose kind is `image` keeps its
 * kind and loses its picture, which is a tombstone saying what it was.
 */
function erase(store: SeekStore, found: Found, now: string): Erased {
  const message = found.message;
  const erased: Erased = { message };
  if (message.media) erased.media = message.media;
  if (message.file) erased.file = message.file;

  message.deleted_at = now;
  message.text = '';
  delete message.media;
  delete message.file;
  message.mentions = [];
  delete message.reactions;
  delete message.quoted;
  delete message.forwarded_from;

  settle(store, [message]);
  return erased;
}

/**
 * Stop every pending delivery of these messages.
 *
 * `consumed` is the loop's own word for an entry that has been taken (`store.drain`), so the
 * queue drops it without the record losing it — the same reason `drain` marks rather than
 * splices. An entry that was already consumed is left alone: it may carry the verdict it was
 * judged with, and a second write would be a second answer about one message.
 */
function settle(store: SeekStore, messages: Message[]): Observation[] {
  const gone = new Set(messages.map((message) => message.id));
  const settled: Observation[] = [];
  for (const entries of Object.values(store.data.observations)) {
    for (const entry of entries) {
      if (entry.state === 'consumed') continue;
      if (!entry.message_id || !gone.has(entry.message_id)) continue;
      entry.state = 'consumed';
      settled.push(entry);
    }
  }
  return settled;
}

export interface DeleteMessageInput {
  messageId: Id;
  /** An injectable clock, so a test does not depend on wall time. */
  now?: string;
}

/**
 * Delete one message: its words go, its row stays, its deliveries stop.
 *
 * A message deleted twice is refused rather than re-stamped, for the reason `removeBot` gives —
 * a second stamp would move the moment it happened, and the moment is the whole fact.
 */
export function deleteMessage(store: SeekStore, input: DeleteMessageInput): Erased {
  const messageId = typeof input?.messageId === 'string' ? input.messageId : '';
  const found = findMessage(store, messageId);
  if (!found) {
    throw new Error(
      `unknown message: ${messageId}: there is nothing to take back, and writing a deletion ` +
        'for a row that is not there would report that a room changed when it did not',
    );
  }
  if (found.message.deleted_at !== undefined) {
    throw new Error(
      `the message ${messageId} was already deleted on ${found.message.deleted_at}: ` +
        'a second stamp would move the moment it happened',
    );
  }

  return erase(store, found, input.now ?? new Date().toISOString());
}

export interface DeleteThreadInput {
  /** The message the thread starts from — a reply is a message, not a thread. */
  rootId: Id;
  now?: string;
}

export interface DeletedThread {
  roomId: Id;
  /** The root, and then every reply it holds, in the order they were said. */
  erased: Erased[];
}

/**
 * Delete a thread: the root and everything answered under it, in one write.
 *
 * **One write rather than a loop of `deleteMessage` calls**, because a thread half-deleted is a
 * state nobody asked for: the replies of a stamped root answer a message whose words are gone,
 * and a caller that failed between two of them would leave exactly that. The stamp is the same
 * instant for every message in it, which is what makes "this thread was deleted at 14:02" one
 * fact rather than a series of them.
 */
export function deleteThread(store: SeekStore, input: DeleteThreadInput): DeletedThread {
  const rootId = typeof input?.rootId === 'string' ? input.rootId : '';
  const found = findMessage(store, rootId);
  if (!found) {
    throw new Error(`unknown message: ${rootId}: there is no thread to delete`);
  }
  const root = found.message;
  if (root.chain !== undefined && root.chain !== root.id) {
    throw new Error(
      `the message ${rootId} answers another one, so it is not a thread: the thread it ` +
        `belongs to starts at ${root.chain}, and deleting a thread is asked of its root`,
    );
  }
  if (root.deleted_at !== undefined) {
    throw new Error(
      `the thread starting at ${rootId} was already deleted on ${root.deleted_at}: ` +
        'a second stamp would move the moment it happened',
    );
  }

  const now = input.now ?? new Date().toISOString();
  const messages = store.data.messages[found.roomId] ?? [];
  const erased: Erased[] = [];
  for (const message of messages) {
    // `chain` is the root of the run, and a message that caused nothing roots its own chain
    // (`src/delivery.ts`) — so the root itself is in the set the first clause matches, and the
    // second is there to say so rather than to catch a case the first one misses.
    if (message.chain !== root.id && message.id !== root.id) continue;
    if (message.deleted_at !== undefined) continue;
    erased.push(erase(store, { roomId: found.roomId, message }, now));
  }

  return { roomId: found.roomId, erased };
}

export interface DeleteRoomInput {
  roomId: Id;
  now?: string;
}

export interface DeletedRoom {
  room: Room;
  /** Every message the room held, or the empty list for a room nobody spoke in. */
  erased: Erased[];
  /** The rows taken out, so the window can say who is no longer in a room that is not there. */
  memberships: Membership[];
}

/**
 * Delete a group: the room, everything said in it, and every membership that put somebody in it.
 *
 * **The memberships go because that is what "not there" means to every other read.** A room is
 * listed for the people in it (`snapshot.js` reads the memberships), a bot is woken by being in
 * one (`botsIn`), and `deliver()` refuses a sender who is not a member — so removing the rows
 * takes the room out of every list, out of every bot's reach, and out of the composer's way in
 * one step, without any of those readers learning a new rule.
 *
 * **The room is stamped as well, and it is not the same fact as the missing memberships.** A
 * row with no members is a room somebody could still be added to, which is why `removeMember`
 * refuses to empty one; a stamped row is a room that no longer exists, which is what `deliver()`
 * checks before it says anything else. Without the stamp the refusal a person would meet on
 * speaking into a deleted room is "sender … is not a member", which is true and not the truth.
 *
 * **A room is not deleted for having members.** `createRoom` refuses an empty room and
 * `removeMember` refuses to empty one, both because a room nobody is in can never be spoken in
 * again — and this verb is the one way out of that rule, taken deliberately and by name. That is
 * why it exists at all rather than being a fourth refusal.
 */
export function deleteRoom(store: SeekStore, input: DeleteRoomInput): DeletedRoom {
  const roomId = typeof input?.roomId === 'string' ? input.roomId : '';
  const room = store.room(roomId);
  if (!room) {
    throw new Error(`unknown room: ${roomId}: there is nothing to delete`);
  }
  if (room.deleted_at !== undefined) {
    throw new Error(
      `the room ${roomId} was already deleted on ${room.deleted_at}: ` +
        'a second stamp would move the moment it happened',
    );
  }

  const now = input.now ?? new Date().toISOString();
  room.deleted_at = now;

  const erased: Erased[] = [];
  for (const message of store.data.messages[roomId] ?? []) {
    if (message.deleted_at !== undefined) continue;
    erased.push(erase(store, { roomId, message }, now));
  }

  const memberships = store.membershipsOf(roomId);
  for (const membership of memberships) {
    delete store.data.memberships[membership.id];
  }

  return { room, erased, memberships };
}
