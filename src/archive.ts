/**
 * Where a bot's uncompacted content goes, and how it is read back.
 *
 * `docs/host-rulings.md`, "The observation box": *"where the uncompacted content is put
 * has to be told to the model, and the model may go and read it. The uncompacted content
 * is archived by day."* The note is the compaction; what it was written from is the raw
 * material, and that is what this file keeps — one file per day, under the agent's own
 * home, so the day a message arrived is the day it is filed in.
 *
 * **It is filed when a compaction consumes it, and not before.** Until then the entries
 * are still in the room's box and read again on every turn — writing them here as well
 * would be a second copy of something nobody has stopped reading. The moment they leave
 * the box is the moment they would otherwise survive only as a sentence in a note, and
 * that is the moment this file takes them.
 *
 * **What is filed is what the work agent may see.** A verdict and its reason are the
 * judgement's answer to a question the work agent was never asked (§4), so they are not
 * here either: a line is the entry's own facts, and nothing of the watch side rides
 * along. `turn.ts`'s `HandedEntry` strips them on the way into a turn; this strips them
 * on the way to disk, because a file read by that same agent is the same surface.
 *
 * **A line is the entry's facts, not a rendering of them.** The file is JSON Lines so
 * that what is read back carries what the record carried — an arrival time, the room, who
 * spoke — rather than a shape somebody chose for one prompt. The words a reader is given
 * are assembled at the reading end, where the reader is known.
 */

import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SeekStore } from './store.ts';
import type { Observation } from './types.ts';

/** The directory's name, under the agent's home. */
export const ARCHIVE_DIR = 'archive';

/**
 * The largest read this seam hands back, in bytes of rendered text.
 *
 * **It is a share of a window, not a file-size rule.** The read goes into the next
 * request of the same turn, and that request carries the whole box again — so what this
 * number may take is whatever is left of the smallest window the turn runs against. The
 * bundled `llama-server` is started with `n_ctx` 8192 (`ui/electron/server.js`), which is
 * a couple of thousand tokens of English; 8 KiB is a little under half of it, which
 * leaves the box, the note and the answer somewhere to be. A day longer than this is not
 * refused — the newest lines are handed back and the count of the ones left out is stated
 * first, in the shape `box.ts` already uses for a box that could not hold everything
 * ("80 of 300 read; 220 unread"). A reader told what it was not shown can ask again; a
 * reader handed a silently shortened day cannot.
 */
export const ARCHIVE_READ_LIMIT = 8 * 1024;

/** One filed entry: the entry's own facts, and none of the judgement's. */
export interface ArchivedEntry {
  /** When it arrived (`Observation.delivered_at`). */
  at: string;
  /** The room it was said in, or `''` for a reminder, which is in no room. */
  room: string;
  /** Who said it, named at the moment it was filed. */
  sender: string;
  /** The message it is about, when it is about one. */
  messageId?: string;
  /** The words. */
  text: string;
}

/** What a caller has to supply per entry, because only it can reach the message. */
export type Describe = (entry: Observation) => { sender: string; text: string };

/** The day a file is named for: the calendar day the entry arrived, in UTC. */
export function dayOf(at: string): string {
  // The record's own instant, cut rather than converted: an entry belongs to the day it
  // arrived, and re-deriving that day in another zone would file one day's messages
  // under another's name.
  const day = at.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error(
      `an archive line carries the arrival ${JSON.stringify(at)}, which is not an instant`,
    );
  }
  return day;
}

/** The directory one agent's days live in. */
export function archiveDirOf(home: string): string {
  return join(home, ARCHIVE_DIR);
}

/** The file one day lives in. */
export function archiveFileOf(home: string, day: string): string {
  return join(archiveDirOf(home), `${day}.jsonl`);
}

/**
 * File these entries under the days they arrived, and say what was written.
 *
 * Appended, never rewritten: a compaction consumes entries and never unconsumes them, so
 * a file that already holds part of a day is a file this run is adding the tail of.
 *
 * **Called before the note is written, not after.** If the directory cannot be written
 * the compaction must not happen — the delta is still in the record, and the next tick
 * may summarise it again. The other order would consume the entries and then fail to keep
 * them, which is the one outcome this file exists to prevent.
 */
export function archiveObservations(
  home: string,
  entries: Observation[],
  describe: Describe,
): { days: string[]; lines: number } {
  if (entries.length === 0) return { days: [], lines: 0 };
  const byDay = new Map<string, string[]>();
  for (const entry of entries) {
    const day = dayOf(entry.delivered_at);
    const { sender, text } = describe(entry);
    const line: ArchivedEntry = {
      at: entry.delivered_at,
      room: entry.room_id ?? '',
      sender,
      text,
    };
    if (entry.message_id !== undefined) line.messageId = entry.message_id;
    const rows = byDay.get(day) ?? [];
    rows.push(JSON.stringify(line));
    byDay.set(day, rows);
  }
  mkdirSync(archiveDirOf(home), { recursive: true });
  const days: string[] = [];
  let lines = 0;
  for (const [day, rows] of byDay) {
    appendFileSync(archiveFileOf(home, day), `${rows.join('\n')}\n`, 'utf8');
    days.push(day);
    lines += rows.length;
  }
  return { days: days.sort(), lines };
}

/**
 * Which days this agent has on disk, oldest first.
 *
 * The empty list is the ordinary state of a bot nothing has compacted yet, and it reads as
 * "nothing has been filed", never as an error: a directory that is not there holds no
 * days, which is a fact about the bot rather than a fault.
 */
export function archiveDays(home: string): string[] {
  let names: string[];
  try {
    names = readdirSync(archiveDirOf(home));
  } catch {
    return [];
  }
  return names
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .map((name) => name.slice(0, 10))
    .sort();
}

/**
 * One day, as the words a reader is handed.
 *
 * `null` means this agent has no such day: the files are the whole of what may be read, so
 * a day it does not hold is answered rather than invented. A day it does hold comes back
 * one line per entry, `[{at}] {sender}: {text}` — the shape the turn's own transcript uses
 * for the same facts (`work-v8.json`, and `work-v5` before it). A reader handed yesterday
 * in one shape and today in another has to learn a difference that buys nothing.
 */
export function readArchiveDay(home: string, day: string): string | null {
  // The name is the whole of the path: a day that is not a day is not a file this reader
  // looks for, so nothing a model writes in a call can reach out of the archive.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  let raw: string;
  try {
    raw = readFileSync(archiveFileOf(home, day), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

  const lines: string[] = [];
  for (const row of raw.split('\n')) {
    if (row.trim() === '') continue;
    const entry = JSON.parse(row) as ArchivedEntry;
    lines.push(`[${entry.at}] ${entry.sender}: ${entry.text}`);
  }

  // The newest lines are the ones that fit, and the count of the rest goes first. A
  // question about what was said arrives attached to the recent end of a conversation,
  // and a reader told what it did not see can narrow the day; a reader handed an
  // arbitrarily cut middle of one cannot tell that it was cut.
  let kept = 0;
  let bytes = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const size = Buffer.byteLength(lines[index], 'utf8') + 1;
    if (bytes + size > ARCHIVE_READ_LIMIT) break;
    bytes += size;
    kept += 1;
  }
  const shown = lines.slice(lines.length - kept);
  const left = lines.length - kept;
  if (left === 0) return shown.join('\n');
  return (
    `[${lines.length - left} of ${lines.length} lines read; ${left} older ones are not in ` +
    `this answer because ${ARCHIVE_READ_LIMIT} bytes is all a read hands back]\n` +
    shown.join('\n')
  );
}

/**
 * Where the archive is, in the words a prompt can carry.
 *
 * The ruling asks for the place *and* the filing, so this answers both: the directory and
 * the days already in it. A bot with no days is told the place it will be — the first
 * compaction files something there, and a reader told only once it has something to read
 * would not know where to look on the day it does.
 */
export function archivePlaceOf(home: string): string {
  const dir = resolve(archiveDirOf(home));
  const days = archiveDays(home);
  return days.length === 0 ? `${dir} (nothing filed yet)` : `${dir} (days: ${days.join(', ')})`;
}

/**
 * How an entry is named for the file: the sender's name, and the words it delivered.
 *
 * The message is read off the store rather than copied onto the entry, which is
 * `watch.ts`'s rule and `work-server.ts`'s for the same reason — the record keeps one copy
 * of what was said. A sender with no row is named by its own id, which is what a client
 * shows for a stranger.
 */
export function describeFrom(store: SeekStore): Describe {
  return (entry: Observation) => {
    if (entry.message_id === undefined || entry.room_id === undefined) {
      // A reminder is in no room and behind no message, and compaction never files one
      // (it folds rooms). Answering with the entry's own words rather than throwing keeps
      // this function total for a caller that one day does.
      return { sender: '', text: entry.text ?? '' };
    }
    const message = store
      .messagesOf(entry.room_id)
      .find((one) => one.id === entry.message_id);
    if (message === undefined) return { sender: '', text: '' };
    const bot = store.data.bots[message.sender_id];
    if (bot) return { sender: bot.name === '' ? bot.id : bot.name, text: message.text };
    const person = store.data.principals[message.sender_id];
    if (person) {
      return { sender: person.name === '' ? person.id : person.name, text: message.text };
    }
    return { sender: message.sender_id, text: message.text };
  };
}
