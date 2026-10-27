/**
 * The entities of `docs/design/data-model.md`.
 *
 * One sentence holds the whole shape: **messages are shared facts; context is a
 * private interpretation.** A room has one message log, and every bot derives
 * its own answer from it once, when a message is delivered to it.
 *
 * Identifiers use the prefixes of data-model rule 10: `ou_` a principal
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
  /**
   * What the bot is, in the four things a person fills in when adding one.
   *
   * The host asked for these on 2026-10-26T20:18, in these words: 姓名／性别／职位／性格.
   * **`position` is what the bot does in this organization and `personality` is how it talks and
   * works** — two different questions, which is why the second is free text over several lines
   * and the first is a short label. `name` is above; `gender` is one of a short list the window
   * offers and is stored as written, `''` included, because a person may decline to say.
   *
   * They are stored on the bot and not on its agents: every agent of the bot speaks as it, and a
   * description copied onto each agent would disagree with itself the first time one was edited.
   */
  gender?: string;
  position?: string;
  personality?: string;
  /**
   * When this bot was deleted, or absent while it stands.
   *
   * **A stamp, not a deletion**, and the difference is the whole point: a bot that
   * has spoken is named by every message it wrote (`Message.sender_id`), so erasing
   * the row would leave a room full of messages by somebody the store cannot name.
   * Deleting it therefore removes its **memberships** — it is in no room, wakes
   * nobody, and appears in no list of who the organization has — and leaves the row
   * here to keep the history readable.
   *
   * The name is `deleted_at` and not a word of its own, because a bot lives in one
   * organization (one store, one directory) and so there is no elsewhere to be taken
   * out to: the host ruled that on 2026-10-27 (机器人并不是跨组织存在的). Rows written
   * while the window said 移出 carry `removed_at` instead, and `deletedAtOf()`
   * (`src/bots.ts`) is the one place that reads both.
   *
   * It is one moment in time and not a `deleted: true` flag for the reason every
   * other stamp in this file is: "when" answers both "is it gone" and "since when"
   * with one fact, and a boolean plus a stamp is two facts that can disagree.
   */
  deleted_at?: string;
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

/** The open platform's three chat modes, stored for fidelity. */
export type ChatMode = 'group' | 'topic' | 'p2p';

/**
 * Where a group of participants talks.
 *
 * A direct message is a headcount, not a type: it is an ordinary room with two
 * members. `chat_mode` is carried because the open platform has the field, and **no domain
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
  /**
   * What the room says about itself: three texts a person may write and edit.
   *
   * They are on the Room rather than on a membership because they are the room's,
   * not a reader's: everybody who opens it reads the same description, the same
   * announcement and the same tag, and one person editing one of them changes what
   * the others see. (A per-reader view is the thing the kernel deliberately does
   * *not* keep — `docs/design/data-model.md` rule 15.)
   *
   * **Nothing already written depends on them.** A `Message` carries `room_id` and
   * never a copy of the room's name, so editing these rewrites no history: the
   * archived log still names the room it was said in, and the room still says what
   * it is now. That is why these may move when a message's own words may not.
   *
   * Absent means nobody wrote one, which the window draws as an invitation to
   * write it rather than as an empty string somebody chose.
   */
  description?: string;
  /** The room's pinned notice — the protoype's 群公告, read by everyone. */
  announcement?: string;
  /**
   * One short label a person may put on the room (`外部群`, `排期`), or absent.
   *
   * Free text and not a closed set: no code branches on it, exactly as `chat_mode`
   * is stored and never branched on — the day something does, it stops being a
   * label and becomes a field with a meaning, and that is a decision, not an edit.
   */
  tag?: string;
  /**
   * When this room was deleted, or absent while it is there.
   *
   * `deleteRoom()` (`src/erase.ts`) writes it together with two other things: every
   * message the room held is taken back, and every membership in it is removed — the
   * memberships being what makes the room disappear from every list, since a room is
   * listed for the people in it. The stamp is the part the memberships cannot say:
   * a row with no members is a room somebody could be added to, while this is a room
   * that no longer exists, and `deliver()` refuses it in a sentence that says so.
   */
  deleted_at?: string;
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

/**
 * A message's picture, as a reference rather than as bytes.
 *
 * `agent-lifecycle.md` §2 requirement 2 is a measured one — *"Messages carry
 * screenshots, photos, diagrams and tool cards. Deciding 'is this about me?'
 * from alt text alone is guessing"* — and until this existed a `kind` could say
 * `image` while nothing could say *which* image, so the only thing an image
 * message carried was its `text`.
 *
 * **The bytes are not in here.** The store writes its shards whole on every save
 * (`store.ts`), so a picture inlined would be re-serialised on every unrelated
 * turn. A picture belongs in a file beside the store, under whatever scheme the
 * client keeps its blobs, and a message names one: `key` is opaque on purpose,
 * exactly as a model's name is `agents.yml`'s. What the kernel owns is the link,
 * and that it survives the trip to the judgement that has to see the picture
 * (`box.ts`, `BoxMedia`).
 *
 * **Present exactly when `kind` is `image`**, which `deliver()` enforces instead
 * of trusting a caller to remember: this cut carries pictures, and a file or a
 * tool card gets a carrier when something reads one. Nothing reads
 * a file or a tool card's carrier today.
 */
export interface MessageMedia {
  /** Which blob, in whatever scheme the client keeps its files under. */
  key: string;
  /** What the bytes are — `image/png`, `application/pdf` — so a reader can tell. */
  mime: string;
}

/**
 * A message's attachment, as a reference plus the three facts a person needs to
 * recognise it: what it was called, how big it is, and what it is.
 *
 * **A file, not a picture, and a carrier of its own.** `MessageMedia` is one
 * `{key, mime}` pair and it is the picture the judgement is shown (`box.ts`,
 * `BoxMedia`); this is the other half of what a composer's paperclip attaches —
 * a PDF, a spreadsheet, a zip — which nothing reads but a person. Folding the two
 * into one field would mean either handing the judgement a mime it cannot read or
 * leaving a file with no name to draw, so they stay two carriers with two kinds.
 *
 * **`name` is the person's, `key` is the client's.** A name may repeat
 * (`report.pdf` twice is two files) and may contain anything at all, which is why
 * the key is built from a stamp rather than from the name — the same split
 * `MessageMedia.key` takes, and for the same reason: a key built from a name is a
 * key that is sometimes a path.
 *
 * **Present exactly when `kind` is `file`**, which `deliver()` enforces rather
 * than trusting a caller — see `fileFor`.
 */
export interface MessageFile {
  /** Which blob, in whatever scheme the client keeps its files under. */
  key: string;
  /** The name the person's file had, drawn as it stands and never used as a path. */
  name: string;
  /** How many bytes, so a row can say `12 KB` without opening it. */
  size: number;
  /** What the bytes are — `application/pdf`, `text/csv`, or the fallback. */
  mime: string;
}

/** One entry of `Message.mentions` — the open platform's `{id, name}` pair. */
export interface Mention {
  id: Id;
  name: string;
}

/**
 * One entry of `Message.reactions` — one emoji and the principals who chose it.
 *
 * Feishu's own pair is `emoji_type` and `count`, and only the first is stored:
 * `count` is the length of `operators`, so there is one answer rather than two
 * that can disagree — a hand-repaired entry naming two operators cannot also
 * claim four people (`Message.depth` reads the same way). The other half of
 * Feishu's shape is "did *I* react", which is derived where it is asked, for the
 * reason `mentionsMe` is: a reader's viewpoint does not go on the shared log
 * (data-model rule 15).
 */
export interface Reaction {
  emoji_type: string;
  /** The principals who chose this emoji, in the order they chose it. */
  operators: Id[];
}

/**
 * The message a reply quotes, read at the moment the reply was sent.
 *
 * A snapshot, not a pointer: the quoted message can be dropped afterwards, and a
 * quotation that changes after the reply is written puts words in the replying
 * author's mouth that they never answered.
 */
export interface QuotedMessage {
  message_id: Id;
  /** The quoted message's sender, by name, as it read then. */
  name: string;
  /** The quoted message's words, cut to what the block draws. */
  text: string;
}

/**
 * Where a forwarded message came from, read at the moment it was forwarded.
 *
 * The forwarded message carries the original's own words and picture as *its*
 * content (`deliver()` copies both), so this records the one thing that content
 * cannot say for itself: whose words they are.
 */
export interface ForwardedFrom {
  message_id: Id;
  name: string;
}

/**
 * A shared fact whose own words are written once.
 *
 * `mentions` is the only stored form of "who was named". There is deliberately
 * no `mentionsMe` here: that is one reader's viewpoint, and it belongs on that
 * reader's queue entry (data-model rule 15). The same rule is why `reactions`
 * keeps `operators[]` and neither a `count` nor a "mine".
 *
 * What a message *says* never changes after `deliver()` writes it — its words,
 * its picture, its mentions, its cause. What other people add to it does: a
 * reaction is another principal's answer to the message, arriving after it was
 * sent, and `toggleReaction()` is the only thing that writes it.
 *
 * **A message can also be taken back, once, and that is a second write of a
 * different kind.** `deleteMessage()` (`src/erase.ts`) stamps `deleted_at` and
 * drops the content — the words, the picture, the attachment, the mentions, the
 * reactions and the two snapshots — while the row stays, because an
 * `Observation`, a reply's `root_id`/`chain` and a `Turn` all name this id and
 * would otherwise point at nothing. So the words are written once and taken back
 * once: what a reader sees after a deletion is a tombstone that says who spoke,
 * where and when, and no longer what.
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
  /**
   * The picture this message is, when its `kind` says `image`.
   *
   * Absent on every other kind, and `deliver()` refuses both halves of that: an
   * `image` carrying no picture, and a picture on a message whose kind disowns
   * it. Without the invariant the text of an image message is all a judgement
   * has, and a verdict reached on it is the guess §2 warns about.
   */
  media?: MessageMedia;
  /**
   * The attachment this message is, when its `kind` says `file`.
   *
   * Absent on every other kind, refused on the two halves of that the way `media`
   * is: a `file` carrying nothing, and an attachment on a kind that disowns it.
   */
  file?: MessageFile;
  mentions: Mention[];
  /**
   * Who reacted to this message, with what — absent until somebody does.
   *
   * The one field on a stored message that moves after it is written:
   * `toggleReaction()` adds and takes back one principal's entry. An entry whose
   * last operator leaves is dropped, so a message whose reactions were all taken
   * back is the same as one nobody ever reacted to.
   */
  reactions?: Reaction[];
  /** The message this one quotes, as it read when this one was sent. */
  quoted?: QuotedMessage;
  /** Where this one was forwarded from, as it read when it was forwarded. */
  forwarded_from?: ForwardedFrom;
  /** The message this one answers, when it answers one. */
  root_id?: Id;
  /** The message that caused this one. */
  caused_by?: Id;
  /** The root of that causal run. */
  chain?: Id;
  /** Hop count, read off the data — never a mutable counter. */
  depth: number;
  created_at: string;
  /**
   * When this message was taken back, or absent while it stands.
   *
   * A stamp and not a hole in the room's log, for the reason the record's own
   * docstring gives: everything that names this id keeps resolving. A stamp and
   * not a `deleted: true` flag, for the reason `Bot.deleted_at` is a stamp —
   * "when" answers both "is it gone" and "since when" with one fact, and a
   * boolean beside a stamp is two facts that can disagree.
   *
   * Setting it is `deleteMessage()`'s write, and that write drops the content in
   * the same step: a stamped message carries `text: ''`, no `media`, no `file`,
   * no `mentions`, no `reactions` and neither snapshot.
   */
  deleted_at?: string;
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
 * Where an observation stands in the bot's queue (`agent-lifecycle.md` §3).
 *
 * Two states, not three: `watched` is `verdict` (see `Observation.verdict`) and
 * giving it a second field would be two versions of one fact. Absent is `new` —
 * every entry a file was written before this field existed still reads as waiting,
 * which is the only reading that is not a guess.
 */
export type ObservationState = 'new' | 'consumed';

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
  /**
   * Where the entry stands in the queue.
   *
   * `agent-lifecycle.md` §3 gives the entry a state machine —
   * `new → watched (act | ignore | snooze | keep) → consumed` — and this field is
   * the half of it the runtime needs: absent (or `new`) is still waiting, and
   * `consumed` is a tick that has taken it and will not take it again. The middle
   * state is not a field, because it already is one: `verdict` is what `watched`
   * means, and a second copy could disagree with it.
   *
   * **A consumed entry stays.** The inbox is append-only (§3), and a verdict lives
   * on the entry it judged and nowhere else — so an
   * entry that carried one and were dropped would take the only copy of the
   * judgement with it, and the box's last-verdict part could never be filled.
   */
  state?: ObservationState;
  /**
   * What was decided about this entry, when something was.
   *
   * `data-model.md` §2.4 gives the entry *"a verdict (ignore / snooze / keep /
   * act)"* beside the reason behind it, and `agent-lifecycle.md` §3 reaches it
   * through the state machine: `new → watched (act | ignore | snooze | keep) →
   * consumed`. `watched` is what this field means, which is why `state` has two
   * values and not three.
   *
   * **An entry may skip it altogether.** Stage 0's fast pass — an @-mention, a
   * reply, a direct message, a reminder coming due — consumes the entry without
   * asking the watch agent (§4), so an entry settled that way carries no verdict
   * and no reason. Absent therefore means *nothing judged this*, never *the
   * judgement had nothing to say*. A rule never writes one either: the only
   * writers are `gate.ts` for a decision read off the hints and `watch.ts` for
   * one that came back from the judgement.
   *
   * **It does not cross into the work agent's context**, for the reason the
   * reason doesn't: the copy handed to a turn is `HandedEntry` in `turn.ts`,
   * which removes this field and the reason so a prompt is not told what was
   * decided about it before it reads the message.
   *
   * Declared here because it was already true everywhere else: `gate.ts` and
   * `watch.ts` have been writing it, `box.ts` reading it and `turn.ts` stripping
   * it while this file — the one place that states the shape of the record —
   * denied it existed. Nothing noticed, because this repository runs the tests
   * with `node --test` and never asks a compiler.
   */
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

// --- The rest of the shapes are fixed by the design, and every one of them is
// written: `Session` and `Turn` in `turn.ts`, `Memory` in `compact.ts`, and
// `ScheduleRow` in `schedule.ts`. ---

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

/**
 * What one turn spent, in the only currency this product has.
 *
 * `docs/host-rulings.md` settles what a cost is here — "No spending cap": no budget
 * field, no "quiet because spent" state, and the spend **recorded and visible**
 * instead. What a turn records is these two numbers, so the pair is the whole of cost
 * rather than a summary of it.
 *
 * A named shape because it crosses one seam twice: the ledger row the store keeps, and
 * the report a `Decide` hands back to the turn that ran it (`turn.ts`). Two loose fields
 * in two places is how one of them ends up written and the other left at zero — which is
 * the state this pair was in until it existed.
 *
 * There is no money in it. The model runs on the caller's own machine
 * so nothing is billed, and the only number a server
 * reports is tokens.
 */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
}

/** One action by an agent: the atomic unit of cost and audit. */
export interface Turn extends TokenUsage {
  id: Id;
  agent_id: Id;
  session_id: Id;
  started_at: string;
  ended_at?: string;
  /**
   * Always `0`, and that is the honest figure rather than a forgotten one.
   *
   * Nothing is billed: the model runs on the caller's own machine
   * so a currency number would have to be invented out of
   * a price list nobody here quoted — exactly the "a number chosen at a call site is a
   * number no measurement stands behind" the repository refuses elsewhere. What a turn
   * spends is its tokens, and they are above it in `TokenUsage`.
   */
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
