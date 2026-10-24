/**
 * The global schedule: one table, one comparator, and a due row is a delivery.
 *
 * `docs/design/agent-lifecycle.md` §12 and the Schedule row of
 * `docs/design/data-model.md` are the specification. The line this file is
 * checked against is §12's own:
 *
 * > **the schedule may produce deliveries, and it may never produce ticks.**
 *
 * So there is no timer here, no per-bot heartbeat, and nothing that grows with
 * the number of bots: one table in the process and a comparator that reads the
 * clock. A row coming due writes an entry into one bot's inbox, and a delivered
 * entry wakes that bot exactly as a person's message would — the schedule is a
 * **second producer of deliveries**, never a second wake source.
 *
 * Three properties are the whole of the care taken here:
 *
 * - **A firing is one write, and it is idempotent.** The row leaves `pending` in
 *   the same uninterrupted step that drops the entry into the inbox, keyed by
 *   the row's `id` (§12). A process that was closed when a row came due fires it
 *   on the next start, once — an instant missed is not a reminder skipped, and
 *   it is not a reminder delivered twice. Ten rows missed while the laptop slept
 *   fire in time order, each as its own delivery.
 * - **The text is delivered verbatim.** What the author wrote is what the bot
 *   reads back: not summarised, not translated, not rewritten on the way out.
 *   That is what makes a reminder a note to its future self rather than a fresh
 *   instruction, so nothing in this file touches the string.
 * - **A reminder is never displayed.** It has no room, no message and no frame;
 *   it reaches the inbox and stops there (§12). Nothing here writes a message.
 *
 * The table is **global**: every bot reads and writes it, and nothing filters it
 * by `bot_id` — a bot can see what other bots have scheduled, which is a shared
 * calendar rather than a private one.
 */

import { newId, SeekStore } from './store.ts';
import type { Id, Observation, ScheduleRow } from './types.ts';

export interface AddRowInput {
  /** The bot the reminder is for. Never an agent: the inbox is the bot's. */
  botId: Id;
  /** The instant it is due. An ISO string, like every other time in the store. */
  when: string;
  /** Delivered verbatim. Nothing rewrites it, then or later. */
  text: string;
  /** The agent that wrote the row, when one did. The loop writes rows too. */
  createdBy?: Id;
  /** An injectable clock, so a test does not depend on wall time. */
  now?: string;
}

/**
 * Write one row.
 *
 * Three things are refused, and each is a way a reminder could stop meaning what
 * its author wrote: a bot that does not exist (nothing would ever read it), an
 * instant that cannot be read (nothing could ever fire it), and empty text (a
 * reminder that says nothing is not a reminder — the same refusal `say()` makes
 * for a message nobody chose to finish).
 */
export function addRow(store: SeekStore, input: AddRowInput): ScheduleRow {
  if (!store.data.bots[input.botId]) {
    throw new Error(`unknown bot: ${input.botId}`);
  }
  if (Number.isNaN(Date.parse(input.when))) {
    throw new Error(`not an instant: ${input.when}`);
  }
  if (input.text.length === 0) {
    throw new Error('a reminder with no text says nothing, so it is not one');
  }

  const row: ScheduleRow = {
    id: newId('sc'),
    bot_id: input.botId,
    when: input.when,
    // Stored exactly as given. Every later reader sees these bytes.
    text: input.text,
    state: 'pending',
    created_at: input.now ?? new Date().toISOString(),
  };
  if (input.createdBy) row.created_by = input.createdBy;
  store.data.schedule.push(row);
  return row;
}

/**
 * Drop a row before it comes due, leaving a tombstone.
 *
 * §12: the state moves once and never backwards. A row that already fired is on
 * the record as having fired, and cancelling it afterwards would be a claim
 * about the past — so it is refused rather than quietly rewritten.
 */
export function cancelRow(store: SeekStore, rowId: Id): ScheduleRow {
  const row = store.data.schedule.find((own) => own.id === rowId);
  if (!row) throw new Error(`unknown schedule row: ${rowId}`);
  if (row.state !== 'pending') {
    throw new Error(
      `schedule row ${rowId} is already ${row.state}: the state moves once, and never backwards`,
    );
  }
  row.state = 'cancelled';
  return row;
}

/**
 * The whole table, unfiltered.
 *
 * Deliberately not "rows for this bot": §12 makes it one shared calendar, and a
 * reader that filtered by `bot_id` would be a private one.
 */
export function listRows(store: SeekStore): ScheduleRow[] {
  return store.data.schedule;
}

/**
 * Deliver every row that has come due, oldest first, and mark each fired.
 *
 * Returns the entries it delivered, so a caller can see what it just woke
 * without re-reading every inbox.
 *
 * The save is the caller's, exactly as it is for `deliver()`: the row's state
 * change and the entry are written in one uninterrupted step here, and the one
 * `store.save()` that follows makes both durable together.
 */
export function fireDue(store: SeekStore, now?: string): Observation[] {
  const at = now ?? new Date().toISOString();
  const atMillis = Date.parse(at);

  const due = store.data.schedule
    .filter((row) => row.state === 'pending')
    // A row whose `when` cannot be read never fires and stays visible in
    // `listRows`. `addRow` refuses such a row, so this is only reachable from a
    // hand-edited file — and a reminder that silently vanished would be worse
    // than one an author can still see and cancel.
    .filter((row) => {
      const when = Date.parse(row.when);
      return !Number.isNaN(when) && when <= atMillis;
    })
    // Time order, so ten rows missed while the machine slept arrive as ten
    // deliveries in the order they were meant to happen (§12). `created_at` and
    // the id break exact ties, so the order is the same on every run.
    .sort(
      (a, b) =>
        Date.parse(a.when) - Date.parse(b.when) ||
        a.created_at.localeCompare(b.created_at) ||
        a.id.localeCompare(b.id),
    );

  const delivered: Observation[] = [];
  for (const row of due) {
    // The one write: the row stops being pending in this same step, before the
    // entry exists, so a second call — a restart, a double tick — finds nothing
    // to fire rather than delivering the reminder twice.
    row.state = 'fired';
    row.fired_at = at;

    const entry: Observation = {
      id: newId('ob'),
      bot_id: row.bot_id,
      kind: 'reminder',
      // A reminder is the bot talking to itself: nobody mentioned it, nothing
      // replies to it, and it is in no room. It takes the fast-pass on its
      // `kind`, not on a hint (§4, stage 0 row 2).
      hints: { mentionsMe: false, repliesToMe: false, direct: false },
      // Verbatim, and no room and no message: this is the entry that is never
      // displayed (§12).
      text: row.text,
      schedule_id: row.id,
      delivered_at: at,
    };
    store.inbox(row.bot_id).push(entry);
    delivered.push(entry);
  }

  return delivered;
}
