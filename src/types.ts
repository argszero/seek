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
  /**
   * How many bot turns have run here in a row, with no human message between
   * them (`agent-lifecycle.md` §11.3). It lives on the Room, never on an agent:
   * no single agent can see how many times its peers just spoke, so a counter
   * on one would be that agent measuring itself and calling it a conversation.
   *
   * Absent means none have run. A human message resets it.
   */
  consecutive_agent_turns?: number;
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
  /**
   * Set when this entry would have woken the bot but the chain wall held it
   * back (`agent-lifecycle.md` §11.4): the message addresses this bot, and
   * either the chain is at its depth cap or the room's run of consecutive bot
   * turns is at its cap.
   *
   * It records why, at the moment the message landed. The wake decision is
   * taken again when the entry is settled (`chain.ts`), so an entry held while
   * a burst was running is reconsidered once the room moves on.
   */
  chainBlocked?: ChainBlockReason;
}

export type ObservationKind =
  | 'mention'
  | 'reply'
  | 'direct'
  | 'message'
  | 'reminder';

export type Verdict = 'ignore' | 'snooze' | 'keep' | 'act';

/**
 * Why the chain wall held an entry back (`agent-lifecycle.md` §11.3).
 *
 * Both readings are facts about the record — the message's `depth`, and the
 * room's run of bot turns — so neither needs restoring after a restart.
 * `depth` is the chain's own length; `room_agent_turns` is the room's burst.
 */
export type ChainBlockReason = 'depth' | 'room_agent_turns';

/**
 * One entry on one bot's queue. An entry is a delivery, and a delivery is the
 * only thing that wakes a bot.
 */
export interface Observation {
  id: Id;
  bot_id: Id;
  /**
   * The message this entry delivers. Absent on a reminder: a reminder was never
   * spoken in a room, so there is no message behind it (`agent-lifecycle.md`
   * §12).
   */
  message_id?: Id;
  /** Absent on a reminder: a reminder has no room and is never displayed. */
  room_id?: Id;
  kind: ObservationKind;
  hints: ObservationHints;
  /**
   * The reminder's own words, on a reminder and on nothing else.
   *
   * Delivered **verbatim** (§12): not summarised, not translated, not rewritten
   * on the way out. What the author wrote is what the bot reads back, which is
   * what makes a reminder a note to its future self rather than a fresh
   * instruction. Every other entry refers to a message, and the message holds
   * the text.
   */
  text?: string;
  /** The schedule row that produced this entry, on a reminder (§12). */
  schedule_id?: Id;
  delivered_at: string;
  /** Written by the loop or the watch side, never at delivery. */
  verdict?: Verdict;
  /**
   * What the judgement said about this entry, when it said anything.
   *
   * `agent-lifecycle.md` §4: *"The reason is still recorded — on the observation
   * entry, next to the verdict"*, because it is what makes a bad call
   * reviewable and the work agent may read it back. Two consequences follow
   * from the same section: the runtime **never puts it in the work agent's
   * context** (a reason there is a premise, not advice), and a rule never
   * writes one — a reason is the judgement's own sentence, so an entry stage 0
   * settled has a verdict and no reason.
   */
  reason?: string;
}

// --- The rest of the shapes are fixed by the design. Only `ScheduleRow` is
// written yet (`schedule.ts`); the three below are still schema-only. ---

/** An agent's private stretch of work in one room. Never a user-visible unit. */
export interface Session {
  id: Id;
  agent_id: Id;
  /**
   * Absent when the work was in no room.
   *
   * A session is an agent's stretch of work *in one room*, and a reminder has
   * no room — §12 keeps "the turn that fired it" on the record, so that turn
   * needs a session, and that session belongs to no room. It is the only way a
   * session has no room.
   */
  room_id?: Id;
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
  /**
   * The last observation a room digest accounts for.
   *
   * It is written in the same operation as `body` (`agent-lifecycle.md` §3), and
   * the delta a judgement reads is derived from it: the queue entries after this
   * one. Absent on a diary row and on a digest that has consumed nothing.
   */
  consumed_to?: Id;
  updated_at: string;
}

/**
 * Where a row is in its one-way trip (`agent-lifecycle.md` §12).
 *
 * It moves once and never backwards: `pending` → `fired`, or `pending` →
 * `cancelled`, and a `cancelled` row is a tombstone because "I had planned this
 * and dropped it" is information its author may want back.
 */
export type ScheduleState = 'pending' | 'fired' | 'cancelled';

/**
 * One row of the one global schedule table.
 *
 * When a row comes due its `text` becomes an Observation of kind `reminder` on
 * the target bot's queue — a delivery, not a tick.
 */
export interface ScheduleRow {
  id: Id;
  /** The bot the reminder belongs to: the inbox is the bot's, never an agent's. */
  bot_id: Id;
  /** The instant it is due, an ISO string like every other time here. */
  when: string;
  /** Delivered verbatim, exactly as its author wrote it. */
  text: string;
  state: ScheduleState;
  created_at: string;
  /** The agent that wrote the row, when an agent did rather than the loop. */
  created_by?: Id;
  /** When it fired. Present exactly when `state` is `fired`, set in one step with it. */
  fired_at?: string;
}
