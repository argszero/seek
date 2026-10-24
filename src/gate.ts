/**
 * Stage 0: rules only, no model.
 *
 * `docs/design/agent-lifecycle.md` holds the table this file implements, in its
 * own order (the section "rules run first"):
 *
 * | Order | Check | Cost | Verdict |
 * |---|---|---|---|
 * | 1 | No new observations at all | nothing | Return |
 * | 2 | @ me, a reply to my message, a direct message, my own reminder due | nothing | Act |
 * | 3 | Muted room, my own message, another bot's broadcast | nothing | Ignore |
 * | 4 | Everything else | one small-model call | The model decides |
 *
 * The two cases that are **certain and free** are settled before anything runs,
 * so the watch model is only ever asked about the genuinely ambiguous
 * remainder — a group of people talking near the bot, without naming it. An
 * implementation where an un-addressed message reaches a model before these
 * rules have had their say is already wrong.
 *
 * **Order matters, not just membership.** A reminder is authored by the bot
 * itself, so it satisfies both "my own reminder coming due" (row 2) and "my own
 * message" (row 3); row 2 runs first, which is why a reminder wakes the bot
 * instead of being ignored by it. The same holds for a message in a muted room
 * that @-mentions the bot: these are rows, and a lower row never overturns a
 * higher one.
 *
 * Nothing here calls a model, reads a clock or scans a room for its own name.
 * The hints it reads were computed once, at delivery (`delivery.ts`), and this
 * file only ever consumes them.
 */

import type { SeekStore } from './store.ts';
import type { Id, Observation } from './types.ts';

/**
 * What stage 0 settled for one entry.
 *
 * `judge` is not a stored verdict: it means "these rules could not settle it",
 * and it is the only outcome that costs a model call. The stored verdicts are
 * `ignore` and `act` (see `Verdict` in `types.ts`); `snooze` and `keep` are
 * written by the watch side and the loop, never here.
 */
export type GateDecision = 'act' | 'ignore' | 'judge';

export interface GateResult {
  /**
   * What the tick does next: `act` beats `judge` beats `return`. `return` is
   * both row 1 (nothing arrived) and row 3's own ending (everything that
   * arrived was settled without asking anything) — in either case no stage
   * runs and nothing has been spent.
   */
  action: 'return' | 'act' | 'judge';
  /** Fast-pass entries (row 2): certain and free, so stage 2 is called directly. */
  act: Observation[];
  /** Settled as not for this bot (row 3). These are consumed without a call. */
  ignore: Observation[];
  /** Everything the rules could not settle (row 4): stage 1's input. */
  judge: Observation[];
}

/**
 * Settle one entry.
 *
 * The four act conditions are read off the hints computed at delivery and are
 * never re-derived here: a bot does not scan a room for its own name, and
 * "was I addressed" was answered once, when the message landed.
 *
 * The one clause of row 3 this file does not implement is "my own message", and
 * that is deliberate rather than an omission: a delivery is written for every
 * member bot *except the sender* (`delivery.ts`), so an entry whose sender is
 * this bot cannot exist — there is no input to decide and nothing a test could
 * pin. Re-checking it here would be a second copy of a rule whose only real
 * home already enforces it.
 */
export function classify(
  store: SeekStore,
  botId: Id,
  entry: Observation,
): GateDecision {
  // Row 2 — certain and free. A reminder has no room and no message: it is the
  // one entry whose author is the bot itself, and it passes for that reason.
  if (entry.kind === 'reminder') return 'act';
  if (entry.hints.mentionsMe) return 'act';
  if (entry.hints.repliesToMe) return 'act';
  if (entry.hints.direct) return 'act';

  // Row 3 — settled as not for this bot.
  // Another bot talking to the room. Addressed-to-me was already answered by
  // row 2, so reaching here means nobody named this bot: a broadcast.
  if (entry.room_id && isBotSender(store, entry)) return 'ignore';
  // A muted room. `muted` is a property of the membership, not of the bot, so
  // the same bot can be muted here and awake elsewhere.
  if (entry.room_id && isMuted(store, entry.room_id, botId)) return 'ignore';

  // Row 4 — the ambiguous remainder, and the only row that costs anything.
  return 'judge';
}

/**
 * Settle a tick's whole batch.
 *
 * Entries are settled one by one — the rules have "settled most messages" and
 * left a remainder — and the batch's `action` follows the loop's order: a tick
 * holding anything that fast-passes is an act tick however much chatter arrived
 * with it.
 *
 * A settled `ignore` is recorded on the entry it judged, and nowhere else
 * (defaults table row 6): the verdict is the observation's, because the room's
 * message log is a shared fact and a per-reader judgement on it would have to be
 * copied once per bot. A fast-pass entry skips the verdict altogether (see
 * `data-model.md`, the Observation row), and a `judge` entry has none yet —
 * stage 1 writes that one.
 */
export function gate(
  store: SeekStore,
  botId: Id,
  entries: Observation[],
): GateResult {
  const act: Observation[] = [];
  const ignore: Observation[] = [];
  const judge: Observation[] = [];

  for (const entry of entries) {
    const decision = classify(store, botId, entry);
    if (decision === 'act') {
      act.push(entry);
    } else if (decision === 'ignore') {
      // Row 3 says "mark them ignore": the decision is the record.
      entry.verdict = 'ignore';
      ignore.push(entry);
    } else {
      judge.push(entry);
    }
  }

  const action = act.length > 0 ? 'act' : judge.length > 0 ? 'judge' : 'return';
  return { action, act, ignore, judge };
}

/** Whether the message behind this entry was written by another bot. */
function isBotSender(store: SeekStore, entry: Observation): boolean {
  const message = entry.room_id
    ? store.messagesOf(entry.room_id).find((m) => m.id === entry.message_id)
    : undefined;
  return message !== undefined && store.data.bots[message.sender_id] !== undefined;
}

/** Whether this bot has muted this room. */
function isMuted(store: SeekStore, roomId: Id, botId: Id): boolean {
  return store
    .membershipsOf(roomId)
    .some((m) => m.principal_id === botId && m.muted === true);
}
