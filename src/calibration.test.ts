/**
 * The calibration record describes the runtime this tree actually runs, and nothing
 * checked that.
 *
 * `calibration/measured.json` is the persisted copy of the readings the shipped
 * prompt and its operating point rest on. Its own `_why_this_file_exists` says why it
 * matters: four of the scripts that produced those numbers print them and write no
 * file, so this record is the only copy. A record with one copy has no second reader,
 * which is the same shape as the count in the READMEs and the roster's `model` field
 * before it — a promise the project makes about itself that only a reader's attention
 * was guarding.
 *
 * **It had already gone stale, in two places, and one of them contradicted the same
 * file.** On 2026-10-25 `how_the_probability_was_read` still said *"the measurement
 * and the runtime do not read the same estimator today"*, named `bindOptions` as the
 * runtime's reader, and called the difference *"a stated open tension, not a settled
 * fact — docs/decisions.md carries it with the word that would change it"*. Three of
 * those four things were false at once: `src/llama.ts`'s `readingOf` sums every
 * candidate whose decoded form spells the option, `src/llama.test.ts` asserts that
 * sum, and `docs/decisions.md` row 19 settles the reading rather than carrying it as
 * open. And `what_was_not_measured` still led with *"vision: no image case was ever
 * run"* while `model.vision_projector`, eleven lines above it in the same object,
 * reported vision being measured — 56 English image cases and 12 Chinese, 41/56 at
 * the shipped cut.
 *
 * **What is compared is not prose, and it is not a pinned number.** A record cannot
 * be checked against a copy of itself, so the three checks below each lean on
 * something outside the sentence they are checking:
 *
 * 1. **The declaration.** The record states which estimator it is talking about, in a
 *    field a machine reads, and that value is the one `src/llama.test.ts` pins by
 *    behaviour. A record that stops saying is the state this defect started in.
 * 2. **The implementation.** Every document that describes the estimator has to name
 *    the function that reads it, and that function has to be the summing one — read
 *    out of `src/llama.ts` rather than asserted about it. The stale sentence named
 *    `bindOptions`, which measures where to read, not what to read.
 * 3. **The corpus.** The record may not call something unmeasured while the tree
 *    holds labelled cases for it. What counts as a set is structural, not verbal: a
 *    labelled case set carries a `labels` field and a `cases` array, while a replay
 *    or a summary of one carries `result` and no labels — so `server-transport.json`
 *    and `measured.json` are not counted as sets, and the sixty-eight cases in
 *    `cases.json`, `heldout.json`, `boundary.json` and `zh.json` are.
 *
 * What this file does not decide is whether the numbers themselves are right. It
 * cannot: they came from a model this repository does not ship and a run nothing here
 * re-executes. It decides only that the record says what the tree does.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** The record under test, and the two documents that describe the same estimator. */
const RECORD = 'calibration/measured.json';
const DESCRIBERS = [
  RECORD,
  'calibration/provenance.md',
  'calibration/provenance.zh-CN.md',
];

/** The directory whose labelled sets make "unmeasured" a claim about this tree. */
const VISION = 'calibration/vision';

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8');
}

interface MeasuredRecord {
  model: Record<string, string>;
  how_the_probability_was_read: Record<string, string>;
  what_was_not_measured: string[];
}

function record(): MeasuredRecord {
  const parsed = JSON.parse(read(RECORD)) as MeasuredRecord;
  assert.ok(
    parsed.how_the_probability_was_read && parsed.what_was_not_measured && parsed.model,
    `${RECORD} no longer holds the three blocks this check reads — a record that ` +
      'dropped them has stopped saying what its numbers rest on',
  );
  return parsed;
}

/**
 * One function's body, taken from the file that declares it.
 *
 * Read rather than imported because the claim is about what the shipped reader *is*,
 * and an import would only prove that some function exists under that name. The body
 * runs to the first line that is a closing brace in column zero, which is where a
 * top-level function in this tree ends.
 */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`\nfunction ${name}(`);
  assert.ok(
    start >= 0,
    `src/llama.ts declares no function ${name}, and the documents name it as the ` +
      'reader of the option probability — one of the two has to move',
  );
  const end = source.indexOf('\n}', start);
  assert.ok(end > start, `the body of ${name} could not be read out of src/llama.ts`);
  return source.slice(start, end);
}

/** How many labelled image cases the tree holds, counted structurally. */
function labelledImageCases(): { total: number; sets: string[] } {
  const sets: string[] = [];
  let total = 0;
  for (const name of readdirSync(join(ROOT, VISION)).sort()) {
    if (!name.endsWith('.json')) continue;
    const parsed = JSON.parse(read(join(VISION, name))) as {
      labels?: unknown;
      cases?: unknown;
    };
    if (parsed.labels === undefined || !Array.isArray(parsed.cases)) continue;
    sets.push(`${name} (${parsed.cases.length})`);
    total += parsed.cases.length;
  }
  return { total, sets };
}

test('the record declares the estimator the runtime reads, and the reader sums', () => {
  const how = record().how_the_probability_was_read;
  assert.equal(
    how.estimator,
    'summed_over_spellings',
    `${RECORD} must state which estimator its numbers were taken under, in a field a ` +
      'machine reads. The runtime sums every spelling of an option ' +
      '(src/llama.ts `readingOf`, pinned by src/llama.test.ts "the reading sums every ' +
      'spelling of the option"), so a record saying anything else — or saying nothing ' +
      '— is describing a different reading from the one that ships',
  );

  const body = functionBody(read('src/llama.ts'), 'readingOf');
  assert.match(
    body,
    /Math\.exp\(/,
    'the reader the record describes reads probabilities out of logprobs, and this body ' +
      'does not — the declared estimator and the implementation have parted company',
  );
  assert.match(
    body,
    /reduce\(/,
    'the declared estimator sums over spellings, so the reader has to accumulate over ' +
      'more than one candidate; this body does not',
  );

  for (const file of DESCRIBERS) {
    assert.match(
      read(file),
      /readingOf/,
      `${file} describes the estimator without naming the function that reads it. The ` +
        'sentence this check replaced named `bindOptions`, which measures the position ' +
        'the answer is read at rather than the quantity read there',
    );
  }
});

test('the record may not call unmeasured what the tree holds labelled cases for', () => {
  const { total, sets } = labelledImageCases();
  assert.ok(
    total > 0,
    `no labelled case set was found under ${VISION}, so the check below would pass on ` +
      'nothing — the sets are what "measured" means here',
  );

  const measured = record();
  assert.match(
    measured.model.vision_projector ?? '',
    /measur/i,
    `${RECORD}'s model block has stopped recording that vision was measured, while ` +
      `${total} labelled image cases sit in ${sets.join(', ')}`,
  );

  const denied = measured.what_was_not_measured.filter((line) => /no image case/i.test(line));
  assert.deepEqual(
    denied,
    [],
    `${VISION} holds ${total} labelled image cases — ${sets.join(', ')} — and ` +
      `${RECORD} says ${JSON.stringify(denied[0] ?? '')}. A record whose model block ` +
      'reports a measurement and whose unmeasured list denies it is the same ' +
      'self-contradiction that stood in this file until 2026-10-25',
  );
});
