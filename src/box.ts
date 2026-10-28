/**
 * The observation box: what a judgement actually reads.
 *
 * `docs/design/agent-lifecycle.md` §3 ("The observation box") names four parts,
 * and this file assembles them — it does not decide any of them:
 *
 * | Part | Where it comes from |
 * |---|---|
 * | **Summary** | the room digest the work agent wrote (`compact.ts`, `digestOf`) |
 * | **Delta** | the record's entries after that digest's consumed-to point (`deltaFor`) |
 * | **Last verdict** | read off the entry the loop wrote it on — never a second copy |
 * | **Question set** | the caller's (`agents.yml`), absent until a ruling fixes its shape |
 *
 * Three rules from the same section drive the shape here:
 *
 * - **It always fits.** The box is filled newest-first until the model's window
 *   is reached, and how many observations were left beyond it is recorded —
 *   *"80 of 300 read; 220 unread"*. A judgement handed more than it can read
 *   returns a confident guess, which looks exactly like a verdict; the count is
 *   what keeps that failure visible instead of silent. When compaction cannot
 *   run at all, this count is what shows it.
 * - **It is structured, not prose.** A summary paragraph is one field. The rest
 *   are fields: how many observations, who spoke, how stale the last verdict is.
 * - **It never waits for a compaction.** Whatever box exists is what is read —
 *   possibly an empty summary and a long delta. Nothing here locks, queues or
 *   retries.
 *
 * **No model is called and nothing is written.** `buildBox` is a pure read of
 * the store: it appends no message, no turn and no row, and it is not a turn.
 * The model that consumes the box is not this file's business, exactly as the
 * compaction writer and stage 1's judgement are not.
 *
 * **The window is the caller's, because the runtime cannot know how a window is
 * measured.** §3 leaves it a count — of entries, of tokens, of images — and the
 * numbers are settled by measurement, so `window` is a budget and `weigh` says
 * what one entry costs against it. With no `weigh` an entry costs 1, which makes
 * the window a count of observations. Nothing here assumes tokens.
 */

import { deltaFor, digestOf } from './compact.ts';
import type { SeekStore } from './store.ts';
import type { Id, Message, Observation, Verdict } from './types.ts';

export interface BoxOptions {
  /**
   * How much the judgement can read, in the units `weigh` returns.
   *
   * It is the caller's number: the runtime does not know the model's window, and
   * §3 settles it by measurement rather than by a constant in here.
   */
  window: number;
  /**
   * What one observation costs against `window`. Defaults to 1.
   *
   * A caller whose window is measured in tokens passes the token count of the
   * entry; one whose window is a plain count passes nothing. A cost that is not
   * a positive number is a caller bug and throws, because a zero-cost entry
   * would let the fill loop run past the window it is supposed to respect.
   */
  weigh?: (entry: Observation) => number;
}

/** The last verdict, put in as a fact about the record. */
export interface BoxVerdict {
  verdict: Verdict;
  /** The entry the loop wrote it on — the only place a verdict is ever stored. */
  entryId: Id;
  /**
   * When that entry arrived.
   *
   * The verdict carries no timestamp of its own (on the
   * entry it judged, and nowhere else), so this is the arrival time of the entry
   * it was written on — named for what it is rather than passed off as the moment
   * the judgement was made.
   */
  delivered_at: string;
  /**
   * What the judgement said, when it said anything.
   *
   * §3 lists it as part of the box's last-verdict part — *"when it was taken,
   * what it was, and the reason if one came back"* — and it is a **fact about
   * the record**, never an argument: "you kept this twelve observations ago and
   * have said nothing since" is the box reporting; "you should keep this" is
   * the box arguing, and that is what would make a stale decision
   * self-perpetuating (§3).
   */
  reason?: string;
}

/** Who spoke in this room over the delta, and how often. */
export interface BoxSpeaker {
  principalId: Id;
  name?: string;
  count: number;
}

/**
 * One picture the judgement is handed, named rather than inlined.
 *
 * The bytes stay where the client keeps them (`MessageMedia.key` is a reference),
 * so what the box owes a judgement is that the picture is **in the box at all**.
 * An image message whose entry the delta holds while its picture reaches nobody
 * is judged from its text, and that is the guessing `src/README.md` line 25
 * forbids — the entry alone cannot prevent it, because an entry names a message
 * and a message's text reads perfectly well on its own.
 *
 * **Handing over the picture is the kernel's; loading the bytes is not.** Turning
 * a `key` into pixels needs the client's blob scheme, and putting a picture in
 * front of a model needs a vision projector that has not been measured (line 25).
 * The box stops at the reference, which is the last thing this kernel can be sure
 * of.
 */
export interface BoxMedia {
  /** The entry this picture belongs to — the delta line it is the picture for. */
  entryId: Id;
  /** The message that carries it. */
  messageId: Id;
  /** The blob's address, opaque here: how a client names a file is its business. */
  key: string;
  /** What the bytes are — `image/png` — since a reader has to know before loading. */
  mime: string;
}

/**
 * One room's box, as a judgement receives it. Structured, never prose.
 *
 * **The box is what a judgement is told; the question is what it is asked, and it
 * is not here.** The question is the prompt artifact's own last part (`prompts.ts`):
 * `watch-v3` declares one choice question with two named answers, and the shipped
 * cut is a threshold on the probability the endpoint answers with — so the text,
 * the two answer names and the cut are one artifact. A question carried here as well
 * would be a second one, free to disagree with the text and with the mask measured
 * against it, and the roster has no field for it either — so there is no path by which a caller can ask two.
 */
export interface RoomBox {
  botId: Id;
  roomId: Id;
  /** The last compaction's result. Absent when nothing has been compacted. */
  summary?: string;
  /** The observations that fit, newest first. */
  delta: Observation[];
  /**
   * The pictures among those observations, in the same order, newest first.
   *
   * Derived from the entries the window **kept**, never from the delta in full:
   * an observation beyond the window is not handed over, and a picture handed
   * over without its line would be an image the judgement cannot place — line 23's
   * failure in its new form.
   *
   * How a picture is charged against `window` is the caller's `weigh`, which is
   * given the entry and not its bytes, so a window measured in images arrives as a
   * `weigh` that counts entries. Nothing here charges for the picture.
   */
  media: BoxMedia[];
  /** How many entries the judgement was given. */
  read: number;
  /** How many the delta holds in total. */
  total: number;
  /** How many were left beyond the window. `read + unread === total`. */
  unread: number;
  /** The newest verdict on the record, as a fact. */
  lastVerdict?: BoxVerdict;
  /** How many delta entries arrived after that verdict: its staleness. */
  observationsSinceLastVerdict?: number;
  /** Everyone who spoke across the delta. */
  whoSpoke: BoxSpeaker[];
}

/**
 * Build the box for one (bot, room).
 *
 * Newest first, up to the window, with the unread count carried along. The
 * newest entry that cannot fit is not read — the box never exceeds the window,
 * even when a single entry is larger than the whole of it, and that shows up as
 * an unread count rather than as a quietly oversized box.
 */
export function buildBox(
  store: SeekStore,
  botId: Id,
  roomId: Id,
  options: BoxOptions,
): RoomBox {
  const weigh = options.weigh ?? (() => 1);
  // No `inFlight` to add: the entries that woke this judgement are on the record
  // the delta is read from, so the box holds the line that woke it without any
  // caller handing it back in.
  const total = deltaFor(store, botId, roomId, workAgentId(store, botId));

  const kept: Observation[] = [];
  let spent = 0;
  for (let index = total.length - 1; index >= 0; index -= 1) {
    const entry = total[index];
    const cost = weigh(entry);
    if (!Number.isFinite(cost) || cost <= 0) {
      throw new Error(
        `weigh() must return a positive number of units, got ${cost} for ${entry.id}`,
      );
    }
    if (spent + cost > options.window) break;
    spent += cost;
    kept.push(entry);
  }
  // Filled by walking backwards, so `kept` is already newest-first — the order
  // the judgement reads it. Reversing would hand it oldest-first.

  const summary = digestOf(store, workAgentId(store, botId) ?? '', roomId)?.body;

  const lastVerdict = newestVerdict(total);
  const messages = byMessageId(store.messagesOf(roomId));
  const box: RoomBox = {
    botId,
    roomId,
    delta: kept,
    media: mediaOf(messages, kept),
    read: kept.length,
    total: total.length,
    unread: total.length - kept.length,
    whoSpoke: speakersOf(store, messages, total),
  };
  if (summary !== undefined) box.summary = summary;
  if (lastVerdict) {
    box.lastVerdict = lastVerdict;
    // Counted by position, not by timestamp: several entries delivered inside
    // one millisecond carry the same `delivered_at`, so a time comparison would
    // call a stale verdict fresh.
    const at = total.findIndex((entry) => entry.id === lastVerdict.entryId);
    box.observationsSinceLastVerdict = at === -1 ? 0 : total.length - 1 - at;
  }
  return box;
}

function workAgentId(store: SeekStore, botId: Id): Id | undefined {
  return store.agentsOf(botId).find((agent) => agent.role === 'work')?.id;
}

/**
 * The newest entry carrying a verdict.
 *
 * Derived, never stored: a verdict lives on the entry it
 * judged and nowhere else, so a "last verdict" field would be a second version
 * of one fact — free to disagree with the entries it summarises.
 */
function newestVerdict(delta: Observation[]): BoxVerdict | undefined {
  for (let index = delta.length - 1; index >= 0; index -= 1) {
    const entry = delta[index];
    if (entry.verdict) {
      const last: BoxVerdict = {
        verdict: entry.verdict,
        entryId: entry.id,
        delivered_at: entry.delivered_at,
      };
      // Carried when the judgement gave one, and absent when it did not: a box
      // that invented a reason would be putting words in the last verdict's
      // mouth, which is the instruction this field is not allowed to become.
      if (entry.reason !== undefined) last.reason = entry.reason;
      return last;
    }
  }
  return undefined;
}

/** The room's messages, keyed by id — built once, because two parts read them. */
function byMessageId(messages: Message[]): Map<Id, Message> {
  const byId = new Map<Id, Message>();
  for (const message of messages) byId.set(message.id, message);
  return byId;
}

/**
 * The pictures in the entries the box actually kept.
 *
 * Walked in the delta's own order, so `box.media` and `box.delta` read together.
 * A reminder has no message (`message_id` absent) and so no picture: its words are
 * its own, and it is never displayed.
 */
function mediaOf(messages: Map<Id, Message>, delta: Observation[]): BoxMedia[] {
  const media: BoxMedia[] = [];
  for (const entry of delta) {
    const message = entry.message_id ? messages.get(entry.message_id) : undefined;
    if (!message?.media) continue;
    media.push({
      entryId: entry.id,
      messageId: message.id,
      key: message.media.key,
      mime: message.media.mime,
    });
  }
  return media;
}

/** Who spoke across the delta, counted off the messages the entries point at. */
function speakersOf(
  store: SeekStore,
  byId: Map<Id, Message>,
  delta: Observation[],
): BoxSpeaker[] {
  const counts = new Map<Id, number>();
  for (const entry of delta) {
    const sender = byId.get(entry.message_id)?.sender_id;
    if (!sender) continue;
    counts.set(sender, (counts.get(sender) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([principalId, count]) => {
      const principal = store.principal(principalId);
      return principal
        ? { principalId, name: principal.name, count }
        : { principalId, count };
    })
    .sort((a, b) => b.count - a.count || a.principalId.localeCompare(b.principalId));
}
