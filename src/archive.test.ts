/**
 * What a note folded away is still there to be read back — and nothing else is.
 *
 * `docs/host-rulings.md`, "The observation box": *"The uncompacted content is archived by
 * day"*, *"the location is told to the model"*, and *"the model may go and read it"*.
 * Three claims, and each of them is a way to be wrong that nothing else would notice:
 * a file that is written but never named is content nobody can reach, a reader that
 * answers more than the day it was asked for is a hole in the surface, and a compaction
 * that writes the note and then fails to file what it consumed loses the very thing the
 * ruling exists to keep.
 *
 * So each test here reads a file off a real directory rather than asking the module what
 * it would have written, and the paths below are temporary directories made for the test
 * rather than the fixtures' `/tmp/seek/...`, which two runs would share.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  ARCHIVE_READ_LIMIT,
  archiveDays,
  archiveFileOf,
  archiveObservations,
  archivePlaceOf,
  describeFrom,
  readArchiveDay,
} from './archive.ts';
import { RoomCompactor } from './compact.ts';
import { deliver } from './delivery.ts';
import { makeWorld } from './fixtures.ts';
import type { Observation } from './types.ts';

/** A directory of its own, so two runs of this file cannot read each other's days. */
function homeOf(): string {
  return mkdtempSync(join(tmpdir(), 'seek-archive-'));
}

/** One entry, as the record stamps it. */
function entry(at: string, overrides: Partial<Observation> = {}): Observation {
  return {
    id: `ob_${at}`,
    bot_id: 'ou_bot',
    room_id: 'oc_room',
    message_id: `om_${at}`,
    kind: 'message',
    hints: { mentionsMe: false, repliesToMe: false, direct: false },
    delivered_at: at,
    ...overrides,
  };
}

const describe = (one: Observation) => ({ sender: '邵安清', text: `said at ${one.delivered_at}` });

test('a day is a file, and the day it is filed under is the day it arrived', () => {
  const home = homeOf();
  const written = archiveObservations(
    home,
    [entry('2026-10-30T23:59:59.000Z'), entry('2026-10-31T00:00:01.000Z')],
    describe,
  );
  assert.deepEqual(written, { days: ['2026-10-30', '2026-10-31'], lines: 2 });

  const first = readFileSync(archiveFileOf(home, '2026-10-30'), 'utf8').trim().split('\n');
  assert.equal(first.length, 1, 'midnight is where one day ends and the next begins');
  const line = JSON.parse(first[0]) as Record<string, unknown>;
  assert.deepEqual(line, {
    at: '2026-10-30T23:59:59.000Z',
    room: 'oc_room',
    sender: '邵安清',
    messageId: 'om_2026-10-30T23:59:59.000Z',
    text: 'said at 2026-10-30T23:59:59.000Z',
  });

  // And the days are what the locator can find, week after week: a second compaction on
  // the same day appends rather than replacing, because a compaction never unconsumes.
  archiveObservations(home, [entry('2026-10-31T09:00:00.000Z')], describe);
  assert.deepEqual(archiveDays(home), ['2026-10-30', '2026-10-31']);
  const second = readFileSync(archiveFileOf(home, '2026-10-31'), 'utf8').trim().split('\n');
  assert.equal(second.length, 2, 'the tail of a day is added to the day, not put over it');
});

test('what is filed is the facts of the entry, and none of the watch side\u2019s', async () => {
  const world = makeWorld();
  const home = homeOf();
  deliver(world.store, { roomId: world.room, senderId: world.me, text: 'the batch failed' });
  const entries = await world.store.drain(world.botA);

  archiveObservations(home, entries, describeFrom(world.store));

  const line = JSON.parse(
    readFileSync(archiveFileOf(home, entries[0].delivered_at.slice(0, 10)), 'utf8').trim(),
  ) as Record<string, unknown>;
  // The sender is the person's name, not the id the row is keyed by: a file read by the
  // agent that answers is read in the same words as the room it came from.
  assert.equal(line.sender, 'me');
  assert.equal(line.text, 'the batch failed');
  assert.equal(line.room, world.room);
  // Nothing of the judgement rides along. `turn.ts` strips a verdict on the way into a
  // turn; this is the same surface and the same rule.
  assert.deepEqual(Object.keys(line).sort(), ['at', 'messageId', 'room', 'sender', 'text']);
});

test('a day is answered in the shape the transcript uses, oldest first', () => {
  const home = homeOf();
  archiveObservations(
    home,
    [entry('2026-10-30T01:00:00.000Z'), entry('2026-10-30T02:00:00.000Z')],
    describe,
  );

  assert.equal(
    readArchiveDay(home, '2026-10-30'),
    '[2026-10-30T01:00:00.000Z] 邵安清: said at 2026-10-30T01:00:00.000Z\n' +
      '[2026-10-30T02:00:00.000Z] 邵安清: said at 2026-10-30T02:00:00.000Z',
  );
});

test('a day this bot does not hold is answered as absent, and a name that is not a day is not a file', () => {
  const home = homeOf();
  archiveObservations(home, [entry('2026-10-30T01:00:00.000Z')], describe);

  assert.equal(readArchiveDay(home, '2026-10-29'), null, 'a day with nothing filed is nothing');
  assert.equal(readArchiveDay(home, 'not-a-day'), null, 'a day is a date or it is not a day');
  // The name is the whole of the path, so nothing a model writes in a call can reach out
  // of the archive: a traversal is not a day, and a day is the only thing this reads.
  assert.equal(readArchiveDay(home, '../../etc/passwd'), null);
  assert.equal(readArchiveDay(home, '2026-10-30.jsonl'), null);
});

test('a day longer than a read hands back keeps its newest lines and says what it left out', () => {
  const home = homeOf();
  const rows: Observation[] = [];
  // Each line is a sentence, so the day is well past the limit and the cut has to happen
  // somewhere in the middle rather than at a line nobody could miss.
  for (let index = 0; index < 400; index += 1) {
    const minutes = String(Math.floor(index / 60)).padStart(2, '0');
    const seconds = String(index % 60).padStart(2, '0');
    rows.push(entry(`2026-10-30T00:${minutes}:${seconds}.000Z`));
  }
  archiveObservations(home, rows, (one) => ({
    sender: '邵安清',
    text: `${one.delivered_at} the retry queue was backed up and nobody had looked at it`,
  }));

  const read = readArchiveDay(home, '2026-10-30');
  assert.ok(read, 'a long day is answered, not refused');
  const [first, ...lines] = read.split('\n');
  assert.match(
    first,
    /^\[(\d+) of 400 lines read; (\d+) older ones are not in this answer/,
    'the count goes first, so a reader knows what it was not shown',
  );
  const left = Number(/of 400 lines read; (\d+) older/.exec(first)?.[1]);
  assert.equal(lines.length + left, 400, 'every line is either shown or counted');
  assert.ok(Buffer.byteLength(read, 'utf8') < ARCHIVE_READ_LIMIT + 200, 'the answer is bounded');
  assert.equal(lines[lines.length - 1], readArchiveDay(home, '2026-10-30')?.split('\n').at(-1));
  assert.match(
    String(lines.at(-1)),
    /^\[2026-10-30T00:06:39\.000Z\] /,
    'the newest line is kept, not the oldest',
  );
});

test('the place a model is told names the directory and the days in it', () => {
  const home = homeOf();
  assert.match(archivePlaceOf(home), /\/archive \(nothing filed yet\)$/);

  archiveObservations(home, [entry('2026-10-30T01:00:00.000Z')], describe);
  archiveObservations(home, [entry('2026-10-31T01:00:00.000Z')], describe);
  const place = archivePlaceOf(home);
  assert.match(place, /\/archive \(days: 2026-10-30, 2026-10-31\)$/);
});

test('a compaction files what its note folds away, and files it before the note is written', async () => {
  const world = makeWorld();
  const home = homeOf();
  world.store.data.agents[world.agentA2].home = home;

  deliver(world.store, { roomId: world.room, senderId: world.me, text: 'first' });
  deliver(world.store, { roomId: world.room, senderId: world.me, text: 'second' });

  const compactor = new RoomCompactor(world.store, {
    summarise: () => 'a note that covers both messages',
    lines: { maxObservations: 1 },
  });
  const outcome = await compactor.compact(world.botA, world.room);
  assert.equal(outcome.ran, true);

  const day = outcome.ran ? outcome.delta[0].delivered_at.slice(0, 10) : '';
  const filed = readArchiveDay(home, day);
  assert.ok(filed, 'the day the note folded away is on disk');
  assert.match(filed, /me: first/);
  assert.match(filed, /me: second/);
  assert.deepEqual(archiveDays(home), [day]);

  // **Nothing is filed twice.** The next compaction folds in only what arrived after the
  // note, so the archive stays one line per message rather than a second copy of the box.
  deliver(world.store, { roomId: world.room, senderId: world.me, text: 'third' });
  await compactor.compact(world.botA, world.room);
  const after = String(readArchiveDay(home, day));
  assert.equal(after.split('\n').length, 3, 'the third message is the only line added');
  assert.equal(after.split('\n').filter((line) => line.includes('first')).length, 1);
});

test('a directory that cannot be written leaves the delta where it was', async () => {
  const world = makeWorld();
  // A home whose parent is a file: `mkdirSync` cannot make the directory, so the archive
  // cannot be written — and the note must not be either.
  const block = join(homeOf(), 'not-a-directory');
  writeFileSync(block, 'x', 'utf8');
  world.store.data.agents[world.agentA2].home = join(block, 'agents', 'work');

  deliver(world.store, { roomId: world.room, senderId: world.me, text: 'first' });
  const compactor = new RoomCompactor(world.store, {
    summarise: () => 'a note',
    lines: { maxObservations: 1 },
  });

  await assert.rejects(() => compactor.compact(world.botA, world.room));
  const delta = compactor.delta(world.botA, world.room);
  assert.equal(delta.length, 1, 'the entries are still in the delta, to be summarised again');
});

test('a home that has an archive directory already is used, not replaced', () => {
  const home = homeOf();
  mkdirSync(join(home, 'archive'), { recursive: true });
  writeFileSync(archiveFileOf(home, '2026-10-29'), '', 'utf8');
  archiveObservations(home, [entry('2026-10-30T12:00:00.000Z')], describe);
  assert.deepEqual(archiveDays(home), ['2026-10-29', '2026-10-30'], 'the older day is still there');
});
