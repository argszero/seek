/**
 * Delivery: a principal posts to a room, and every bot in that room gets one
 * entry on its queue.
 *
 * Three things this file is the only place for:
 *
 * - **One write per bot, not per agent.** The queue, the tick and "already
 *   handled" are the bot's, so a room of two bots gets two entries however many
 *   agents work behind them.
 * - **`mentionsMe` is derived, never stored on the message.** The message keeps
 *   the `mentions[]` field — who was named — and each bot finds its own id in it
 *   once, at delivery. A per-reader boolean on a shared immutable fact would
 *   force a rewrite or a copy of the message per bot in the room.
 * - **The hints and the kind are computed once, here.** Nothing downstream scans
 *   a room for its own name, and nothing re-derives "was I addressed" later.
 */

import { chainBlock, resetAgentTurns } from './chain.ts';
import { newId, SeekStore } from './store.ts';
import type {
  Bot,
  ForwardedFrom,
  Id,
  Mention,
  Message,
  MessageKind,
  MessageFile,
  MessageMedia,
  Observation,
  ObservationHints,
  ObservationKind,
  QuotedMessage,
} from './types.ts';

/**
 * A message named together with the room holding it.
 *
 * The pair rather than the id alone, because a forward's source is wherever the
 * original was said and the destination is somewhere else — see `forwardOf` below.
 */
export interface ForwardedSource {
  roomId: Id;
  messageId: Id;
}

export interface PostMessageInput {
  roomId: Id;
  senderId: Id;
  text: string;
  kind?: MessageKind;
  /**
   * The picture this message is. Required by `kind: 'image'`, refused on any
   * other kind — see `mediaFor` for why the pair is an invariant.
   */
  media?: MessageMedia;
  /**
   * The attachment this message is. Required by `kind: 'file'`, refused on every
   * other kind — the pair is an invariant here for the reason `media` is.
   */
  file?: MessageFile;
  /** The principals this message @-mentions, the open platform's `{id, name}` pairs. */
  mentions?: Mention[];
  /**
   * The message this one quotes. `deliver()` reads it out of the store and keeps
   * the snapshot, because a caller's copy of somebody's words is a claim about
   * what they said — see `QuotedMessage` in `types.ts`.
   */
  quoteOf?: Id;
  /**
   * The message this one forwards. Its words, kind and picture are copied off
   * the stored message here, not passed in, so a forward cannot say something
   * the original did not.
   *
   * **A forward names where the original is.** Forwarding is sending somebody
   * else's message *somewhere else*, so the source is usually not a message in the
   * room being posted to — a bare `Id` is the one-room case (the original is in this
   * room), and `{roomId, messageId}` says so when it is not. Anything else would
   * make the toolbar's forward button a copy of the message into the room it is
   * already in.
   */
  forwardOf?: Id | ForwardedSource;
  /** The message this one answers, when it answers one. */
  rootId?: Id;
  /** Which agent of the sending bot wrote it. */
  agentId?: Id;
  /** An injectable clock, so a test does not depend on wall time. */
  now?: string;
}

export interface Delivery {
  message: Message;
  /** One entry per recipient bot, in the order the room lists them. */
  observations: Observation[];
}

/**
 * Post a message and deliver it.
 *
 * Synchronous by design: the message and every entry are appended in one
 * uninterrupted step, so a delivery can never interleave with the pop half of a
 * drain. The caller persists once, with `await store.save()`.
 */
export function deliver(store: SeekStore, input: PostMessageInput): Delivery {
  const room = store.room(input.roomId);
  if (!room) throw new Error(`unknown room: ${input.roomId}`);
  if (!store.principal(input.senderId)) {
    throw new Error(`unknown sender: ${input.senderId}`);
  }
  if (!store.isMember(input.roomId, input.senderId)) {
    throw new Error(
      `sender ${input.senderId} is not a member of ${input.roomId}`,
    );
  }

  const parent = input.rootId
    ? store.messagesOf(input.roomId).find((m) => m.id === input.rootId)
    : undefined;
  if (input.rootId && !parent) {
    throw new Error(`unknown message in ${input.roomId}: ${input.rootId}`);
  }

  // The two snapshots are read out of the store before anything is written: what
  // a reply quotes and where a forward came from are facts of the moment it is
  // sent, and neither is taken from the caller.
  if (input.quoteOf && input.forwardOf) {
    throw new Error(
      'a message both quotes and forwards: a forward carries another message\'s own ' +
        'content, so it has no words of its own to put a quotation beside',
    );
  }
  const quoting = input.quoteOf
    ? messageIn(store, input.roomId, input.quoteOf)
    : undefined;
  const forwarding = input.forwardOf
    ? typeof input.forwardOf === 'string'
      ? messageIn(store, input.roomId, input.forwardOf)
      : messageIn(
          store,
          input.forwardOf.roomId,
          input.forwardOf.messageId,
        )
    : undefined;
  if (
    forwarding &&
    (input.kind !== undefined ||
      input.media !== undefined ||
      input.file !== undefined ||
      (input.text ?? '').trim() !== '')
  ) {
    throw new Error(
      'a forwarded message carrying content of its own: `forwardOf` names the message ' +
        'whose words, kind and picture are carried, and anything passed beside it is a ' +
        'second copy of a fact the store already holds',
    );
  }

  const now = input.now ?? new Date().toISOString();
  const kind = forwarding ? forwarding.kind : (input.kind ?? 'text');
  const media = forwarding
    ? copyOf(forwarding.media)
    : mediaFor(kind, input.media);
  const file = forwarding
    ? copyOfFile(forwarding.file)
    : fileFor(kind, input.file);
  const message: Message = {
    id: newId('om'),
    room_id: input.roomId,
    sender_id: input.senderId,
    kind,
    text: forwarding ? forwarding.text : input.text,
    mentions: (input.mentions ?? []).map((mention) => ({
      id: mention.id,
      name: mention.name,
    })),
    depth: parent ? parent.depth + 1 : 0,
    created_at: now,
  };
  if (input.agentId) message.agent_id = input.agentId;
  // A copy of the caller's object, not the object: the message is written once
  // and stays clean, and a caller still holding the reference could otherwise
  // rename a picture under a message already delivered.
  if (media) message.media = media;
  if (file) message.file = file;
  if (quoting) message.quoted = quotedFrom(store, quoting);
  if (forwarding) message.forwarded_from = forwardedFrom(store, forwarding);
  if (parent) {
    message.root_id = parent.id;
    message.caused_by = parent.id;
    message.chain = parent.chain ?? parent.id;
  } else {
    // A message that caused nothing else roots its own chain.
    message.chain = message.id;
  }

  store.messagesOf(input.roomId).push(message);

  // A person speaking in this room ends its run of bot turns (§11.3). Nothing
  // resets a chain's depth: that is the message's own fact, and a person
  // rejoining a thread is a new hop in the thread they rejoined.
  if (store.data.principals[input.senderId]) {
    resetAgentTurns(store, input.roomId);
  }

  const observations: Observation[] = [];
  for (const bot of store.botsIn(input.roomId)) {
    // A bot does not wake itself with its own words.
    if (bot.id === input.senderId) continue;
    const hints = deriveHints(store, bot, message);
    // §11.4: the entry still lands, at zero cost, marked with why the wall held
    // it. The hint is the record taken now; the wake decision is taken again
    // when the entry is settled (`chain.ts`).
    const held = chainBlock(store, bot.id, {
      id: '',
      bot_id: bot.id,
      message_id: message.id,
      room_id: message.room_id,
      kind: 'message',
      hints,
      delivered_at: now,
    });
    if (held) hints.chainBlocked = held;
    const observation: Observation = {
      id: newId('ob'),
      bot_id: bot.id,
      message_id: message.id,
      room_id: message.room_id,
      kind: deriveKind(hints),
      hints,
      delivered_at: now,
    };
    store.inbox(bot.id).push(observation);
    observations.push(observation);
  }

  return { message, observations };
}

/**
 * Where a quotation is cut.
 *
 * The block draws one line of the quoted message, and a reply to a manifesto is
 * not made better by carrying the manifesto. The cut is taken here rather than
 * by whoever draws it, so two readers cannot disagree about what a quotation is.
 */
const QUOTE_CHARS = 160;

/** One message of one room, or a refusal naming both. */
function messageIn(store: SeekStore, roomId: Id, messageId: Id): Message {
  const found = store
    .messagesOf(roomId)
    .find((message) => message.id === messageId);
  if (!found) throw new Error(`unknown message in ${roomId}: ${messageId}`);
  return found;
}

/** A principal's name as it reads now, for the snapshots below. */
function senderName(store: SeekStore, senderId: Id): string {
  const sender = store.principal(senderId);
  return sender && typeof sender.name === 'string' ? sender.name : senderId;
}

/**
 * The quotation a reply keeps: the quoted message's sender and its words.
 *
 * Taken now and stored, so the reply goes on meaning what it answered even if the
 * message it answered is dropped later. `system` is not a principal and so has no
 * name to look up; the snapshot then says `system`, which is what the message's
 * own `sender_id` says.
 */
function quotedFrom(store: SeekStore, message: Message): QuotedMessage {
  return {
    message_id: message.id,
    name: senderName(store, message.sender_id),
    text: message.text.slice(0, QUOTE_CHARS),
  };
}

function forwardedFrom(store: SeekStore, message: Message): ForwardedFrom {
  return {
    message_id: message.id,
    name: senderName(store, message.sender_id),
  };
}

/** A copy of a stored picture reference, for the reason `mediaFor` returns one. */
function copyOf(media: MessageMedia | undefined): MessageMedia | undefined {
  return media ? { key: media.key, mime: media.mime } : undefined;
}

export interface ReactionInput {
  roomId: Id;
  messageId: Id;
  /** The principal reacting: a person or a bot, either way one id. */
  principalId: Id;
  /** Feishu's `emoji_type` — the name the picker sends (`OK`, `SMILE`). */
  emojiType: string;
}

/**
 * Add one principal's reaction to a message, or take it back.
 *
 * **A toggle, because the button is one button.** In the interface the same emoji
 * in the same place adds and removes, and two entry points for one state are two
 * things that can disagree.
 *
 * **The count is not stored.** `operators` is the fact and its length is the count,
 * so a file repaired by hand cannot say four people and name two.
 *
 * **An entry whose last operator leaves is dropped**, so a message whose reactions
 * were all taken back is the same message as one nobody ever reacted to: there is
 * no zero row to draw and nothing to prune later.
 *
 * **The reactor has to be someone in the room.** A reaction is a principal's answer
 * to a message they were there for; the alternative is a stranger's mark with no
 * membership behind it, and nothing to check it against later.
 */
export function toggleReaction(
  store: SeekStore,
  input: ReactionInput,
): Message {
  const message = messageIn(store, input.roomId, input.messageId);
  const emojiType = input.emojiType.trim();
  if (emojiType === '') {
    throw new Error(
      'a reaction with no emoji_type: the emoji is the whole of what a reaction says',
    );
  }
  if (!store.principal(input.principalId)) {
    throw new Error(`unknown principal: ${input.principalId}`);
  }
  if (!store.isMember(input.roomId, input.principalId)) {
    throw new Error(
      `${input.principalId} is not a member of ${input.roomId}, so it has nothing to ` +
        'react to here',
    );
  }

  const reactions = message.reactions ?? [];
  const existing = reactions.find(
    (reaction) => reaction.emoji_type === emojiType,
  );
  if (!existing) {
    reactions.push({
      emoji_type: emojiType,
      operators: [input.principalId],
    });
  } else {
    const at = existing.operators.indexOf(input.principalId);
    if (at >= 0) existing.operators.splice(at, 1);
    else existing.operators.push(input.principalId);
    if (existing.operators.length === 0) {
      reactions.splice(reactions.indexOf(existing), 1);
    }
  }
  // Absent, not empty: `[]` would be a field that says "nothing here" on every
  // message ever written, and the shape a reader checks for is the same either way.
  if (reactions.length === 0) delete message.reactions;
  else message.reactions = reactions;
  return message;
}

/**
 * The picture a message carries, checked against the kind that claims it.
 *
 * `agent-lifecycle.md` §2 requirement 2 is a measurement this kernel has to make
 * possible before it can make it: a judgement must **see** an image, because
 * *"deciding 'is this about me?' from alt text alone is guessing"*. What makes
 * seeing possible is one invariant — **`media` is present exactly when `kind` is
 * `image`** — and it is enforced here rather than left to callers, because the
 * failure is silent in every direction: an image message with nothing behind it
 * reads downstream as a text message, and no later check can tell that from a
 * picture nobody sent.
 *
 * Three refusals, each one a way the invariant would otherwise be untrue:
 *
 * - **An `image` with no picture** — or with a picture whose `key` names no blob.
 *   That is the alt-text failure itself, and it is refused at the door instead of
 *   being measured by a model as if it were a message.
 * - **A picture on any other kind.** A message that says "no picture" while
 *   carrying one is dropped in silence by everything that dispatches on `kind`.
 * - **An `image` whose mime is not an image.** The kind would say picture and the
 *   bytes would say otherwise, and only one of the two can be true.
 */
function mediaFor(
  kind: MessageKind,
  media: MessageMedia | undefined,
): MessageMedia | undefined {
  if (kind !== 'image') {
    if (media !== undefined) {
      throw new Error(
        `media on a ${JSON.stringify(kind)} message: only 'image' carries a picture, ` +
          'and a kind that disowns its own bytes is one every reader drops in silence',
      );
    }
    return undefined;
  }
  if (!media || media.key.trim() === '') {
    throw new Error(
      "an image message with no image: `media` is what lets a judgement see it, and " +
        "judging one from its text alone is the failure src/README.md line 25 names",
    );
  }
  if (!media.mime.startsWith('image/')) {
    throw new Error(
      `an image message whose mime is ${JSON.stringify(media.mime)}: the kind says ` +
        'picture and the bytes say otherwise',
    );
  }
  return { key: media.key, mime: media.mime };
}

/**
 * The attachment rule, stated once.
 *
 * `kind` and the carrier are one invariant in both directions, exactly as `media` is: a
 * `file` message carrying no attachment is a row that draws a paperclip over nothing, and
 * an attachment on any other kind is bytes every reader drops in silence — which is the
 * failure `src/README.md` line 25 names for a picture read from its text alone.
 *
 * **A copy is returned, not the caller's object.** A message is written once; a caller
 * still holding the reference could otherwise rename a file under a message already sent.
 */
function fileFor(
  kind: MessageKind,
  file: MessageFile | undefined,
): MessageFile | undefined {
  if (kind !== 'file') {
    if (file !== undefined) {
      throw new Error(
        `an attachment on a ${JSON.stringify(kind)} message: only 'file' carries one, and a ` +
          'kind that disowns its own bytes is one every reader drops in silence',
      );
    }
    return undefined;
  }
  if (!file || typeof file.key !== 'string' || file.key.trim() === '') {
    throw new Error(
      "a file message with no file: the row would draw an attachment over nothing, and " +
        'the person would have no way to tell it from one whose bytes were lost',
    );
  }
  if (typeof file.name !== 'string' || file.name.trim() === '') {
    throw new Error(
      'a file message whose attachment has no name: the name is the only thing that says ' +
        'which file this is, since the key is opaque by design',
    );
  }
  if (typeof file.size !== 'number' || !Number.isFinite(file.size) || file.size < 0) {
    throw new Error(
      `a file message whose size is ${JSON.stringify(file.size)}: a size is how the row ` +
        'says how big it is without opening it, so an unusable one is worse than none',
    );
  }
  if (typeof file.mime !== 'string' || file.mime.trim() === '') {
    throw new Error(
      'a file message whose attachment has no mime: a reader that cannot name what the ' +
        'bytes are cannot choose an application to open them with',
    );
  }
  return { key: file.key, name: file.name, size: file.size, mime: file.mime };
}

/** A copy of a stored attachment reference, for the reason `copyOf` returns one. */
function copyOfFile(file: MessageFile | undefined): MessageFile | undefined {
  return file
    ? { key: file.key, name: file.name, size: file.size, mime: file.mime }
    : undefined;
}

/**
 * The zero-cost answers, from the shared log as it stands at delivery.
 *
 * `direct` is a headcount, not a type: the room holds exactly two members, and
 * the receiving bot is one of them. Nothing reads `chat_mode`.
 */
export function deriveHints(
  store: SeekStore,
  bot: Bot,
  message: Message,
): ObservationHints {
  const answered = message.caused_by
    ? store.messagesOf(message.room_id).find((m) => m.id === message.caused_by)
    : undefined;
  return {
    mentionsMe: message.mentions.some((mention) => mention.id === bot.id),
    repliesToMe: answered !== undefined && answered.sender_id === bot.id,
    direct: store.membershipsOf(message.room_id).length === 2,
  };
}

/**
 * Which band the entry falls in — the set stage 0's fast pass reads.
 *
 * A reminder is not derived here: it is the schedule row's own kind, the one
 * entry whose author is the bot itself.
 */
export function deriveKind(hints: ObservationHints): ObservationKind {
  if (hints.mentionsMe) return 'mention';
  if (hints.repliesToMe) return 'reply';
  if (hints.direct) return 'direct';
  return 'message';
}
