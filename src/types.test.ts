/**
 * `types.ts` states the shape of every record, and until this file existed not one
 * test read it.
 *
 * That is how `Observation` came to deny a field the rest of the kernel had been
 * using for weeks: `gate.ts` writes `entry.verdict`, `watch.ts` writes it,
 * `box.ts` reads it to fill the last verdict, and `turn.ts` strips it before an
 * entry reaches a turn — while the file that says what an observation *is*
 * declared no such field. A plain object takes a new key, so every one of those
 * call sites worked. `docs/design/data-model.md` §2.4 has carried the verdict on
 * the entry all along, in both languages.
 *
 * Nothing caught it because this repository never asks a compiler: `npm test` is
 * `node --test "src/**\/*.test.ts"`, node strips the annotations and runs the code,
 * and `src/dependencies.test.ts` forbids the six dependency keys — `devDependencies`
 * among them — so a type checker cannot arrive without repealing that rule. The
 * check has to be a test, or there is no check.
 *
 * Three ways the declaration can stop being true, one test each:
 *
 * 1. the field is removed from `Observation` (this is the drift that happened);
 * 2. the hand-over in `turn.ts` names a field that no longer exists, so `Omit<>`
 *    silently strips nothing and the verdict starts riding into prompts;
 * 3. the store stops carrying it — a field the design calls essential that no
 *    longer survives a save is a field that has quietly stopped travelling.
 *
 * What this file does **not** do is check any other type. `tsc` is not coming
 * (issue #125's second item is answered: no), so a second drift of a different
 * shape still needs its own guard. This one guards the field that was missed.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { deliver } from './delivery.ts';
import { makeWorld } from './fixtures.ts';
import { SeekStore } from './store.ts';

const TYPES = fileURLToPath(new URL('./types.ts', import.meta.url));
const TURN = fileURLToPath(new URL('./turn.ts', import.meta.url));
const DATA_MODEL = fileURLToPath(new URL('../docs/design/data-model.md', import.meta.url));

/**
 * The body of one declared interface, sliced out of the source.
 *
 * Anchored on the closing brace in the first column rather than on a line count,
 * so a comment or a field added above it does not move the window. The two
 * interfaces this file reads hold no nested braces; one that did would need a
 * different reader, and saying so here is cheaper than a regex that quietly
 * matches too much.
 */
function declared(name: string): string {
  const source = readFileSync(TYPES, 'utf8');
  const opening = `export interface ${name} {`;
  const start = source.indexOf(opening);
  assert.notEqual(start, -1, `${name} is not declared in types.ts`);
  const end = source.indexOf('\n}\n', start);
  assert.notEqual(end, -1, `${name} is never closed in types.ts`);
  return source.slice(start + opening.length, end);
}

test('the record declares the verdict the design and the runtime both have', () => {
  const body = declared('Observation');

  assert.match(
    body,
    /^ {2}verdict\?: Verdict;$/m,
    'Observation does not declare `verdict?: Verdict`, though gate.ts and watch.ts both write one',
  );
  assert.match(
    body,
    /^ {2}reason\?: string;$/m,
    'Observation does not declare `reason?: string`, which sits beside the verdict',
  );

  // Beside it, in the order the judgement produces them: a verdict, then the
  // sentence behind it. `data-model.md` §2.4 puts them on the same entry.
  const verdictAt = body.indexOf('verdict?: Verdict;');
  const reasonAt = body.indexOf('reason?: string;');
  assert.ok(verdictAt < reasonAt, 'the verdict and the reason are on the entry, verdict first');

  // The four words are the design's; the four members are the type's. A verdict
  // the type cannot express, or one it can and the document never named, is drift
  // in one direction or the other — and this line reads the two side by side,
  // which nothing else in the repository does.
  const row = readFileSync(DATA_MODEL, 'utf8')
    .split('\n')
    .find((line) => line.startsWith('| **Observation**'));
  assert.ok(row, 'data-model.md no longer describes Observation in its table');
  const stated = /a verdict \(([^)]+)\)/.exec(row);
  assert.ok(stated, 'the Observation row no longer names the verdict and its four words');
  const words = stated[1].split('/').map((word) => word.trim());

  const union = /export type Verdict = ([^;]+);/.exec(readFileSync(TYPES, 'utf8'));
  assert.ok(union, 'types.ts no longer declares Verdict');
  const members = [...union[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(
    [...words].sort(),
    [...members].sort(),
    'the design names a different set of verdicts than the type allows',
  );
});

test('the copy that reaches a turn strips the fields this record declares', () => {
  const turn = readFileSync(TURN, 'utf8');
  const body = declared('Observation');

  // `HandedEntry` is `Omit<Observation, 'verdict' | 'reason'>`. If either name
  // stops being a declared field, `Omit<>` removes nothing for it and the value
  // crosses into the prompt — with no error anywhere, because annotations are
  // stripped before the code runs.
  const line = /export type HandedEntry = Omit<Observation, ([^>]+)>;/.exec(turn);
  assert.ok(line, 'turn.ts no longer declares HandedEntry as an Omit of Observation');
  for (const name of ['verdict', 'reason']) {
    assert.ok(line[1].includes(`'${name}'`), `HandedEntry no longer strips ${name}`);
    assert.ok(body.includes(`${name}?:`), `HandedEntry strips ${name}, which Observation does not declare`);
  }
});

test('a verdict written on an entry survives the file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seek-types-'));
  const path = join(directory, 'seek.json');
  try {
    const world = makeWorld();
    const store = new SeekStore(world.store.data, path);
    deliver(store, { roomId: world.room, senderId: world.me, text: 'can you look at this?' });

    const queued = store.pending(world.botA);
    assert.equal(queued.length, 1, 'the delivery put one entry on the bot queue');
    queued[0].verdict = 'keep';
    queued[0].reason = 'it asks me something';
    await store.save();

    // Two readers, because the store's own read-back could be the thing that is
    // wrong: the raw shard, and a store loaded from that file.
    const raw = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(raw.observations[world.botA][0].verdict, 'keep', 'the shard dropped the verdict');
    assert.equal(raw.observations[world.botA][0].reason, 'it asks me something');

    const reloaded = await SeekStore.load(path);
    const back = reloaded.pending(world.botA)[0];
    assert.equal(back.verdict, 'keep', 'the verdict did not survive the round trip');
    assert.equal(back.reason, 'it asks me something');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
