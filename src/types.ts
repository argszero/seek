/**
 * The entities of `docs/design/data-model.md`.
 *
 * One sentence holds the whole shape: **messages are shared facts; context is a
 * private interpretation.** A room has one message log, and every bot derives
 * its own answer from it once, when a message is delivered to it.
 *
 * Identifiers use the Feishu prefixes of data-model rule 10: `ou_` a principal
 * (a human or a bot), `oc_` a room, `om_` a message, `ag_` an agent.
 */

export type Id = string;

export type PrincipalKind = 'human' | 'bot';

/** Anything that can appear in a room and be addressed. */
export interface Principal {
  id: Id;
  kind: PrincipalKind;
  name: string;
  avatar?: string;
  /** Self-introduction, used by others to gauge whether to approach it. */
  description?: string;
}

/**
 * A visible contact — the thing a room shows.
 *
 * A bot is a principal: its `id` is its `ou_` id. It is stored in its own shard
 * because the identity changes rarely while its agents are busy. The name,
 * avatar and description live here and are read by every agent of the bot,
 * never copied onto one.
 */
export interface Bot {
  id: Id;
  name: string;
  avatar?: string;
  description?: string;
}

/**
 * One long-lived worker behind a bot.
 *
 * It holds a model, a prompt, tools, a memory and its own home directory — and
 * no queue, no clock and no life state, which all belong to the bot.
 */
export interface Agent {
  id: Id;
  bot_id: Id;
  /** `watch`, `work`, and whatever comes later. A role, never a name. */
  role: string;
  /** The workspace its sessions open in, unless one was given another. */
  home: string;
  model: string;
  prompt: string;
  tools: string[];
}

/** Feishu's three chat modes, stored for fidelity. */
export type ChatMode = 'group' | 'topic' | 'p2p';

/**
 * Where a group of participants talks.
 *
 * A direct message is a headcount, not a type: it is an ordinary room with two
 * members. `chat_mode` is carried because Feishu has the field, and **no domain
 * logic branches on it**.
 */
export interface Room {
  id: Id;
  name?: string;
  chat_mode: ChatMode;
  created_at: string;
}

export type MembershipRole = 'owner' | 'member';

/** The Room × Principal relation: the same principal differs per room. */
export interface Membership {
  id: Id;
  room_id: Id;
  principal_id: Id;
  joined_at: string;
  role: MembershipRole;
  read_position?: Id;
  muted?: boolean;
  observing?: boolean;
}

export type MessageKind = 'text' | 'image' | 'file' | 'tool_card' | 'system';

/** One entry of `Message.mentions` — Feishu's own `{id, name}` pair. */
export interface Mention {
  id: Id;
  name: string;
}

/**
 * An immutable shared fact.
 *
 * `mentions` is the only stored form of "who was named". There is deliberately
 * no `mentionsMe` here: that is one reader's viewpoint, and it belongs on that
 * reader's queue entry (data-model rule 15).
 */
export interface Message {
  id: Id;
  room_id: Id;
  /** `ou_…` of the principal that wrote it, or `system`. */
  sender_id: Id;
  /** Which agent of the bot wrote it. The room does not show this. */
  agent_id?: Id;
  kind: MessageKind;
  text: string;
  mentions: Mention[];
  /** The message this one answers, when it answers one. */
  root_id?: Id;
  /** The message that caused this one. */
  caused_by?: Id;
  /** The root of that causal run. */
  chain?: Id;
  /** Hop count, read off the data — never a mutable counter. */
  depth: number;
  created_at: string;
}

/**
 * The zero-cost answers derived for one bot when a message lands.
 *
 * They are computed once, at delivery, and live here and nowhere else.
 */
export interface ObservationHints {
  /** This bot's id found in the message's `mentions[]`. */
  mentionsMe: boolean;
  /** The message answers something this bot said. */
  repliesToMe: boolean;
  /** The room holds exactly this bot and the sender. */
  direct: boolean;
}

export type ObservationKind =
  | 'mention'
  | 'reply'
  | 'direct'
  | 'message'
  | 'reminder';

export type Verdict = 'ignore' | 'snooze' | 'keep' | 'act';

/**
 * One entry on one bot's queue. An entry is a delivery, and a delivery is the
 * only thing that wakes a bot.
 */
export interface Observation {
  id: Id;
  bot_id: Id;
  message_id: Id;
  /** Absent on a reminder: a reminder has no room and is never displayed. */
  room_id?: Id;
  kind: ObservationKind;
  hints: ObservationHints;
  delivered_at: string;
  /** Written by the loop or the watch side, never at delivery. */
  verdict?: Verdict;
}

// --- Schema-only this round: the shapes are fixed, nothing writes them yet. ---

/** An agent's private stretch of work in one room. Never a user-visible unit. */
export interface Session {
  id: Id;
  agent_id: Id;
  room_id: Id;
  workspace: string;
  started_at: string;
  ended_at?: string;
}

/** One action by an agent: the atomic unit of cost and audit. */
export interface Turn {
  id: Id;
  agent_id: Id;
  session_id: Id;
  started_at: string;
  ended_at?: string;
  input_tokens: number;
  output_tokens: number;
  cost: number;
  /** Messages produced by the speaking tool — never the turn's own output. */
  produced: Id[];
}

export type MemoryLevel = 'diary' | 'room_digest' | 'session';

/** Agent diary, room digest, session memory. One store per agent. */
export interface Memory {
  id: Id;
  agent_id: Id;
  level: MemoryLevel;
  room_id?: Id;
  body: string;
  updated_at: string;
}

/**
 * One row of the one global schedule table.
 *
 * When a row comes due its `text` becomes an Observation of kind `reminder` on
 * the target bot's queue — a delivery, not a tick.
 */
export interface ScheduleRow {
  id: Id;
  bot_id: Id;
  when: string;
  text: string;
  fired_at?: string;
}
