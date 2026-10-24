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
 *   Feishu's `mentions[]` — who was named — and each bot finds its own id in it
 *   once, at delivery. A per-reader boolean on a shared immutable fact would
 *   force a rewrite or a copy of the message per bot in the room.
 * - **The hints and the kind are computed once, here.** Nothing downstream scans
 *   a room for its own name, and nothing re-derives "was I addressed" later.
 */

import { newId, SeekStore } from './store.ts';
import type {
  Bot,
  Id,
  Mention,
  Message,
  MessageKind,
  Observation,
  ObservationHints,
  ObservationKind,
} from './types.ts';

export interface PostMessageInput {
  roomId: Id;
  senderId: Id;
  text: string;
  kind?: MessageKind;
  /** The principals this message @-mentions, Feishu's `{id, name}` pairs. */
  mentions?: Mention[];
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

  const now = input.now ?? new Date().toISOString();
  const message: Message = {
    id: newId('om'),
    room_id: input.roomId,
    sender_id: input.senderId,
    kind: input.kind ?? 'text',
    text: input.text,
    mentions: (input.mentions ?? []).map((mention) => ({
      id: mention.id,
      name: mention.name,
    })),
    depth: parent ? parent.depth + 1 : 0,
    created_at: now,
  };
  if (input.agentId) message.agent_id = input.agentId;
  if (parent) {
    message.root_id = parent.id;
    message.caused_by = parent.id;
    message.chain = parent.chain ?? parent.id;
  } else {
    // A message that caused nothing else roots its own chain.
    message.chain = message.id;
  }

  store.messagesOf(input.roomId).push(message);

  const observations: Observation[] = [];
  for (const bot of store.botsIn(input.roomId)) {
    // A bot does not wake itself with its own words.
    if (bot.id === input.senderId) continue;
    const hints = deriveHints(store, bot, message);
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
